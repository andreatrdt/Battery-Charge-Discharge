"""GB system-frequency acquisition and aggregation.

Frequency is the physical grid frequency in Hz. It is acquired at high
resolution (Elexon ``/system/frequency``, ~15 s samples), normalised to UTC,
optionally cached, and aggregated to the selected Settlement Period before it is
sent to the frontend (raw sub-minute series are never shipped whole).

Source rules mirror the rest of the app:

* ``synthetic`` / ``sample`` never call the network — they generate deterministic,
  reproducible, plausible frequency series (labelled as such). The generated
  frequency is **not** a mechanical transform of NIV.
* ``elexon`` uses the real API; a failure returns an *unavailable* summary
  (null fields + warning), never a silent synthetic fallback.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from gb_battery.data.cache import ParquetCache
from gb_battery.data.elexon import ElexonClient
from gb_battery.data.settings import DataSettings, get_settings
from gb_battery.market.balance import FrequencySummary
from gb_battery.settlement import UTC, settlement_periods_for_day

# Nominal sample interval when it cannot be inferred from the data (seconds).
DEFAULT_SAMPLE_INTERVAL_S = 15.0


def _window_for(day: date, settlement_period: int | None) -> tuple[datetime, datetime]:
    """UTC [start, end) for a Settlement Period, or the whole settlement day."""
    periods = settlement_periods_for_day(day)
    if settlement_period is not None:
        for p in periods:
            if p.settlement_period == settlement_period:
                return p.start_utc, p.end_utc
    return periods[0].start_utc, periods[-1].end_utc


def _slice(df: pd.DataFrame, start: datetime, end: datetime) -> pd.DataFrame:
    t = pd.to_datetime(df["measurement_time"], utc=True)
    return df[(t >= start) & (t < end)]


def aggregate_frequency(
    df: pd.DataFrame,
    *,
    source: str,
    provenance: str,
    published_at: datetime | None = None,
    warnings: list[str] | None = None,
) -> FrequencySummary:
    """Aggregate a ``measurement_time`` / ``frequency_hz`` frame to a summary.

    Invalid samples (NaN / +-Inf frequencies, NaT timestamps) are scrubbed before
    any statistic is computed.
    """
    warnings = list(warnings or [])
    if df is None or df.empty or "frequency_hz" not in df.columns:
        warnings.append("No frequency samples available.")
        return FrequencySummary(source=source, provenance=provenance, warnings=warnings)

    clean = df.copy()
    clean["frequency_hz"] = pd.to_numeric(clean["frequency_hz"], errors="coerce")
    clean = clean.replace([np.inf, -np.inf], np.nan)
    if "measurement_time" in clean.columns:
        clean["measurement_time"] = pd.to_datetime(
            clean["measurement_time"], utc=True, errors="coerce"
        )
        clean = clean.dropna(subset=["measurement_time"])
        clean = clean.sort_values("measurement_time")
    clean = clean.dropna(subset=["frequency_hz"])
    # Physically implausible values are treated as missing.
    clean = clean[(clean["frequency_hz"] > 45.0) & (clean["frequency_hz"] < 55.0)]

    if clean.empty:
        warnings.append("No valid frequency samples in the window.")
        return FrequencySummary(source=source, provenance=provenance, warnings=warnings)

    freqs = clean["frequency_hz"].to_numpy(dtype=float)
    latest = float(freqs[-1])

    interval_s = DEFAULT_SAMPLE_INTERVAL_S
    first_at = last_at = None
    if "measurement_time" in clean.columns and len(clean) > 1:
        times = clean["measurement_time"]
        first_at = times.iloc[0].to_pydatetime()
        last_at = times.iloc[-1].to_pydatetime()
        gaps = times.diff().dropna().dt.total_seconds()
        med = float(gaps.median()) if len(gaps) else DEFAULT_SAMPLE_INTERVAL_S
        if med and med > 0:
            interval_s = med
    elif "measurement_time" in clean.columns and len(clean) == 1:
        first_at = last_at = clean["measurement_time"].iloc[0].to_pydatetime()

    below = int(round(float((freqs < 49.9).sum()) * interval_s))
    above = int(round(float((freqs > 50.1).sum()) * interval_s))

    return FrequencySummary(
        latest_frequency_hz=round(latest, 4),
        mean_frequency_hz=round(float(freqs.mean()), 4),
        min_frequency_hz=round(float(freqs.min()), 4),
        max_frequency_hz=round(float(freqs.max()), 4),
        deviation_from_50_hz=round(latest - 50.0, 4),
        seconds_below_49_9=below,
        seconds_above_50_1=above,
        observation_count=int(len(clean)),
        first_observation_at=first_at,
        last_observation_at=last_at,
        published_at=published_at,
        source=source,
        provenance=provenance,
        warnings=warnings,
    )


def _synthetic_frequency_frame(
    start: datetime, end: datetime, *, seed_key: str, interval_s: float = 15.0
) -> pd.DataFrame:
    """Deterministic, reproducible, plausible frequency samples for a window.

    A seeded mean-reverting (Ornstein–Uhlenbeck-like) walk around 50 Hz with a
    slow diurnal drift. Deterministic for a given (day, SP, source) key, and
    deliberately **not** a function of NIV.
    """
    seed = abs(hash(seed_key)) % (2**32)
    rng = np.random.default_rng(seed)
    n = max(1, int(round((end - start).total_seconds() / interval_s)))
    freq = 50.0
    theta, sigma = 0.05, 0.012  # reversion strength, step volatility
    hour = start.astimezone(UTC).hour + start.minute / 60.0
    # A small, smooth diurnal bias (tighter overnight, looser at peaks).
    drift = -0.02 * math.sin((hour - 6.0) / 24.0 * 2 * math.pi)
    rows = []
    for i in range(n):
        freq += theta * ((50.0 + drift) - freq) + sigma * rng.standard_normal()
        rows.append(
            {
                "measurement_time": start + timedelta(seconds=i * interval_s),
                "frequency_hz": round(freq, 4),
            }
        )
    return pd.DataFrame(rows)


def build_frequency_summary(
    day: date,
    settlement_period: int | None,
    source: str,
    *,
    network_policy: str = "live_with_cache",
    settings: DataSettings | None = None,
    client: ElexonClient | None = None,
    cache: ParquetCache | None = None,
) -> FrequencySummary:
    """Build an aggregated frequency summary for the source (never fabricates)."""
    settings = settings or get_settings()
    start, end = _window_for(day, settlement_period)

    if source in ("synthetic", "sample"):
        # Generate one deterministic whole-day frame (seeded by day+source) so
        # the per-SP KPI and the day series are always mutually consistent.
        day_start, day_end = _window_for(day, None)
        day_frame = _synthetic_frequency_frame(
            day_start, day_end, seed_key=f"{source}:{day.isoformat()}"
        )
        window = _slice(day_frame, start, end)
        return aggregate_frequency(
            window,
            source=source,
            provenance="synthetic" if source == "synthetic" else "sample",
            warnings=[],
        )

    if source != "elexon":
        return FrequencySummary(
            source=source,
            provenance="unavailable",
            warnings=[f"Unknown source '{source}'."],
        )

    # Elexon: real data only. A failure yields an explicit unavailable summary.
    if network_policy not in ("live_with_cache", "cache_only", "live_only"):
        return FrequencySummary(
            source="elexon", provenance="unavailable",
            warnings=[f"Unknown network_policy '{network_policy}'."],
        )
    client = client or ElexonClient(settings)
    cache = cache or ParquetCache(settings)
    cache_key = "elexon.frequency"
    key = f"{day.isoformat()}_sp{settlement_period or 'day'}"
    raw: pd.DataFrame | None = None
    published_at = None
    warnings: list[str] = []

    if network_policy in ("live_with_cache", "live_only"):
        try:
            raw = client.system_frequency(start, end)
            cache.put(cache_key, key, raw)
        except Exception as exc:  # noqa: BLE001 — surface, never substitute
            warnings.append(f"Elexon frequency request failed: {exc}")
            raw = None
    if (raw is None or raw.empty) and network_policy in ("live_with_cache", "cache_only"):
        cached = cache.get(cache_key, key)
        if cached is not None and not cached.empty:
            raw = cached
            warnings.append("Frequency served from cache.")

    if raw is None or raw.empty:
        return FrequencySummary(
            source="elexon",
            provenance="unavailable",
            warnings=warnings or ["Frequency unavailable."],
        )
    if "published_at" in raw.columns and raw["published_at"].notna().any():
        published_at = pd.to_datetime(raw["published_at"], utc=True).max().to_pydatetime()
    return aggregate_frequency(
        raw, source="elexon", provenance="observed",
        published_at=published_at, warnings=warnings,
    )


def build_frequency_day(
    day: date,
    source: str,
    *,
    network_policy: str = "live_with_cache",
    settings: DataSettings | None = None,
    client: ElexonClient | None = None,
    cache: ParquetCache | None = None,
) -> dict:
    """Per-Settlement-Period frequency series for a whole day (for the GB chart).

    Returns ``{"source", "provenance", "warnings", "periods": [{settlement_period,
    mean_frequency_hz, min_frequency_hz, max_frequency_hz}]}``. Never fabricates:
    an Elexon failure yields an empty series with a warning, not synthetic data.
    """
    settings = settings or get_settings()
    periods = settlement_periods_for_day(day)
    provenance = "synthetic" if source == "synthetic" else "sample" if source == "sample" else "observed"
    warnings: list[str] = []

    if source in ("synthetic", "sample"):
        day_start, day_end = periods[0].start_utc, periods[-1].end_utc
        day_frame = _synthetic_frequency_frame(
            day_start, day_end, seed_key=f"{source}:{day.isoformat()}"
        )
    elif source == "elexon":
        client = client or ElexonClient(settings)
        cache = cache or ParquetCache(settings)
        day_frame = None
        if network_policy in ("live_with_cache", "live_only"):
            try:
                day_frame = client.system_frequency(periods[0].start_utc, periods[-1].end_utc)
                cache.put("elexon.frequency", f"{day.isoformat()}_day", day_frame)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Elexon frequency request failed: {exc}")
                day_frame = None
        if (day_frame is None or day_frame.empty) and network_policy in (
            "live_with_cache", "cache_only"
        ):
            day_frame = cache.get("elexon.frequency", f"{day.isoformat()}_day")
        if day_frame is None or day_frame.empty:
            return {
                "source": "elexon", "provenance": "unavailable",
                "warnings": warnings or ["Frequency unavailable."], "periods": [],
            }
    else:
        return {"source": source, "provenance": "unavailable",
                "warnings": [f"Unknown source '{source}'."], "periods": []}

    out = []
    for p in periods:
        window = _slice(day_frame, p.start_utc, p.end_utc)
        summary = aggregate_frequency(window, source=source, provenance=provenance)
        out.append(
            {
                "settlement_period": p.settlement_period,
                "mean_frequency_hz": summary.mean_frequency_hz,
                "min_frequency_hz": summary.min_frequency_hz,
                "max_frequency_hz": summary.max_frequency_hz,
            }
        )
    return {"source": source, "provenance": provenance, "warnings": warnings, "periods": out}
