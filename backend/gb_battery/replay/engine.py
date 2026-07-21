"""Rolling-horizon replay engine with cross-day horizons and execution models.

For each executed Settlement Period, in chronological order:

1. ``as_of`` = the period's start (the decision gate);
2. build the information set from the PIT store (``published_at <= as_of``);
3. forecast the **full optimisation horizon** (24/48/72 h — it crosses midnight);
4. estimate an explicit continuation value for energy stored at horizon end;
5. optimise the horizon (wholesale-only revenue streams);
6. **execute only the first period** — through the configured execution model
   (requested vs executed volume are separate; executed volume drives SoC);
7. settle against the outturn once published (reference price ± spread/slippage);
8. carry SoC, per-day cycle usage and cumulative P&L forward — nothing resets
   at midnight.

Execution, spread, slippage and fills are **simulated assumptions** (see
:mod:`gb_battery.replay.execution`); MID is a reference price, not an
executable bid or ask.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field, computed_field

from gb_battery.battery.config import BatteryConfig
from gb_battery.market.balance import (
    CommercialPosition,
    commercial_position,
    metered_net_export_from_soc,
)
from gb_battery.optimiser.deterministic import optimise
from gb_battery.optimiser.inputs import OptimisationInputs, PeriodInput, RevenueStreams
from gb_battery.replay.continuation import ContinuationEstimate, estimate_continuation
from gb_battery.replay.decision_state import (
    ExecutionRecord,
    ModelRecommendation,
    PhysicalStateRecord,
    SessionState,
    TraderInstruction,
    TraderLoopError,
)
from gb_battery.replay.execution import (
    ExecutionMode,
    ExecutionParams,
    apply_execution,
    params_for,
)
from gb_battery.replay.forecaster import ForecastVintage, PITForecaster
from gb_battery.replay.pit import (
    PITDataStore,
    _utc,
    store_from_elexon,
    store_from_sample,
    store_from_synthetic,
)
from gb_battery.replay.records import Provenance
from gb_battery.replay.versions import version_stamp
from gb_battery.settlement import (
    SettlementPeriod,
    settlement_periods_between,
    settlement_periods_for_day,
)

WHOLESALE_ONLY = RevenueStreams(
    wholesale=True,
    upward_availability=False,
    downward_availability=False,
    bm_activation=False,
    imbalance=False,
)

EXECUTION_ASSUMPTION = (
    "Executed at the MID reference price (± the configured simulated spread/"
    "slippage): no order book, no partial-fill randomness, no market impact "
    "beyond the simple model. MID is a reference price, not an executable bid/ask."
)

# Upper bound on state transitions one automatic step() may perform. The longest
# legitimate path (resuming at READY_FOR_NEXT_PERIOD) needs five.
MAX_AUTOMATIC_TRANSITIONS = 6


class ReplayOptions(BaseModel):
    """Configuration of one replay session."""

    source: Literal["sample", "synthetic", "elexon"] = "sample"
    strategy: Literal["rolling_forecast", "rolling_threshold"] = "rolling_forecast"
    history_days: int = Field(default=14, ge=3, le=60)
    mid_lag_minutes: int = Field(default=10, ge=0, le=120)
    seed: int = 42
    live: bool = False  # cap information & settlement at wall-clock now

    # Cross-day rolling horizon (Phase 9).
    horizon_hours: Literal[24, 48, 72] = 48
    n_days: int = Field(default=1, ge=1, le=3)  # executed replay range (days)

    # Terminal treatment (Phase 10).
    terminal_treatment: Literal["continuation", "config"] = "continuation"
    continuation_window_hours: int = Field(default=24, ge=6, le=72)

    # Execution realism (Phase 19).
    execution_mode: ExecutionMode = "ideal"
    execution_params: ExecutionParams | None = None

    # Optional user-supplied contracted schedule (net export MWh per period,
    # keyed "YYYY-MM-DD|SP"). When absent, the session freezes a day-ahead plan.
    contracted_net_export: dict[str, float] | None = None

    @property
    def forward_days_needed(self) -> int:
        """Days of data beyond the first day the store must cover."""
        return (
            (self.n_days - 1)
            + math.ceil(self.horizon_hours / 24)
            + math.ceil(self.continuation_window_hours / 24)
        )


class ProposedPeriod(BaseModel):
    """One period of a proposed (not executed) schedule."""

    settlement_date: date
    settlement_period: int
    start_utc: datetime
    energy_action: str  # CHARGE | DISCHARGE | IDLE
    charge_mw: float
    discharge_mw: float
    ending_soc_mwh: float
    forecast_price: float
    expected_pnl_gbp: float


class DecisionRecord(BaseModel):
    """The audited outcome of one replay step."""

    step: int
    settlement_date: date
    settlement_period: int
    start_utc: datetime
    end_utc: datetime
    duration_hours: float

    # Information set
    as_of: datetime
    information_cutoff: datetime
    basis_max_published_at: datetime | None
    n_input_observations: int
    n_input_forecasts: int

    # Horizon
    horizon_hours: int
    horizon_n_periods: int
    horizon_end_utc: datetime

    # Forecast for the executed period
    forecast_price: float
    forecast_q10: float
    forecast_q90: float
    forecast_sigma: float
    forecast_basis: str
    forecast_provenance: str
    demand_forecast_mw: float | None = None
    wind_forecast_mw: float | None = None
    solar_forecast_mw: float | None = None

    # Decision — energy action and physical flexibility are SEPARATE concepts.
    energy_action: Literal["CHARGE", "DISCHARGE", "IDLE"]
    flexibility_position: Literal["NONE", "UP", "DOWN", "BOTH"] = "NONE"
    up_capability_mw: float = 0.0  # physical estimate, NOT a reserve contract
    down_capability_mw: float = 0.0

    # Requested (optimiser) vs executed (after the execution model) volumes.
    requested_charge_mw: float
    requested_discharge_mw: float
    charge_mw: float  # executed
    discharge_mw: float  # executed
    unfilled_mwh: float = 0.0

    soc_before_mwh: float
    soc_after_mwh: float
    expected_immediate_pnl_gbp: float
    expected_horizon_pnl_gbp: float
    explanation: str
    binding_constraints: list[str]
    proposed_schedule: list[ProposedPeriod]

    # Continuation value (explicit, Phase 10)
    continuation_gbp_per_mwh: float
    continuation_method: str
    continuation_value_gbp: float  # coefficient × planned end-of-horizon SoC
    continuation_share_of_objective_pct: float | None = None
    continuation_window: str | None = None
    continuation_warning: str | None = None

    # Settlement
    settlement_status: Literal["settled", "pending"]
    actual_price: float | None = None  # reference (MID) outturn
    actual_price_available_at: datetime | None = None
    actual_price_provenance: str | None = None
    execution_mode: str = "ideal"
    buy_execution_price: float | None = None
    sell_execution_price: float | None = None
    spread_slippage_cost_gbp: float | None = None
    fee_cost_gbp: float | None = None
    realised_gross_pnl_gbp: float | None = None  # at reference price, before exec costs
    realised_pnl_gbp: float | None = None  # NET of execution costs & degradation
    degradation_cost_gbp: float = 0.0
    forecast_error: float | None = None  # forecast − actual

    # Decision hierarchy: model recommendation → trader instruction → market
    # execution → confirmed physical state. Each is immutable once committed.
    recommendation: ModelRecommendation | None = None
    trader_instruction: TraderInstruction | None = None
    execution: ExecutionRecord | None = None
    physical_state: PhysicalStateRecord | None = None

    # Paper Commercial Imbalance for this period (confirmed metered net export vs
    # the frozen contracted net export). Never a settled BSC result.
    commercial: CommercialPosition | None = None

    warnings: list[str] = Field(default_factory=list)

    # Legacy alias kept for API compatibility (equals energy_action).
    @computed_field  # type: ignore[prop-decorator]
    @property
    def action(self) -> str:
        return self.energy_action


@dataclass
class _PendingGate:
    """Mutable workspace for one in-progress gate (the manual state machine).

    Holds everything computed at ``recommend`` time so the later stages can
    settle and commit without recomputing. It is never exposed; the committed
    :class:`DecisionRecord` and its four sub-records are the immutable output.
    """

    step: int
    period: SettlementPeriod
    as_of: datetime
    now: datetime | None
    horizon: list[SettlementPeriod]
    vintage: ForecastVintage
    cont: ContinuationEstimate
    recommendation: ModelRecommendation
    proposed: list[ProposedPeriod]
    expected_horizon: float
    objective: float | None
    planned_terminal_soc: float
    warnings: list[str]
    instruction: TraderInstruction | None = None
    execution: ExecutionRecord | None = None
    executed_soc_after: float = 0.0
    extra: dict = field(default_factory=dict)


def inputs_from_vintage(
    vintage: ForecastVintage,
    periods: list[SettlementPeriod],
    *,
    streams: RevenueStreams = WHOLESALE_ONLY,
) -> OptimisationInputs:
    """Build optimiser inputs from a forecast vintage (forecast provenance only)."""
    rows: list[PeriodInput] = []
    for per in periods:
        row = vintage.row_for(per.settlement_date, per.settlement_period)
        if row is None:
            continue
        rows.append(
            PeriodInput(
                settlement_date=per.settlement_date,
                settlement_period=per.settlement_period,
                start_utc=per.start_utc,
                end_utc=per.end_utc,
                duration_hours=per.duration_hours,
                wholesale_price=row.point,
                wholesale_price_sigma=row.sigma,
                demand_forecast_mw=row.demand_forecast_mw,
                wind_forecast_mw=row.wind_forecast_mw,
                solar_forecast_mw=row.solar_forecast_mw,
            )
        )
    return OptimisationInputs(periods=rows, revenue_streams=streams)


def _threshold_first_action(
    config: BatteryConfig, inputs: OptimisationInputs, soc: float
) -> tuple[float, float]:
    """First-period action of the transparent threshold rule (30/70 percentiles)."""
    from gb_battery.backtest.strategies import threshold_rule

    sched = threshold_rule(config, inputs, soc)
    first = sched[0]
    return first.charge_mw, first.discharge_mw


class ReplayEngine:
    """Chronological replay of one or more settlement dates for one battery."""

    def __init__(
        self,
        config: BatteryConfig,
        day: date,
        options: ReplayOptions | None = None,
        store: PITDataStore | None = None,
        forecaster: PITForecaster | None = None,
        periods: list[SettlementPeriod] | None = None,
    ) -> None:
        self.options = options or ReplayOptions()
        self.day = day
        self.config = config
        self.forecaster = forecaster or PITForecaster()
        self.store = store if store is not None else self._build_store()
        # `periods` override exists for small hand-verifiable tests; it also caps
        # the optimisation horizon to the given periods.
        self._explicit_periods = periods is not None
        if periods is not None:
            self.periods = periods
        else:
            self.periods = []
            for i in range(self.options.n_days):
                self.periods.extend(settlement_periods_for_day(self.day + timedelta(days=i)))
        self.soc = float(
            min(max(config.initial_soc_mwh, config.effective_min_soc), config.effective_max_soc)
        )
        self._initial_soc = self.soc
        # Immutable contracted schedule (net export MWh per period), frozen lazily
        # on first use. Recommendations / instructions / executions never touch it.
        self._contracted: dict[tuple[date, int], float] | None = None
        self._contracted_provenance: str = "unavailable"
        self.discharged_mwh = 0.0  # cumulative across the whole replay (never resets)
        self.discharged_by_date: dict[date, float] = {}  # daily cycle-budget usage
        self.decisions: list[DecisionRecord] = []
        self.vintages: list[ForecastVintage] = []
        self.warnings: list[str] = list(self.store.notes)
        self.versions = version_stamp()
        # Manual trader-in-the-loop state machine. Automatic step()/run() compose
        # the same stages and always return here to READY_FOR_RECOMMENDATION.
        self.state: SessionState = SessionState.READY_FOR_RECOMMENDATION
        self._pending: _PendingGate | None = None
        # Append-only audit hook: called after every state transition with
        # (transition_name, step, replayable_inputs). Set by the session layer to
        # persist the trail; ``None`` during recovery so replaying does not
        # duplicate history.
        self.on_transition: Callable[[str, int, dict], None] | None = None

    def _log_transition(self, transition: str, data: dict) -> None:
        if self.on_transition is not None:
            self.on_transition(transition, self.step_index, data)

    # ------------------------------------------------------------------ store
    def _build_store(self) -> PITDataStore:
        opt = self.options
        if opt.source == "synthetic":
            return store_from_synthetic(
                self.day,
                history_days=opt.history_days,
                forward_days=opt.forward_days_needed,
                mid_lag_minutes=opt.mid_lag_minutes,
                seed=opt.seed,
            )
        if opt.source == "sample":
            store, day = store_from_sample(self.day, mid_lag_minutes=opt.mid_lag_minutes)
            self.day = day
            return store
        return store_from_elexon(
            self.day,
            history_days=opt.history_days,
            forward_days=opt.forward_days_needed,
            mid_lag_minutes=opt.mid_lag_minutes,
        )

    # ------------------------------------------------------------------ state
    @property
    def step_index(self) -> int:
        return len(self.decisions)

    def is_complete(self, now: datetime | None = None) -> bool:
        if self.step_index >= len(self.periods):
            return True
        if self.options.live:
            per = self.periods[self.step_index]
            now = _utc(now) if now is not None else _utc(datetime.now(tz=UTC))
            # A live step only runs once its period has completed (else the
            # action would be un-settleable and the loop would fabricate the
            # future). The forward view is served by propose() instead.
            return per.end_utc > now
        return False

    # ---------------------------------------------------------------- horizon
    def _horizon(self, t: int) -> list[SettlementPeriod]:
        """Optimisation horizon from gate ``t`` — crosses midnight by design."""
        if self._explicit_periods:
            return self.periods[t:]
        return settlement_periods_between(
            self.periods[t].start_utc, self.options.horizon_hours * 2
        )

    # ------------------------------------------------------- staged decision
    def recommend(self, now: datetime | None = None) -> ModelRecommendation | None:
        """Stage 1 — produce the optimiser's advisory recommendation.

        Advances no state and executes nothing. Returns ``None`` when the replay
        is complete. Requires the state machine to be ready for a new gate.
        """
        if self.options.live and now is None:
            now = datetime.now(tz=UTC)
        if self.state not in (SessionState.READY_FOR_RECOMMENDATION, SessionState.COMPLETE):
            raise TraderLoopError(
                f"Cannot recommend from state {self.state}; resolve the current period first."
            )
        if self.is_complete(now):
            self.state = SessionState.COMPLETE
            return None

        t = self.step_index
        per = self.periods[t]
        as_of = per.start_utc
        horizon = self._horizon(t)
        vintage = self.forecaster.forecast(self.store, as_of, horizon)
        inputs = inputs_from_vintage(vintage, horizon)
        cont = self._continuation(as_of, horizon, vintage)
        cfg = self._step_config(horizon, cont)

        step_warnings = list(vintage.warnings)
        if cont.warning:
            step_warnings.append(cont.warning)

        planned_terminal_soc = self.soc
        if self.options.strategy == "rolling_threshold":
            req_charge, req_discharge = _threshold_first_action(cfg, inputs, self.soc)
            proposed: list[ProposedPeriod] = []
            expected_horizon = 0.0
            objective: float | None = None
            explanation = (
                "Threshold rule: charge below the 30th, discharge above the 70th "
                "percentile of the forecast horizon prices."
            )
            binding: list[str] = []
        else:
            result = optimise(cfg, inputs, compute_marginals=False)
            if result.status != "optimal" or not result.periods:
                step_warnings.append(f"Optimiser status '{result.status}'; holding (IDLE).")
                req_charge = req_discharge = 0.0
                proposed = []
                expected_horizon = 0.0
                objective = None
                explanation = "Optimisation failed for this horizon; no action taken."
                binding = []
            else:
                first = result.periods[0]
                req_charge, req_discharge = first.charge_mw, first.discharge_mw
                explanation = first.explanation
                binding = first.binding_constraints
                expected_horizon = result.total_expected_pnl_gbp
                objective = result.objective_gbp
                planned_terminal_soc = result.periods[-1].ending_soc_mwh
                proposed = [
                    ProposedPeriod(
                        settlement_date=p.settlement_date,
                        settlement_period=p.settlement_period,
                        start_utc=p.start_utc,
                        energy_action=_energy_action(p.charge_mw, p.discharge_mw),
                        charge_mw=p.charge_mw,
                        discharge_mw=p.discharge_mw,
                        ending_soc_mwh=p.ending_soc_mwh,
                        forecast_price=p.wholesale_price,
                        expected_pnl_gbp=p.total_expected_pnl_gbp,
                    )
                    for p in result.periods
                ]

        row = vintage.rows[0]
        dt = per.duration_hours
        deg_req = self.config.degradation_cost_gbp_per_mwh_throughput * (req_charge + req_discharge) * dt
        expected_immediate = row.point * (req_discharge - req_charge) * dt - deg_req
        # Model-expected SoC after the *recommended* action (no clamp — advisory).
        rec_soc_after = (
            self.soc
            + self.config.charge_efficiency * req_charge * dt
            - req_discharge * dt / self.config.discharge_efficiency
        )
        recommendation = ModelRecommendation(
            energy_action=_energy_action(req_charge, req_discharge),
            charge_mw=round(req_charge, 4),
            discharge_mw=round(req_discharge, 4),
            expected_immediate_pnl_gbp=round(expected_immediate, 4),
            expected_horizon_pnl_gbp=round(expected_horizon, 2),
            expected_soc_after_mwh=round(rec_soc_after, 4),
            explanation=explanation,
            binding_constraints=binding,
            forecast_price=row.point,
            issued_at=as_of,
            information_cutoff=vintage.information_cutoff,
            forecast_vintage_step=t,
        )
        self._pending = _PendingGate(
            step=t, period=per, as_of=as_of, now=now, horizon=horizon, vintage=vintage,
            cont=cont, recommendation=recommendation, proposed=proposed,
            expected_horizon=expected_horizon, objective=objective,
            planned_terminal_soc=planned_terminal_soc, warnings=step_warnings,
        )
        self.state = SessionState.AWAITING_TRADER_DECISION
        self._log_transition(
            "RECOMMENDATION",
            {"now": now.isoformat() if now else None, "recommendation": recommendation.model_dump(mode="json")},
        )
        return recommendation

    def submit_trader_instruction(
        self,
        decision: str,
        *,
        charge_mw: float = 0.0,
        discharge_mw: float = 0.0,
        reason: str | None = None,
        actor: str | None = None,
        source: str = "manual_ui",
        at: datetime | None = None,
    ) -> TraderInstruction:
        """Stage 2 — record what the trader instructs (advisory rec unchanged).

        ``at`` is the instruction timestamp; automatic replay passes the gate
        time so runs stay reproducible, manual calls default to wall-clock now.
        """
        if self.state != SessionState.AWAITING_TRADER_DECISION or self._pending is None:
            raise TraderLoopError(
                f"Cannot submit a trader decision from state {self.state}; recommend first."
            )
        rec = self._pending.recommendation
        if decision == "ACCEPT_RECOMMENDATION":
            c, d = rec.charge_mw, rec.discharge_mw
        elif decision == "REJECT_TO_IDLE":
            c, d = 0.0, 0.0
        elif decision == "MODIFY":
            c, d = float(charge_mw), float(discharge_mw)
        else:
            raise TraderLoopError(
                f"Unknown decision '{decision}' "
                "(ACCEPT_RECOMMENDATION | MODIFY | REJECT_TO_IDLE)."
            )
        if c < 0 or d < 0:
            raise TraderLoopError("Charge and discharge MW must be non-negative.")
        if c > 1e-6 and d > 1e-6:
            raise TraderLoopError("Cannot charge and discharge simultaneously.")
        if c > self.config.maximum_charge_mw + 1e-6:
            raise TraderLoopError(
                f"Charge {c} MW exceeds the battery's {self.config.maximum_charge_mw} MW limit."
            )
        if d > self.config.maximum_discharge_mw + 1e-6:
            raise TraderLoopError(
                f"Discharge {d} MW exceeds the battery's {self.config.maximum_discharge_mw} MW limit."
            )
        instruction = TraderInstruction(
            decision=decision, charge_mw=round(c, 4), discharge_mw=round(d, 4),
            reason=reason, decided_at=at or datetime.now(tz=UTC), actor=actor, source=source,
        )
        self._pending.instruction = instruction
        self.state = SessionState.AWAITING_EXECUTION
        self._log_transition(
            "TRADER_INSTRUCTION",
            {
                "decision": decision,
                "charge_mw": charge_mw,
                "discharge_mw": discharge_mw,
                "reason": reason,
                "actor": actor,
                "source": source,
                "at": instruction.decided_at.isoformat(),
            },
        )
        return instruction

    def apply_execution(self, execution_source: str | None = None) -> ExecutionRecord:
        """Stage 3 — simulate the fill of the trader instruction."""
        if self.state != SessionState.AWAITING_EXECUTION or self._pending is None:
            raise TraderLoopError(
                f"Cannot execute from state {self.state}; submit a trader decision first."
            )
        pg = self._pending
        instr = pg.instruction
        assert instr is not None
        dt = pg.period.duration_hours
        params = params_for(self.options.execution_mode, self.options.execution_params)
        cap = params.max_executable_mw
        exec_charge = (min(instr.charge_mw, cap) if cap is not None else instr.charge_mw) * params.fill_ratio
        exec_discharge = (
            min(instr.discharge_mw, cap) if cap is not None else instr.discharge_mw
        ) * params.fill_ratio
        # Daily cycle budget clamp at execution time.
        if self.config.maximum_cycles_per_day is not None:
            daily_budget = self.config.maximum_cycles_per_day * self.config.energy_capacity_mwh
            remaining_today = max(
                daily_budget - self.discharged_by_date.get(pg.period.settlement_date, 0.0), 0.0
            )
            exec_discharge = min(exec_discharge, remaining_today / max(dt, 1e-9))
        exec_charge, exec_discharge, soc_after = self._apply_physics(exec_charge, exec_discharge, dt)
        unfilled = (
            max(instr.charge_mw - exec_charge, 0.0) + max(instr.discharge_mw - exec_discharge, 0.0)
        ) * dt
        status = "simulated"
        if unfilled > 1e-6 and (exec_charge > 1e-6 or exec_discharge > 1e-6):
            status = "partially_filled"
        elif exec_charge < 1e-6 and exec_discharge < 1e-6 and (instr.charge_mw + instr.discharge_mw) > 1e-6:
            status = "rejected"
        src = execution_source or f"{self.options.execution_mode}_simulation"
        execution = ExecutionRecord(
            status=status,
            requested_charge_mw=instr.charge_mw,
            requested_discharge_mw=instr.discharge_mw,
            executed_charge_mw=round(exec_charge, 4),
            executed_discharge_mw=round(exec_discharge, 4),
            executed_energy_mwh=round((exec_charge + exec_discharge) * dt, 4),
            unfilled_mwh=round(unfilled, 4),
            execution_source=src,
        )
        pg.execution = execution
        pg.executed_soc_after = soc_after
        self.state = SessionState.AWAITING_STATE_CONFIRMATION
        self._log_transition(
            "EXECUTION",
            {"execution_source": execution_source, "execution": execution.model_dump(mode="json")},
        )
        return execution

    def confirm_state(
        self,
        *,
        executed_charge_mw: float | None = None,
        executed_discharge_mw: float | None = None,
        confirmed_soc_after_mwh: float | None = None,
        soc_source: str = "executed_action_estimate",
        execution_source: str | None = None,
        at: datetime | None = None,
    ) -> DecisionRecord:
        """Stage 4 — reconcile the confirmed physical state and commit the gate.

        Confirmed SoC drives the next optimisation. Priority: an explicit
        ``confirmed_soc_after_mwh`` (telemetry / meter / manual) is authoritative;
        otherwise the SoC implied by the executed action is used. The committed
        :class:`DecisionRecord` (and all four sub-records) is immutable.
        """
        if self.state != SessionState.AWAITING_STATE_CONFIRMATION or self._pending is None:
            raise TraderLoopError(
                f"Cannot confirm state from {self.state}; execute first."
            )
        pg = self._pending
        assert pg.execution is not None and pg.instruction is not None
        dt = pg.period.duration_hours

        # Optional manual override of executed volumes (e.g. confirmed fills).
        exec_charge = pg.execution.executed_charge_mw
        exec_discharge = pg.execution.executed_discharge_mw
        executed_soc_after = pg.executed_soc_after
        if executed_charge_mw is not None or executed_discharge_mw is not None:
            exec_charge = float(executed_charge_mw or 0.0)
            exec_discharge = float(executed_discharge_mw or 0.0)
            exec_charge, exec_discharge, executed_soc_after = self._apply_physics(
                exec_charge, exec_discharge, dt
            )
            pg.execution = pg.execution.model_copy(
                update={
                    "executed_charge_mw": round(exec_charge, 4),
                    "executed_discharge_mw": round(exec_discharge, 4),
                    "executed_energy_mwh": round((exec_charge + exec_discharge) * dt, 4),
                    "status": "confirmed",
                    "execution_source": execution_source or "manual_confirmation",
                }
            )

        # Confirmed physical state (priority: telemetry/manual > executed estimate).
        model_expected_soc = pg.recommendation.expected_soc_after_mwh
        if confirmed_soc_after_mwh is not None:
            confirmed = float(confirmed_soc_after_mwh)
            if not (self.config.effective_min_soc - 1e-6 <= confirmed <= self.config.effective_max_soc + 1e-6):
                raise TraderLoopError(
                    f"Confirmed SoC {confirmed} MWh is outside the operating band "
                    f"[{self.config.effective_min_soc}, {self.config.effective_max_soc}]."
                )
            state_status = "confirmed"
        else:
            confirmed = executed_soc_after
            soc_source = "executed_action_estimate"
            state_status = "estimated"
        recon_diff = confirmed - executed_soc_after
        physical_state = PhysicalStateRecord(
            soc_before_mwh=round(self.soc, 4),
            model_expected_soc_after_mwh=round(model_expected_soc, 4),
            executed_implied_soc_after_mwh=round(executed_soc_after, 4),
            confirmed_soc_after_mwh=round(confirmed, 4),
            soc_source=soc_source,
            confirmed_at=at or datetime.now(tz=UTC),
            reconciliation_difference_mwh=round(recon_diff, 4),
            status="inconsistent" if abs(recon_diff) > 1e-3 else state_status,
        )

        record = self._commit_gate(pg, exec_charge, exec_discharge, confirmed, physical_state)
        self.state = SessionState.READY_FOR_NEXT_PERIOD
        self._log_transition(
            "PHYSICAL_STATE_CONFIRMATION",
            {
                "executed_charge_mw": executed_charge_mw,
                "executed_discharge_mw": executed_discharge_mw,
                "confirmed_soc_after_mwh": confirmed_soc_after_mwh,
                "soc_source": soc_source,
                "execution_source": execution_source,
                "at": physical_state.confirmed_at.isoformat() if physical_state.confirmed_at else None,
                # The schedule proposed at this gate is now historical; it is kept
                # verbatim in the committed decision and superseded at the next gate.
                "superseded_schedule_periods": len(record.proposed_schedule),
            },
        )
        return record

    def advance(self) -> None:
        """Stage 5 — move to the next gate once the current one is resolved."""
        if self.state != SessionState.READY_FOR_NEXT_PERIOD:
            raise TraderLoopError(
                f"Cannot advance from state {self.state}; confirm the physical state first."
            )
        self._pending = None
        self.state = (
            SessionState.COMPLETE if self.step_index >= len(self.periods)
            else SessionState.READY_FOR_RECOMMENDATION
        )
        self._log_transition("ADVANCE", {"new_state": self.state.value})

    def _commit_gate(
        self,
        pg: _PendingGate,
        exec_charge: float,
        exec_discharge: float,
        confirmed_soc: float,
        physical_state: PhysicalStateRecord,
    ) -> DecisionRecord:
        """Build & append the immutable DecisionRecord for a resolved gate."""
        per = pg.period
        dt = per.duration_hours
        vintage = pg.vintage
        cont = pg.cont
        row = vintage.rows[0]
        rec = pg.recommendation
        instr = pg.instruction
        assert instr is not None and pg.execution is not None

        deg = self.config.degradation_cost_gbp_per_mwh_throughput * (exec_charge + exec_discharge) * dt
        up_cap, down_cap = self._capabilities(exec_charge, exec_discharge)
        cont_value_gbp = cont.gbp_per_mwh * pg.planned_terminal_soc
        cont_share = None
        step_warnings = list(pg.warnings)
        if pg.objective is not None and abs(pg.objective) > 1e-9:
            cont_share = round(100.0 * cont_value_gbp / pg.objective, 1)
            if cont_share > 50.0 and self.options.horizon_hours <= 24:
                step_warnings.append(
                    f"Continuation value is {cont_share}% of the objective — the "
                    "horizon is short; consider 48 h or more."
                )
        if instr.decision != "ACCEPT_RECOMMENDATION":
            step_warnings.append(
                f"Trader {instr.decision.lower()} — executed action differs from the recommendation."
            )

        params = params_for(self.options.execution_mode, self.options.execution_params)
        outturn = self.store.outturn("wholesale_price", per.settlement_date, per.settlement_period)
        settle_now = outturn is not None
        if outturn is not None and self.options.live and pg.now is not None:
            settle_now = _utc(outturn.published_at) <= _utc(pg.now)
        if settle_now and outturn is not None:
            fill_res = apply_execution(exec_charge, exec_discharge, outturn.value, dt, params)
            e_charge = exec_charge * dt
            e_discharge = exec_discharge * dt
            half = (fill_res.buy_price - outturn.value) if fill_res.buy_price is not None else 0.0
            half_s = (outturn.value - fill_res.sell_price) if fill_res.sell_price is not None else 0.0
            spread_cost = half * e_charge + half_s * e_discharge
            fee_cost = params.fee_gbp_per_mwh * (e_charge + e_discharge)
            gross = outturn.value * (e_discharge - e_charge) - deg
            net = gross - spread_cost - fee_cost
            pg.execution = pg.execution.model_copy(
                update={
                    "buy_price": fill_res.buy_price if exec_charge > 0 else None,
                    "sell_price": fill_res.sell_price if exec_discharge > 0 else None,
                    "spread_slippage_cost_gbp": round(spread_cost, 4),
                    "fee_cost_gbp": round(fee_cost, 4),
                }
            )
            record_settlement = {
                "settlement_status": "settled",
                "actual_price": outturn.value,
                "actual_price_available_at": outturn.published_at,
                "actual_price_provenance": outturn.provenance.value,
                "buy_execution_price": fill_res.buy_price if exec_charge > 0 else None,
                "sell_execution_price": fill_res.sell_price if exec_discharge > 0 else None,
                "spread_slippage_cost_gbp": round(spread_cost, 4),
                "fee_cost_gbp": round(fee_cost, 4),
                "realised_gross_pnl_gbp": round(gross, 4),
                "realised_pnl_gbp": round(net, 4),
                "forecast_error": round(row.point - outturn.value, 4),
            }
        else:
            record_settlement = {"settlement_status": "pending"}

        commercial = self._commercial_for_gate(
            per, rec, instr, exec_charge, exec_discharge, confirmed_soc, pg.proposed
        )

        record = DecisionRecord(
            step=pg.step,
            settlement_date=per.settlement_date,
            settlement_period=per.settlement_period,
            start_utc=per.start_utc,
            end_utc=per.end_utc,
            duration_hours=dt,
            as_of=pg.as_of,
            information_cutoff=vintage.information_cutoff,
            basis_max_published_at=vintage.basis_max_published_at,
            n_input_observations=vintage.n_input_observations,
            n_input_forecasts=vintage.n_input_forecasts,
            horizon_hours=self.options.horizon_hours,
            horizon_n_periods=len(pg.horizon),
            horizon_end_utc=pg.horizon[-1].end_utc,
            forecast_price=row.point,
            forecast_q10=row.q10,
            forecast_q90=row.q90,
            forecast_sigma=row.sigma,
            forecast_basis=row.basis,
            forecast_provenance=row.provenance.value,
            demand_forecast_mw=row.demand_forecast_mw,
            wind_forecast_mw=row.wind_forecast_mw,
            solar_forecast_mw=row.solar_forecast_mw,
            energy_action=_energy_action(exec_charge, exec_discharge),
            flexibility_position="NONE",
            up_capability_mw=round(up_cap, 2),
            down_capability_mw=round(down_cap, 2),
            requested_charge_mw=round(instr.charge_mw, 4),
            requested_discharge_mw=round(instr.discharge_mw, 4),
            charge_mw=round(exec_charge, 4),
            discharge_mw=round(exec_discharge, 4),
            unfilled_mwh=pg.execution.unfilled_mwh,
            soc_before_mwh=round(self.soc, 4),
            soc_after_mwh=round(confirmed_soc, 4),
            expected_immediate_pnl_gbp=rec.expected_immediate_pnl_gbp,
            expected_horizon_pnl_gbp=round(pg.expected_horizon, 2),
            explanation=rec.explanation,
            binding_constraints=rec.binding_constraints,
            proposed_schedule=pg.proposed,
            continuation_gbp_per_mwh=cont.gbp_per_mwh,
            continuation_method=cont.method,
            continuation_value_gbp=round(cont_value_gbp, 2),
            continuation_share_of_objective_pct=cont_share,
            continuation_window=(
                f"{cont.window_start_utc:%Y-%m-%d %H:%M}Z → {cont.window_end_utc:%Y-%m-%d %H:%M}Z"
                if cont.window_start_utc and cont.window_end_utc
                else None
            ),
            continuation_warning=cont.warning,
            execution_mode=self.options.execution_mode,
            degradation_cost_gbp=round(deg, 4),
            recommendation=rec,
            trader_instruction=instr,
            execution=pg.execution,
            physical_state=physical_state,
            commercial=commercial,
            warnings=step_warnings,
            **record_settlement,
        )

        # Confirmed SoC drives the next optimisation; cycle budget uses the
        # executed (physical) discharge.
        self.soc = confirmed_soc
        self.discharged_mwh += exec_discharge * dt
        self.discharged_by_date[per.settlement_date] = (
            self.discharged_by_date.get(per.settlement_date, 0.0) + exec_discharge * dt
        )
        self.decisions.append(record)
        self.vintages.append(vintage)
        return record

    # ------------------------------------------------------------------- step
    def step(self, now: datetime | None = None) -> DecisionRecord | None:
        """Automatic gate: resume from whatever valid state the session is in.

        A previous request may have stopped between stages (client timeout,
        cancelled request, or a manual action that part-advanced the gate), so
        this drives the *current* gate forward from any valid state rather than
        assuming it starts at ``READY_FOR_RECOMMENDATION``. It commits **at most
        one** Settlement Period per call and always leaves the session in
        ``READY_FOR_RECOMMENDATION`` or ``COMPLETE``.

        This is exactly the composition the manual API performs, so historical
        replay and validation stay fully automated and reproducible.
        """
        if self.options.live and now is None:
            now = datetime.now(tz=UTC)

        # Worst case is READY_FOR_NEXT_PERIOD: advance → recommend → instruct →
        # execute → confirm+advance = 5 transitions. The guard turns a
        # non-converging state machine into a clear error instead of a hang.
        for _ in range(MAX_AUTOMATIC_TRANSITIONS):
            state = self.state
            if state == SessionState.COMPLETE:
                return None
            if state == SessionState.READY_FOR_NEXT_PERIOD:
                self.advance()
                continue
            if state == SessionState.READY_FOR_RECOMMENDATION:
                if self.recommend(now) is None:
                    return None  # replay complete
                continue
            if state == SessionState.AWAITING_TRADER_DECISION:
                self.submit_trader_instruction(
                    "ACCEPT_RECOMMENDATION",
                    source="automatic_policy",
                    at=self._gate_at(),
                )
                continue
            if state == SessionState.AWAITING_EXECUTION:
                self.apply_execution()
                continue
            if state == SessionState.AWAITING_STATE_CONFIRMATION:
                record = self.confirm_state(
                    soc_source="executed_action_estimate", at=self._gate_at()
                )
                self.advance()
                return record
            raise RuntimeError(f"Unhandled replay session state '{state}'.")

        raise RuntimeError(
            f"Automatic step did not converge within {MAX_AUTOMATIC_TRANSITIONS} "
            f"transitions (state {self.state}); refusing to loop."
        )

    def _gate_at(self) -> datetime | None:
        """Deterministic gate timestamp for the in-progress period, if any."""
        return self._pending.as_of if self._pending else None

    def run(self, max_steps: int | None = None, now: datetime | None = None) -> list[DecisionRecord]:
        """Step until the replay range (or the live boundary) is exhausted."""
        out: list[DecisionRecord] = []
        while max_steps is None or len(out) < max_steps:
            rec = self.step(now)
            if rec is None:
                break
            out.append(rec)
        return out

    # ------------------------------------------------------------- live view
    def propose(self, as_of: datetime) -> tuple[ForecastVintage, list[ProposedPeriod]] | None:
        """Forecast + optimise the not-yet-executed remainder at ``as_of``.

        Nothing is executed or settled — this is the forward-looking paper view.
        """
        t = self.step_index
        if t >= len(self.periods):
            return None
        horizon = self._horizon(t)
        vintage = self.forecaster.forecast(self.store, _utc(as_of), horizon)
        inputs = inputs_from_vintage(vintage, horizon)
        cont = self._continuation(_utc(as_of), horizon, vintage)
        cfg = self._step_config(horizon, cont)
        result = optimise(cfg, inputs, compute_marginals=False)
        proposed = [
            ProposedPeriod(
                settlement_date=p.settlement_date,
                settlement_period=p.settlement_period,
                start_utc=p.start_utc,
                energy_action=_energy_action(p.charge_mw, p.discharge_mw),
                charge_mw=p.charge_mw,
                discharge_mw=p.discharge_mw,
                ending_soc_mwh=p.ending_soc_mwh,
                forecast_price=p.wholesale_price,
                expected_pnl_gbp=p.total_expected_pnl_gbp,
            )
            for p in result.periods
        ]
        return vintage, proposed

    # ---------------------------------------------------------------- helpers
    def _continuation(
        self, as_of: datetime, horizon: list[SettlementPeriod], vintage: ForecastVintage
    ) -> ContinuationEstimate:
        override = self.config.terminal_soc_value_gbp_per_mwh
        return estimate_continuation(
            self.store,
            as_of,
            horizon[-1].end_utc,
            discharge_efficiency=self.config.discharge_efficiency,
            forecaster=self.forecaster,
            config_override=override,
            horizon_forecast_points=[r.point for r in vintage.rows],
            window_hours=self.options.continuation_window_hours,
        )

    def _step_config(
        self, horizon: list[SettlementPeriod], cont: ContinuationEstimate
    ) -> BatteryConfig:
        """Per-step config: current SoC, daily cycle budget, explicit terminal value."""
        updates: dict = {
            "initial_soc_mwh": self.soc,
            "terminal_soc_value_gbp_per_mwh": cont.gbp_per_mwh,
        }
        if self.options.terminal_treatment == "continuation":
            # No artificial end-of-horizon SoC floor: the continuation value —
            # not a constraint — decides what energy is worth carrying forward.
            updates["minimum_terminal_soc_mwh"] = self.config.minimum_soc_mwh
        if self.config.maximum_cycles_per_day is not None:
            cap = self.config.energy_capacity_mwh
            daily_budget = self.config.maximum_cycles_per_day * cap
            gate_day = horizon[0].settlement_date
            used_today = self.discharged_by_date.get(gate_day, 0.0)
            # Remaining budget for today + full budget for each further day the
            # horizon touches (the daily limit legitimately renews at midnight;
            # consumption within each day never resets).
            further_days = len({p.settlement_date for p in horizon}) - 1
            allowed = max(daily_budget - used_today, 0.0) + daily_budget * further_days
            frac_day = max(sum(p.duration_hours for p in horizon) / 24.0, 1e-9)
            # build_model caps discharge at cycles × capacity × frac_day; invert.
            updates["maximum_cycles_per_day"] = max(allowed / (cap * frac_day), 1e-6)
        return self.config.model_copy(update=updates)

    # ------------------------------------------------------- contracted plan
    def _ensure_contracted(self) -> None:
        """Freeze the immutable contracted schedule (once) if not already set.

        User-supplied contracted energy takes priority; otherwise a day-ahead
        plan is frozen from a single optimisation over the whole replay range at
        the start of the first period. It is never overwritten by later
        recommendations, instructions or executions.
        """
        if self._contracted is not None:
            return
        self._contracted = {}
        if self.options.contracted_net_export:
            for key, val in self.options.contracted_net_export.items():
                try:
                    d_str, sp_str = key.split("|")
                    self._contracted[(date.fromisoformat(d_str), int(sp_str))] = float(val)
                except (ValueError, TypeError):
                    continue
            self._contracted_provenance = "user_supplied"
            return
        try:
            as_of = self.periods[0].start_utc
            horizon = list(self.periods)
            vintage = self.forecaster.forecast(self.store, as_of, horizon)
            inputs = inputs_from_vintage(vintage, horizon)
            cont = self._continuation(as_of, horizon, vintage)
            updates: dict = {
                "initial_soc_mwh": self._initial_soc,
                "terminal_soc_value_gbp_per_mwh": cont.gbp_per_mwh,
            }
            if self.options.terminal_treatment == "continuation":
                updates["minimum_terminal_soc_mwh"] = self.config.minimum_soc_mwh
            cfg = self.config.model_copy(update=updates)
            result = optimise(cfg, inputs, compute_marginals=False)
            if result.status == "optimal" and result.periods:
                for p in result.periods:
                    net = (p.discharge_mw - p.charge_mw) * p.duration_hours
                    self._contracted[(p.settlement_date, p.settlement_period)] = round(net, 6)
                self._contracted_provenance = "paper_day_ahead_plan"
        except Exception:  # noqa: BLE001 — leave empty -> commercial unavailable
            self._contracted_provenance = "unavailable"

    def contracted_net_export_for(self, per: SettlementPeriod) -> float | None:
        """Frozen contracted net export (MWh) for a period, or None."""
        self._ensure_contracted()
        assert self._contracted is not None
        return self._contracted.get((per.settlement_date, per.settlement_period))

    def _commercial_for_gate(
        self,
        per: SettlementPeriod,
        rec: ModelRecommendation,
        instr: TraderInstruction,
        exec_charge: float,
        exec_discharge: float,
        confirmed_soc: float,
        proposed: list[ProposedPeriod],
    ) -> CommercialPosition:
        """Paper Commercial Imbalance for a resolved gate (metered vs contracted)."""
        dt = per.duration_hours
        contracted = self.contracted_net_export_for(per)
        metered = metered_net_export_from_soc(
            self.soc, confirmed_soc,
            self.config.charge_efficiency, self.config.discharge_efficiency,
        )
        scheduled = None
        if proposed:
            p0 = proposed[0]
            scheduled = (p0.discharge_mw - p0.charge_mw) * dt
        flags = (
            [f"contracted={self._contracted_provenance}"] if contracted is not None else []
        )
        return commercial_position(
            contracted_net_export_mwh=contracted,
            confirmed_metered_net_export_mwh=metered,
            scheduled_net_export_mwh=scheduled,
            model_recommended_net_export_mwh=(rec.discharge_mw - rec.charge_mw) * dt,
            trader_instructed_net_export_mwh=(instr.discharge_mw - instr.charge_mw) * dt,
            executed_net_export_mwh=(exec_discharge - exec_charge) * dt,
            status="paper",
            provenance="paper_trade",
            assumption_flags=flags,
        )

    def _apply_physics(
        self, charge_mw: float, discharge_mw: float, dt: float
    ) -> tuple[float, float, float]:
        """Clamp an action to physical feasibility and evolve SoC."""
        cfg = self.config
        charge_mw = min(max(charge_mw, 0.0), cfg.maximum_charge_mw)
        discharge_mw = min(max(discharge_mw, 0.0), cfg.maximum_discharge_mw)
        if charge_mw > 0 and discharge_mw > 0:  # never simultaneous
            if charge_mw >= discharge_mw:
                charge_mw, discharge_mw = charge_mw - discharge_mw, 0.0
            else:
                charge_mw, discharge_mw = 0.0, discharge_mw - charge_mw
        add = cfg.charge_efficiency * charge_mw * dt
        room = cfg.effective_max_soc - self.soc
        if add > room:
            charge_mw = room / max(cfg.charge_efficiency * dt, 1e-9)
            add = room
        remove = discharge_mw * dt / cfg.discharge_efficiency
        avail = self.soc - cfg.effective_min_soc
        if remove > avail:
            discharge_mw = avail * cfg.discharge_efficiency / max(dt, 1e-9)
            remove = avail
        return charge_mw, discharge_mw, self.soc + add - remove

    def _capabilities(self, charge_mw: float, discharge_mw: float) -> tuple[float, float]:
        """Physical flexibility estimates around the executed action.

        These are *capability* figures (what the battery could physically do for
        the configured service duration), NOT evidence of any reserve contract.
        """
        cfg = self.config
        net = discharge_mw - charge_mw
        h_up = cfg.upward_service_duration_h
        h_down = cfg.downward_service_duration_h
        up = min(
            cfg.maximum_discharge_mw - net,
            cfg.grid_export_limit_mw - net,
            (self.soc - cfg.effective_min_soc) * cfg.discharge_efficiency / max(h_up, 1e-9),
        )
        down = min(
            cfg.maximum_charge_mw + net,
            cfg.grid_import_limit_mw + net,
            (cfg.effective_max_soc - self.soc) / max(cfg.charge_efficiency * h_down, 1e-9),
        )
        return max(up, 0.0), max(down, 0.0)

    # -------------------------------------------------------------- summaries
    def realised_summary(self) -> dict:
        settled = [d for d in self.decisions if d.settlement_status == "settled"]
        pending = [d for d in self.decisions if d.settlement_status == "pending"]
        realised = sum(d.realised_pnl_gbp or 0.0 for d in settled)
        gross = sum(d.realised_gross_pnl_gbp or 0.0 for d in settled)
        revenue = sum(
            (d.actual_price or 0.0) * d.discharge_mw * d.duration_hours for d in settled
        )
        cost = sum((d.actual_price or 0.0) * d.charge_mw * d.duration_hours for d in settled)
        deg = sum(d.degradation_cost_gbp for d in self.decisions)
        exec_costs = sum(
            (d.spread_slippage_cost_gbp or 0.0) + (d.fee_cost_gbp or 0.0) for d in settled
        )
        unfilled = sum(d.unfilled_mwh for d in self.decisions)
        errors = [d.forecast_error for d in settled if d.forecast_error is not None]
        cum, peak, max_dd = 0.0, 0.0, 0.0
        for d in settled:
            cum += d.realised_pnl_gbp or 0.0
            peak = max(peak, cum)
            max_dd = max(max_dd, peak - cum)
        return {
            "n_steps": len(self.decisions),
            "n_settled": len(settled),
            "n_pending": len(pending),
            "realised_pnl_gbp": round(realised, 2),  # net of execution costs
            "realised_gross_pnl_gbp": round(gross, 2),  # at reference price
            "execution_cost_gbp": round(exec_costs, 2),
            "unfilled_mwh": round(unfilled, 3),
            "wholesale_revenue_gbp": round(revenue, 2),
            "charging_cost_gbp": round(cost, 2),
            "degradation_cost_gbp": round(deg, 2),
            "cycles": round(self.discharged_mwh / self.config.energy_capacity_mwh, 3)
            if self.config.energy_capacity_mwh
            else 0.0,
            "max_drawdown_gbp": round(max_dd, 2),
            "ending_soc_mwh": round(self.soc, 3),
            "forecast_mae": round(sum(abs(e) for e in errors) / len(errors), 3) if errors else None,
            "forecast_rmse": round((sum(e * e for e in errors) / len(errors)) ** 0.5, 3)
            if errors
            else None,
            "forecast_bias": round(sum(errors) / len(errors), 3) if errors else None,
            "execution_mode": self.options.execution_mode,
            "execution_assumption": EXECUTION_ASSUMPTION,
        }


def _energy_action(charge_mw: float, discharge_mw: float) -> Literal["CHARGE", "DISCHARGE", "IDLE"]:
    if charge_mw > 1e-4:
        return "CHARGE"
    if discharge_mw > 1e-4:
        return "DISCHARGE"
    return "IDLE"


def perfect_foresight_range(
    config: BatteryConfig,
    store: PITDataStore,
    periods: list[SettlementPeriod],
) -> tuple[OptimisationInputs, list[float]] | None:
    """Optimiser inputs built from the realised price path (benchmark only).

    Returns ``None`` when any period of the range lacks an outturn (e.g. live).
    """
    rows: list[PeriodInput] = []
    prices: list[float] = []
    for per in periods:
        obs = store.outturn("wholesale_price", per.settlement_date, per.settlement_period)
        if obs is None:
            return None
        prices.append(obs.value)
        rows.append(
            PeriodInput(
                settlement_date=per.settlement_date,
                settlement_period=per.settlement_period,
                start_utc=per.start_utc,
                end_utc=per.end_utc,
                duration_hours=per.duration_hours,
                wholesale_price=obs.value,
                wholesale_price_kind="observed",
            )
        )
    return OptimisationInputs(periods=rows, revenue_streams=WHOLESALE_ONLY), prices


__all__ = [
    "EXECUTION_ASSUMPTION",
    "DecisionRecord",
    "ProposedPeriod",
    "Provenance",
    "ReplayEngine",
    "ReplayOptions",
    "inputs_from_vintage",
    "perfect_foresight_range",
]
