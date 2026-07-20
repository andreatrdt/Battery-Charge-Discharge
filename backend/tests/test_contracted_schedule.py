"""Immutable contracted schedule and paper Commercial Imbalance reconstruction."""

from __future__ import annotations

from datetime import date

import pytest
from gb_battery.battery.config import BatteryConfig
from gb_battery.market.balance import metered_net_export_from_soc
from gb_battery.replay.engine import ReplayEngine, ReplayOptions

DAY = date(2025, 2, 10)


def _engine(**opts):
    options = ReplayOptions(source="synthetic", history_days=7, horizon_hours=24, **opts)
    return ReplayEngine(BatteryConfig(), DAY, options)


def test_contracted_schedule_frozen_and_immutable():
    eng = _engine()
    eng._ensure_contracted()
    snapshot = dict(eng._contracted or {})
    assert snapshot, "expected a frozen day-ahead contracted schedule"
    assert eng._contracted_provenance == "paper_day_ahead_plan"
    # Running the whole session (recommend/instruct/execute/confirm) must never
    # overwrite the contracted schedule.
    eng.run(max_steps=12)
    assert dict(eng._contracted or {}) == snapshot


def test_commercial_imbalance_equals_metered_minus_contracted():
    eng = _engine()
    eng.run(max_steps=10)
    committed = [d for d in eng.decisions if d.commercial and d.commercial.status == "paper"]
    assert committed, "expected paper commercial positions"
    for d in committed:
        c = d.commercial
        assert c.commercial_imbalance_mwh == pytest.approx(
            c.confirmed_metered_net_export_mwh - c.contracted_net_export_mwh, abs=1e-6
        )
        # Metered net export must come from the confirmed SoC change, not the
        # instruction or recommendation.
        expected_metered = metered_net_export_from_soc(
            d.soc_before_mwh, d.soc_after_mwh,
            eng.config.charge_efficiency, eng.config.discharge_efficiency,
        )
        assert c.confirmed_metered_net_export_mwh == pytest.approx(expected_metered, abs=1e-3)


def test_user_supplied_contracted_takes_priority():
    periods = __import__(
        "gb_battery.settlement", fromlist=["settlement_periods_for_day"]
    ).settlement_periods_for_day(DAY)
    key = f"{DAY.isoformat()}|{periods[0].settlement_period}"
    eng = _engine(contracted_net_export={key: 42.0})
    eng._ensure_contracted()
    assert eng._contracted_provenance == "user_supplied"
    assert eng.contracted_net_export_for(periods[0]) == 42.0


def test_recommendation_does_not_become_contracted():
    eng = _engine()
    eng.run(max_steps=6)
    for d in eng.decisions:
        if d.commercial and d.commercial.status == "paper":
            # The contracted value is the frozen day-ahead plan, not the model
            # recommendation for that period.
            assert d.commercial.contracted_net_export_mwh is not None
            # They *may* coincide by chance, but the provenance proves the source.
            assert "contracted=paper_day_ahead_plan" in d.commercial.assumption_flags


def test_commercial_imbalance_reconstructed_after_restart():
    from fastapi.testclient import TestClient
    from gb_battery.api.main import app
    from gb_battery.replay.session import REGISTRY

    client = TestClient(app)
    rid = client.post(
        "/api/replay/start", json={"day": "2025-01-20", "source": "sample", "horizon_hours": 24}
    ).json()["replay_id"]
    client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 4})

    def _comm(rid):
        ds = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]
        return {
            d["settlement_period"]: (d.get("commercial") or {}).get("commercial_imbalance_mwh")
            for d in ds
        }

    before = _comm(rid)
    assert any(v is not None for v in before.values())
    REGISTRY._sessions.clear()  # noqa: SLF001 — simulate a process restart
    after = _comm(rid)
    assert after == before
