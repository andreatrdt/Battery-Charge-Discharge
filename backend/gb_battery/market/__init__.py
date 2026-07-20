"""GB balance domain: three rigorously separated concepts.

* **Commercial Imbalance** — this battery portfolio's own imbalance between what it
  contracted to deliver and what it physically delivered (a private, paper figure).
* **GB System Imbalance** — the aggregate imbalance of the GB system, expressed as
  Net Imbalance Volume (NIV) from official Elexon settlement data.
* **System Frequency** — the physical grid frequency in Hz.

These three concepts are never merged and never inferred from one another.
"""

from gb_battery.market.balance import (
    COMMERCIAL_TOLERANCE_MWH,
    NIV_TOLERANCE_MWH,
    BalanceContext,
    BalanceSnapshot,
    BatteryState,
    CommercialPosition,
    FrequencySummary,
    SystemImbalance,
    classify_commercial,
    classify_system,
    commercial_position,
    metered_net_export_from_soc,
)

__all__ = [
    "COMMERCIAL_TOLERANCE_MWH",
    "NIV_TOLERANCE_MWH",
    "BalanceContext",
    "BalanceSnapshot",
    "BatteryState",
    "CommercialPosition",
    "FrequencySummary",
    "SystemImbalance",
    "classify_commercial",
    "classify_system",
    "commercial_position",
    "metered_net_export_from_soc",
]
