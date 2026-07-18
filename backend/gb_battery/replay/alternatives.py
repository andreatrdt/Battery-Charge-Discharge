"""Decision alternatives: what would forcing charge / discharge / idle have cost?

For a chosen replay step the first-period action is *fixed* to each alternative
and the remaining horizon is genuinely re-optimised on the same forecast
vintage and battery state — actual re-solves, not invented values. Marginal
(perturbation) values for the step are computed the same way the production
optimiser does.

This is a learning and audit feature; it runs on demand because each call is
four MILP solves.
"""

from __future__ import annotations

import pyomo.environ as pyo

from gb_battery.optimiser.deterministic import _perturbation_marginals, optimise
from gb_battery.optimiser.model import build_model
from gb_battery.optimiser.solver import solve
from gb_battery.replay.engine import ReplayEngine, inputs_from_vintage


def _solve_with_fixed_first(config, inputs, charge_fix: float | None, discharge_fix: float | None):
    """Solve the horizon with the first period's action fixed (None = free)."""
    model = build_model(config, inputs)
    if charge_fix is not None:
        model.charge[0].fix(charge_fix)
        model.cbin[0].fix(1 if charge_fix > 1e-6 else 0)
    if discharge_fix is not None:
        model.discharge[0].fix(discharge_fix)
        model.dbin[0].fix(1 if discharge_fix > 1e-6 else 0)
    outcome = solve(model)
    if outcome.status not in {"optimal", "time_limit"}:
        return None
    n = len(inputs.periods)
    first_price = inputs.periods[0].wholesale_price
    dt = inputs.periods[0].duration_hours
    c = float(pyo.value(model.charge[0]))
    d = float(pyo.value(model.discharge[0]))
    deg = config.degradation_cost_gbp_per_mwh_throughput * (c + d) * dt
    immediate = first_price * (d - c) * dt - deg
    terminal_soc = float(pyo.value(model.soc[n]))
    continuation = model.terminal_value_coeff * terminal_soc
    objective = outcome.objective or 0.0
    return {
        "charge_mw": round(c, 3),
        "discharge_mw": round(d, 3),
        "immediate_value_gbp": round(immediate, 2),
        "future_value_gbp": round(objective - immediate - continuation, 2),
        "continuation_value_gbp": round(continuation, 2),
        "total_objective_gbp": round(objective, 2),
        "end_of_horizon_soc_mwh": round(terminal_soc, 3),
    }


def decision_alternatives(engine: ReplayEngine, step: int) -> dict:
    """Compare forced charge / discharge / idle against the optimiser's choice."""
    if not 0 <= step < len(engine.decisions):
        raise IndexError(f"No decision at step {step}")
    d = engine.decisions[step]
    vintage = engine.vintages[step]
    horizon = engine._horizon(step)  # noqa: SLF001 — same-package audit access
    inputs = inputs_from_vintage(vintage, horizon)
    cont = engine._continuation(d.as_of, horizon, vintage)  # noqa: SLF001
    cfg = engine._step_config(horizon, cont)  # noqa: SLF001
    cfg = cfg.model_copy(update={"initial_soc_mwh": d.soc_before_mwh})

    alternatives = {}
    specs = {
        "optimiser_selected": (None, None),
        "force_charge": (cfg.maximum_charge_mw, 0.0),
        "force_discharge": (0.0, cfg.maximum_discharge_mw),
        "force_idle": (0.0, 0.0),
    }
    # Physical feasibility for forced actions (respect SoC room over one period).
    dth = horizon[0].duration_hours
    room = (cfg.effective_max_soc - d.soc_before_mwh) / max(cfg.charge_efficiency * dth, 1e-9)
    avail = (d.soc_before_mwh - cfg.effective_min_soc) * cfg.discharge_efficiency / max(dth, 1e-9)
    for name, (c_fix, d_fix) in specs.items():
        c = min(c_fix, room) if c_fix is not None else None
        dis = min(d_fix, avail) if d_fix is not None else None
        res = _solve_with_fixed_first(cfg, inputs, c, dis)
        if res is not None:
            alternatives[name] = res

    selected = alternatives.get("optimiser_selected")
    ranked = sorted(
        (k for k in alternatives if k != "optimiser_selected"),
        key=lambda k: alternatives[k]["total_objective_gbp"],
        reverse=True,
    )
    next_best = ranked[0] if ranked else None
    value_gap = (
        round(selected["total_objective_gbp"] - alternatives[next_best]["total_objective_gbp"], 2)
        if selected and next_best
        else None
    )

    # Marginal resource values at this step (perturbation re-solves; unit-labelled).
    base = optimise(cfg, inputs, compute_marginals=False)
    marginals = {}
    if base.status == "optimal":
        raw = _perturbation_marginals(cfg, inputs, base.objective_gbp)
        marginals = {
            "stored_energy": {"value": raw.get("stored_energy_gbp_per_mwh"), "unit": "£ per additional MWh stored"},
            "empty_capacity": {"value": raw.get("empty_capacity_gbp_per_mwh"), "unit": "£ per additional MWh of capacity"},
            "charge_power": {"value": raw.get("charge_power_gbp_per_mw"), "unit": "£ per additional MW of charge power"},
            "discharge_power": {"value": raw.get("discharge_power_gbp_per_mw"), "unit": "£ per additional MW of discharge power"},
        }

    return {
        "step": step,
        "settlement_period": d.settlement_period,
        "as_of": d.as_of.isoformat(),
        "soc_before_mwh": d.soc_before_mwh,
        "alternatives": alternatives,
        "selected": "optimiser_selected",
        "next_best": next_best,
        "value_gap_gbp": value_gap,
        "binding_constraints": d.binding_constraints,
        "marginals": marginals,
        "note": (
            "Each alternative is a genuine re-solve of the same horizon with the "
            "first-period action fixed; forced actions are clamped to physical "
            "feasibility first. Values are model-expected (forecast-based)."
        ),
    }
