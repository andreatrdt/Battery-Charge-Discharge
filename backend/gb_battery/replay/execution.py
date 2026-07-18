"""Simulated execution models — explicit, simple, and labelled as assumptions.

Three modes trade off realism against simplicity:

* ``ideal``  — full requested volume at the reference price (the historical
  theoretical benchmark; what the app assumed before execution modelling).
* ``simple`` — configurable half-spread, proportional slippage, per-MWh fee,
  a maximum executable MW and a deterministic fill ratio.
* ``stress`` — the same mechanics with harsher defaults (wide spread, more
  slippage, volume haircut).

Price convention (positive quantities):

    buy_price  = reference + spread/2 + slippage
    sell_price = reference − spread/2 − slippage

Slippage is proportional to the reference price and to the participation of the
requested volume against ``max_executable_mw`` — a crude but transparent proxy
for walking the book. **Executed** volume (never requested volume) drives the
battery's state of charge.

Everything here is a simulated assumption: no order book is consulted and no
orders exist. MID is a reference price, not an executable bid or ask.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field

ExecutionMode = Literal["ideal", "simple", "stress"]


class ExecutionParams(BaseModel):
    """Tunable execution assumptions (all simulated)."""

    spread_gbp_per_mwh: float = Field(default=0.0, ge=0)  # full bid/ask spread
    fee_gbp_per_mwh: float = Field(default=0.0, ge=0)  # per-MWh transaction fee
    slippage_frac_of_price: float = Field(default=0.0, ge=0, le=0.2)
    max_executable_mw: float | None = Field(default=None, gt=0)
    fill_ratio: float = Field(default=1.0, gt=0, le=1.0)  # deterministic haircut


DEFAULTS: dict[ExecutionMode, ExecutionParams] = {
    "ideal": ExecutionParams(),
    "simple": ExecutionParams(
        spread_gbp_per_mwh=2.0, fee_gbp_per_mwh=0.10,
        slippage_frac_of_price=0.005, fill_ratio=1.0,
    ),
    "stress": ExecutionParams(
        spread_gbp_per_mwh=8.0, fee_gbp_per_mwh=0.10,
        slippage_frac_of_price=0.02, fill_ratio=0.8,
    ),
}


def params_for(mode: ExecutionMode, override: ExecutionParams | None = None) -> ExecutionParams:
    return override if override is not None else DEFAULTS[mode]


@dataclass(frozen=True)
class ExecutionFill:
    """Outcome of executing one period's requested action against a reference price."""

    requested_charge_mw: float
    requested_discharge_mw: float
    executed_charge_mw: float
    executed_discharge_mw: float
    buy_price: float | None  # None when nothing bought
    sell_price: float | None
    reference_price: float
    spread_cost_gbp: float  # ≥ 0, spread + slippage vs reference
    fee_cost_gbp: float  # ≥ 0
    unfilled_mwh: float  # requested − executed energy (absolute)

    @property
    def execution_cost_gbp(self) -> float:
        return self.spread_cost_gbp + self.fee_cost_gbp


def apply_execution(
    requested_charge_mw: float,
    requested_discharge_mw: float,
    reference_price: float,
    duration_hours: float,
    params: ExecutionParams,
) -> ExecutionFill:
    """Fill a requested action under the given execution assumptions."""
    cap = params.max_executable_mw
    exec_charge = min(requested_charge_mw, cap) if cap is not None else requested_charge_mw
    exec_discharge = min(requested_discharge_mw, cap) if cap is not None else requested_discharge_mw
    exec_charge *= params.fill_ratio
    exec_discharge *= params.fill_ratio

    half_spread = params.spread_gbp_per_mwh / 2.0
    slippage = params.slippage_frac_of_price * abs(reference_price)
    buy_price = reference_price + half_spread + slippage if exec_charge > 0 else None
    sell_price = reference_price - half_spread - slippage if exec_discharge > 0 else None

    e_buy = exec_charge * duration_hours
    e_sell = exec_discharge * duration_hours
    spread_cost = (half_spread + slippage) * (e_buy + e_sell)
    fee_cost = params.fee_gbp_per_mwh * (e_buy + e_sell)
    unfilled = (
        (requested_charge_mw - exec_charge) + (requested_discharge_mw - exec_discharge)
    ) * duration_hours

    return ExecutionFill(
        requested_charge_mw=round(requested_charge_mw, 4),
        requested_discharge_mw=round(requested_discharge_mw, 4),
        executed_charge_mw=round(exec_charge, 4),
        executed_discharge_mw=round(exec_discharge, 4),
        buy_price=round(buy_price, 4) if buy_price is not None else None,
        sell_price=round(sell_price, 4) if sell_price is not None else None,
        reference_price=reference_price,
        spread_cost_gbp=round(spread_cost, 4),
        fee_cost_gbp=round(fee_cost, 4),
        unfilled_mwh=round(unfilled, 4),
    )
