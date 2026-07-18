"""Cross-day rolling horizon: midnight carry, DST, budgets, horizon rebuild."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.engine import ReplayEngine, ReplayOptions

TWO_DAYS = ReplayOptions(source="synthetic", n_days=2, horizon_hours=48, history_days=7)


@pytest.fixture(scope="module")
def two_day_engine() -> ReplayEngine:
    eng = ReplayEngine(BatteryConfig(), date(2025, 2, 10), TWO_DAYS)
    eng.run()
    return eng


def test_two_day_replay_executes_every_period(two_day_engine: ReplayEngine) -> None:
    assert len(two_day_engine.decisions) == 96
    days = {d.settlement_date for d in two_day_engine.decisions}
    assert days == {date(2025, 2, 10), date(2025, 2, 11)}


def test_horizon_crosses_midnight(two_day_engine: ReplayEngine) -> None:
    d0 = two_day_engine.decisions[0]
    assert d0.horizon_n_periods == 96  # 48 h of half-hours
    assert d0.horizon_end_utc.date() >= date(2025, 2, 12)
    # Every vintage covers at least two settlement dates until near the end.
    v0 = two_day_engine.vintages[0]
    assert len({r.settlement_date for r in v0.rows}) >= 2


def test_soc_does_not_reset_at_midnight(two_day_engine: ReplayEngine) -> None:
    recs = two_day_engine.decisions
    last_d1 = [d for d in recs if d.settlement_date == date(2025, 2, 10)][-1]
    first_d2 = [d for d in recs if d.settlement_date == date(2025, 2, 11)][0]
    assert first_d2.soc_before_mwh == pytest.approx(last_d1.soc_after_mwh)
    # And the chain is continuous everywhere.
    for prev, nxt in zip(recs, recs[1:], strict=False):
        assert nxt.soc_before_mwh == pytest.approx(prev.soc_after_mwh)


def test_cycle_usage_tracks_per_day_without_incorrect_reset(two_day_engine: ReplayEngine) -> None:
    cfg = two_day_engine.config
    budget = cfg.maximum_cycles_per_day * cfg.energy_capacity_mwh
    # Daily budget is respected on each date...
    for _day, used in two_day_engine.discharged_by_date.items():
        assert used <= budget + 1e-6
    # ...and cumulative usage is the sum over days (never reset to zero).
    assert two_day_engine.discharged_mwh == pytest.approx(
        sum(two_day_engine.discharged_by_date.values())
    )


def test_horizon_rebuilt_after_every_step(two_day_engine: ReplayEngine) -> None:
    starts = [v.rows[0].start_utc for v in two_day_engine.vintages]
    assert starts == sorted(starts)
    assert len(set(starts)) == len(starts)  # a fresh horizon at every gate
    for v, d in zip(two_day_engine.vintages, two_day_engine.decisions, strict=True):
        assert v.rows[0].settlement_date == d.settlement_date
        assert v.rows[0].settlement_period == d.settlement_period


@pytest.mark.parametrize(
    ("start", "n_expected"),
    [
        (date(2025, 3, 29), 48 + 46),  # normal day then 46-SP spring-forward day
        (date(2025, 10, 25), 48 + 50),  # normal day then 50-SP autumn-back day
    ],
)
def test_dst_transitions_inside_a_two_day_replay(start: date, n_expected: int) -> None:
    eng = ReplayEngine(
        BatteryConfig(),
        start,
        ReplayOptions(source="synthetic", n_days=2, horizon_hours=24, history_days=4),
    )
    eng.run()
    assert len(eng.decisions) == n_expected
    # Midnight is a marker, not an economic boundary: SoC continuity holds
    # across the DST-affected boundary too.
    boundary = [d for d in eng.decisions if d.settlement_date == start][-1]
    after = [d for d in eng.decisions if d.settlement_date == start + timedelta(days=1)][0]
    assert after.soc_before_mwh == pytest.approx(boundary.soc_after_mwh)


def test_only_first_period_of_each_horizon_is_executed(two_day_engine: ReplayEngine) -> None:
    for d in two_day_engine.decisions:
        assert d.proposed_schedule[0].settlement_period == d.settlement_period
        assert d.proposed_schedule[0].settlement_date == d.settlement_date
        # The proposal is long (up to 96 periods) but exactly one row was executed.
        assert len(d.proposed_schedule) > 1 or d is two_day_engine.decisions[-1]
