"""Point-in-time forecast validation, benchmarks and error heatmaps.

Every number here is computed under the same information discipline as the
replay itself: a "forecast" for period *t* uses only records published at or
before *t*'s gate. Two framings are reported:

* **1-step-ahead** — the forecast each model would have issued at every gate
  for that gate's own period (what the rolling strategy actually trades on);
* **start-of-day** — the full-day forecast issued at the day's first gate
  (used for peak/trough timing and ramp errors, where a whole path is needed).

Benchmarks (all transparent):

* ``persistence`` — the most recent visible observation, any SP;
* ``lag_same_sp_1d`` / ``lag_same_sp_7d`` — same SP, 1 / 7 days earlier;
* ``rolling_median_7d`` — median of the same SP over ≤7 visible prior days;
* ``climatology_weekday_sp`` — mean of the same weekday & SP over history;
* ``internal_model`` — the production :class:`PITForecaster` (with quantiles).

MAPE is deliberately not used: prices and net-solar values cross zero.
"""

from __future__ import annotations

from datetime import date, timedelta
from statistics import mean, median

import numpy as np

from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.engine import ReplayEngine, ReplayOptions
from gb_battery.replay.forecaster import PITForecaster, VintageRow
from gb_battery.replay.metrics import price_error_heatmap
from gb_battery.replay.pit import PITDataStore, _utc
from gb_battery.settlement import SettlementPeriod, settlement_periods_for_day

PRICE_BENCHMARKS = [
    "persistence",
    "lag_same_sp_1d",
    "lag_same_sp_7d",
    "rolling_median_7d",
    "climatology_weekday_sp",
    "internal_model",
]

METRIC_GUIDE = {
    "mae": {"unit": "£/MWh or MW", "better": "lower", "means": "average absolute error; a trader's typical miss"},
    "rmse": {"unit": "£/MWh or MW", "better": "lower", "means": "like MAE but punishes large misses — spikes matter"},
    "bias": {"unit": "£/MWh or MW", "better": "closer to 0", "means": "systematic over(+)/under(−) forecasting"},
    "correlation": {"unit": "−1…1", "better": "higher", "means": "does the forecast move with reality at all"},
    "directional_accuracy_pct": {"unit": "%", "better": "higher", "means": "how often the forecast called the next move's direction — direction drives charge/discharge"},
    "ramp_mae": {"unit": "£/MWh per SP", "better": "lower", "means": "error in period-to-period changes; bad ramps mistime actions"},
    "peak_timing_error_sp": {"unit": "SPs", "better": "lower", "means": "how far off the day's forecast peak was — discharging at the wrong peak is expensive"},
    "trough_timing_error_sp": {"unit": "SPs", "better": "lower", "means": "how far off the day's forecast trough was"},
    "pinball_loss": {"unit": "£/MWh", "better": "lower", "means": "quantile-forecast quality (q10/q50/q90 combined)"},
    "coverage_q10_q90_pct": {"unit": "%", "better": "closer to 80", "means": "share of actuals inside the q10–q90 band; honesty of the uncertainty claim"},
    "interval_width": {"unit": "£/MWh", "better": "narrower at same coverage", "means": "how much uncertainty the model admits"},
}


# ------------------------------------------------------------------- benchmarks


