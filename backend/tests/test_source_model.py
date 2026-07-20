"""Unified source model: no silent fallback, provenance, JSON safety."""

from __future__ import annotations

import json
import math
from datetime import date

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from gb_battery.api.main import app
from gb_battery.data.market_snapshot import build_market_snapshot
from gb_battery.data.serialize import frame_to_records, json_safe

client = TestClient(app)


# ------------------------------------------------------------------ JSON safety


def test_json_safe_scrubs_nan_inf_nat_na() -> None:
    assert json_safe(float("nan")) is None
    assert json_safe(float("inf")) is None
    assert json_safe(float("-inf")) is None
    assert json_safe(pd.NaT) is None
    assert json_safe(pd.NA) is None
    assert json_safe(np.float64("nan")) is None
    assert json_safe(np.int64(5)) == 5
    assert json_safe(np.bool_(True)) is True
    assert json_safe({"a": float("nan"), "b": [1.0, float("inf")]}) == {"a": None, "b": [1.0, None]}


def test_frame_to_records_is_json_valid() -> None:
    frame = pd.DataFrame(
        {
            "settlement_period": [1, 2],
            "wholesale_price": [50.0, float("nan")],
            "x": [np.inf, 3.0],
            "t": [pd.Timestamp("2025-01-15T00:00:00Z"), pd.NaT],
        }
    )
    records = frame_to_records(frame)
    s = json.dumps(records)  # must not raise
    assert "NaN" not in s and "Infinity" not in s
    assert records[1]["wholesale_price"] is None
    assert records[0]["x"] is None


# ---------------------------------------------------------------- source model


def test_synthetic_and_sample_never_touch_network() -> None:
    for src in ("synthetic", "sample"):
        snap = build_market_snapshot(date(2025, 1, 15), source=src)
        assert snap.actual_source == src
        assert snap.network_used is False
        assert snap.cache_used is False


def test_sample_substitutes_missing_day_with_warning() -> None:
    snap = build_market_snapshot(date(2035, 6, 1), source="sample")
    prov = snap.provenance()
    assert prov["actual_source"] == "sample"
    assert prov["date_substituted"] is True
    assert prov["actual_data_day"] != prov["requested_day"]
    assert snap.warnings


def test_elexon_cache_only_missing_raises_not_synthetic() -> None:
    from gb_battery.data.http import DataSourceError

    # A day with no cached Elexon data under cache_only must fail explicitly.
    with pytest.raises(DataSourceError):
        build_market_snapshot(date(1991, 1, 1), source="elexon", network_policy="cache_only")


def test_market_endpoint_reports_full_provenance() -> None:
    r = client.get("/api/market/snapshot", params={"day": "2025-01-15", "source": "synthetic"})
    assert r.status_code == 200
    prov = r.json()["provenance"]
    for key in (
        "requested_source", "actual_source", "requested_day", "actual_data_day",
        "date_substituted", "network_used", "cache_used",
    ):
        assert key in prov
    assert prov["actual_source"] == "synthetic"
    # No NaN tokens anywhere in the payload.
    assert "NaN" not in r.text


def test_market_endpoint_rejects_unknown_source() -> None:
    r = client.get("/api/market/snapshot", params={"day": "2025-01-15", "source": "bogus"})
    assert r.status_code == 400


def test_market_endpoint_elexon_unavailable_is_502_not_500() -> None:
    r = client.get(
        "/api/market/snapshot",
        params={"day": "1991-01-01", "source": "elexon", "network_policy": "cache_only"},
    )
    assert r.status_code == 502  # explicit upstream failure, never an unexplained 500
    detail = r.json()["detail"]
    assert detail["requested_source"] == "elexon"


def test_missing_series_are_null_not_nan() -> None:
    # Synthetic frame has all series; assert every numeric value is finite or None.
    r = client.get("/api/market/snapshot", params={"day": "2025-01-15", "source": "sample"})
    for row in r.json()["periods"]:
        for v in row.values():
            if isinstance(v, float):
                assert math.isfinite(v)
