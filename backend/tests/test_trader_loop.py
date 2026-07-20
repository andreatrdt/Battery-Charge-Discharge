"""Trader-in-the-loop: state machine, decision hierarchy, confirmed-state carry."""

from __future__ import annotations

from datetime import date

import pytest
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.decision_state import SessionState, TraderLoopError
from gb_battery.replay.engine import ReplayEngine, ReplayOptions
from gb_battery.settlement import settlement_periods_for_day

DAY = date(2025, 1, 20)


def _engine() -> ReplayEngine:
    return ReplayEngine(
        BatteryConfig(),
        DAY,
        ReplayOptions(source="sample", horizon_hours=24),
        periods=settlement_periods_for_day(DAY),
    )


def test_automatic_step_composes_the_stages() -> None:
    """Automatic run still works and leaves the machine ready each gate."""
    eng = _engine()
    eng.run(max_steps=3)
    assert len(eng.decisions) == 3
    assert eng.state == SessionState.READY_FOR_RECOMMENDATION
    for d in eng.decisions:
        # Every automatic decision carries the full immutable hierarchy.
        assert d.recommendation is not None
        assert d.trader_instruction is not None
        assert d.trader_instruction.decision == "ACCEPT_RECOMMENDATION"
        assert d.trader_instruction.source == "automatic_policy"
        assert d.execution is not None
        assert d.physical_state is not None
        assert d.physical_state.soc_source == "executed_action_estimate"


def test_accept_copies_recommendation_and_carries_executed_soc() -> None:
    eng = _engine()
    rec = eng.recommend()
    assert rec is not None
    assert eng.state == SessionState.AWAITING_TRADER_DECISION
    instr = eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
    assert instr.charge_mw == rec.charge_mw
    assert instr.discharge_mw == rec.discharge_mw
    eng.apply_execution()
    d = eng.confirm_state()
    eng.advance()
    # Next solve starts from the executed/confirmed SoC.
    assert eng.soc == pytest.approx(d.physical_state.confirmed_soc_after_mwh)
    assert d.physical_state.soc_source == "executed_action_estimate"


def test_modify_keeps_recommendation_immutable_and_drives_next_soc() -> None:
    eng = _engine()
    rec = eng.recommend()
    assert rec is not None
    eng.submit_trader_instruction("MODIFY", charge_mw=20.0, discharge_mw=0.0, reason="risk")
    eng.apply_execution()
    d = eng.confirm_state()
    eng.advance()
    # The original recommendation is preserved verbatim in the audit record...
    assert d.recommendation.charge_mw == rec.charge_mw
    assert d.recommendation.discharge_mw == rec.discharge_mw
    # ...while the executed action and next SoC follow the trader's 20 MW charge.
    assert d.trader_instruction.decision == "MODIFY"
    assert d.charge_mw == pytest.approx(20.0)
    expected = eng.config.initial_soc_mwh + eng.config.charge_efficiency * 20.0 * d.duration_hours
    assert eng.soc == pytest.approx(expected, abs=1e-3)


def test_reject_to_idle_leaves_soc_unchanged() -> None:
    eng = _engine()
    eng.recommend()
    soc0 = eng.soc
    eng.submit_trader_instruction("REJECT_TO_IDLE")
    eng.apply_execution()
    d = eng.confirm_state()
    eng.advance()
    assert d.energy_action == "IDLE"
    assert d.charge_mw == 0.0 and d.discharge_mw == 0.0
    assert eng.soc == pytest.approx(soc0)


def test_partial_fill_drives_soc_by_executed_not_requested() -> None:
    from gb_battery.replay.execution import ExecutionParams

    eng = ReplayEngine(
        BatteryConfig(),
        DAY,
        ReplayOptions(
            source="sample", horizon_hours=24, execution_mode="simple",
            execution_params=ExecutionParams(fill_ratio=0.5),
        ),
        periods=settlement_periods_for_day(DAY),
    )
    eng.recommend()
    eng.submit_trader_instruction("MODIFY", charge_mw=40.0, discharge_mw=0.0)
    execution = eng.apply_execution()
    d = eng.confirm_state()
    # 50% fill → executed 20 MW; SoC follows the executed volume.
    assert execution.executed_charge_mw == pytest.approx(20.0)
    assert execution.status == "partially_filled"
    expected = eng.config.initial_soc_mwh + eng.config.charge_efficiency * 20.0 * d.duration_hours
    assert eng.soc == pytest.approx(expected, abs=1e-3)


