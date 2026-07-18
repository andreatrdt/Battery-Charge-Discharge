"""Trader metrics, P&L attribution, regime analysis and strategy comparison.

Everything here is computed from settled :class:`DecisionRecord` rows — no
value is invented. The attribution decomposition is an exact identity (see
:func:`attribution`), tested to reconcile to realised net P&L within numerical
tolerance.
"""

from __future__ import annotations

import math
from statistics import mean, pstdev

from gb_battery.battery.config import BatteryConfig
from gb_battery.optimiser.deterministic import optimise
from gb_battery.replay.engine import DecisionRecord, ReplayEngine, ReplayOptions, perfect_foresight_range

PERFECT_FORESIGHT_LABEL = "Perfect foresight benchmark — not a tradable strategy."

SOC_NEAR_EDGE_FRAC = 0.05  # "near empty/full" = within 5% of usable range


# ------------------------------------------------------------------ trader metrics


def trader_metrics(decisions: list[DecisionRecord], config: BatteryConfig) -> dict:
    """Performance / risk / forecast-contribution / operation / execution metrics."""
    settled = [d for d in decisions if d.settlement_status == "settled"]
    pnls = [d.realised_pnl_gbp or 0.0 for d in settled]
    active = [d for d in settled if d.energy_action != "IDLE"]
    active_pnls = [d.realised_pnl_gbp or 0.0 for d in active]
    wins = [p for p in active_pnls if p > 0]
    losses = [p for p in active_pnls if p < 0]

    cum, peak, max_dd = 0.0, 0.0, 0.0
    for p in pnls:
        cum += p
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)

    # Historical VaR / Expected Shortfall on the per-period realised P&L
    # distribution (95%, loss reported as a positive number).
    var95 = es95 = None
    if len(pnls) >= 10:
        ordered = sorted(pnls)
        k = max(int(math.floor(0.05 * len(ordered))), 1)
        tail = ordered[:k]
        var95 = round(-ordered[k - 1], 2)
        es95 = round(-mean(tail), 2)

    expected = sum(d.expected_immediate_pnl_gbp for d in settled)
    realised = sum(pnls)

    # Wrong-direction: traded one way while the realised price made the
    # opposite action profitable relative to the forecast.
    wrong_dir = sum(
        1
        for d in active
        if d.actual_price is not None
        and (
            (d.energy_action == "DISCHARGE" and d.actual_price < d.forecast_price - 2 * d.forecast_sigma)
            or (d.energy_action == "CHARGE" and d.actual_price > d.forecast_price + 2 * d.forecast_sigma)
        )
    )

    usable = max(config.effective_max_soc - config.effective_min_soc, 1e-9)
    near_empty = sum(
        1 for d in settled if (d.soc_after_mwh - config.effective_min_soc) / usable < SOC_NEAR_EDGE_FRAC
    )
    near_full = sum(
        1 for d in settled if (config.effective_max_soc - d.soc_after_mwh) / usable < SOC_NEAR_EDGE_FRAC
    )
    power_bound = sum(
        1
        for d in settled
        if "charge_power_max" in d.binding_constraints or "discharge_power_max" in d.binding_constraints
    )
    energy_bound = sum(
        1 for d in settled if "battery_full" in d.binding_constraints or "battery_empty" in d.binding_constraints
    )

    charge_mwh = sum(d.charge_mw * d.duration_hours for d in settled)
    discharge_mwh = sum(d.discharge_mw * d.duration_hours for d in settled)
    req_mwh = sum((d.requested_charge_mw + d.requested_discharge_mw) * d.duration_hours for d in decisions)
    exec_mwh = sum((d.charge_mw + d.discharge_mw) * d.duration_hours for d in decisions)

    return {
        "performance": {
            "gross_pnl_gbp": round(sum(d.realised_gross_pnl_gbp or 0.0 for d in settled), 2),
            "net_pnl_gbp": round(realised, 2),
            "expected_pnl_gbp": round(expected, 2),
            "pnl_surprise_gbp": round(realised - expected, 2),
            "hit_rate_pct": round(100.0 * len(wins) / len(active_pnls), 1) if active_pnls else None,
            "average_win_gbp": round(mean(wins), 2) if wins else None,
            "average_loss_gbp": round(mean(losses), 2) if losses else None,
            "payoff_ratio": round(mean(wins) / abs(mean(losses)), 2) if wins and losses else None,
            "profit_factor": round(sum(wins) / abs(sum(losses)), 2) if wins and losses else None,
            "n_active_periods": len(active),
        },
        "risk": {
            "max_drawdown_gbp": round(max_dd, 2),
            "pnl_volatility_gbp": round(pstdev(pnls), 2) if len(pnls) > 1 else None,
            "var95_gbp_per_period": var95,
            "expected_shortfall95_gbp": es95,
            "worst_period_gbp": round(min(pnls), 2) if pnls else None,
        },
        "battery": {
            "charge_throughput_mwh": round(charge_mwh, 2),
            "discharge_throughput_mwh": round(discharge_mwh, 2),
            "equivalent_full_cycles": round(discharge_mwh / config.energy_capacity_mwh, 3)
            if config.energy_capacity_mwh
            else 0.0,
            "degradation_cost_gbp": round(sum(d.degradation_cost_gbp for d in decisions), 2),
            "average_soc_mwh": round(mean(d.soc_after_mwh for d in settled), 2) if settled else None,
            "time_near_empty_pct": round(100.0 * near_empty / len(settled), 1) if settled else None,
            "time_near_full_pct": round(100.0 * near_full / len(settled), 1) if settled else None,
            "power_limit_binding_pct": round(100.0 * power_bound / len(settled), 1) if settled else None,
            "energy_limit_binding_pct": round(100.0 * energy_bound / len(settled), 1) if settled else None,
        },
        "execution": {
            "requested_volume_mwh": round(req_mwh, 2),
            "executed_volume_mwh": round(exec_mwh, 2),
            "unfilled_volume_mwh": round(sum(d.unfilled_mwh for d in decisions), 2),
            "spread_slippage_cost_gbp": round(
                sum(d.spread_slippage_cost_gbp or 0.0 for d in settled), 2
            ),
            "fee_cost_gbp": round(sum(d.fee_cost_gbp or 0.0 for d in settled), 2),
            "wrong_direction_decisions": wrong_dir,
        },
    }


