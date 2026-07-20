"""Replay & live paper-trading endpoints.

Modes served here:

* **Historical Replay** — chronological simulation of completed days; every
  decision uses only information published at or before its gate. The
  optimisation horizon (24/48/72 h) crosses midnight; state never resets.
* **Live Paper Trading** — today: completed periods are replayed and settled,
  the remainder is a forward proposal at ``as_of = now``. Future actuals are
  never present in responses.
* **Perfect Foresight** — exposed *only* inside ``/metrics`` as a labelled
  benchmark, never mixed into the rolling strategy's results.

Completed runs are archived to DuckDB (see ``replay/persistence.py``) so a
backend restart does not destroy them; archived runs are read-only.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.alternatives import decision_alternatives
from gb_battery.replay.decision_state import TraderLoopError
from gb_battery.replay.engine import (
    EXECUTION_ASSUMPTION,
    ReplayEngine,
    ReplayOptions,
)
from gb_battery.replay.execution import ExecutionParams
from gb_battery.replay.forecaster import ForecastVintage
from gb_battery.replay.metrics import (
    attribution,
    compare_replay_strategies,
    immediate_counterfactuals,
    intervention_metrics,
    price_error_heatmap,
    regime_analysis,
    trader_metrics,
)
from gb_battery.replay.persistence import get_archive
from gb_battery.replay.pit import _utc
from gb_battery.replay.recovery import recover_engine
from gb_battery.replay.session import REGISTRY, ReplaySession
from gb_battery.settlement import LONDON

router = APIRouter(prefix="/api", tags=["replay"])


class ReplayStartRequest(BaseModel):
    config: BatteryConfig = Field(default_factory=BatteryConfig)
    day: date = date(2025, 1, 20)
    source: str = "sample"  # sample | synthetic | elexon
    strategy: str = "rolling_forecast"  # rolling_forecast | rolling_threshold
    history_days: int = Field(default=14, ge=3, le=60)
    mid_lag_minutes: int = Field(default=10, ge=0, le=120)
    seed: int = 42
    auto_run: bool = False
    # Cross-day horizon & realism controls
    horizon_hours: int = Field(default=48)
    n_days: int = Field(default=1, ge=1, le=3)
    terminal_treatment: str = "continuation"
    execution_mode: str = "ideal"
    execution_params: ExecutionParams | None = None


class ReplayStepRequest(BaseModel):
    replay_id: str
    n_steps: int = Field(default=1, ge=1, le=150)


class ReplayRunRequest(BaseModel):
    replay_id: str


class LiveOptimiseRequest(BaseModel):
    config: BatteryConfig = Field(default_factory=BatteryConfig)
    source: str = "elexon"
    strategy: str = "rolling_forecast"
    history_days: int = Field(default=14, ge=3, le=60)
    mid_lag_minutes: int = Field(default=10, ge=0, le=120)
    seed: int = 42
    horizon_hours: int = Field(default=48)
    execution_mode: str = "ideal"
    execution_params: ExecutionParams | None = None


def _options_from(req: ReplayStartRequest | LiveOptimiseRequest, live: bool) -> ReplayOptions:
    return ReplayOptions(
        source=req.source,
        strategy=getattr(req, "strategy", "rolling_forecast"),
        history_days=req.history_days,
        mid_lag_minutes=req.mid_lag_minutes,
        seed=req.seed,
        live=live,
        horizon_hours=req.horizon_hours,
        n_days=getattr(req, "n_days", 1),
        terminal_treatment=getattr(req, "terminal_treatment", "continuation"),
        execution_mode=req.execution_mode,
        execution_params=req.execution_params,
    )


def _attach_audit(session: ReplaySession) -> ReplaySession:
    """Persist session metadata and append every transition to the audit log."""
    archive = get_archive()
    eng = session.engine
    _save_metadata(session)

    def _on_transition(transition: str, step: int, data: dict) -> None:
        archive.append_transition(session.replay_id, transition, step, data)
        # Refresh the run snapshot after each committed gate so a restart
        # recovers both the audit trail and the latest summary.
        if transition in ("PHYSICAL_STATE_CONFIRMATION", "ADVANCE"):
            _archive_session(session)

    eng.on_transition = _on_transition
    return session


def _save_metadata(session: ReplaySession) -> None:
    """Write the run document early so recovery knows options/config."""
    eng = session.engine
    get_archive().save(
        replay_id=session.replay_id,
        created_at=session.created_at,
        mode=session.mode,
        day=eng.day.isoformat(),
        n_days=eng.options.n_days,
        complete=False,
        options=eng.options.model_dump(mode="json"),
        config=eng.config.model_dump(mode="json"),
        versions=eng.versions,
        summary=eng.realised_summary(),
        decisions=[d.model_dump(mode="json") for d in eng.decisions],
        vintages=[],
        metrics=None,
    )


def _get_session(replay_id: str) -> ReplaySession:
    """Return the live session, recovering a persisted one after a restart."""
    session = REGISTRY.get(replay_id)
    if session is not None:
        return session
    # Not in memory: rebuild from the append-only transition log if possible.
    recovered = recover_engine(replay_id)
    if recovered is not None:
        engine, meta = recovered
        session = REGISTRY.adopt(replay_id, engine, mode=meta["mode"])
        engine.warnings.append(
            f"Session recovered after restart: replayed {meta['transitions_applied']} of "
            f"{meta['transitions_in_log']} logged transitions; state {meta['recovered_state']}."
        )
        return _attach_audit(session)
    raise HTTPException(
        404,
        f"Unknown replay '{replay_id}'. Completed runs may be archived — "
        f"try GET /api/replay/runs and GET /api/replay/{replay_id} (read-only).",
    )


def _vintage_payload(v: ForecastVintage, idx: int, n_vintages: int) -> dict:
    return {
        "step": idx,
        "n_vintages": n_vintages,
        "issued_at": v.issued_at.isoformat(),
        "information_cutoff": v.information_cutoff.isoformat(),
        "basis_max_published_at": (
            v.basis_max_published_at.isoformat() if v.basis_max_published_at else None
        ),
        "n_input_observations": v.n_input_observations,
        "n_input_forecasts": v.n_input_forecasts,
        "rows": [
            {
                "settlement_date": r.settlement_date.isoformat(),
                "settlement_period": r.settlement_period,
                "start_utc": r.start_utc.isoformat(),
                "point": r.point,
                "q10": r.q10,
                "q50": r.q50,
                "q90": r.q90,
                "sigma": r.sigma,
                "basis": r.basis,
                "intraday_bias": r.intraday_bias,
                "provenance": r.provenance.value,
                "demand_forecast_mw": r.demand_forecast_mw,
                "wind_forecast_mw": r.wind_forecast_mw,
                "solar_forecast_mw": r.solar_forecast_mw,
                "fundamentals_provenance": (
                    r.fundamentals_provenance.value if r.fundamentals_provenance else None
                ),
            }
            for r in v.rows
        ],
        "warnings": v.warnings,
    }


def _status_payload(session: ReplaySession, now: datetime | None = None) -> dict:
    eng = session.engine
    n = len(eng.periods)
    complete = eng.is_complete(now)
    next_per = eng.periods[eng.step_index] if eng.step_index < n else None
    return {
        "replay_id": session.replay_id,
        "mode": session.mode,
        "archived": False,
        "day": eng.day.isoformat(),
        "options": eng.options.model_dump(),
        "versions": eng.versions,
        "n_periods": n,
        "step_index": eng.step_index,
        "complete": complete,
        "state": eng.state.value,  # trader-in-the-loop state machine
        "soc_mwh": round(eng.soc, 4),
        "next_settlement_period": next_per.settlement_period if next_per else None,
        "next_period_start_utc": next_per.start_utc.isoformat() if next_per else None,
        "summary": eng.realised_summary(),
        "warnings": eng.warnings + _persistence_warnings(),
        "persistence_available": get_archive().available,
        "execution_assumption": EXECUTION_ASSUMPTION,
    }


def _persistence_warnings() -> list[str]:
    """Surface a disabled archive rather than silently losing the audit trail."""
    archive = get_archive()
    return [] if archive.available else [archive.unavailable_reason or "Persistence unavailable."]


def _archive_session(session: ReplaySession, metrics: dict | None = None) -> None:
    """Best-effort persistence of a session's full state."""
    eng = session.engine
    get_archive().save(
        replay_id=session.replay_id,
        created_at=session.created_at,
        mode=session.mode,
        day=eng.day.isoformat(),
        n_days=eng.options.n_days,
        complete=eng.is_complete(),
        options=eng.options.model_dump(mode="json"),
        config=eng.config.model_dump(mode="json"),
        versions=eng.versions,
        summary=eng.realised_summary(),
        decisions=[d.model_dump(mode="json") for d in eng.decisions],
        vintages=[
            _vintage_payload(v, i, len(eng.vintages)) for i, v in enumerate(eng.vintages)
        ],
        metrics=metrics,
    )


