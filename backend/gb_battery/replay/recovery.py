"""Rebuild a replay session (including a mid-flight gate) after a restart.

The append-only transition log records the *inputs* of every stage, and each
stage is deterministic given those inputs and the point-in-time store. So a
session is recovered by constructing a fresh engine from the persisted options
and config, then replaying the log stage by stage.

Nothing in the log is mutated: recovery is a pure read plus a deterministic
re-execution. The engine's audit hook is disabled while replaying so recovery
never appends duplicate history.
"""

from __future__ import annotations

from datetime import date, datetime

from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.decision_state import SessionState, TraderLoopError
from gb_battery.replay.engine import ReplayEngine, ReplayOptions
from gb_battery.replay.persistence import ReplayArchive, get_archive


def _parse_dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def recover_engine(
    replay_id: str, archive: ReplayArchive | None = None
) -> tuple[ReplayEngine, dict] | None:
    """Rebuild the engine for ``replay_id`` from storage.

    Returns ``(engine, metadata)`` or ``None`` when the run is unknown or has no
    recoverable metadata. Raises nothing on a corrupt tail: replay stops at the
    last transition that applies cleanly, leaving a consistent state machine.
    """
    archive = archive or get_archive()
    stored = archive.load(replay_id)
    if stored is None or not stored.get("options") or not stored.get("config"):
        return None

    options = ReplayOptions(**stored["options"])
    config = BatteryConfig(**stored["config"])
    day = date.fromisoformat(stored["day"])
    engine = ReplayEngine(config, day, options)
    engine.on_transition = None  # never re-append while replaying history

    transitions = archive.load_transitions(replay_id)
    applied = 0
    for t in transitions:
        data = t.get("data") or {}
        kind = t.get("transition")
        try:
            if kind == "RECOMMENDATION":
                engine.recommend(now=_parse_dt(data.get("now")))
            elif kind == "TRADER_INSTRUCTION":
                engine.submit_trader_instruction(
                    data["decision"],
                    charge_mw=data.get("charge_mw", 0.0),
                    discharge_mw=data.get("discharge_mw", 0.0),
                    reason=data.get("reason"),
                    actor=data.get("actor"),
                    source=data.get("source", "manual_ui"),
                    at=_parse_dt(data.get("at")),
                )
            elif kind == "EXECUTION":
                engine.apply_execution(execution_source=data.get("execution_source"))
            elif kind == "PHYSICAL_STATE_CONFIRMATION":
                engine.confirm_state(
                    executed_charge_mw=data.get("executed_charge_mw"),
                    executed_discharge_mw=data.get("executed_discharge_mw"),
                    confirmed_soc_after_mwh=data.get("confirmed_soc_after_mwh"),
                    soc_source=data.get("soc_source", "executed_action_estimate"),
                    execution_source=data.get("execution_source"),
                    at=_parse_dt(data.get("at")),
                )
            elif kind == "ADVANCE":
                engine.advance()
            else:  # unknown transition kind — skip rather than fail the recovery
                continue
            applied += 1
        except (TraderLoopError, KeyError, TypeError, ValueError):
            # A truncated or inconsistent tail (e.g. the process died mid-write)
            # leaves the machine at the last clean state; stop replaying there.
            break

    metadata = {
        "replay_id": replay_id,
        "mode": stored.get("mode", "historical"),
        "created_at": stored.get("created_at"),
        "recovered": True,
        "transitions_in_log": len(transitions),
        "transitions_applied": applied,
        "recovered_state": engine.state.value,
        "committed_decisions": len(engine.decisions),
    }
    return engine, metadata


def is_recoverable(replay_id: str, archive: ReplayArchive | None = None) -> bool:
    archive = archive or get_archive()
    stored = archive.load(replay_id)
    return bool(stored and stored.get("options") and stored.get("config"))


__all__ = ["SessionState", "is_recoverable", "recover_engine"]