# -------------------------------------------------------------------- attribution


def attribution(decisions: list[DecisionRecord]) -> dict:
    """Exact expected → realised P&L decomposition.

    Identity per settled period (all energies in MWh at the executed level):

        expected  = fc·(req_d − req_c) − deg(req)
        volume    = fc·(exe_net − req_net) − (deg(exe) − deg(req))
        price     = (act − fc)·exe_net
        costs     = spread/slippage + fees            (subtracted)
        realised_net = expected + volume + price − costs        (exact)

    Components that cannot be separated further are honestly not invented; the
    ``residual_gbp`` line reports any numerical remainder (≈ 0 by construction).
    """
    settled = [d for d in decisions if d.settlement_status == "settled"]
    expected = volume = price = costs = realised = 0.0
    for d in settled:
        dt = d.duration_hours
        fc = d.forecast_price
        act = d.actual_price or 0.0
        req_net = (d.requested_discharge_mw - d.requested_charge_mw) * dt
        exe_net = (d.discharge_mw - d.charge_mw) * dt
        deg_rate = 0.0
        req_thru = (d.requested_charge_mw + d.requested_discharge_mw) * dt
        exe_thru = (d.charge_mw + d.discharge_mw) * dt
        if exe_thru > 1e-12:
            deg_rate = d.degradation_cost_gbp / exe_thru
        deg_req = deg_rate * req_thru
        expected += fc * req_net - deg_req
        volume += fc * (exe_net - req_net) - (d.degradation_cost_gbp - deg_req)
        price += (act - fc) * exe_net
        costs += (d.spread_slippage_cost_gbp or 0.0) + (d.fee_cost_gbp or 0.0)
        realised += d.realised_pnl_gbp or 0.0
    residual = realised - (expected + volume + price - costs)
    return {
        "expected_model_pnl_gbp": round(expected, 2),
        "price_forecast_effect_gbp": round(price, 2),
        "volume_effect_gbp": round(volume, 2),
        "execution_cost_effect_gbp": round(-costs, 2),
        "residual_interaction_gbp": round(residual, 2),
        "realised_net_pnl_gbp": round(realised, 2),
        "reconciles": abs(residual) < 0.05,
        "note": (
            "Exact identity: expected + volume effect + price effect − execution "
            "costs = realised net. Degradation is inside expected/volume (never "
            "double-counted); the residual line reports numerical remainder only."
        ),
    }


