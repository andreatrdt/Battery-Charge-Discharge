"""Integration matrix: every source-aware page/API flow across the source enum.

The two guarantees this file exists to enforce:

1. ``synthetic`` and ``sample`` **never** touch the network. Any attempt to reach
   Elexon raises loudly (the HTTP layer is monkeypatched to fail the test).
2. An unsupported source/flow combination fails **explicitly** — no silent
   substitution of synthetic data, and the response names the actual source.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from gb_battery.api.main import app

client = TestClient(app)

OFFLINE_SOURCES = ["synthetic", "sample"]
ALL_SOURCES = ["synthetic", "sample", "elexon"]


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch):
    """Make any outbound Elexon HTTP call an immediate, obvious failure."""
    calls: list[str] = []

    def _boom(self, url, params=None, **kwargs):  # noqa: ANN001, ARG001
        calls.append(url)
        raise AssertionError(f"Network access attempted for an offline source: {url}")

    monkeypatch.setattr("gb_battery.data.http.ResilientClient.get_json", _boom)
    return calls


# ------------------------------------------------------------------ Market


@pytest.mark.parametrize("source", OFFLINE_SOURCES)
def test_market_offline_sources_never_call_elexon(source: str, no_network) -> None:
    r = client.get("/api/market/snapshot", params={"day": "2025-01-15", "source": source})
    assert r.status_code == 200
    prov = r.json()["provenance"]
    assert prov["requested_source"] == source
    assert prov["actual_source"] == source  # no substitution
    assert prov["network_used"] is False
    assert no_network == []


def test_market_elexon_cache_only_makes_no_network_call(no_network) -> None:
    """cache_only must not hit the network even for the elexon source."""
    r = client.get(
        "/api/market/snapshot",
        params={"day": "1991-01-01", "source": "elexon", "network_policy": "cache_only"},
    )
    # No cached data for that day → explicit upstream failure, never synthetic.
    assert r.status_code == 502
    assert r.json()["detail"]["requested_source"] == "elexon"
    assert no_network == []


# ---------------------------------------------------------------- Backtest


@pytest.mark.parametrize("source", OFFLINE_SOURCES)
def test_backtest_supported_offline_sources(source: str, no_network) -> None:
    r = client.post("/api/backtest", json={"days": 3, "source": source})
    assert r.status_code == 200
    prov = r.json()["provenance"]
    assert prov["requested_source"] == source
    assert prov["actual_source"] == source
    assert prov["network_used"] is False and prov["cache_used"] is False
    assert prov["actual_data_day_start"] and prov["actual_data_day_end"]
    assert no_network == []


def test_backtest_elexon_is_explicitly_unsupported_not_substituted(no_network) -> None:
    r = client.post("/api/backtest", json={"days": 3, "source": "elexon"})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["status"] == "unsupported_source"
    assert d["requested_source"] == "elexon"
    assert d["actual_source"] is None  # nothing was produced
    assert set(d["supported_sources"]) == {"synthetic", "sample"}
    assert "no data was substituted" in " ".join(d["warnings"]).lower()
    assert no_network == []


# ------------------------------------------------------------------ Replay


@pytest.mark.parametrize("source", OFFLINE_SOURCES)
def test_replay_offline_sources_never_call_elexon(source: str, no_network) -> None:
    r = client.post(
        "/api/replay/start",
        json={"day": "2025-01-20", "source": source, "horizon_hours": 24},
    )
    assert r.status_code == 200
    assert r.json()["options"]["source"] == source
    rid = r.json()["replay_id"]
    assert client.post("/api/replay/step", json={"replay_id": rid, "n_steps": 1}).status_code == 200
    assert no_network == []


def test_replay_rejects_elexon_for_today() -> None:
    from datetime import date

    r = client.post(
        "/api/replay/start", json={"day": date.today().isoformat(), "source": "elexon"}
    )
    assert r.status_code == 400  # explicit; use live paper trading instead


# -------------------------------------------------------------- Validation


@pytest.mark.parametrize("source", OFFLINE_SOURCES)
def test_validation_offline_sources_never_call_elexon(source: str, no_network) -> None:
    r = client.post(
        "/api/validation/forecast",
        json={
            "source": source,
            "day": "2025-01-15",
            "models": ["persistence", "internal_model"],
            "with_strategy_pnl": False,
        },
    )
    assert r.status_code == 200
    assert r.json()["source"] == source
    assert no_network == []


def test_validation_discloses_capped_strategy_models() -> None:
    """The economic diagnostic must name exactly which models it replayed."""
    r = client.post(
        "/api/validation/forecast",
        json={
            "source": "sample",
            "day": "2025-01-15",
            "models": ["persistence", "lag_same_sp_1d", "rolling_median_7d", "internal_model"],
            "with_strategy_pnl": True,
        },
    )
    assert r.status_code == 200
    price = r.json()["price"]
    replayed = price["strategy_pnl_models"]
    assert 0 < len(replayed) < len(price["table"])  # genuinely capped
    assert "internal_model" in replayed
    # Statistical metrics exist for EVERY model; strategy P&L only for the capped set.
    for row in price["table"]:
        assert row["mae"] >= 0
        if row["model"] in replayed:
            assert row["strategy_pnl_gbp"] is not None
        else:
            assert row["strategy_pnl_gbp"] is None
    note = price["framing_note"].lower()
    assert "at most" in note and "day range" in note


# ------------------------------------------------------ Terminal / Schedule


@pytest.mark.parametrize("source", OFFLINE_SOURCES)
def test_optimise_offline_sources_never_call_elexon(source: str, no_network) -> None:
    """Terminal and Schedule both drive /api/optimise with the global source."""
    r = client.post("/api/optimise", json={"day": "2025-01-15", "source": source})
    assert r.status_code == 200
    assert r.json()["source"] == source
    assert no_network == []


def test_optimise_rejects_unknown_source() -> None:
    r = client.post("/api/optimise", json={"day": "2025-01-15", "source": "bogus"})
    assert r.status_code == 400


# ------------------------------------------------------------------- Data


@pytest.mark.parametrize("source", ALL_SOURCES)
def test_data_page_snapshot_reports_requested_and_actual_source(source: str) -> None:
    """The Data page reads /api/market/snapshot for the global source."""
    r = client.get(
        "/api/market/snapshot",
        params={"day": "2025-01-15", "source": source, "network_policy": "cache_only"},
    )
    if r.status_code == 200:
        prov = r.json()["provenance"]
        assert prov["requested_source"] == source
        # Whatever happens, the response never claims a different source silently.
        assert prov["actual_source"] == source
    else:
        # Elexon with no cache: an explicit failure naming the requested source.
        assert r.status_code == 502
        assert r.json()["detail"]["requested_source"] == source


def test_bundled_sample_endpoint_is_labelled_synthetic() -> None:
    r = client.get("/api/data/sample", params={"limit": 4})
    assert r.status_code == 200
    assert "synthetic" in r.json()["note"].lower()
