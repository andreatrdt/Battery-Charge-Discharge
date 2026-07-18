"""Execution models: spread direction, fills, SoC from executed volume, attribution."""

from __future__ import annotations

from datetime import date

import pytest
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.engine import ReplayEngine, ReplayOptions
from gb_battery.replay.execution import ExecutionParams, apply_execution
from gb_battery.replay.metrics import attribution


def test_buy_price_above_and_sell_price_below_reference() -> None:
    params = ExecutionParams(spread_gbp_per_mwh=4.0, slippage_frac_of_price=0.01)
    buy = apply_execution(10.0, 0.0, 100.0, 0.5, params)
    sell = apply_execution(0.0, 10.0, 100.0, 0.5, params)
    assert buy.buy_price == pytest.approx(100.0 + 2.0 + 1.0)  # ref + half-spread + slippage
    assert sell.sell_price == pytest.approx(100.0 - 2.0 - 1.0)
    # Costs are positive and symmetric on equal volume.
    assert buy.spread_cost_gbp == pytest.approx(sell.spread_cost_gbp)
    assert buy.spread_cost_gbp == pytest.approx((2.0 + 1.0) * 5.0)  # £3/MWh × 5 MWh


def test_partial_fill_and_volume_cap() -> None:
    params = ExecutionParams(fill_ratio=0.8, max_executable_mw=6.0)
    fill = apply_execution(10.0, 0.0, 50.0, 0.5, params)
    assert fill.executed_charge_mw == pytest.approx(6.0 * 0.8)
    assert fill.unfilled_mwh == pytest.approx((10.0 - 4.8) * 0.5)


def test_executed_volume_drives_soc_not_requested() -> None:
    """Under a 50% haircut the SoC path must follow executed, not requested MW."""
    day = date(2025, 2, 10)
    opts = ReplayOptions(
        source="synthetic",
        history_days=7,
        horizon_hours=24,
        execution_mode="simple",
        execution_params=ExecutionParams(fill_ratio=0.5),
    )
    eng = ReplayEngine(BatteryConfig(), day, opts)
    eng.run(max_steps=12)
    active = [d for d in eng.decisions if d.energy_action != "IDLE"]
    assert active, "expected at least one active decision"
    for d in eng.decisions:
        assert d.charge_mw <= d.requested_charge_mw + 1e-9
        assert d.discharge_mw <= d.requested_discharge_mw + 1e-9
        expected_delta = (
            eng.config.charge_efficiency * d.charge_mw
            - d.discharge_mw / eng.config.discharge_efficiency
        ) * d.duration_hours
        # Records store 4-dp rounded values → tolerance reflects that.
        assert d.soc_after_mwh - d.soc_before_mwh == pytest.approx(expected_delta, abs=1e-3)
    # Requested exceeded executed somewhere, and the shortfall is reported.
    assert any(d.unfilled_mwh > 0 for d in active)


def test_stress_costs_more_than_simple_more_than_ideal() -> None:
    day = date(2025, 2, 10)
    results = {}
    for mode in ("ideal", "simple", "stress"):
        eng = ReplayEngine(
            BatteryConfig(),
            day,
            ReplayOptions(source="synthetic", history_days=7, horizon_hours=24, execution_mode=mode),
        )
        eng.run()
        s = eng.realised_summary()
        results[mode] = s
    assert results["ideal"]["execution_cost_gbp"] == 0.0
    assert results["simple"]["execution_cost_gbp"] > 0.0
    assert results["stress"]["execution_cost_gbp"] > results["simple"]["execution_cost_gbp"]
    # Net = gross − execution costs, every mode.
    for s in results.values():
        assert s["realised_pnl_gbp"] == pytest.approx(
            s["realised_gross_pnl_gbp"] - s["execution_cost_gbp"], abs=0.05
        )


def test_attribution_reconciles_under_stress_execution() -> None:
    eng = ReplayEngine(
        BatteryConfig(),
        date(2025, 2, 10),
        ReplayOptions(source="synthetic", history_days=7, horizon_hours=24, execution_mode="stress"),
    )
    eng.run()
    att = attribution(eng.decisions)
    assert att["reconciles"] is True
    lhs = (
        att["expected_model_pnl_gbp"]
        + att["price_forecast_effect_gbp"]
        + att["volume_effect_gbp"]
        + att["execution_cost_effect_gbp"]
    )
    assert lhs == pytest.approx(att["realised_net_pnl_gbp"], abs=0.05)
    # Execution costs appear once (in their own component), degradation never twice.
    assert att["execution_cost_effect_gbp"] < 0