# ------------------------------------------------------------------------ regimes

REGIME_RULES = (
    "Priority order: negative_price (actual < 0) → price_spike (actual > mean + 2σ "
    "of the run's settled prices) → evening_peak (17:00–20:00 London) → "
    "morning_ramp (06:00–09:00 London) → high_wind / low_wind (wind forecast in "
    "top/bottom quartile of the run, when available) → normal."
)


def classify_regime(d: DecisionRecord, price_mean: float, price_std: float,
                    wind_q25: float | None, wind_q75: float | None) -> str:
    if d.actual_price is not None and d.actual_price < 0:
        return "negative_price"
    if d.actual_price is not None and price_std > 0 and d.actual_price > price_mean + 2 * price_std:
        return "price_spike"
    from gb_battery.settlement import LONDON

    hour = d.start_utc.astimezone(LONDON).hour
    if 17 <= hour < 20:
        return "evening_peak"
    if 6 <= hour < 9:
        return "morning_ramp"
    # Wind regime from the day-ahead forecast visible at the gate (PIT-safe).
    wind = d.wind_forecast_mw
    if wind_q75 is not None and wind is not None and wind >= wind_q75:
        return "high_wind"
    if wind_q25 is not None and wind is not None and wind <= wind_q25:
        return "low_wind"
    return "normal"