class BenchmarkForecaster(PITForecaster):
    """A PIT forecaster whose point forecast follows a named benchmark rule.

    Reuses the production forecaster's machinery (PIT queries, sigma, quantile
    shape) but swaps the point. Used both for validation metrics and for
    downstream strategy-P&L comparisons, so statistical and economic rankings
    come from the same code path.
    """

    def __init__(self, method: str) -> None:
        super().__init__()
        if method not in PRICE_BENCHMARKS:
            raise ValueError(f"Unknown benchmark '{method}'")
        self.method = method

    def forecast(self, store, as_of, target_periods):
        vintage = super().forecast(store, as_of, target_periods)
        if self.method == "internal_model":
            return vintage
        obs = store.observations_at(_utc(as_of), "wholesale_price")
        by_sp: dict[int, list[tuple[date, float]]] = {}
        for o in obs:
            by_sp.setdefault(o.settlement_period, []).append((o.settlement_date, o.value))
        last_obs = obs[-1].value if obs else None
        by_wd_sp: dict[tuple[int, int], list[float]] = {}
        for o in obs:
            by_wd_sp.setdefault((o.settlement_date.weekday(), o.settlement_period), []).append(o.value)

        new_rows: list[VintageRow] = []
        for row, per in zip(vintage.rows, target_periods, strict=True):
            point = self._point_for(per, by_sp, last_obs, by_wd_sp)
            if point is None:
                point = row.point  # fall back to internal when the rule has no data
            shift = point - row.point
            new_rows.append(
                VintageRow(
                    **{
                        **row.__dict__,
                        "point": round(point, 3),
                        "q50": round(point, 3),
                        "q10": round(row.q10 + shift, 3),
                        "q90": round(row.q90 + shift, 3),
                        "basis": self.method,
                    }
                )
            )
        vintage.rows = new_rows
        return vintage

    def _point_for(self, per: SettlementPeriod, by_sp, last_obs, by_wd_sp) -> float | None:
        hist = [
            (d, v) for d, v in by_sp.get(per.settlement_period, []) if d < per.settlement_date
        ]
        hist.sort()
        if self.method == "persistence":
            return last_obs
        if self.method == "lag_same_sp_1d":
            return hist[-1][1] if hist else None
        if self.method == "lag_same_sp_7d":
            exact = [v for d, v in hist if d == per.settlement_date - timedelta(days=7)]
            return exact[0] if exact else (hist[0][1] if hist else None)
        if self.method == "rolling_median_7d":
            tail = [v for _, v in hist[-7:]]
            return float(median(tail)) if tail else None
        if self.method == "climatology_weekday_sp":
            vals = [
                v
                for (wd, sp), vs in by_wd_sp.items()
                if wd == per.settlement_date.weekday() and sp == per.settlement_period
                for v in vs
            ]
            return float(mean(vals)) if vals else None
        return None


# ---------------------------------------------------------------------- metrics


def _point_metrics(fc: list[float], act: list[float]) -> dict:
    f = np.asarray(fc, dtype=float)
    a = np.asarray(act, dtype=float)
    err = f - a
    out = {
        "n": len(a),
        "mae": round(float(np.mean(np.abs(err))), 3),
        "rmse": round(float(np.sqrt(np.mean(err**2))), 3),
        "bias": round(float(np.mean(err)), 3),
        "correlation": round(float(np.corrcoef(f, a)[0, 1]), 3)
        if len(a) > 2 and np.std(f) > 0 and np.std(a) > 0
        else None,
    }
    if len(a) > 2:
        d_f = np.sign(np.diff(f))
        d_a = np.sign(np.diff(a))
        valid = d_a != 0
        out["directional_accuracy_pct"] = (
            round(100.0 * float(np.mean(d_f[valid] == d_a[valid])), 1) if valid.any() else None
        )
        out["ramp_mae"] = round(float(np.mean(np.abs(np.diff(f) - np.diff(a)))), 3)
    return out


def _pinball(actual: np.ndarray, q: np.ndarray, alpha: float) -> float:
    diff = actual - q
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1) * diff)))


def _prob_metrics(rows: list[VintageRow], actuals: list[float]) -> dict:
    a = np.asarray(actuals, dtype=float)
    q10 = np.asarray([r.q10 for r in rows])
    q50 = np.asarray([r.q50 for r in rows])
    q90 = np.asarray([r.q90 for r in rows])
    inside = (a >= q10) & (a <= q90)
    return {
        "pinball_q10": round(_pinball(a, q10, 0.1), 3),
        "pinball_q50": round(_pinball(a, q50, 0.5), 3),
        "pinball_q90": round(_pinball(a, q90, 0.9), 3),
        "coverage_q10_q90_pct": round(100.0 * float(np.mean(inside)), 1),
        "avg_interval_width": round(float(np.mean(q90 - q10)), 2),
        "calibration": {
            "share_below_q10_pct": round(100.0 * float(np.mean(a < q10)), 1),
            "share_below_q50_pct": round(100.0 * float(np.mean(a < q50)), 1),
            "share_below_q90_pct": round(100.0 * float(np.mean(a < q90)), 1),
        },
    }


