"""Automatic step resumption, per-session locking and 409 (not 500) semantics.

The automatic ``/replay/step`` workflow must drive the current gate forward from
*any* valid state: a cancelled or timed-out request used to leave the session
stranded mid-gate, after which every later step raised
``Cannot recommend from state ...`` and surfaced as HTTP 500.
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from gb_battery.api.main import app
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.decision_state import SessionState, TraderLoopError
from gb_battery.replay.engine import MAX_AUTOMATIC_TRANSITIONS, ReplayEngine, ReplayOptions
from gb_battery.replay.session import REGISTRY

client = TestClient(app)
DAY = date(2025, 2, 10)


def _engine() -> ReplayEngine:
    return ReplayEngine(
        BatteryConfig(), DAY,
        ReplayOptions(source="synthetic", history_days=7, horizon_hours=24),
    )


def _accept(e: ReplayEngine):
    return e.submit_trader_instruction("ACCEPT_RECOMMENDATION", source="automatic_policy")


def _drive_to(state: SessionState) -> ReplayEngine:
    """Return an engine parked in ``state`` with a part-resolved gate."""
    e = _engine()
    if state is SessionState.READY_FOR_RECOMMENDATION:
        return e
    e.recommend()
    if state is SessionState.AWAITING_TRADER_DECISION:
        return e
    _accept(e)
    if state is SessionState.AWAITING_EXECUTION:
        return e
    e.apply_execution()
    if state is SessionState.AWAITING_STATE_CONFIRMATION:
        return e
    e.confirm_state(soc_source="executed_action_estimate")
    if state is SessionState.READY_FOR_NEXT_PERIOD:
        return e
    raise AssertionError(f"unsupported target state {state}")


RESUMABLE = [
    SessionState.READY_FOR_RECOMMENDATION,
    SessionState.AWAITING_TRADER_DECISION,
    SessionState.AWAITING_EXECUTION,
    SessionState.AWAITING_STATE_CONFIRMATION,
    SessionState.READY_FOR_NEXT_PERIOD,
]


# ------------------------------------------------------------------ engine

@pytest.mark.parametrize("state", RESUMABLE, ids=lambda s: s.value)
def test_step_resumes_and_commits_exactly_one_period(state):
    eng = _drive_to(state)
    assert eng.state is state
    before = len(eng.decisions)
    record = eng.step()
    assert record is not None
    assert len(eng.decisions) - before == 1, "a step must commit exactly one Settlement Period"
    assert eng.state in (SessionState.READY_FOR_RECOMMENDATION, SessionState.COMPLETE)


@pytest.mark.parametrize("state", RESUMABLE, ids=lambda s: s.value)
def test_step_never_duplicates_decisions(state):
    eng = _drive_to(state)
    eng.step()
    eng.step()
    keys = [(d.settlement_date, d.settlement_period) for d in eng.decisions]
    assert len(keys) == len(set(keys)), "no Settlement Period may be committed twice"
    assert [d.step for d in eng.decisions] == list(range(len(eng.decisions)))


def test_step_from_complete_returns_none():
    eng = _engine()
    eng.run()
    assert eng.state is SessionState.COMPLETE
    n = len(eng.decisions)
    assert eng.step() is None
    assert len(eng.decisions) == n


def test_next_optimisation_starts_from_confirmed_soc():
    eng = _drive_to(SessionState.AWAITING_EXECUTION)
    record = eng.step()
    assert record is not None
    assert eng.soc == pytest.approx(record.soc_after_mwh, abs=1e-6)
    assert record.physical_state is not None
    assert eng.soc == pytest.approx(record.physical_state.confirmed_soc_after_mwh, abs=1e-6)


def test_resumption_preserves_the_existing_immutable_records():
    """Resuming must not re-issue the recommendation already produced."""
    eng = _drive_to(SessionState.AWAITING_EXECUTION)
    pending = eng._pending  # noqa: SLF001 — asserting immutability of staged records
    rec_before = pending.recommendation
    instr_before = pending.instruction
    record = eng.step()
    assert record is not None
    assert record.recommendation == rec_before
    assert record.trader_instruction == instr_before
    # The automatic path must stay attributable to the policy, not a human.
    assert record.trader_instruction.source == "automatic_policy"


def test_transition_guard_is_bounded():
    # Longest legitimate resume path uses 5 transitions; the guard allows 6.
    assert MAX_AUTOMATIC_TRANSITIONS >= 5


# --------------------------------------------------------------------- API

def _start(source: str = "synthetic") -> str:
    r = client.post(
        "/api/replay/start",
        json={"day": DAY.isoformat(), "source": source, "horizon_hours": 24, "n_days": 1},
    )
    assert r.status_code == 200, r.text
    return r.json()["replay_id"]


def test_step_endpoint_returns_200_and_one_decision():
    rid = _start()
    r = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
    assert r.status_code == 200, r.text
    assert len(r.json()["new_decisions"]) == 1


@pytest.mark.parametrize("state", RESUMABLE, ids=lambda s: s.value)
def test_step_endpoint_resumes_from_any_pending_state(state):
    rid = _start()
    session = REGISTRY.get(rid)
    assert session is not None
    # Park the live session in the target state, then step through the API.
    eng = session.engine
    if state is not SessionState.READY_FOR_RECOMMENDATION:
        eng.recommend()
    if state in (
        SessionState.AWAITING_EXECUTION,
        SessionState.AWAITING_STATE_CONFIRMATION,
        SessionState.READY_FOR_NEXT_PERIOD,
    ):
        _accept(eng)
    if state in (SessionState.AWAITING_STATE_CONFIRMATION, SessionState.READY_FOR_NEXT_PERIOD):
        eng.apply_execution()
    if state is SessionState.READY_FOR_NEXT_PERIOD:
        eng.confirm_state(soc_source="executed_action_estimate")
    assert eng.state is state

    r = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
    assert r.status_code == 200, r.text
    assert r.json()["state"] in ("READY_FOR_RECOMMENDATION", "COMPLETE")


def test_sequential_steps_complete_several_periods():
    rid = _start()
    for _ in range(5):
        r = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
        assert r.status_code == 200, r.text
    decisions = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]
    assert len(decisions) == 5
    keys = [(d["settlement_date"], d["settlement_period"]) for d in decisions]
    assert len(keys) == len(set(keys))


def test_concurrent_operation_returns_409_not_500():
    rid = _start()
    session = REGISTRY.get(rid)
    assert session is not None
    assert session.operation_lock.acquire(blocking=False)
    try:
        r = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
        assert r.status_code == 409, r.text
        assert "already in progress" in r.json()["detail"].lower()
    finally:
        session.operation_lock.release()
    # Once released the session works normally again.
    assert client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1}).status_code == 200


def test_separate_sessions_do_not_block_each_other():
    busy, free = _start(), _start()
    busy_session = REGISTRY.get(busy)
    assert busy_session is not None
    assert busy_session.operation_lock.acquire(blocking=False)
    try:
        r = client.post("/api/replay/step", json={"replay_id": free, "n_steps": 1})
        assert r.status_code == 200, r.text
    finally:
        busy_session.operation_lock.release()


def test_trader_loop_error_from_step_is_409_not_500(monkeypatch):
    rid = _start()
    session = REGISTRY.get(rid)
    assert session is not None

    def _boom(*a, **k):
        raise TraderLoopError("Cannot recommend from state AWAITING_EXECUTION; resolve it first.")

    monkeypatch.setattr(session.engine, "run", _boom)
    r = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
    assert r.status_code == 409, r.text
    # The lock must be released even though the operation failed.
    assert session.operation_lock.acquire(blocking=False)
    session.operation_lock.release()


def test_unexpected_error_is_not_masked_as_409(monkeypatch):
    """A genuine defect must stay a 500, never be hidden behind 409."""
    rid = _start()
    session = REGISTRY.get(rid)
    assert session is not None

    def _boom(*a, **k):
        raise RuntimeError("unexpected internal defect")

    monkeypatch.setattr(session.engine, "run", _boom)
    with pytest.raises(RuntimeError):
        client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
    # Still released.
    assert session.operation_lock.acquire(blocking=False)
    session.operation_lock.release()


def test_run_endpoint_still_works():
    rid = _start()
    client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 2})
    r = client.post("/api/replay/run", json={"replay_id": rid})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["complete"] is True
    keys = [(d["settlement_date"], d["settlement_period"]) for d in body["decisions"]]
    assert len(keys) == len(set(keys))


def test_step_after_recovery_and_commercial_still_reconstructable():
    rid = _start(source="sample")
    client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 3})
    before = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]
    imb_before = {
        d["settlement_period"]: (d.get("commercial") or {}).get("commercial_imbalance_mwh")
        for d in before
    }
    assert any(v is not None for v in imb_before.values())

    REGISTRY._sessions.clear()  # noqa: SLF001 — simulate a process restart

    r = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1})
    assert r.status_code == 200, r.text
    after = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]
    assert len(after) == len(before) + 1
    imb_after = {
        d["settlement_period"]: (d.get("commercial") or {}).get("commercial_imbalance_mwh")
        for d in after
    }
    for sp, value in imb_before.items():
        assert imb_after[sp] == value
