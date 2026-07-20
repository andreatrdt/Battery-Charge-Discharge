"""Market overview, combined balance & configuration endpoints."""

from __future__ import annotations

from datetime import date
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from gb_battery.api.services import snapshot_to_payload
from gb_battery.battery.config import BatteryConfig
from gb_battery.data.cache import ParquetCache
from gb_battery.data.frequency import build_frequency_day, build_frequency_summary
from gb_battery.data.http import DataSourceError
from gb_battery.data.market_snapshot import MarketSnapshot, build_market_snapshot
from gb_battery.data.serialize import json_safe
from gb_battery.data.settings import DataSettings, get_settings
from gb_battery.market.balance import (
    BalanceContext,
    BalanceSnapshot,
    BatteryState,
    CommercialPosition,
    SystemImbalance,
    classify_system,
)
from gb_battery.replay.session import REGISTRY

router = APIRouter(prefix="/api", tags=["market"])


@router.get("/config/default")
def default_config() -> dict:
    return BatteryConfig().model_dump(mode="json")


@router.get("/market/snapshot")
def market_snapshot(
    day: date = Query(default=date(2025, 1, 14)),
    source: str = Query(default="synthetic", description="synthetic | sample | elexon"),
    network_policy: str = Query(
        default="live_with_cache", description="live_with_cache | cache_only | live_only"
    ),
    offline: bool = Query(default=False, description="Legacy: force synthetic for the elexon source"),
) -> dict:
    """Per-period market snapshot for the chosen source.

    Synthetic and sample never touch the network; Elexon failures surface as a
    clear 502 (never a silent synthetic substitution). The response's
    ``provenance`` block reports requested vs actual source, network/cache use
    and any date substitution.
    """
    if source not in ("synthetic", "sample", "elexon"):
        raise HTTPException(400, f"Unknown source '{source}' (synthetic | sample | elexon)")
    settings = DataSettings(offline=offline)
    try:
        snap = build_market_snapshot(
            day, source=source, network_policy=network_policy, settings=settings
        )
    except DataSourceError as exc:
        # Upstream data genuinely unavailable — an explicit, actionable status.
        raise HTTPException(
            502,
            {
                "message": str(exc),
                "requested_source": source,
                "hint": "Retry Elexon, use network_policy=cache_only, or switch to source=sample/synthetic.",
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return snapshot_to_payload(snap)


def _system_from_snapshot(snap: MarketSnapshot, settlement_period: int) -> SystemImbalance | None:
    """Extract GB System Imbalance (NIV + system price) for one period."""
    df = snap.frame
    rows = df[df["settlement_period"] == settlement_period]
    if rows.empty:
        return None
    r = rows.iloc[0]
    niv = _num(r.get("net_imbalance_volume"))
    sysp = _num(r.get("system_price"))
    if niv is None and sysp is None:
        return None
    published = r.get("system_price_published_at")
    published_at = None
    if published is not None and not pd.isna(published):
        published_at = pd.to_datetime(published, utc=True).to_pydatetime()
    provenance = "observed" if snap.actual_source == "elexon" else snap.actual_source
    return SystemImbalance(
        settlement_date=snap.day,
        settlement_period=settlement_period,
        net_imbalance_volume_mwh=niv,
        direction=classify_system(niv),
        system_price_gbp_per_mwh=sysp,
        published_at=published_at,
        source=snap.actual_source,
        provenance=provenance,
        warnings=[],
    )


def _num(x: Any) -> float | None:
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # scrub NaN


def _commercial_and_battery(
    replay_session_id: str, day: date, settlement_period: int, system_price: float | None
) -> tuple[CommercialPosition | None, BatteryState | None, list[str]]:
    """Pull the paper Commercial Imbalance and battery state from a session."""
    session = REGISTRY.get(replay_session_id)
    if session is None:
        return (
            CommercialPosition.unavailable("Replay session not found (may need recovery)."),
            None,
            [f"Replay session '{replay_session_id}' not in memory."],
        )
    eng = session.engine
    match = next(
        (
            d
            for d in eng.decisions
            if d.settlement_period == settlement_period and d.settlement_date == day
        ),
        None,
    )
    if match is None or match.commercial is None:
        battery = BatteryState(soc_mwh=round(eng.soc, 4))
        return (
            CommercialPosition.unavailable("No committed decision for this period yet."),
            battery,
            [],
        )
    commercial = match.commercial
    if commercial.status != "unavailable" and system_price is not None:
        imbalance = commercial.commercial_imbalance_mwh or 0.0
        commercial = commercial.model_copy(
            update={
                "system_price_gbp_per_mwh": system_price,
                "indicative_imbalance_cashflow_gbp": round(imbalance * system_price, 4),
            }
        )
    net_power = round(match.discharge_mw - match.charge_mw, 4)
    confirmed_at = match.physical_state.confirmed_at if match.physical_state else None
    battery = BatteryState(
        soc_mwh=round(match.soc_after_mwh, 4),
        net_power_mw=net_power,
        confirmed_at=confirmed_at,
    )
    return commercial, battery, []


@router.get("/market/balance")
def market_balance(
    day: date = Query(default=date(2025, 1, 14)),
    settlement_period: int = Query(default=1, ge=1, le=50),
    source: str = Query(default="synthetic", description="synthetic | sample | elexon"),
    network_policy: str = Query(default="live_with_cache"),
    replay_session_id: str | None = Query(default=None),
) -> dict:
    """Combined GB balance snapshot for one Settlement Period.

    Returns three independent, individually-nullable blocks — GB System Imbalance
    (NIV), System Frequency and this portfolio's paper Commercial Imbalance — plus
    battery state. A failure in one block never fails the whole response: the
    unavailable block is ``null`` with a warning, and the rest is still served.
    """
    if source not in ("synthetic", "sample", "elexon"):
        raise HTTPException(400, f"Unknown source '{source}' (synthetic | sample | elexon)")

    warnings: list[str] = []
    settings = get_settings()

    # System block (via the resilient snapshot; an Elexon failure degrades to null).
    system: SystemImbalance | None = None
    actual_source = source
    network_used = cache_used = False
    actual_data_date = day
    try:
        snap = build_market_snapshot(day, source=source, network_policy=network_policy)
        actual_source = snap.actual_source
        network_used = snap.network_used
        cache_used = snap.cache_used
        actual_data_date = snap.day
        system = _system_from_snapshot(snap, settlement_period)
        if system is None:
            warnings.append("GB System Imbalance unavailable for this period.")
    except DataSourceError as exc:
        warnings.append(f"GB System Imbalance unavailable: {exc}")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    # Frequency block (independent; never falls back to synthetic on failure).
    frequency = build_frequency_summary(
        actual_data_date, settlement_period, source, network_policy=network_policy, settings=settings
    )

    # Commercial + battery (only from a live replay/trader session).
    system_price = system.system_price_gbp_per_mwh if system else None
    commercial: CommercialPosition | None = None
    battery: BatteryState | None = None
    if replay_session_id:
        commercial, battery, comm_warnings = _commercial_and_battery(
            replay_session_id, actual_data_date, settlement_period, system_price
        )
        warnings.extend(comm_warnings)
    else:
        commercial = CommercialPosition.unavailable(
            "No replay/trader session — public data cannot know this portfolio's "
            "contracts or metering."
        )

    snapshot = BalanceSnapshot(
        context=BalanceContext(
            settlement_date=actual_data_date,
            settlement_period=settlement_period,
            requested_source=source,
            actual_source=actual_source,
            requested_date=day,
            actual_data_date=actual_data_date,
            network_used=network_used,
            cache_used=cache_used,
            warnings=warnings,
        ),
        system=system,
        frequency=frequency,
        commercial=commercial,
        battery=battery,
    )
    return json_safe(snapshot.model_dump(mode="json"))


@router.get("/market/frequency")
def market_frequency(
    day: date = Query(default=date(2025, 1, 14)),
    source: str = Query(default="synthetic"),
    network_policy: str = Query(default="live_with_cache"),
) -> dict:
    """Per-Settlement-Period frequency series for the whole day (GB System chart)."""
    if source not in ("synthetic", "sample", "elexon"):
        raise HTTPException(400, f"Unknown source '{source}' (synthetic | sample | elexon)")
    return json_safe(build_frequency_day(day, source, network_policy=network_policy))


@router.get("/market/status")
def data_status() -> dict:
    """Last successful update per cached source (for the data-freshness panel)."""
    settings = get_settings()
    cache = ParquetCache(settings)
    entries = cache.all_entries()
    return {
        "offline": settings.offline,
        "stale_after_hours": settings.stale_after_hours,
        "sources": [
            {
                "source": e.source,
                "key": e.key,
                "rows": e.rows,
                "retrieved_at": e.retrieved_at.isoformat() if e.retrieved_at else None,
                "stale": e.is_stale(settings.stale_after_hours),
            }
            for e in entries
        ],
    }