@router.post("/replay/start")
def replay_start(req: ReplayStartRequest) -> dict:
    last_day = req.day + timedelta(days=req.n_days - 1)
    if last_day >= date.today() and req.source == "elexon":
        raise HTTPException(
            400,
            "Historical replay needs completed days; use /api/live/optimise for today.",
        )
    try:
        options = _options_from(req, live=False)
    except Exception as exc:  # noqa: BLE001 — pydantic validation of options
        raise HTTPException(422, f"Invalid replay options: {exc}") from exc
    try:
        engine = ReplayEngine(req.config, req.day, options)
    except Exception as exc:  # noqa: BLE001 — data-source failures become clear API errors
        raise HTTPException(
            502,
            f"Could not build the point-in-time store from '{req.source}': {exc}. "
            "The 'sample' and 'synthetic' sources work offline.",
        ) from exc
    session = _attach_audit(REGISTRY.create(engine, mode="historical"))
    if req.auto_run:
        engine.run()
        _archive_session(session)
    payload = _status_payload(session)
    if req.auto_run:
        payload["decisions"] = [d.model_dump(mode="json") for d in engine.decisions]
    return payload


@router.post("/replay/step")
def replay_step(req: ReplayStepRequest) -> dict:
    session = _get_session(req.replay_id)
    new = session.engine.run(max_steps=req.n_steps)
    if session.engine.is_complete():
        _archive_session(session)
    payload = _status_payload(session)
    payload["new_decisions"] = [d.model_dump(mode="json") for d in new]
    return payload


