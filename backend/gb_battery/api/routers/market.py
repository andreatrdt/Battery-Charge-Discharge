"""Market overview & configuration endpoints."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException, Query

from gb_battery.api.services import snapshot_to_payload
from gb_battery.battery.config import BatteryConfig
from gb_battery.data.cache import ParquetCache
from gb_battery.data.http import DataSourceError
from gb_battery.data.market_snapshot import build_market_snapshot
from gb_battery.data.settings import DataSettings, get_settings

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
