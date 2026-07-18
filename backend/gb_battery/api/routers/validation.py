"""Forecast-validation endpoints: benchmarks, metrics, heatmaps.

Every comparison is point-in-time (see ``replay/validation.py``): a forecast
for period *t* uses only records published at or before *t*'s gate, and every
model's *economic* value is measured by running the identical rolling replay.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from gb_battery.battery.config import BatteryConfig
from gb_battery.replay.engine import ReplayOptions
from gb_battery.replay.pit import store_from_elexon, store_from_sample, store_from_synthetic
from gb_battery.replay.validation import (
    PRICE_BENCHMARKS,
    validate_fundamentals,
    validate_price_forecasts,
)

router = APIRouter(prefix="/api", tags=["validation"])


class ForecastValidationRequest(BaseModel):
    source: str = "sample"  # sample | synthetic | elexon
    day: date = date(2025, 1, 20)
    n_days: int = Field(default=1, ge=1, le=3)
    history_days: int = Field(default=14, ge=3, le=60)
    seed: int = 42
    models: list[str] = Field(
        default_factory=lambda: ["persistence", "lag_same_sp_1d", "rolling_median_7d", "internal_model"]
    )
    with_strategy_pnl: bool = True
    config: BatteryConfig = Field(default_factory=BatteryConfig)


@router.get("/validation/models")
def validation_models() -> dict:
    return {"models": PRICE_BENCHMARKS}


@router.post("/validation/forecast")
def forecast_validation(req: ForecastValidationRequest) -> dict:
    unknown = [m for m in req.models if m not in PRICE_BENCHMARKS]
    if unknown:
        raise HTTPException(400, f"Unknown models {unknown}; choose from {PRICE_BENCHMARKS}")
    options = ReplayOptions(source=req.source if req.source != "elexon" else "elexon")
    forward = req.n_days - 1 + 3  # cover cross-day horizons inside the strategy runs
    try:
        if req.source == "synthetic":
            store = store_from_synthetic(
                req.day, history_days=req.history_days, forward_days=forward, seed=req.seed
            )
            day = req.day
        elif req.source == "sample":
            store, day = store_from_sample(req.day)
        elif req.source == "elexon":
            store = store_from_elexon(req.day, history_days=req.history_days, forward_days=forward)
            day = req.day
        else:
            raise HTTPException(400, f"Unknown source '{req.source}'")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not build the validation store: {exc}") from exc

    price = validate_price_forecasts(
        store,
        day,
        n_days=req.n_days,
        models=req.models,
        config=req.config,
        with_strategy_pnl=req.with_strategy_pnl,
        options=options,
    )
    fundamentals = validate_fundamentals(store, day, n_days=req.n_days)
    return {
        "day": day.isoformat(),
        "n_days": req.n_days,
        "source": req.source,
        "price": price,
        "fundamentals": fundamentals,
        "note": (
            "All forecasts are point-in-time reconstructions or published day-ahead "
            "records; no future information enters any comparison. Strategy P&L "
            "reruns the identical rolling replay per model — statistical accuracy "
            "alone never declares a winner."
        ),
    }