def test_manual_soc_confirmation_overrides_executed_estimate() -> None:
    eng = _engine()
    eng.recommend()
    eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
    eng.apply_execution()
    d = eng.confirm_state(confirmed_soc_after_mwh=61.5, soc_source="telemetry")
    ps = d.physical_state
    assert ps.soc_source == "telemetry"
    assert ps.confirmed_soc_after_mwh == pytest.approx(61.5)
    # Telemetry wins; the discrepancy vs the executed estimate is recorded.
    assert ps.reconciliation_difference_mwh == pytest.approx(61.5 - ps.executed_implied_soc_after_mwh)
    assert eng.soc == pytest.approx(61.5)


class TestInvalidTransitions:
    def test_execute_before_recommend(self) -> None:
        eng = _engine()
        with pytest.raises(TraderLoopError):
            eng.apply_execution()

    def test_decision_before_recommend(self) -> None:
        eng = _engine()
        with pytest.raises(TraderLoopError):
            eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")

    def test_second_decision_after_execution(self) -> None:
        eng = _engine()
        eng.recommend()
        eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
        eng.apply_execution()
        with pytest.raises(TraderLoopError):
            eng.submit_trader_instruction("REJECT_TO_IDLE")

    def test_advance_before_confirm(self) -> None:
        eng = _engine()
        eng.recommend()
        eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
        eng.apply_execution()
        with pytest.raises(TraderLoopError):
            eng.advance()

    def test_simultaneous_charge_discharge_rejected(self) -> None:
        eng = _engine()
        eng.recommend()
        with pytest.raises(TraderLoopError):
            eng.submit_trader_instruction("MODIFY", charge_mw=10.0, discharge_mw=10.0)

    def test_over_power_limit_rejected(self) -> None:
        eng = _engine()
        eng.recommend()
        with pytest.raises(TraderLoopError):
            eng.submit_trader_instruction("MODIFY", charge_mw=999.0)

    def test_out_of_band_confirmed_soc_rejected(self) -> None:
        eng = _engine()
        eng.recommend()
        eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
        eng.apply_execution()
        with pytest.raises(TraderLoopError):
            eng.confirm_state(confirmed_soc_after_mwh=99999.0, soc_source="telemetry")


def test_manual_matches_automatic_when_always_accepting() -> None:
    """A manual all-accept run reproduces the automatic run exactly."""
    auto = _engine()
    auto.run()
    manual = _engine()
    gate = None
    while True:
        rec = manual.recommend()
        if rec is None:
            break
        gate = manual._pending.as_of  # noqa: SLF001
        manual.submit_trader_instruction("ACCEPT_RECOMMENDATION", source="automatic_policy", at=gate)
        manual.apply_execution()
        manual.confirm_state(soc_source="executed_action_estimate", at=gate)
        manual.advance()
    assert len(manual.decisions) == len(auto.decisions)
    for a, m in zip(auto.decisions, manual.decisions, strict=True):
        assert a.charge_mw == pytest.approx(m.charge_mw)
        assert a.discharge_mw == pytest.approx(m.discharge_mw)
        assert a.soc_after_mwh == pytest.approx(m.soc_after_mwh)
        assert a.realised_pnl_gbp == pytest.approx(m.realised_pnl_gbp)


def test_confirmed_state_before_midnight_drives_post_midnight_optimisation() -> None:
    """A telemetry SoC confirmed at the last day-1 gate carries into day 2."""
    day2 = date(2025, 1, 21)
    day1_periods = settlement_periods_for_day(DAY)
    periods = day1_periods + settlement_periods_for_day(day2)
    opts = ReplayOptions(source="synthetic", n_days=2, horizon_hours=24, history_days=7)
    eng = ReplayEngine(BatteryConfig(), DAY, opts, periods=list(periods))

    # Auto-run all of day 1 except its final gate.
    eng.run(max_steps=len(day1_periods) - 1)
    assert eng.step_index == len(day1_periods) - 1

    # On the last day-1 gate, confirm a distinctive telemetry SoC of 15 MWh.
    eng.recommend()
    eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
    eng.apply_execution()
    last_d1 = eng.confirm_state(confirmed_soc_after_mwh=15.0, soc_source="telemetry")
    eng.advance()
    assert last_d1.settlement_date == DAY
    assert eng.soc == pytest.approx(15.0)

    # The first day-2 gate must therefore start from the confirmed 15 MWh.
    first_d2 = eng.recommend()
    assert first_d2 is not None
    assert eng._pending.period.settlement_date == day2  # noqa: SLF001
    eng.submit_trader_instruction("ACCEPT_RECOMMENDATION")
    eng.apply_execution()
    d2 = eng.confirm_state()
    assert d2.soc_before_mwh == pytest.approx(15.0)