# ------------------------------------------------------------------ price study


def validate_price_forecasts(
    store: PITDataStore,
    day: date,
    *,
    n_days: int = 1,
    models: list[str] | None = None,
    config: BatteryConfig | None = None,
    with_strategy_pnl: bool = True,
    options: ReplayOptions | None = None,
) -> dict:
    """Benchmark every price model statistically AND economically."""
    models = models or ["persistence", "lag_same_sp_1d", "rolling_median_7d", "internal_model"]
    config = config or BatteryConfig()
    base_options = options or ReplayOptions(source="synthetic")
    periods: list[SettlementPeriod] = []
    for i in range(n_days):
        periods.extend(settlement_periods_for_day(day + timedelta(days=i)))

    actual_by_key: dict[tuple, float] = {}
    for per in periods:
        obs = store.outturn("wholesale_price", per.settlement_date, per.settlement_period)
        if obs is not None:
            actual_by_key[(per.settlement_date, per.settlement_period)] = obs.value
    usable = [p for p in periods if (p.settlement_date, p.settlement_period) in actual_by_key]
    if len(usable) < 8:
        return {"error": "Not enough settled periods with outturns to validate against."}

    table = []
    heatmap = None
    internal_prob = None
    sod_series: dict[str, list[dict]] = {}
    for method in models:
        fc = BenchmarkForecaster(method)
        # 1-step-ahead framing: forecast each gate's own period at its gate.
        step_fc, step_act, step_rows = [], [], []
        for per in usable:
            vintage = fc.forecast(store, per.start_utc, [per])
            row = vintage.rows[0]
            step_rows.append(row)
            step_fc.append(row.point)
            step_act.append(actual_by_key[(per.settlement_date, per.settlement_period)])
        m = _point_metrics(step_fc, step_act)

        # Start-of-day framing: one full-path vintage at the first gate.
        sod = fc.forecast(store, usable[0].start_utc, usable)
        sod_fc = [r.point for r in sod.rows]
        sod_act = [actual_by_key[(r.settlement_date, r.settlement_period)] for r in sod.rows]
        peak_err = abs(int(np.argmax(sod_fc)) - int(np.argmax(sod_act)))
        trough_err = abs(int(np.argmin(sod_fc)) - int(np.argmin(sod_act)))
        m["peak_timing_error_sp"] = peak_err
        m["trough_timing_error_sp"] = trough_err
        m["start_of_day_mae"] = round(float(np.mean(np.abs(np.asarray(sod_fc) - np.asarray(sod_act)))), 3)
        sod_series[method] = [
            {
                "settlement_date": r.settlement_date.isoformat(),
                "settlement_period": r.settlement_period,
                "forecast": r.point,
                "q10": r.q10,
                "q90": r.q90,
                "actual": actual_by_key[(r.settlement_date, r.settlement_period)],
            }
            for r in sod.rows
        ]

        if method == "internal_model":
            internal_prob = _prob_metrics(step_rows, step_act)

        strategy_pnl = None
        capture = None
        if with_strategy_pnl:
            eng = ReplayEngine(
                config,
                day,
                options=ReplayOptions(**{**base_options.model_dump(), "n_days": n_days}),
                store=store,
                forecaster=fc,
            )
            eng.run()
            strategy_pnl = eng.realised_summary()["realised_pnl_gbp"]
            if method == "internal_model":
                heatmap = price_error_heatmap(eng)
        table.append(
            {
                "model": method,
                **m,
                **({"probabilistic": internal_prob} if method == "internal_model" and internal_prob else {}),
                "strategy_pnl_gbp": strategy_pnl,
                "capture_of_perfect_pct": capture,
            }
        )

    return {
        "variable": "wholesale_price",
        "framing_note": (
            "1-step-ahead metrics describe the forecast each model issued at every "
            "decision gate for that gate's own period; peak/trough timing and "
            "start-of-day MAE use the full-path forecast issued at the first gate. "
            "Strategy P&L runs the identical rolling replay with each model — a "
            "statistically better forecast is not declared better until it also "
            "earns more."
        ),
        "table": table,
        "metric_guide": METRIC_GUIDE,
        "start_of_day_series": sod_series,
        "price_heatmap_sp_by_hours_ahead": heatmap,
    }


