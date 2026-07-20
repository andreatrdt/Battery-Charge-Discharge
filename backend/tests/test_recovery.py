"""Durable audit trail: append-only transitions and mid-flight session recovery."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from gb_battery.api.main import app
from gb_battery.replay.persistence import get_archive
from gb_battery.replay.session import REGISTRY

client = TestClient(app)


def _simulate_restart() -> None:
    """Drop every in-memory session, as a process restart would."""
    REGISTRY._sessions.clear()  # noqa: SLF001 — deliberate test of restart behaviour


def _start_manual(day: str = "2025-01-20") -> str:
    r = client.post(
        "/api/replay/start", json={"day": day, "source": "sample", "horizon_hours": 24}
    )
    assert r.status_code == 200
    return r.json()["replay_id"]


def test_every_stage_is_appended_to_the_audit_log() -> None:
    rid = _start_manual()
    client.post("/api/replay/recommend", json={"replay_id": rid})
    client.post(
        "/api/replay/trader-decision",
        json={"replay_id": rid, "decision": "MODIFY", "charge_mw": 10, "reason": "why not"},
    )
    client.post("/api/replay/execute", json={"replay_id": rid})
    client.post("/api/replay/confirm-state", json={"replay_id": rid})
    client.post("/api/replay/advance", json={"replay_id": rid})

    log = get_archive().load_transitions(rid)
    kinds = [t["transition"] for t in log]
    assert kinds == [
        "RECOMMENDATION",
        "TRADER_INSTRUCTION",
        "EXECUTION",
        "PHYSICAL_STATE_CONFIRMATION",
        "ADVANCE",
    ]
    # Monotonic, gap-free sequence numbers.
    assert [t["seq"] for t in log] == list(range(len(log)))
    # The trader's own words are preserved verbatim.
    instr = next(t for t in log if t["transition"] == "TRADER_INSTRUCTION")
    assert instr["data"]["decision"] == "MODIFY"
    assert instr["data"]["reason"] == "why not"
    # The confirmation records that a schedule was superseded at this gate.
    conf = next(t for t in log if t["transition"] == "PHYSICAL_STATE_CONFIRMATION")
    assert conf["data"]["superseded_schedule_periods"] > 0


def test_audit_log_is_append_only_never_rewritten() -> None:
    rid = _start_manual()
    client.post("/api/replay/recommend", json={"replay_id": rid})
    first = get_archive().load_transitions(rid)
    client.post("/api/replay/trader-decision", json={"replay_id": rid, "decision": "REJECT_TO_IDLE"})
    client.post("/api/replay/execute", json={"replay_id": rid})
    client.post("/api/replay/confirm-state", json={"replay_id": rid})
    later = get_archive().load_transitions(rid)
    # Earlier rows are byte-identical after later activity; only rows are added.
    assert len(later) > len(first)
    assert later[: len(first)] == first


def test_midflight_session_recovers_after_restart() -> None:
    """A session paused between execution and confirmation survives a restart."""
    rid = _start_manual()
    client.post("/api/replay/recommend", json={"replay_id": rid})
    client.post(
        "/api/replay/trader-decision",
        json={"replay_id": rid, "decision": "MODIFY", "charge_mw": 25, "reason": "mid-flight"},
    )
    before = client.post("/api/replay/execute", json={"replay_id": rid}).json()
    assert before["state"] == "AWAITING_STATE_CONFIRMATION"

    _simulate_restart()

    after = client.get(f"/api/replay/{rid}")
    assert after.status_code == 200
    body = after.json()
    assert body["archived"] is False  # a live, resumable session — not a snapshot
    assert body["state"] == "AWAITING_STATE_CONFIRMATION"  # exact state preserved
    assert body["soc_mwh"] == pytest.approx(before["soc_mwh"])
    assert body["step_index"] == before["step_index"]
    assert any("recovered after restart" in w.lower() for w in body["warnings"])


def test_recovered_session_is_still_usable_and_preserves_history() -> None:
    rid = _start_manual()
    client.post("/api/replay/recommend", json={"replay_id": rid})
    client.post(
        "/api/replay/trader-decision",
        json={"replay_id": rid, "decision": "MODIFY", "charge_mw": 25, "reason": "keep me"},
    )
    client.post("/api/replay/execute", json={"replay_id": rid})

    _simulate_restart()

    # The gate can still be completed after recovery.
    r = client.post(
        "/api/replay/confirm-state",
        json={"replay_id": rid, "confirmed_soc_after_mwh": 66.0, "soc_source": "telemetry"},
    )
    assert r.status_code == 200
    d = r.json()["decision"]
    # The pre-restart recommendation, instruction and schedule are intact.
    assert d["recommendation"] is not None
    assert d["trader_instruction"]["decision"] == "MODIFY"
    assert d["trader_instruction"]["reason"] == "keep me"
    assert len(d["proposed_schedule"]) > 0  # superseded schedule preserved
    assert d["physical_state"]["confirmed_soc_after_mwh"] == pytest.approx(66.0)
    # And the confirmed SoC drives the next gate.
    adv = client.post("/api/replay/advance", json={"replay_id": rid})
    assert adv.json()["soc_mwh"] == pytest.approx(66.0)
    assert adv.json()["state"] == "READY_FOR_RECOMMENDATION"


def test_recovery_reproduces_committed_decisions_exactly() -> None:
    """Replaying the log yields the same committed decisions as before restart."""
    rid = _start_manual()
    for _ in range(2):
        client.post("/api/replay/recommend", json={"replay_id": rid})
        client.post("/api/replay/trader-decision", json={"replay_id": rid, "decision": "ACCEPT_RECOMMENDATION"})
        client.post("/api/replay/execute", json={"replay_id": rid})
        client.post("/api/replay/confirm-state", json={"replay_id": rid})
        client.post("/api/replay/advance", json={"replay_id": rid})
    before = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]

    _simulate_restart()

    after = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]
    assert len(after) == len(before) == 2
    for a, b in zip(before, after, strict=True):
        assert a["settlement_period"] == b["settlement_period"]
        assert a["charge_mw"] == pytest.approx(b["charge_mw"])
        assert a["discharge_mw"] == pytest.approx(b["discharge_mw"])
        assert a["soc_after_mwh"] == pytest.approx(b["soc_after_mwh"])
        assert a["realised_pnl_gbp"] == pytest.approx(b["realised_pnl_gbp"])


def test_completed_automatic_run_still_archives_read_only() -> None:
    """Backwards compatibility: finished runs remain served from the archive."""
    r = client.post(
        "/api/replay/start",
        json={"day": "2025-01-21", "source": "sample", "auto_run": True, "horizon_hours": 24},
    )
    rid = r.json()["replay_id"]
    assert r.json()["complete"] is True

    _simulate_restart()

    after = client.get(f"/api/replay/{rid}")
    assert after.status_code == 200
    assert after.json()["complete"] is True
    assert len(client.get(f"/api/replay/{rid}/decisions").json()["decisions"]) == 48


def test_unknown_replay_still_404s() -> None:
    assert client.get("/api/replay/doesnotexist").status_code == 404


def test_archive_degrades_gracefully_when_db_cannot_be_opened(tmp_path) -> None:
    """A locked/unopenable DuckDB must disable persistence, not raise.

    DuckDB allows one writer process per file, so a second backend (or a
    concurrently running test suite) can legitimately fail to open it. That must
    never turn every replay endpoint into a 500.
    """
    from gb_battery.data.settings import DataSettings
    from gb_battery.replay.persistence import ReplayArchive

    bad_dir = tmp_path / "cache"
    bad_dir.mkdir()
    # A directory where the database file should be makes opening impossible.
    (bad_dir / "replays.duckdb").mkdir()

    archive = ReplayArchive(DataSettings(cache_dir=bad_dir))
    assert archive.available is False
    assert archive.unavailable_reason and "persistence is disabled" in archive.unavailable_reason.lower()
    # Every operation degrades to a safe no-op instead of raising.
    assert archive.append_transition("x", "RECOMMENDATION", 0, {}) == -1
    assert archive.load_transitions("x") == []
    assert archive.load("x") is None
    assert archive.list_runs() == []
    assert (
        archive.save(
            replay_id="x", created_at=datetime.now(tz=UTC), mode="historical", day="2025-01-20",
            n_days=1, complete=False, options={}, config={}, versions={}, summary={},
            decisions=[], vintages=[],
        )
        is False
    )
    archive.update_metrics("x", {"a": 1})  # must not raise


def test_replay_still_works_when_persistence_is_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """Replays keep running (in memory) and say so when the archive is down."""
    from gb_battery.data.settings import DataSettings
    from gb_battery.replay import persistence
    from gb_battery.replay.persistence import ReplayArchive

    bad_dir = tmp_path / "cache2"
    bad_dir.mkdir()
    (bad_dir / "replays.duckdb").mkdir()
    disabled = ReplayArchive(DataSettings(cache_dir=bad_dir))
    monkeypatch.setattr(persistence, "_archive", disabled)

    r = client.post(
        "/api/replay/start", json={"day": "2025-01-20", "source": "sample", "horizon_hours": 24}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["persistence_available"] is False
    assert any("persistence is disabled" in w.lower() for w in body["warnings"])
    # And the session is still fully usable in memory.
    rid = body["replay_id"]
    assert client.post("/api/replay/recommend", json={"replay_id": rid}).status_code == 200
