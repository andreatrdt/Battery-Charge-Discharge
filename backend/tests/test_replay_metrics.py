"""Trader metrics, validation benchmarks and persistence — hand-checkable cases."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.engine import DecisionRecord, ProposedPeriod, ReplayEngine, ReplayOptions
from gb_battery.replay.metrics import attribution, trader_metrics
from gb_battery.replay.persistence import ReplayArchive
from gb_battery.replay.validation import BenchmarkForecaster, _point_metrics, _prob_metrics
from gb_battery.replay.pit import store_from_synthetic
from gb_battery.settlement import settlement_periods_for_day

DAY = date(2025, 6, 2)


def _decision(step: int, action: str, mw: float, fc: float, act: float, dt: float = 0.5) -> DecisionRecord:
    """Hand-buildable settled decision under ideal execution, no degradation."""
    per = settlement_periods_for_day(DAY)[step]
    charge = mw if action == "CHARGE" else 0.0
    discharge = mw if action == "DISCHARGE" else 0.0
    net = (discharge - charge) * dt
    return DecisionRecord(
        step=step,
        settlement_date=DAY,
        settlement_period=per.settlement_period,
        start_utc=per.start_utc,
        end_utc=per.end_utc,
        duration_hours=dt,
        as_of=per.start_utc,
        information_cutoff=per.start_utc,
        basis_max_published_at=per.start_utc - timedelta(minutes=5),
        n_input_observations=1,
        n_input_forecasts=1,
        horizon_hours=24,
        horizon_n_periods=48,
        horizon_end_utc=per.start_utc + timedelta(hours=24),
        forecast_price=fc,
        forecast_q10=fc - 10,
        forecast_q90=fc + 10,
        forecast_sigma=8.0,
        forecast_basis="lag_same_sp",
        forecast_provenance="model_forecast",
        energy_action=action,  # type: ignore[arg-type]
        requested_charge_mw=charge,
        requested_discharge_mw=discharge,
        charge_mw=charge,
        discharge_mw=discharge,
        soc_before_mwh=50.0,
        soc_after_mwh=50.0 + (charge - discharge) * dt,
        expected_immediate_pnl_gbp=fc * net,
        expected_horizon_pnl_gbp=0.0,
        explanation="test",
        binding_constraints=[],
        proposed_schedule=[
            ProposedPeriod(
                settlement_date=DAY,
                settlement_period=per.settlement_period,
                start_utc=per.start_utc,
                energy_action=action,
                charge_mw=charge,
                discharge_mw=discharge,
                ending_soc_mwh=50.0,
                forecast_price=fc,
                expected_pnl_gbp=fc * net,
            )
        ],
        continuation_gbp_per_mwh=0.0,
        continuation_method="none",
        continuation_value_gbp=0.0,
        settlement_status="settled",
        actual_price=act,
        actual_price_available_at=per.end_utc + timedelta(minutes=10),
        actual_price_provenance="observed",
        realised_gross_pnl_gbp=act * net,
        realised_pnl_gbp=act * net,
        forecast_error=fc - act,
    )


class TestHandCheckableTraderMetrics:
    """Four settled periods with numbers small enough to verify by hand.

    D1: discharge 2 MW, fc 100, act 100 → +100   (win)
    D2: discharge 2 MW, fc 100, act  50 →  +50   (win)
    D3: charge    2 MW, fc  20, act  80 →  −80   (loss)
    D4: idle                                → 0  (not counted as active)
    """

    @pytest.fixture(scope="class")
    def decisions(self) -> list[DecisionRecord]:
        return [
            _decision(0, "DISCHARGE", 2.0, 100.0, 100.0),
            _decision(1, "DISCHARGE", 2.0, 100.0, 50.0),
            _decision(2, "CHARGE", 2.0, 20.0, 80.0),
            _decision(3, "IDLE", 0.0, 60.0, 60.0),
        ]

    def test_hit_rate_payoff_profit_factor(self, decisions) -> None:
        m = trader_metrics(decisions, BatteryConfig())["performance"]
        assert m["n_active_periods"] == 3
        assert m["hit_rate_pct"] == pytest.approx(66.7, abs=0.1)  # 2 wins of 3 active
        assert m["average_win_gbp"] == pytest.approx(75.0)  # (100+50)/2
        assert m["average_loss_gbp"] == pytest.approx(-80.0)
        assert m["payoff_ratio"] == pytest.approx(75.0 / 80.0, abs=0.01)
        assert m["profit_factor"] == pytest.approx(150.0 / 80.0, abs=0.01)
        assert m["net_pnl_gbp"] == pytest.approx(70.0)

    def test_drawdown_and_worst_period(self, decisions) -> None:
        r = trader_metrics(decisions, BatteryConfig())["risk"]
        # Cumulative: 100, 150, 70, 70 → peak 150, trough after 150 is 70.
        assert r["max_drawdown_gbp"] == pytest.approx(80.0)
        assert r["worst_period_gbp"] == pytest.approx(-80.0)

    def test_attribution_identity_by_hand(self, decisions) -> None:
        att = attribution(decisions)
        # expected: D1 fc100·(+1 MWh) = 100; D2 = 100; D3 fc20·(−1) = −20; D4 0 → 180.
        # price:    D1 (100−100)·1 = 0; D2 (50−100)·1 = −50; D3 (80−20)·(−1) = −60 → −110.
        # realised: 100 + 50 − 80 + 0 = 70 = 180 − 110 ✓ (exact identity).
        assert att["expected_model_pnl_gbp"] == pytest.approx(180.0)
        assert att["price_forecast_effect_gbp"] == pytest.approx(-110.0)
        assert att["volume_effect_gbp"] == pytest.approx(0.0)
        assert att["realised_net_pnl_gbp"] == pytest.approx(70.0)
        assert att["reconciles"] is True


def test_var_and_expected_shortfall_ordering() -> None:
    decisions = [
        _decision(i, "DISCHARGE", 2.0, 50.0, 50.0 - 10 * i) for i in range(12)
    ]
    r = trader_metrics(decisions, BatteryConfig())["risk"]
    assert r["var95_gbp_per_period"] is not None
    assert r["expected_shortfall95_gbp"] >= r["var95_gbp_per_period"]  # ES ≥ VaR


def test_point_metrics_and_pinball_by_hand() -> None:
    m = _point_metrics([10.0, 20.0, 30.0, 40.0], [12.0, 18.0, 33.0, 39.0])
    assert m["mae"] == pytest.approx((2 + 2 + 3 + 1) / 4)
    assert m["bias"] == pytest.approx((-2 + 2 - 3 + 1) / 4)
    # Pinball for a single quantile, by hand: q10 forecasts 0, actual 10 →
    # loss = 0.1 × 10 = 1.0.
    import numpy as np

    from gb_battery.replay.validation import _pinball

    assert _pinball(np.array([10.0]), np.array([0.0]), 0.1) == pytest.approx(1.0)
    assert _pinball(np.array([10.0]), np.array([20.0]), 0.1) == pytest.approx(9.0)


def test_benchmark_forecaster_is_point_in_time() -> None:
    store = store_from_synthetic(DAY, history_days=7, forward_days=1)
    periods = settlement_periods_for_day(DAY)
    gate = periods[0].start_utc
    fc = BenchmarkForecaster("lag_same_sp_1d")
    vintage = fc.forecast(store, gate, periods)
    # Wherever yesterday's same-SP outturn was PUBLISHED before the gate, the
    # lag benchmark must equal it. (Yesterday's final SPs publish after this
    # gate — end + lag — and must therefore NOT be the source; that is the
    # point-in-time discipline working, not a bug.)
    checked = 0
    for row in vintage.rows:
        prev = store.outturn("wholesale_price", DAY - timedelta(days=1), row.settlement_period)
        assert prev is not None
        if prev.published_at <= gate:
            assert row.point == pytest.approx(prev.value, abs=0.01)
            checked += 1
        else:
            # Must fall back to an older visible day, never the unpublished value.
            older = store.outturn(
                "wholesale_price", DAY - timedelta(days=2), row.settlement_period
            )
            assert older is not None
            assert row.point == pytest.approx(older.value, abs=0.01)
    assert checked >= 30  # most of yesterday was visible


def test_interval_coverage_counts_correctly() -> None:
    from gb_battery.replay.forecaster import VintageRow

    rows = [
        VintageRow(
            settlement_date=DAY, settlement_period=i + 1,
            start_utc=datetime(2025, 6, 2, tzinfo=UTC), point=50.0, q10=40.0, q50=50.0,
            q90=60.0, sigma=8.0, basis="test", intraday_bias=0.0,
        )
        for i in range(4)
    ]
    actuals = [45.0, 55.0, 39.0, 61.0]  # two inside, two outside
    prob = _prob_metrics(rows, actuals)
    assert prob["coverage_q10_q90_pct"] == pytest.approx(50.0)
    assert prob["avg_interval_width"] == pytest.approx(20.0)


def test_persistence_round_trip(tmp_path) -> None:
    from gb_battery.data.settings import DataSettings

    archive = ReplayArchive(DataSettings(cache_dir=tmp_path))
    eng = ReplayEngine(
        BatteryConfig(),
        date(2025, 2, 10),
        ReplayOptions(source="synthetic", history_days=5, horizon_hours=24),
    )
    eng.run(max_steps=4)
    ok = archive.save(
        replay_id="testrun1",
        created_at=datetime.now(tz=UTC),
        mode="historical",
        day="2025-02-10",
        n_days=1,
        complete=False,
        options=eng.options.model_dump(mode="json"),
        config=eng.config.model_dump(mode="json"),
        versions=eng.versions,
        summary=eng.realised_summary(),
        decisions=[d.model_dump(mode="json") for d in eng.decisions],
        vintages=[],
        metrics={"x": 1},
    )
    assert ok
    loaded = archive.load("testrun1")
    assert loaded is not None
    assert len(loaded["decisions"]) == 4
    assert loaded["versions"]["strategy_version"]
    assert loaded["metrics"] == {"x": 1}
    assert loaded["summary"]["realised_pnl_gbp"] == eng.realised_summary()["realised_pnl_gbp"]
    runs = archive.list_runs()
    assert any(r["replay_id"] == "testrun1" for r in runs)


def test_reserve_bm_never_in_replay_pnl() -> None:
    """The wholesale replay P&L contains no reserve/BM revenue by construction."""
    eng = ReplayEngine(
        BatteryConfig(),
        date(2025, 2, 10),
        ReplayOptions(source="synthetic", history_days=5, horizon_hours=24),
    )
    eng.run(max_steps=6)
    for d in eng.decisions:
        assert d.flexibility_position == "NONE"  # capability shown, never contracted
        if d.settlement_status == "settled":
            # Realised P&L is exactly reference-price cash − degradation − exec costs.
            net = (d.actual_price or 0.0) * (d.discharge_mw - d.charge_mw) * d.duration_hours
            expected = net - d.degradation_cost_gbp - (d.spread_slippage_cost_gbp or 0.0) - (d.fee_cost_gbp or 0.0)
            assert d.realised_pnl_gbp == pytest.approx(expected, abs=0.01)