# ------------------------------------------------------------ fundamentals study


def validate_fundamentals(store: PITDataStore, day: date, *, n_days: int = 1) -> dict:
    """Day-ahead published forecast vs outturn for demand / wind / solar / residual."""
    out: dict[str, object] = {}
    days = [day + timedelta(days=i) for i in range(n_days)]
    per_var: dict[str, list[dict]] = {v: [] for v in ("demand_mw", "wind_mw", "solar_mw")}
    for d in days:
        for per in settlement_periods_for_day(d):
            for var in ("demand_mw", "wind_mw", "solar_mw"):
                fc_map = store.forecasts_at(per.start_utc, var, day=d)
                fc = fc_map.get(per.settlement_period)
                obs = store.outturn(var, d, per.settlement_period)
                if fc is not None and obs is not None:
                    per_var[var].append(
                        {
                            "settlement_date": d.isoformat(),
                            "settlement_period": per.settlement_period,
                            "weekday": d.weekday(),
                            "forecast": fc.value,
                            "actual": obs.value,
                            "forecast_published_at": fc.published_at.isoformat(),
                            "provenance": fc.provenance.value,
                        }
                    )
    residual_rows: list[dict] = []
    demand_idx = {(r["settlement_date"], r["settlement_period"]): r for r in per_var["demand_mw"]}
    wind_idx = {(r["settlement_date"], r["settlement_period"]): r for r in per_var["wind_mw"]}
    solar_idx = {(r["settlement_date"], r["settlement_period"]): r for r in per_var["solar_mw"]}
    for key, dr in demand_idx.items():
        wr, sr = wind_idx.get(key), solar_idx.get(key)
        if wr and sr:
            residual_rows.append(
                {
                    "settlement_date": key[0],
                    "settlement_period": key[1],
                    "weekday": dr["weekday"],
                    "forecast": dr["forecast"] - wr["forecast"] - sr["forecast"],
                    "actual": dr["actual"] - wr["actual"] - sr["actual"],
                }
            )
    all_vars = {**per_var, "residual_demand_mw": residual_rows}
    for var, rows in all_vars.items():
        if len(rows) < 4:
            out[var] = {"available": False, "note": "No day-ahead forecast + outturn pairs in this store."}
            continue
        out[var] = {
            "available": True,
            "metrics": _point_metrics([r["forecast"] for r in rows], [r["actual"] for r in rows]),
            "series": rows,
        }
    # Demand MAE heatmap weekday × SP and wind bias by SP (single day-ahead
    # horizon — the horizon axis would be degenerate and is honestly omitted).
    def _heat(rows: list[dict], value_fn) -> list[dict]:
        cells: dict[tuple[int, int], list[float]] = {}
        for r in rows:
            cells.setdefault((r["weekday"], r["settlement_period"]), []).append(value_fn(r))
        return [
            {"weekday": wd, "settlement_period": sp, "value": round(mean(v), 1), "n": len(v)}
            for (wd, sp), v in sorted(cells.items())
        ]

    if all_vars["demand_mw"]:
        out["demand_mae_heatmap_weekday_sp"] = _heat(
            all_vars["demand_mw"], lambda r: abs(r["forecast"] - r["actual"])
        )
    if all_vars["wind_mw"]:
        out["wind_bias_by_sp"] = _heat(all_vars["wind_mw"], lambda r: r["forecast"] - r["actual"])
    return out