@router.post("/replay/run")
def replay_run(req: ReplayRunRequest) -> dict:
    session = _get_session(req.replay_id)
    session.engine.run()
    _archive_session(session)
    payload = _status_payload(session)
    payload["decisions"] = [d.model_dump(mode="json") for d in session.engine.decisions]
    return payload


# ------------------------------------------------------ trader-in-the-loop

class TraderDecisionRequest(BaseModel):
    replay_id: str
    decision: str  # ACCEPT_RECOMMENDATION | MODIFY | REJECT_TO_IDLE
    charge_mw: float = 0.0
    discharge_mw: float = 0.0
    reason: str | None = None
    actor: str | None = "manual trader"


class ExecuteRequest(BaseModel):
    replay_id: str
    execution_source: str | None = None


class ConfirmStateRequest(BaseModel):
    replay_id: str
    executed_charge_mw: float | None = None
    executed_discharge_mw: float | None = None
    confirmed_soc_after_mwh: float | None = None
    soc_source: str = "manual_confirmation"
    execution_source: str | None = None


def _recommendation_payload(session: ReplaySession) -> dict:
    eng = session.engine
    pending = eng._pending  # noqa: SLF001 — same-package controller access
    rec = pending.recommendation if pending else None
    return {
        "recommendation": rec.model_dump(mode="json") if rec else None,
        "proposed_schedule": [p.model_dump(mode="json") for p in pending.proposed] if pending else [],
    }


@router.post("/replay/recommend")
def replay_recommend(req: ReplayRunRequest) -> dict:
    """Stage 1 (manual): produce the optimiser's advisory recommendation."""
    session = _get_session(req.replay_id)
    try:
        rec = session.engine.recommend()
    except TraderLoopError as exc:
        raise HTTPException(409, str(exc)) from exc
    payload = _status_payload(session)
    if rec is None:
        payload["recommendation"] = None
        payload["proposed_schedule"] = []
    else:
        payload.update(_recommendation_payload(session))
    return payload


