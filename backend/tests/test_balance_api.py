"""`/api/market/balance` combined-snapshot API tests (partial responses)."""

from __future__ import annotations

import math

from fastapi.testclient import TestClient
from gb_battery.api.main import app

client = TestClient(app)


def _get(**params):
    r = client.get("/api/market/balance", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_synthetic_system_and_frequency_available_commercial_unavailable():
    b = _get(day="2025-01-15", settlement_period=30, source="synthetic")
    assert b["system"] is not None
    assert b["system"]["direction"] in {"GB SYSTEM LONG", "GB SYSTEM SHORT", "BALANCED"}
    assert b["frequency"]["latest_frequency_hz"] is not None
    # No session -> commercial explicitly unavailable, not fabricated.
    assert b["commercial"]["status"] == "unavailable"
    assert b["commercial"]["commercial_imbalance_mwh"] is None


def test_provenance_and_source_fields():
    b = _get(day="2025-01-15", settlement_period=1, source="sample")
    ctx = b["context"]
    assert ctx["requested_source"] == "sample"
    assert ctx["actual_source"] == "sample"
    assert ctx["network_used"] is False
    assert ctx["cache_used"] is False
    assert b["system"]["provenance"] == "sample"


def test_commercial_available_from_session():
    s = client.post(
        "/api/replay/start",
        json={"day": "2025-01-15", "source": "synthetic", "horizon_hours": 24, "n_days": 1},
    ).json()
    rid = s["replay_id"]
    st = client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 5}).json()
    day = st["day"]
    dec = client.get(f"/api/replay/{rid}/decisions").json()["decisions"]
    sp = dec[2]["settlement_period"]
    b = _get(day=day, settlement_period=sp, source="synthetic", replay_session_id=rid)
    assert b["commercial"]["status"] == "paper"
    assert b["commercial"]["contracted_net_export_mwh"] is not None
    assert b["commercial"]["confirmed_metered_net_export_mwh"] is not None
    assert b["commercial"]["direction"] in {"LONG", "SHORT", "BALANCED"}
    # Cashflow is filled from the system price when both are present.
    if b["system"]["system_price_gbp_per_mwh"] is not None:
        assert b["commercial"]["indicative_imbalance_cashflow_gbp"] is not None
    assert b["battery"]["soc_mwh"] is not None


def test_partial_system_only_when_no_session():
    b = _get(day="2025-01-15", settlement_period=10, source="synthetic")
    assert b["system"] is not None
    assert b["commercial"]["status"] == "unavailable"


def test_json_safe_no_nan_or_inf():
    b = _get(day="2025-01-15", settlement_period=20, source="synthetic")

    def _check(obj):
        if isinstance(obj, float):
            assert math.isfinite(obj)
        elif isinstance(obj, dict):
            for v in obj.values():
                _check(v)
        elif isinstance(obj, list):
            for v in obj:
                _check(v)

    _check(b)


def test_unknown_source_rejected():
    r = client.get("/api/market/balance", params={"source": "nonsense"})
    assert r.status_code == 400


def test_unknown_session_commercial_unavailable_not_500():
    b = _get(
        day="2025-01-15",
        settlement_period=5,
        source="synthetic",
        replay_session_id="deadbeefdead",
    )
    assert b["commercial"]["status"] == "unavailable"
