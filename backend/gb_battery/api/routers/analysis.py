"""Backtest & forecast-validation endpoints."""

from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, HTTPException

from gb_battery.api.schemas import BacktestRequest, ForecastValidateRequest
from gb_battery.backtest import compare_strategies
from gb_battery.demo.sample_data import generate_synthetic_history, load_sample
from gb_battery.forecast import (
    BaselineForecaster,
    GradientBoostingQuantileForecaster,
    expanding_window_validate,
)

router = APIRouter(prefix="/api", tags=["analysis"])

_FORECASTERS = {
    "lag1d": lambda: BaselineForecaster("lag1d"),
    "lag7d": lambda: BaselineForecaster("lag7d"),
    "roll": lambda: BaselineForecaster("roll"),
    "gbm": lambda: GradientBoostingQuantileForecaster(),
}


# The daily backtest needs a day-ahead price forecast AND a realised outturn per
# period. Elexon MID publishes only the realised reference price — there is no
# public day-ahead *price* forecast series — so a like-for-like backtest cannot be
# built from it without inventing a forecast. That would be exactly the silent
# substitution this app forbids, hence an explicit unsupported response.
BACKTEST_SUPPORTED_SOURCES = ("synthetic", "sample")
BACKTEST_UNSUPPORTED_REASON = {
    "elexon": (
        "The daily backtest needs both a day-ahead price forecast and a realised "
        "outturn for every Settlement Period. Elexon publishes the realised MID "
        "reference price but no day-ahead price-forecast series, so a like-for-like "
        "backtest cannot be built from it without fabricating a forecast. Use the "
        "Replay & Live page for point-in-time Elexon analysis, or switch the source "
        "to Synthetic or Frozen sample."
    )
}


def _backtest_history(source: str, days: int) -> tuple[pd.DataFrame, dict]:
    """Return (history, provenance) for a supported backtest source.

    Never substitutes another source: an unsupported source raises before any
    data is produced.
    """
    warnings: list[str] = []
    if source == "synthetic":
        hist = generate_synthetic_history(days=days)
    elif source == "sample":
        hist = load_sample()
        available = sorted(pd.to_datetime(hist["settlement_date"]).dt.date.unique())
        if len(available) > days:
            keep = set(available[:days])
            hist = hist[pd.to_datetime(hist["settlement_date"]).dt.date.isin(keep)]
        elif len(available) < days:
            warnings.append(
                f"The bundled sample holds {len(available)} days; the requested "
                f"{days} were truncated to the available range."
            )
    else:  # pragma: no cover - guarded by the caller
        raise ValueError(f"Unsupported backtest source '{source}'")

    dates = sorted(pd.to_datetime(hist["settlement_date"]).dt.date.unique())
    provenance = {
        "requested_source": source,
        "actual_source": source,
        "network_used": False,
        "cache_used": False,
        "requested_days": days,
        "actual_days": len(dates),
        "requested_day": dates[0].isoformat() if dates else None,
        "actual_data_day": dates[0].isoformat() if dates else None,
        "actual_data_day_start": dates[0].isoformat() if dates else None,
        "actual_data_day_end": dates[-1].isoformat() if dates else None,
        "date_substituted": len(dates) != days,
        "warnings": warnings,
    }
    return hist, provenance


@router.post("/backtest")
def backtest_endpoint(req: BacktestRequest) -> dict:
    if req.source not in BACKTEST_SUPPORTED_SOURCES:
        raise HTTPException(
            422,
            {
                "status": "unsupported_source",
                "requested_source": req.source,
                "actual_source": None,
                "supported_sources": list(BACKTEST_SUPPORTED_SOURCES),
                "reason": BACKTEST_UNSUPPORTED_REASON.get(
                    req.source, f"Unknown source '{req.source}'."
                ),
                "network_used": False,
                "cache_used": False,
                "warnings": ["No backtest was run; no data was substituted."],
            },
        )
    hist, provenance = _backtest_history(req.source, req.days)
    cmp = compare_strategies(
        req.config, hist, strategies=req.strategies,
        up_availability_price=req.up_availability_price,
        down_availability_price=req.down_availability_price,
    )
    # Provide the deterministic optimiser's equity curve for charting.
    det = cmp["results"].get("deterministic_optimiser")
    equity = []
    if det is not None and not det.ledger.empty:
        cum = det.ledger["total_pnl_gbp"].cumsum()
        equity = [
            {"index": i, "date": str(r["settlement_date"]), "sp": int(r["settlement_period"]),
             "cumulative_pnl": round(float(c), 2)}
            for i, ((_, r), c) in enumerate(zip(det.ledger.iterrows(), cum, strict=True))
        ]
    return {
        "table": cmp["table"],
        "perfect_foresight_pnl_gbp": cmp["perfect_foresight_pnl_gbp"],
        "leakage_audit": cmp["leakage_audit"],
        "equity_curve": equity,
        "provenance": provenance,
    }


@router.post("/forecast/validate")
def forecast_validate_endpoint(req: ForecastValidateRequest) -> dict:
    hist = generate_synthetic_history(days=req.days)
    reports = []
    for name in req.models:
        if name not in _FORECASTERS:
            raise HTTPException(400, f"Unknown model '{name}'")
        rep = expanding_window_validate(
            hist, _FORECASTERS[name], name,
            n_splits=req.n_splits, test_days=req.test_days,
        )
        reports.append(
            {
                "model": name,
                "mean_mae": round(rep.mean_mae, 3),
                "mean_rmse": round(rep.mean_rmse, 3),
                "mean_pinball": {str(q): round(v, 3) for q, v in rep.mean_pinball().items()},
                "n_folds": len(rep.folds),
                "folds": [
                    {"train_end": f.train_end, "test_start": f.test_start,
                     "test_end": f.test_end, "mae": round(f.mae, 3), "rmse": round(f.rmse, 3)}
                    for f in rep.folds
                ],
            }
        )
    return {"reports": reports}