@router.post("/replay/trader-decision")
def replay_trader_decision(req: TraderDecisionRequest) -> dict:
    """Stage 2 (manual): accept, modify or reject the recommendation."""
    session = _get_session(req.replay_id)
    try:
        instr = session.engine.submit_trader_instruction(
            req.decision, charge_mw=req.charge_mw, discharge_mw=req.discharge_mw,
            reason=req.reason, actor=req.actor, source="manual_ui",
        )
    except TraderLoopError as exc:
        raise HTTPException(409, str(exc)) from exc
    payload = _status_payload(session)
    payload["trader_instruction"] = instr.model_dump(mode="json")
    return payload


@router.post("/replay/execute")
def replay_execute(req: ExecuteRequest) -> dict:
    """Stage 3 (manual): simulate the fill of the trader instruction."""
    session = _get_session(req.replay_id)
    try:
        execution = session.engine.apply_execution(execution_source=req.execution_source)
    except TraderLoopError as exc:
        raise HTTPException(409, str(exc)) from exc
    payload = _status_payload(session)
    payload["execution"] = execution.model_dump(mode="json")
    return payload


@router.post("/replay/confirm-state")
def replay_confirm_state(req: ConfirmStateRequest) -> dict:
    """Stage 4 (manual): reconcile the confirmed physical state and commit."""
    session = _get_session(req.replay_id)
    try:
        record = session.engine.confirm_state(
            executed_charge_mw=req.executed_charge_mw,
            executed_discharge_mw=req.executed_discharge_mw,
            confirmed_soc_after_mwh=req.confirmed_soc_after_mwh,
            soc_source=req.soc_source,
            execution_source=req.execution_source,
        )
    except TraderLoopError as exc:
        raise HTTPException(409, str(exc)) from exc
    payload = _status_payload(session)
    payload["decision"] = record.model_dump(mode="json")
    return payload


@router.post("/replay/advance")
def replay_advance(req: ReplayRunRequest) -> dict:
    """Stage 5 (manual): move to the next gate once the state is resolved."""
    session = _get_session(req.replay_id)
    try:
        session.engine.advance()
    except TraderLoopError as exc:
        raise HTTPException(409, str(exc)) from exc
    if session.engine.is_complete():
        _archive_session(session)
    return _status_payload(session)


@router.get("/replay/runs")
def replay_runs(limit: int = Query(default=25, ge=1, le=100)) -> dict:
    """Archived (restart-surviving) replay runs."""
    return {"runs": get_archive().list_runs(limit)}


@router.get("/replay/{replay_id}")
def replay_status(replay_id: str) -> dict:
    session = REGISTRY.get(replay_id)
    if session is not None:
        return _status_payload(session)
    stored = get_archive().load(replay_id)
    if stored is None:
        raise HTTPException(404, f"Unknown replay '{replay_id}'.")
    # An unfinished run is resumable: rebuild it from the append-only audit log
    # so a restart returns the live state machine, not a read-only snapshot.
    if not stored.get("complete"):
        try:
            return _status_payload(_get_session(replay_id))
        except HTTPException:
            pass  # fall through to the archived, read-only view
    return {
        "replay_id": replay_id,
        "mode": stored["mode"],
        "archived": True,
        "day": stored["day"],
        "options": stored["options"],
        "versions": stored["versions"],
        "n_periods": len(stored["decisions"]),
        "step_index": len(stored["decisions"]),
        "complete": stored["complete"],
        "soc_mwh": stored["summary"].get("ending_soc_mwh"),
        "next_settlement_period": None,
        "next_period_start_utc": None,
        "summary": stored["summary"],
        "warnings": ["Archived run (read-only): served from DuckDB, not a live session."],
        "execution_assumption": EXECUTION_ASSUMPTION,
    }


