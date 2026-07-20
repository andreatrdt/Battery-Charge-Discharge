"""Typed models and pure calculations for the combined GB balance snapshot.

The sign convention is a single strict **net-export** convention throughout:

* contracted / delivered **export** (sale) is **positive** MWh;
* contracted / delivered **import** (purchase / charging) is **negative** MWh.

Commercial Imbalance is then::

    commercial_imbalance_mwh = confirmed_metered_net_export_mwh
                             - contracted_net_export_mwh

    > +tolerance  -> LONG
    < -tolerance  -> SHORT
    otherwise     -> BALANCED

GB System Imbalance uses the official Elexon Net Imbalance Volume (NIV)
convention::

    NIV > +tolerance -> GB SYSTEM SHORT
    NIV < -tolerance -> GB SYSTEM LONG
    otherwise        -> BALANCED

The two are independent: the battery's position and the system's position may
point the same way or opposite ways, and neither is inferred from the other or
from frequency.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

# Documented tolerances. A commercial imbalance within +/- this MWh band is
# treated as balanced (rounding / metering noise); the system NIV band is wider
# because NIV is a system-wide MWh quantity.
COMMERCIAL_TOLERANCE_MWH = 0.05
NIV_TOLERANCE_MWH = 1.0

CommercialDirection = Literal["LONG", "SHORT", "BALANCED"]
SystemDirection = Literal["GB SYSTEM LONG", "GB SYSTEM SHORT", "BALANCED"]
CommercialStatus = Literal["paper", "real", "unavailable"]


def classify_commercial(
    imbalance_mwh: float | None, tolerance_mwh: float = COMMERCIAL_TOLERANCE_MWH
) -> CommercialDirection | None:
    """Map a signed commercial imbalance (MWh) to LONG / SHORT / BALANCED."""
    if imbalance_mwh is None:
        return None
    if imbalance_mwh > tolerance_mwh:
        return "LONG"
    if imbalance_mwh < -tolerance_mwh:
        return "SHORT"
    return "BALANCED"


def classify_system(
    niv_mwh: float | None, tolerance_mwh: float = NIV_TOLERANCE_MWH
) -> SystemDirection | None:
    """Map a signed NIV (MWh) to the official GB system direction.

    Positive NIV means the system is short (needs more energy) and is settled as
    ``GB SYSTEM SHORT``; negative NIV is ``GB SYSTEM LONG``.
    """
    if niv_mwh is None:
        return None
    if niv_mwh > tolerance_mwh:
        return "GB SYSTEM SHORT"
    if niv_mwh < -tolerance_mwh:
        return "GB SYSTEM LONG"
    return "BALANCED"


def metered_net_export_from_soc(
    soc_before_mwh: float,
    soc_after_mwh: float,
    charge_efficiency: float,
    discharge_efficiency: float,
) -> float:
    """Grid-side net export (MWh) implied by a confirmed state-of-charge change.

    Within a single Settlement Period the battery is either charging or
    discharging (never both), so the sign of the SoC change fixes the direction:

    * SoC fell  -> discharge: grid export = |ΔSoC| × discharge_efficiency (positive)
    * SoC rose  -> charge:    grid import = |ΔSoC| / charge_efficiency   (negative)

    Using the confirmed SoC (telemetry / meter) makes the metered position
    authoritative over the executed or model-implied one.
    """
    d_soc = soc_after_mwh - soc_before_mwh
    if d_soc <= 0:  # discharge or idle
        return round(-d_soc * discharge_efficiency, 6)
    return round(-d_soc / charge_efficiency, 6)  # charge -> negative net export


class CommercialPosition(BaseModel):
    """This battery portfolio's own (paper) commercial imbalance.

    Stages are kept strictly separate — the optimiser recommendation never
    substitutes for the contracted energy, and the trader instruction never
    substitutes for confirmed delivery.
    """

    contracted_net_export_mwh: float | None = None
    scheduled_net_export_mwh: float | None = None
    model_recommended_net_export_mwh: float | None = None
    trader_instructed_net_export_mwh: float | None = None
    executed_net_export_mwh: float | None = None
    confirmed_metered_net_export_mwh: float | None = None

    commercial_imbalance_mwh: float | None = None
    direction: CommercialDirection | None = None

    system_price_gbp_per_mwh: float | None = None
    indicative_imbalance_cashflow_gbp: float | None = None

    status: CommercialStatus = "unavailable"
    calculation_method: str = "confirmed_metered_minus_contracted"
    provenance: str = "paper_trade"
    assumption_flags: list[str] = Field(default_factory=list)
    unavailable_reason: str | None = None

    @classmethod
    def unavailable(cls, reason: str) -> CommercialPosition:
        return cls(status="unavailable", unavailable_reason=reason, provenance="unavailable")


def commercial_position(
    *,
    contracted_net_export_mwh: float | None,
    confirmed_metered_net_export_mwh: float | None,
    scheduled_net_export_mwh: float | None = None,
    model_recommended_net_export_mwh: float | None = None,
    trader_instructed_net_export_mwh: float | None = None,
    executed_net_export_mwh: float | None = None,
    system_price_gbp_per_mwh: float | None = None,
    status: CommercialStatus = "paper",
    provenance: str = "paper_trade",
    calculation_method: str = "confirmed_metered_minus_contracted",
    tolerance_mwh: float = COMMERCIAL_TOLERANCE_MWH,
    assumption_flags: list[str] | None = None,
) -> CommercialPosition:
    """Build a :class:`CommercialPosition` from the net-export stages.

    Requires **both** a contracted position and confirmed metered delivery; if
    either is missing the position is returned as ``unavailable`` (never
    fabricated from the recommendation or instruction alone).
    """
    if contracted_net_export_mwh is None:
        return CommercialPosition.unavailable("No contracted position for this period.")
    if confirmed_metered_net_export_mwh is None:
        return CommercialPosition.unavailable("No confirmed metered delivery for this period.")

    imbalance = round(confirmed_metered_net_export_mwh - contracted_net_export_mwh, 6)
    direction = classify_commercial(imbalance, tolerance_mwh)
    cashflow = None
    if system_price_gbp_per_mwh is not None:
        cashflow = round(imbalance * system_price_gbp_per_mwh, 4)
    return CommercialPosition(
        contracted_net_export_mwh=round(contracted_net_export_mwh, 4),
        scheduled_net_export_mwh=_round(scheduled_net_export_mwh),
        model_recommended_net_export_mwh=_round(model_recommended_net_export_mwh),
        trader_instructed_net_export_mwh=_round(trader_instructed_net_export_mwh),
        executed_net_export_mwh=_round(executed_net_export_mwh),
        confirmed_metered_net_export_mwh=round(confirmed_metered_net_export_mwh, 4),
        commercial_imbalance_mwh=imbalance,
        direction=direction,
        system_price_gbp_per_mwh=system_price_gbp_per_mwh,
        indicative_imbalance_cashflow_gbp=cashflow,
        status=status,
        calculation_method=calculation_method,
        provenance=provenance,
        assumption_flags=assumption_flags or [],
    )


def _round(x: float | None, dp: int = 4) -> float | None:
    return None if x is None else round(x, dp)


class SystemImbalance(BaseModel):
    """The aggregate GB system imbalance (official Elexon settlement data)."""

    settlement_date: date | None = None
    settlement_period: int | None = None
    net_imbalance_volume_mwh: float | None = None
    direction: SystemDirection | None = None
    system_price_gbp_per_mwh: float | None = None
    published_at: datetime | None = None
    revision_status: str | None = None
    source: str = "elexon"
    provenance: str = "observed"
    warnings: list[str] = Field(default_factory=list)


class FrequencySummary(BaseModel):
    """Aggregated GB system-frequency observations for a display window."""

    latest_frequency_hz: float | None = None
    mean_frequency_hz: float | None = None
    min_frequency_hz: float | None = None
    max_frequency_hz: float | None = None
    deviation_from_50_hz: float | None = None
    seconds_below_49_9: int | None = None
    seconds_above_50_1: int | None = None
    observation_count: int = 0
    first_observation_at: datetime | None = None
    last_observation_at: datetime | None = None
    published_at: datetime | None = None
    source: str = "elexon"
    provenance: str = "observed"
    warnings: list[str] = Field(default_factory=list)


class BatteryState(BaseModel):
    """Confirmed physical battery state for the selected period."""

    soc_mwh: float | None = None
    net_power_mw: float | None = None
    confirmed_at: datetime | None = None


class BalanceContext(BaseModel):
    """Source / date / network provenance for the combined balance response."""

    settlement_date: date
    settlement_period: int
    requested_source: str
    actual_source: str
    requested_date: date
    actual_data_date: date
    network_used: bool = False
    cache_used: bool = False
    warnings: list[str] = Field(default_factory=list)


class BalanceSnapshot(BaseModel):
    """Combined balance snapshot with independent, individually-nullable blocks."""

    context: BalanceContext
    system: SystemImbalance | None = None
    frequency: FrequencySummary | None = None
    commercial: CommercialPosition | None = None
    battery: BatteryState | None = None
