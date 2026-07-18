"""Backwards-compatible re-exports — the implementation lives in metrics.py."""

from gb_battery.replay.metrics import (
    PERFECT_FORESIGHT_LABEL,
    compare_replay_strategies,
    run_perfect_foresight,
)

__all__ = [
    "PERFECT_FORESIGHT_LABEL",
    "compare_replay_strategies",
    "run_perfect_foresight",
]
