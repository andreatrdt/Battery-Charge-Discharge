"""Forecast-validation: benchmarks, metrics, strategy-P&L cap and PIT safety."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from gb_battery.api.main import app
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.pit import store_from_sample
from gb_battery.replay.validation import (
    PRICE_BENCHMARKS,
    BenchmarkForecaster,
    validate_price_forecasts,
)
from gb_battery.settlement import settlement_periods_for_day

client = TestClient(app)


@pytest.fixture(scope="module")
def sample_store():
    return store_from_sample()


def test_all_models_get_statistical_metrics(sample_store) -> None:
    store, day = sample_store
    r = validate_price_forecasts(
        store, day, models=PRICE_BENCHMARKS, config=BatteryConfig(), with_strategy_pnl=False
    )
    got = {row["model"] for row in r["table"]}
    assert got == set(PRICE_BENCHMARKS)
    for row in r["table"]:
        assert row["mae"] >= 0
        assert "rmse" in row and "bias" in row


def test_strategy_pnl_is_capped(sample_store) -> None:
    store, day = sample_store
    r = validate_price_forecasts(
        store, day, models=PRICE_BENCHMARKS, config=BatteryConfig(),
        with_strategy_pnl=True, max_strategy_models=2,
    )
    with_pnl = [row["model"] for row in r["table"] if row["strategy_pnl_gbp"] is not None]
    assert len(with_pnl) == 2
    assert "internal_model" in with_pnl  # internal is always included first
    assert set(r["strategy_pnl_models"]) == set(with_pnl)


def test_benchmark_points_match_documented_rules_and_are_pit(sample_store) -> None:
    store, day = sample_store
    periods = settlement_periods_for_day(day)
    gate = periods[0].start_utc
    fc = BenchmarkForecaster("lag_same_sp_1d")
    vintage = fc.forecast(store, gate, periods)
    # Every input the benchmark used predates the gate (PIT guarantee).
    assert vintage.basis_max_published_at is not None
    assert vintage.basis_max_published_at <= gate
    # Where yesterday's same-SP outturn was published before the gate, the lag
    # benchmark equals it exactly.
    checked = 0
    for row in vintage.rows:
        prev = store.outturn("wholesale_price", day - timedelta(days=1), row.settlement_period)
        if prev is not None and prev.published_at <= gate:
            assert row.point == pytest.approx(prev.value, abs=0.01)
            checked += 1
    assert checked >= 30


def test_internal_model_reports_probabilistic(sample_store) -> None:
    store, day = sample_store
    r = validate_price_forecasts(
        store, day, models=["persistence", "internal_model"], config=BatteryConfig(),
        with_strategy_pnl=False,
    )
    internal = next(row for row in r["table"] if row["model"] == "internal_model")
    assert "probabilistic" in internal
    assert 0 <= internal["probabilistic"]["coverage_q10_q90_pct"] <= 100
    # Benchmarks do not carry probabilistic scores.
    persistence = next(row for row in r["table"] if row["model"] == "persistence")
    assert "probabilistic" not in persistence


def test_fundamentals_validation_present(sample_store) -> None:
    store, day = sample_store
    r = validate_price_forecasts(store, day, models=["internal_model"], config=BatteryConfig(), with_strategy_pnl=False)
    assert r["variable"] == "wholesale_price"


def test_validation_endpoint_returns_200_within_proxy_budget() -> None:
    """The full six-model request must succeed (it previously exceeded the dev
    proxy's 30 s timeout and surfaced as a 500)."""
    import time

    t = time.time()
    resp = client.post(
        "/api/validation/forecast",
        json={
            "source": "sample",
            "day": "2025-01-15",
            "n_days": 1,
            "models": PRICE_BENCHMARKS,
            "with_strategy_pnl": True,
        },
    )
    elapsed = time.time() - t
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["price"]["table"]) == len(PRICE_BENCHMARKS)
    # Generous ceiling for CI; locally this is ~22 s and must stay well under the
    # 30 s dev-proxy limit that caused the original 500.
    assert elapsed < 29.0, f"validation took {elapsed:.1f}s (dev proxy limit is 30s)"


def test_unknown_model_rejected() -> None:
    resp = client.post(
        "/api/validation/forecast",
        json={"source": "sample", "day": "2025-01-15", "models": ["nonsense"]},
    )
    assert resp.status_code == 400