DECISION_CSV_COLS = [
    "step", "settlement_date", "settlement_period", "as_of", "horizon_hours",
    "forecast_price", "forecast_q10", "forecast_q90", "forecast_basis",
    "energy_action", "flexibility_position", "requested_charge_mw",
    "requested_discharge_mw", "charge_mw", "discharge_mw", "unfilled_mwh",
    "soc_before_mwh", "soc_after_mwh", "expected_immediate_pnl_gbp",
    "continuation_gbp_per_mwh", "continuation_method", "actual_price",
    "buy_execution_price", "sell_execution_price", "spread_slippage_cost_gbp",
    "fee_cost_gbp", "realised_gross_pnl_gbp", "realised_pnl_gbp",
    "forecast_error", "settlement_status", "execution_mode",
]


def _decisions_of(replay_id: str) -> list[dict]:
    session = REGISTRY.get(replay_id)
    if session is not None:
        return [d.model_dump(mode="json") for d in session.engine.decisions]
    stored = get_archive().load(replay_id)
    if stored is None:
        raise HTTPException(404, f"Unknown replay '{replay_id}'.")
    return stored["decisions"]


@router.get("/replay/{replay_id}/decisions")
def replay_decisions(replay_id: str, format: str = Query(default="json")):
    decisions = _decisions_of(replay_id)
    if format == "csv":
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=DECISION_CSV_COLS, extrasaction="ignore")
        w.writeheader()
        for d in decisions:
            w.writerow({k: v for k, v in d.items() if k in DECISION_CSV_COLS})
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return {"decisions": decisions}


@router.get("/replay/{replay_id}/forecasts")
def replay_forecasts(
    replay_id: str,
    step: int | None = Query(default=None, description="Vintage index; default latest"),
    format: str = Query(default="json"),
):
    session = REGISTRY.get(replay_id)
    if session is not None:
        vintages = [
            _vintage_payload(v, i, len(session.engine.vintages))
            for i, v in enumerate(session.engine.vintages)
        ]
    else:
        stored = get_archive().load(replay_id)
        if stored is None:
            raise HTTPException(404, f"Unknown replay '{replay_id}'.")
        vintages = stored["vintages"]
    if not vintages:
        return {"step": None, "vintage": None, "n_vintages": 0}
    idx = len(vintages) - 1 if step is None else step
    if not 0 <= idx < len(vintages):
        raise HTTPException(404, f"No forecast vintage at step {idx} (have {len(vintages)}).")
    payload = vintages[idx]
    if format == "csv":
        rows = payload["rows"]
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return payload


@router.get("/replay/{replay_id}/metrics")
def replay_metrics(replay_id: str) -> dict:
    session = REGISTRY.get(replay_id)
    if session is None:
        stored = get_archive().load(replay_id)
        if stored is None:
            raise HTTPException(404, f"Unknown replay '{replay_id}'.")
        if stored.get("metrics"):
            return {**stored["metrics"], "archived": True}
        raise HTTPException(
            409,
            "Archived run has no cached metrics and re-solving needs a live "
            "session — start a new replay with the same options.",
        )
    eng = session.engine
    comparison = compare_replay_strategies(eng)
    comparison["trader_metrics"] = trader_metrics(eng.decisions, eng.config)
    comparison["attribution"] = attribution(eng.decisions)
    comparison["regimes"] = regime_analysis(eng.decisions)
    comparison["price_heatmap"] = price_error_heatmap(eng)
    comparison["intervention_metrics"] = intervention_metrics(eng.decisions)
    comparison["counterfactuals"] = immediate_counterfactuals(eng.decisions)
    # Leakage audit: prove every decision's inputs predate its gate.
    audit = []
    for d in eng.decisions:
        basis_ok = d.basis_max_published_at is None or _utc(d.basis_max_published_at) <= _utc(d.as_of)
        settle_ok = (
            d.actual_price_available_at is None
            or _utc(d.actual_price_available_at) > _utc(d.as_of)
            or d.charge_mw + d.discharge_mw < 1e-9
        )
        audit.append(
            {
                "step": d.step,
                "settlement_period": d.settlement_period,
                "as_of": d.as_of.isoformat(),
                "basis_max_published_at": (
                    d.basis_max_published_at.isoformat() if d.basis_max_published_at else None
                ),
                "inputs_predate_decision": basis_ok,
                "outturn_published_after_decision": settle_ok,
            }
        )
    comparison["leakage_audit"] = audit
    comparison["leakage_ok"] = all(
        a["inputs_predate_decision"] and a["outturn_published_after_decision"] for a in audit
    )
    if eng.is_complete():
        get_archive().update_metrics(replay_id, comparison)
        _archive_session(session, metrics=comparison)
    return comparison


