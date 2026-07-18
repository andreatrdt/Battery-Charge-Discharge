"""Continuation value of stored energy at the end of the optimisation horizon.

A finite horizon needs a value for the energy left in the battery at its end,
otherwise the optimiser dumps everything before the boundary purely because no
future is modelled. The estimate here is deliberately simple and transparent:

    ContinuationValue(SoC_T) = SoC_T × η_d × ExpectedFutureDischargeValue

where ``ExpectedFutureDischargeValue`` is the mean of the **top quartile** of
point-in-time price forecasts for a window immediately beyond the horizon —
a battery discharges into the best periods, not the average one. The forecasts
come from the same PIT forecaster as the optimisation itself, so no future
information enters.

Fallbacks, in order, when the window has too few forecastable periods:
median of the in-horizon forecasts (labelled), then zero (labelled). An
explicit config override (`terminal_soc_value_gbp_per_mwh`) always wins and is
labelled ``config_override``.

The module is deliberately pluggable: anything with the same signature can
replace :func:`estimate_continuation` later (e.g. a dynamic-programming value
function).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from gb_battery.replay.forecaster import PITForecaster
from gb_battery.replay.pit import PITDataStore
from gb_battery.settlement import settlement_periods_between

WINDOW_HOURS_DEFAULT = 24
MIN_WINDOW_POINTS = 8
TOP_QUANTILE = 0.75  # value energy at the mean of the top quartile of prices


@dataclass(frozen=True)
class ContinuationEstimate:
    """Explicit, reportable continuation-value decision inputs."""

    gbp_per_mwh: float  # applied to the model's terminal SoC (already η_d-adjusted)
    method: str  # config_override | beyond_horizon_top_quartile | horizon_median | none
    window_start_utc: datetime | None
    window_end_utc: datetime | None
    n_window_points: int
    expected_future_discharge_value: float | None  # £/MWh before η_d
    warning: str | None = None


def estimate_continuation(
    store: PITDataStore,
    as_of: datetime,
    horizon_end_utc: datetime,
    *,
    discharge_efficiency: float,
    forecaster: PITForecaster,
    config_override: float | None = None,
    horizon_forecast_points: list[float] | None = None,
    window_hours: int = WINDOW_HOURS_DEFAULT,
) -> ContinuationEstimate:
    """Estimate the £/MWh value of energy stored at ``horizon_end_utc``."""
    if config_override is not None:
        return ContinuationEstimate(
            gbp_per_mwh=float(config_override),
            method="config_override",
            window_start_utc=None,
            window_end_utc=None,
            n_window_points=0,
            expected_future_discharge_value=None,
            warning=None,
        )

    window = settlement_periods_between(horizon_end_utc, window_hours * 2)
    vintage = None
    try:
        vintage = forecaster.forecast(store, as_of, window)
    except Exception:  # noqa: BLE001 — no forecastable future: fall back below
        vintage = None

    # Only trust the window when the forecaster had real basis for it — a wall of
    # identical global-median fallbacks would fabricate a continuation value.
    informative = [
        r.point for r in (vintage.rows if vintage is not None else []) if r.basis != "global_median"
    ]
    if len(informative) >= MIN_WINDOW_POINTS:
        arr = np.asarray(informative, dtype=float)
        threshold = float(np.quantile(arr, TOP_QUANTILE))
        top = arr[arr >= threshold]
        future_value = float(np.mean(top)) if len(top) else float(np.mean(arr))
        return ContinuationEstimate(
            gbp_per_mwh=round(discharge_efficiency * future_value, 4),
            method="beyond_horizon_top_quartile",
            window_start_utc=window[0].start_utc,
            window_end_utc=window[-1].end_utc,
            n_window_points=len(informative),
            expected_future_discharge_value=round(future_value, 4),
            warning=None,
        )

    if horizon_forecast_points:
        med = float(np.median(np.asarray(horizon_forecast_points, dtype=float)))
        return ContinuationEstimate(
            gbp_per_mwh=round(discharge_efficiency * med, 4),
            method="horizon_median",
            window_start_utc=None,
            window_end_utc=None,
            n_window_points=len(informative),
            expected_future_discharge_value=round(med, 4),
            warning=(
                "No forecastable data beyond the horizon; fell back to the median of "
                "in-horizon forecasts. Treat end-of-horizon behaviour with caution."
            ),
        )

    return ContinuationEstimate(
        gbp_per_mwh=0.0,
        method="none",
        window_start_utc=None,
        window_end_utc=None,
        n_window_points=0,
        expected_future_discharge_value=None,
        warning="No basis for a continuation value; stored energy valued at zero beyond the horizon.",
    )
