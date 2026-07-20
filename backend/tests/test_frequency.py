"""System-frequency aggregation, scrubbing and source-isolation tests."""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import pytest
from gb_battery.data.frequency import aggregate_frequency, build_frequency_summary
from gb_battery.settlement import UTC


def _frame(values: list[float], interval_s: float = 15.0) -> pd.DataFrame:
    start = datetime(2025, 1, 15, 12, 0, tzinfo=UTC)
    return pd.DataFrame(
        {
            "measurement_time": [start + timedelta(seconds=i * interval_s) for i in range(len(values))],
            "frequency_hz": values,
        }
    )


def test_aggregation_basic_stats():
    df = _frame([50.02, 49.95, 50.05, 49.90, 50.00])
    s = aggregate_frequency(df, source="elexon", provenance="observed")
    assert s.observation_count == 5
    assert s.latest_frequency_hz == pytest.approx(50.00)
    assert s.mean_frequency_hz == pytest.approx(np.mean([50.02, 49.95, 50.05, 49.90, 50.00]), abs=1e-4)
    assert s.min_frequency_hz == pytest.approx(49.90)
    assert s.max_frequency_hz == pytest.approx(50.05)
    assert s.deviation_from_50_hz == pytest.approx(0.0, abs=1e-4)


def test_seconds_below_and_above():
    # 15 s interval: two below 49.9, one above 50.1.
    df = _frame([49.85, 49.80, 50.00, 50.20, 50.00])
    s = aggregate_frequency(df, source="elexon", provenance="observed")
    assert s.seconds_below_49_9 == 30  # 2 samples * 15 s
    assert s.seconds_above_50_1 == 15  # 1 sample * 15 s


def test_invalid_values_scrubbed():
    df = _frame([50.0, float("nan"), float("inf"), -float("inf"), 49.95, 999.0])
    s = aggregate_frequency(df, source="elexon", provenance="observed")
    # NaN/Inf and the out-of-range 999 are dropped; 2 valid samples remain.
    assert s.observation_count == 2
    assert s.max_frequency_hz == pytest.approx(50.0)


def test_missing_frequency_returns_null_plus_warning():
    s = aggregate_frequency(pd.DataFrame(), source="elexon", provenance="observed")
    assert s.latest_frequency_hz is None
    assert s.observation_count == 0
    assert s.warnings


def test_source_metadata_carried():
    s = aggregate_frequency(_frame([50.0, 50.0]), source="elexon", provenance="observed")
    assert s.source == "elexon"
    assert s.provenance == "observed"


@pytest.mark.parametrize("source", ["synthetic", "sample"])
def test_synthetic_and_sample_make_zero_network_calls(monkeypatch, source):
    def _boom(*a, **k):  # pragma: no cover - must never be called
        raise AssertionError("network call attempted in offline source")

    monkeypatch.setattr("gb_battery.data.http.ResilientClient.get_json", _boom)
    from datetime import date

    s = build_frequency_summary(date(2025, 1, 15), 20, source)
    assert s.source == source
    assert s.provenance == ("synthetic" if source == "synthetic" else "sample")
    assert s.observation_count > 0
    assert s.latest_frequency_hz is not None


def test_synthetic_is_deterministic():
    from datetime import date

    a = build_frequency_summary(date(2025, 1, 15), 20, "synthetic")
    b = build_frequency_summary(date(2025, 1, 15), 20, "synthetic")
    assert a.latest_frequency_hz == b.latest_frequency_hz
    assert a.mean_frequency_hz == b.mean_frequency_hz


def test_elexon_failure_does_not_fall_back_to_synthetic():
    from datetime import date

    class _FailingClient:
        def system_frequency(self, frm, to):
            raise RuntimeError("Elexon request failed")

    # Inject a failing client (live_only never reads cache) — no fallback allowed.
    s = build_frequency_summary(
        date(2025, 1, 15), 20, "elexon", network_policy="live_only", client=_FailingClient()
    )
    assert s.provenance == "unavailable"
    assert s.latest_frequency_hz is None
    assert any("failed" in w.lower() or "unavailable" in w.lower() for w in s.warnings)