@router.get("/replay/{replay_id}/attribution")
def replay_attribution(replay_id: str) -> dict:
    session = REGISTRY.get(replay_id)
    if session is not None:
        return attribution(session.engine.decisions)
    stored = get_archive().load(replay_id)
    if stored is None:
        raise HTTPException(404, f"Unknown replay '{replay_id}'.")
    if stored.get("metrics") and "attribution" in stored["metrics"]:
        return stored["metrics"]["attribution"]
    raise HTTPException(409, "Archived run has no cached attribution.")


@router.get("/replay/{replay_id}/alternatives")
def replay_alternatives(replay_id: str, step: int = Query(...)) -> dict:
    session = REGISTRY.get(replay_id)
    if session is None:
        raise HTTPException(
            409,
            "Decision alternatives need a live session (they re-solve the model); "
            "archived runs are read-only.",
        )
    try:
        return decision_alternatives(session.engine, step)
    except IndexError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/replay/{replay_id}/inputs")
def replay_inputs(
    replay_id: str,
    step: int | None = Query(default=None),
    format: str = Query(default="json"),
    max_observations: int = Query(default=800, ge=1, le=5000),
):
    """The exact PIT-visible rows behind one decision (forecasts + observations)."""
    session = _get_session(replay_id)
    eng = session.engine
    if not eng.decisions:
        raise HTTPException(404, "No decisions yet — step the replay first.")
    idx = len(eng.decisions) - 1 if step is None else step
    if not 0 <= idx < len(eng.decisions):
        raise HTTPException(404, f"No decision at step {idx}.")
    d = eng.decisions[idx]
    as_of = d.as_of
    obs = eng.store.observations_at(as_of, "wholesale_price")[-max_observations:]
    obs_rows = [
        {
            "variable": o.variable,
            "settlement_date": o.settlement_date.isoformat(),
            "settlement_period": o.settlement_period,
            "value": o.value,
            "published_at": o.published_at.isoformat(),
            "source": o.source,
            "provenance": o.provenance.value,
            "publication_reconstructed": o.publication_reconstructed,
            "allowed_by_cutoff": o.published_at <= as_of,
        }
        for o in obs
    ]
    v = eng.vintages[idx]
    fc_rows = [
        {
            "variable": "wholesale_price",
            "settlement_date": r.settlement_date.isoformat(),
            "settlement_period": r.settlement_period,
            "point": r.point,
            "q10": r.q10,
            "q90": r.q90,
            "basis": r.basis,
            "provenance": r.provenance.value,
            "issued_at": v.issued_at.isoformat(),
            "horizon_hours": round(
                (r.start_utc - v.issued_at).total_seconds() / 3600.0, 1
            ),
        }
        for r in v.rows
    ]
    if format == "csv":
        buf = io.StringIO()
        w = csv.DictWriter(
            buf,
            fieldnames=[
                "record_type", "variable", "settlement_date", "settlement_period",
                "value", "published_at", "source", "provenance",
            ],
            extrasaction="ignore",
        )
        w.writeheader()
        for o in obs_rows:
            w.writerow({"record_type": "observation", **o})
        for f in fc_rows:
            w.writerow(
                {
                    "record_type": "forecast",
                    "variable": f["variable"],
                    "settlement_date": f["settlement_date"],
                    "settlement_period": f["settlement_period"],
                    "value": f["point"],
                    "published_at": f["issued_at"],
                    "source": "pit_forecaster",
                    "provenance": f["provenance"],
                }
            )
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return {
        "step": idx,
        "as_of": as_of.isoformat(),
        "settlement_period": d.settlement_period,
        "decision_timestamp": as_of.isoformat(),
        "optimisation_horizon_hours": d.horizon_hours,
        "target_sp": d.settlement_period,
        "model_versions": eng.versions,
        "observations_visible": obs_rows,
        "n_observations_visible": len(obs_rows),
        "forecasts_used": fc_rows,
        "store_notes": eng.store.notes,
    }