def regime_analysis(decisions: list[DecisionRecord]) -> dict:
    settled = [d for d in decisions if d.settlement_status == "settled"]
    if not settled:
        return {"rules": REGIME_RULES, "regimes": []}
    prices = [d.actual_price for d in settled if d.actual_price is not None]
    p_mean = mean(prices) if prices else 0.0
    p_std = pstdev(prices) if len(prices) > 1 else 0.0
    winds = sorted(d.wind_forecast_mw for d in settled if d.wind_forecast_mw is not None)
    wind_q25 = winds[len(winds) // 4] if len(winds) >= 8 else None
    wind_q75 = winds[(3 * len(winds)) // 4] if len(winds) >= 8 else None
    buckets: dict[str, list[DecisionRecord]] = {}
    for d in settled:
        buckets.setdefault(classify_regime(d, p_mean, p_std, wind_q25, wind_q75), []).append(d)
    rows = []
    for name, ds in sorted(buckets.items()):
        errs = [d.forecast_error for d in ds if d.forecast_error is not None]
        pnls = [d.realised_pnl_gbp or 0.0 for d in ds]
        active = [d for d in ds if d.energy_action != "IDLE"]
        wins = [d for d in active if (d.realised_pnl_gbp or 0.0) > 0]
        rows.append(
            {
                "regime": name,
                "n_periods": len(ds),
                "forecast_mae": round(mean(abs(e) for e in errs), 2) if errs else None,
                "forecast_bias": round(mean(errs), 2) if errs else None,
                "realised_pnl_gbp": round(sum(pnls), 2),
                "hit_rate_pct": round(100.0 * len(wins) / len(active), 1) if active else None,
                "avg_net_export_mw": round(
                    mean(d.discharge_mw - d.charge_mw for d in ds), 2
                ),
            }
        )
    return {"rules": REGIME_RULES, "regimes": rows}


# -------------------------------------------------------- strategy comparison


def run_perfect_foresight(engine: ReplayEngine) -> dict | None:
    """One-shot optimisation on the realised path over the executed range.

    For a fair, bounded comparison the terminal SoC is valued at the *closing
    actual reference price* (η_d-adjusted) with no artificial terminal floor —
    the same mark-to-market rule used for every strategy in the comparison
    table. Under ideal execution any feasible schedule (including the rolling
    strategy's) therefore scores ≤ this optimum by construction.
    """
    executed = engine.periods[: len(engine.decisions)] or engine.periods
    built = perfect_foresight_range(engine.config, engine.store, executed)
    if built is None:
        return None
    inputs, prices = built
    closing = prices[-1]
    cfg = engine.config.model_copy(
        update={
            "terminal_soc_value_gbp_per_mwh": engine.config.discharge_efficiency * closing,
            "minimum_terminal_soc_mwh": engine.config.minimum_soc_mwh,
        }
    )
    result = optimise(cfg, inputs, compute_marginals=False)
    if result.status != "optimal":
        return None
    revenue = sum(p.wholesale_price * p.discharge_mw * p.duration_hours for p in result.periods)
    cost = sum(p.wholesale_price * p.charge_mw * p.duration_hours for p in result.periods)
    cash = result.total_wholesale_pnl_gbp - result.total_degradation_cost_gbp
    ending = result.periods[-1].ending_soc_mwh
    inv_adj = cash + ending * engine.config.discharge_efficiency * closing
    return {
        "strategy": "perfect_foresight",
        "label": PERFECT_FORESIGHT_LABEL,
        "realised_pnl_gbp": round(cash, 2),
        "inventory_adjusted_pnl_gbp": round(inv_adj, 2),
        "wholesale_revenue_gbp": round(revenue, 2),
        "charging_cost_gbp": round(cost, 2),
        "degradation_cost_gbp": round(result.total_degradation_cost_gbp, 2),
        "execution_cost_gbp": 0.0,
        "cycles": result.full_cycle_equivalents,
        "ending_soc_mwh": round(ending, 3),
        "schedule": [
            {
                "settlement_date": p.settlement_date.isoformat(),
                "settlement_period": p.settlement_period,
                "energy_action": "CHARGE" if p.charge_mw > 1e-4 else ("DISCHARGE" if p.discharge_mw > 1e-4 else "IDLE"),
                "charge_mw": p.charge_mw,
                "discharge_mw": p.discharge_mw,
                "ending_soc_mwh": p.ending_soc_mwh,
                "price": p.wholesale_price,
            }
            for p in result.periods
        ],
        "closing_price_gbp_per_mwh": closing,
    }


def _inventory_adjusted(summary: dict, engine: ReplayEngine, closing: float | None) -> float | None:
    if closing is None:
        return None
    return round(
        summary["realised_pnl_gbp"]
        + summary["ending_soc_mwh"] * engine.config.discharge_efficiency * closing,
        2,
    )


def _peak_trough_capture(engine: ReplayEngine) -> dict:
    settled = [d for d in engine.decisions if d.settlement_status == "settled"]
    if not settled:
        return {"peak_captured": None, "trough_captured": None}
    peak = max(settled, key=lambda d: d.actual_price or float("-inf"))
    trough = min(settled, key=lambda d: d.actual_price or float("inf"))
    return {
        "peak_sp": peak.settlement_period,
        "peak_price": peak.actual_price,
        "peak_captured": peak.discharge_mw > 1e-4,
        "trough_sp": trough.settlement_period,
        "trough_price": trough.actual_price,
        "trough_captured": trough.charge_mw > 1e-4,
    }


def compare_replay_strategies(engine: ReplayEngine) -> dict:
    """Compare the finished main replay against benchmarks on the same store.

    All rolling strategies observe identical point-in-time information; only
    perfect foresight sees the realised path (and is labelled). Ending
    inventory is marked to the closing actual reference price so strategies
    that hold energy at the end are not unfairly penalised.
    """
    settled = [d for d in engine.decisions if d.settlement_status == "settled"]
    closing = settled[-1].actual_price if settled else None

    main = engine.realised_summary()
    rows = [
        {
            "strategy": engine.options.strategy,
            "label": "Rolling point-in-time strategy (main result)",
            **main,
            "inventory_adjusted_pnl_gbp": _inventory_adjusted(main, engine, closing),
        }
    ]

    rows.append(
        {
            "strategy": "no_operation",
            "label": "Battery never trades",
            "realised_pnl_gbp": 0.0,
            "inventory_adjusted_pnl_gbp": (
                round(engine.config.initial_soc_mwh * engine.config.discharge_efficiency * closing, 2)
                if closing is not None
                else None
            ),
            "wholesale_revenue_gbp": 0.0,
            "charging_cost_gbp": 0.0,
            "degradation_cost_gbp": 0.0,
            "execution_cost_gbp": 0.0,
            "cycles": 0.0,
            "max_drawdown_gbp": 0.0,
            "ending_soc_mwh": engine.config.initial_soc_mwh,
        }
    )

    alt = "rolling_threshold" if engine.options.strategy != "rolling_threshold" else "rolling_forecast"
    alt_engine = ReplayEngine(
        engine.config,
        engine.day,
        options=ReplayOptions(**{**engine.options.model_dump(), "strategy": alt}),
        store=engine.store,
        forecaster=engine.forecaster,
    )
    alt_engine.run(max_steps=len(engine.decisions))
    alt_summary = alt_engine.realised_summary()
    rows.append(
        {
            "strategy": alt,
            "label": "Alternative rolling policy on identical information",
            **alt_summary,
            "inventory_adjusted_pnl_gbp": _inventory_adjusted(alt_summary, alt_engine, closing),
        }
    )

    pf = run_perfect_foresight(engine)
    pf_adj = pf["inventory_adjusted_pnl_gbp"] if pf else None
    if pf:
        rows.append({k: v for k, v in pf.items() if k != "schedule"})

    for r in rows:
        adj = r.get("inventory_adjusted_pnl_gbp")
        if pf_adj and r["strategy"] != "perfect_foresight" and pf_adj != 0 and adj is not None:
            r["capture_of_perfect_pct"] = round(100.0 * adj / pf_adj, 1)
        # Regret vs the unattainable bound.
        if pf_adj is not None and adj is not None:
            r["regret_gbp"] = round(pf_adj - adj, 2)

    return {
        "table": rows,
        "perfect_foresight_pnl_gbp": pf["realised_pnl_gbp"] if pf else None,
        "perfect_foresight_inventory_adjusted_gbp": pf_adj,
        "perfect_foresight_label": PERFECT_FORESIGHT_LABEL,
        "perfect_foresight_schedule": pf["schedule"] if pf else None,
        "peak_trough": _peak_trough_capture(engine),
        "inventory_note": (
            "Ending stored energy is marked to the closing actual reference price "
            "(× discharge efficiency) so holding inventory at the end is not "
            "penalised. Capture % and regret use the inventory-adjusted figures."
        ),
        "note": (
            "All rolling strategies observed identical point-in-time information. "
            "Perfect foresight saw the realised path and is not attainable."
        ),
    }


# ------------------------------------------------------------ price error heatmap


def price_error_heatmap(engine: ReplayEngine) -> dict:
    """Price |error| binned by target SP × hours-ahead, from stored vintages.

    Uses only the vintages issued during the replay (point-in-time by
    construction) and actual outturns for already-completed periods.
    """
    cells: dict[tuple[int, int], list[float]] = {}
    actuals: dict[tuple, float] = {}
    for d in engine.decisions:
        if d.actual_price is not None:
            actuals[(d.settlement_date, d.settlement_period)] = d.actual_price
    for vintage in engine.vintages:
        for r in vintage.rows:
            act = actuals.get((r.settlement_date, r.settlement_period))
            if act is None:
                continue
            hours_ahead = int((r.start_utc - vintage.issued_at).total_seconds() // 3600)
            if hours_ahead < 0:
                continue
            cells.setdefault((r.settlement_period, hours_ahead), []).append(abs(r.point - act))
    return {
        "metric": "price_abs_error_gbp_per_mwh",
        "cells": [
            {
                "settlement_period": sp,
                "hours_ahead": h,
                "mae": round(mean(v), 2),
                "n": len(v),
            }
            for (sp, h), v in sorted(cells.items())
        ],
    }
