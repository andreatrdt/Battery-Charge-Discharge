"""Continuation value: explicit reporting and decision impact."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.continuation import estimate_continuation
from gb_battery.replay.engine import ReplayEngine, ReplayOptions
from gb_battery.replay.forecaster import PITForecaster
from gb_battery.replay.pit import PITDataStore, store_from_synthetic
from gb_battery.replay.records import ForecastRecord, Provenance
from gb_battery.settlement import settlement_periods_for_day

DAY = date(2025, 6, 2)


def _store_with_future_forecasts(value: float) -> PITDataStore:
    """Forecasts for DAY and DAY+1 at price ``value``, published 2 days ahead.

    Published early on purpose: at DAY's first gate a strictly day-ahead
    publication for DAY+1 would (correctly!) not be visible yet — that
    behaviour is itself asserted in the fallback test below.
    """
    store = PITDataStore()
    recs = []
    for offset in (0, 1):
        d = DAY + timedelta(days=offset)
        for per in settlement_periods_for_day(d):
            pub = per.start_utc - timedelta(days=2)
            recs.append(
                ForecastRecord(
                    variable="wholesale_price",
                    settlement_date=d,
                    settlement_period=per.settlement_period,
                    start_utc=per.start_utc,
                    value=value,
                    issued_at=pub,
                    published_at=pub,
                    source="test.day_ahead",
                    provenance=Provenance.PUBLISHED_FORECAST,
                )
            )
    store.add_forecasts(recs)
    return store


def test_config_override_always_wins() -> None:
    store = _store_with_future_forecasts(80.0)
    periods = settlement_periods_for_day(DAY)
    est = estimate_continuation(
        store,
        periods[0].start_utc,
        periods[-1].end_utc,
        discharge_efficiency=0.9,
        forecaster=PITForecaster(),
        config_override=12.5,
    )
    assert est.method == "config_override"
    assert est.gbp_per_mwh == 12.5


def test_beyond_horizon_value_uses_top_quartile_and_efficiency() -> None:
    store = _store_with_future_forecasts(100.0)
    periods = settlement_periods_for_day(DAY)
    est = estimate_continuation(
        store,
        periods[0].start_utc,
        periods[-1].end_utc,  # window = DAY+1, all forecasts = 100
        discharge_efficiency=0.9,
        forecaster=PITForecaster(),
        config_override=None,
    )
    assert est.method == "beyond_horizon_top_quartile"
    assert est.expected_future_discharge_value == pytest.approx(100.0)
    assert est.gbp_per_mwh == pytest.approx(90.0)  # η_d-adjusted
    assert est.n_window_points >= 8
    assert est.window_start_utc is not None


def test_no_future_data_falls_back_with_warning() -> None:
    est = estimate_continuation(
        PITDataStore(),
        settlement_periods_for_day(DAY)[0].start_utc,
        settlement_periods_for_day(DAY)[-1].end_utc,
        discharge_efficiency=0.9,
        forecaster=PITForecaster(),
        config_override=None,
        horizon_forecast_points=None,
    )
    assert est.method == "none"
    assert est.gbp_per_mwh == 0.0
    assert est.warning is not None


def test_decisions_report_continuation_separately() -> None:
    eng = ReplayEngine(
        BatteryConfig(),
        date(2025, 2, 10),
        ReplayOptions(source="synthetic", horizon_hours=24, history_days=7),
    )
    eng.run(max_steps=3)
    for d in eng.decisions:
        assert d.continuation_method in {
            "beyond_horizon_top_quartile",
            "horizon_median",
            "config_override",
            "none",
        }
        assert d.continuation_gbp_per_mwh >= 0.0
        # Reported separately from operating P&L, with an objective share.
        assert d.continuation_value_gbp is not None
        assert d.continuation_share_of_objective_pct is not None


def test_higher_continuation_value_keeps_more_energy() -> None:
    """End-of-horizon SoC responds to the continuation value as expected.

    Uses an explicit-periods engine so the horizon ends exactly at the replay
    end (a rolling cross-day horizon never plans "for" the replay's last
    period — its horizon extends past it, which is the whole point).
    """
    day = date(2025, 2, 10)
    store = store_from_synthetic(day, history_days=7, forward_days=1)
    periods = settlement_periods_for_day(day)
    low = BatteryConfig(terminal_soc_value_gbp_per_mwh=0.0, minimum_terminal_soc_mwh=0.0)
    high = BatteryConfig(terminal_soc_value_gbp_per_mwh=500.0, minimum_terminal_soc_mwh=0.0)
    opts = ReplayOptions(source="synthetic", history_days=7)
    eng_low = ReplayEngine(low, day, opts, store=store, periods=periods)
    eng_high = ReplayEngine(high, day, opts, store=store, periods=periods)
    eng_low.run()
    eng_high.run()
    # Valuing stored energy at £500/MWh must not end with less energy than
    # valuing it at £0 — and should end essentially full.
    assert eng_high.soc >= eng_low.soc - 1e-6
    assert eng_high.soc >= 0.9 * high.effective_max_soc
    assert eng_low.soc <= 0.2 * high.effective_max_soc  # £0 value → dump energy
