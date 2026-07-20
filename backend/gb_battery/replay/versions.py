"""Version identifiers stamped onto every persisted replay run.

Bump the relevant constant whenever the corresponding behaviour changes, so
stored runs remain interpretable after the code moves on.
"""

from __future__ import annotations

STRATEGY_VERSION = "2.1"  # + trader-in-the-loop decision hierarchy (recommend→execute→confirm)
PERSISTENCE_SCHEMA_VERSION = "2"  # DuckDB stores JSON docs; old flat runs still load
FORECAST_MODEL_VERSION = "1.1"  # baseline + intraday EWMA bias + quantiles, multi-day
OPTIMISER_VERSION = "1.0"  # Pyomo MILP, HiGHS, wholesale-only replay streams
EXECUTION_MODEL_VERSION = "1.0"  # ideal / simple / stress reference-price models
CONTINUATION_MODEL_VERSION = "1.0"  # beyond-horizon top-quartile discharge value


def version_stamp() -> dict[str, str]:
    return {
        "strategy_version": STRATEGY_VERSION,
        "forecast_model_version": FORECAST_MODEL_VERSION,
        "optimiser_version": OPTIMISER_VERSION,
        "execution_model_version": EXECUTION_MODEL_VERSION,
        "continuation_model_version": CONTINUATION_MODEL_VERSION,
    }
