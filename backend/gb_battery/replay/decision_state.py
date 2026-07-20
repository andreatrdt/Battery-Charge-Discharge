"""The four decision states of a rolling battery gate.

The optimiser produces a *recommendation*, not the physical truth. A trader may
accept, modify or reject it; the market may then fill something different again;
and the confirmed physical state (ideally telemetry) is what the next
optimisation must start from. Keeping these four things as separate, immutable
records is the whole point — never collapse them into one "action".

    ModelRecommendation  →  TraderInstruction  →  ExecutionRecord  →  PhysicalStateRecord
       (advisory)            (what to do)          (what filled)        (what is true)
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class SessionState(StrEnum):
    """Manual trader-in-the-loop state machine (automatic mode composes these)."""

    READY_FOR_RECOMMENDATION = "READY_FOR_RECOMMENDATION"
    AWAITING_TRADER_DECISION = "AWAITING_TRADER_DECISION"
    AWAITING_EXECUTION = "AWAITING_EXECUTION"
    AWAITING_STATE_CONFIRMATION = "AWAITING_STATE_CONFIRMATION"
    READY_FOR_NEXT_PERIOD = "READY_FOR_NEXT_PERIOD"
    COMPLETE = "COMPLETE"


class TraderLoopError(RuntimeError):
    """An invalid state transition or an invalid trader instruction."""


EnergyAction = Literal["CHARGE", "DISCHARGE", "IDLE"]


class ModelRecommendation(BaseModel):
    """The optimiser's advisory recommendation for the immediate period."""

    energy_action: EnergyAction
    charge_mw: float
    discharge_mw: float
    expected_immediate_pnl_gbp: float
    expected_horizon_pnl_gbp: float
    expected_soc_after_mwh: float
    explanation: str
    binding_constraints: list[str] = Field(default_factory=list)
    forecast_price: float
    issued_at: datetime
    information_cutoff: datetime
    forecast_vintage_step: int  # audit reference into the stored vintages


class TraderInstruction(BaseModel):
    """What the trader (or the automatic policy) actually instructed."""

    decision: Literal["ACCEPT_RECOMMENDATION", "MODIFY", "REJECT_TO_IDLE"]
    charge_mw: float
    discharge_mw: float
    reason: str | None = None
    decided_at: datetime
    actor: str | None = None
    source: Literal["manual_ui", "automatic_policy", "imported_instruction"] = "manual_ui"

    @property
    def energy_action(self) -> EnergyAction:
        if self.charge_mw > 1e-4:
            return "CHARGE"
        if self.discharge_mw > 1e-4:
            return "DISCHARGE"
        return "IDLE"


class ExecutionRecord(BaseModel):
    """What the market actually filled (simulated, or manually confirmed)."""

    status: Literal["pending", "simulated", "confirmed", "partially_filled", "rejected"]
    requested_charge_mw: float
    requested_discharge_mw: float
    executed_charge_mw: float
    executed_discharge_mw: float
    executed_energy_mwh: float
    unfilled_mwh: float
    buy_price: float | None = None
    sell_price: float | None = None
    spread_slippage_cost_gbp: float | None = None
    fee_cost_gbp: float | None = None
    execution_source: Literal[
        "ideal_simulation",
        "simple_simulation",
        "stress_simulation",
        "manual_confirmation",
        "imported_fill",
        "telemetry",
    ] = "ideal_simulation"


class PhysicalStateRecord(BaseModel):
    """The confirmed physical state the next optimisation must start from."""

    soc_before_mwh: float
    model_expected_soc_after_mwh: float
    executed_implied_soc_after_mwh: float
    confirmed_soc_after_mwh: float
    soc_source: Literal[
        "telemetry",
        "meter_reconciliation",
        "manual_confirmation",
        "executed_action_estimate",
        "model_simulation",
    ]
    confirmed_at: datetime | None = None
    reconciliation_difference_mwh: float = 0.0
    status: Literal["estimated", "confirmed", "stale", "inconsistent"] = "estimated"