@router.get("/replay/{replay_id}/export")
def replay_export(replay_id: str, what: str = Query(...)) -> PlainTextResponse:
    """CSV exports beyond decisions/forecasts: schedule, attribution, metrics."""
    session = REGISTRY.get(replay_id)
    stored = None if session else get_archive().load(replay_id)
    if session is None and stored is None:
        raise HTTPException(404, f"Unknown replay '{replay_id}'.")
    buf = io.StringIO()
    if what == "proposed_schedule":
        if session is not None:
            decisions = [d.model_dump(mode="json") for d in session.engine.decisions]
        else:
            assert stored is not None
            decisions = stored["decisions"] or []
        w = csv.writer(buf)
        w.writerow(["decision_step", "settlement_date", "settlement_period", "energy_action",
                    "charge_mw", "discharge_mw", "ending_soc_mwh", "forecast_price", "expected_pnl_gbp"])
        for d in decisions:
            for p in d["proposed_schedule"]:
                w.writerow([d["step"], p["settlement_date"], p["settlement_period"], p["energy_action"],
                            p["charge_mw"], p["discharge_mw"], p["ending_soc_mwh"],
                            p["forecast_price"], p["expected_pnl_gbp"]])
    elif what == "attribution":
        att: dict | None
        if session is not None:
            att = attribution(session.engine.decisions)
        else:
            assert stored is not None
            att = (stored.get("metrics") or {}).get("attribution")
        if att is None:
            raise HTTPException(409, "No attribution available for this run.")
        w = csv.writer(buf)
        w.writerow(["component", "gbp"])
        for k, val in att.items():
            if isinstance(val, int | float):
                w.writerow([k, val])
    else:
        raise HTTPException(400, f"Unknown export '{what}' (proposed_schedule | attribution).")
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@router.post("/live/optimise")
def live_optimise(req: LiveOptimiseRequest) -> dict:
    """Live paper trading for today: settle the past, propose the future.

    Completed periods are replayed and settled with actual outturns; periods at
    or after ``now`` carry forecasts only — their actual values do not exist
    here and are reported as null.
    """
    now = datetime.now(tz=UTC)
    today = now.astimezone(LONDON).date()  # GB settlement date is the local calendar day
    try:
        options = _options_from(req, live=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Invalid live options: {exc}") from exc
    try:
        engine = ReplayEngine(req.config, today, options)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            502,
            f"Could not build the live point-in-time store from '{req.source}': {exc}. "
            "Try source='synthetic' for an offline demonstration.",
        ) from exc
    session = REGISTRY.create(engine, mode="live")
    engine.run(now=now)  # replays only periods completed & published before now
    _archive_session(session)

    proposal = engine.propose(as_of=now)
    vintage_payload = None
    proposed_payload = None
    if proposal is not None:
        vintage, proposed = proposal
        proposed_payload = [p.model_dump(mode="json") for p in proposed]
        vintage_payload = {
            "issued_at": vintage.issued_at.isoformat(),
            "information_cutoff": vintage.information_cutoff.isoformat(),
            "rows": [
                {
                    "settlement_date": r.settlement_date.isoformat(),
                    "settlement_period": r.settlement_period,
                    "start_utc": r.start_utc.isoformat(),
                    "point": r.point,
                    "q10": r.q10,
                    "q90": r.q90,
                    "basis": r.basis,
                    "provenance": r.provenance.value,
                }
                for r in vintage.rows
            ],
        }

    payload = _status_payload(session, now=now)
    payload["now_utc"] = now.isoformat()
    payload["decisions"] = [d.model_dump(mode="json") for d in engine.decisions]
    payload["forward_proposal"] = proposed_payload
    payload["forward_vintage"] = vintage_payload
    payload["disclaimer"] = (
        "Paper trading only — simulated decisions, no orders are submitted. "
        + EXECUTION_ASSUMPTION
    )
    return payload
