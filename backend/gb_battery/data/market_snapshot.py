"""Assemble a resilient per-period market snapshot for a settlement date.

Each source (MID, system prices, demand forecast, wind/solar forecast, generation
mix) is fetched independently. If a source fails or the app is offline, that series
degrades gracefully to a cached value or a clearly-labelled synthetic estimate — the
whole snapshot never fails because of one bad source. Per-series provenance and the
last successful update time are recorded for the UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import pandas as pd

from gb_battery.data.cache import ParquetCache
from gb_battery.data.elexon import ElexonClient
from gb_battery.data.settings import DataSettings, get_settings
from gb_battery.demo.scenarios import _fundamentals, diurnal_price_shape
from gb_battery.lineage import DataKind
from gb_battery.optimiser.inputs import OptimisationInputs, PeriodInput, RevenueStreams
from gb_battery.settlement import UTC, settlement_periods_for_day


@dataclass
class SourceStatus:
    source: str
    ok: bool
    kind: DataKind
    detail: str = ""
    retrieved_at: datetime | None = None


@dataclass
class MarketSnapshot:
    day: date
    frame: pd.DataFrame  # per-period wide frame
    statuses: list[SourceStatus] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Provenance (unified source model). ``day`` above == ``actual_data_day``.
    requested_source: str = "elexon"
    actual_source: str = "elexon"
    requested_day: date | None = None
    network_used: bool = False
    cache_used: bool = False

    def provenance(self) -> dict:
        """Source/network/cache/date provenance for the API and UI."""
        return {
            "requested_source": self.requested_source,
            "actual_source": self.actual_source,
            "requested_day": (self.requested_day or self.day).isoformat(),
            "actual_data_day": self.day.isoformat(),
            "date_substituted": (self.requested_day or self.day) != self.day,
            "network_used": self.network_used,
            "cache_used": self.cache_used,
        }

    def to_optimisation_inputs(
        self,
        *,
        upward_availability_price: float = 6.0,
        downward_availability_price: float = 4.0,
        revenue_streams: RevenueStreams | None = None,
        price_sigma_frac: float = 0.15,
    ) -> OptimisationInputs:
        """Convert the snapshot into optimiser inputs."""
        periods = {p.settlement_period: p for p in settlement_periods_for_day(self.day)}
        rows: list[PeriodInput] = []
        wholesale_kind = _kind_for(self.statuses, "wholesale")
        for _, r in self.frame.sort_values("settlement_period").iterrows():
            sp = int(r["settlement_period"])
            per = periods.get(sp)
            if per is None:
                continue
            price = _num(r.get("wholesale_price"))
            sysp = _num(r.get("system_price"))
            demand = _num(r.get("demand_forecast_mw"))
            wind = _num(r.get("wind_forecast_mw"))
            solar = _num(r.get("solar_forecast_mw"))
            residual = None
            if demand is not None:
                residual = demand - (wind or 0.0) - (solar or 0.0)
            prob_short = None
            if residual is not None:
                prob_short = min(max((residual - 20000) / 15000.0, 0.02), 0.98)
            rows.append(
                PeriodInput(
                    settlement_date=self.day,
                    settlement_period=sp,
                    start_utc=per.start_utc,
                    end_utc=per.end_utc,
                    duration_hours=per.duration_hours,
                    wholesale_price=price if price is not None else 0.0,
                    wholesale_price_sigma=(abs(price) * price_sigma_frac + 3.0) if price is not None else 5.0,
                    wholesale_price_kind=wholesale_kind,
                    system_price=sysp,
                    prob_short=round(prob_short, 3) if prob_short is not None else None,
                    expected_imbalance_price=sysp,
                    system_price_kind=_kind_for(self.statuses, "system_price"),
                    upward_availability_price=upward_availability_price,
                    downward_availability_price=downward_availability_price,
                    availability_price_kind=DataKind.ASSUMPTION,
                    expected_bm_up_margin_gbp_per_mw=1.0,
                    expected_bm_down_margin_gbp_per_mw=1.0,
                    bm_kind=DataKind.ESTIMATED,
                    demand_forecast_mw=demand,
                    wind_forecast_mw=wind,
                    solar_forecast_mw=solar,
                    residual_demand_mw=round(residual, 1) if residual is not None else None,
                )
            )
        return OptimisationInputs(periods=rows, revenue_streams=revenue_streams or RevenueStreams())


def _num(x: Any) -> float | None:
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _kind_for(statuses: list[SourceStatus], key: str) -> DataKind:
    for s in statuses:
        if s.source == key:
            return s.kind
    return DataKind.FORECAST


def _synthetic_niv(sp: int, residual_mw: float, *, seed_key: str) -> float:
    """Deterministic, plausible synthetic Net Imbalance Volume (MWh).

    Driven by residual demand (a tight system tends to be short) plus a small
    seeded component so it is not a rigid function of any single series. It is
    generated independently of frequency — the two must never be identical.
    """
    import numpy as np

    rng = np.random.default_rng(abs(hash(f"{seed_key}:{sp}")) % (2**32))
    base = (residual_mw - 24000.0) / 26.0
    return round(float(base + rng.normal(0.0, 60.0)), 1)


def _synthetic_frame(day: date) -> pd.DataFrame:
    periods = settlement_periods_for_day(day)
    n = len(periods)
    rows = []
    for p in periods:
        demand, wind, solar = _fundamentals(p.settlement_period, n)
        price = diurnal_price_shape(p.settlement_period, n)
        residual = demand - wind - solar
        rows.append(
            {
                "settlement_period": p.settlement_period,
                "start_utc": p.start_utc,
                "wholesale_price": price,
                "system_price": price + (12.0 if residual > 25000 else -8.0),
                "net_imbalance_volume": _synthetic_niv(
                    p.settlement_period, residual, seed_key=f"synthetic:{day.isoformat()}"
                ),
                "system_price_published_at": None,
                "demand_forecast_mw": demand,
                "wind_forecast_mw": wind,
                "solar_forecast_mw": solar,
            }
        )
    return pd.DataFrame(rows)


MARKET_COLUMNS = [
    "wholesale_price",
    "system_price",
    "net_imbalance_volume",
    "system_price_published_at",
    "demand_forecast_mw",
    "wind_forecast_mw",
    "solar_forecast_mw",
]


def build_market_snapshot(
    day: date,
    source: str = "elexon",
    *,
    network_policy: str = "live_with_cache",
    settings: DataSettings | None = None,
    client: ElexonClient | None = None,
    cache: ParquetCache | None = None,
) -> MarketSnapshot:
    """Build a per-period market snapshot for one explicit source.

    ``source`` is one of ``synthetic`` | ``sample`` | ``elexon`` and is honoured
    exactly: synthetic and sample never touch the network; Elexon failures are
    reported (never silently replaced with synthetic values). ``network_policy``
    (``live_with_cache`` | ``cache_only`` | ``live_only``) applies only to the
    Elexon source. The returned snapshot always states its true provenance.
    """
    settings = settings or get_settings()
    # Back-compat: a caller that set the legacy ``offline`` flag and asked for
    # Elexon gets synthetic (the old offline behaviour) — an explicit
    # synthetic/sample source is unaffected by the flag.
    if settings.offline and source == "elexon":
        source = "synthetic"

    if source == "synthetic":
        return _synthetic_snapshot(day)
    if source == "sample":
        return _sample_snapshot(day)
    if source == "elexon":
        return _elexon_snapshot(day, network_policy, settings, client, cache)
    raise ValueError(f"Unknown source '{source}' (choose synthetic | sample | elexon)")


def _synthetic_snapshot(day: date) -> MarketSnapshot:
    frame = _synthetic_frame(day)
    statuses = [
        SourceStatus(name, True, DataKind.SYNTHETIC, "generated")
        for name in ("wholesale", "system_price", "demand", "wind_solar")
    ]
    return MarketSnapshot(
        day, frame, statuses,
        warnings=["Synthetic generated data — not from any market source."],
        requested_source="synthetic", actual_source="synthetic", requested_day=day,
        network_used=False, cache_used=False,
    )


def _sample_snapshot(day: date) -> MarketSnapshot:
    from gb_battery.demo.sample_data import load_sample

    hist = load_sample()
    available = sorted(pd.to_datetime(hist["settlement_date"]).dt.date.unique())
    warnings: list[str] = []
    actual_day = day
    if day not in available:
        actual_day = available[-1]
        warnings.append(
            f"Requested day {day.isoformat()} is not in the bundled sample; "
            f"substituted the nearest available sample day {actual_day.isoformat()}."
        )
    rows = hist[pd.to_datetime(hist["settlement_date"]).dt.date == actual_day].copy()
    for col in MARKET_COLUMNS:
        if col not in rows.columns:
            rows[col] = pd.NA
    # Bundled sample carries no NIV; synthesise a deterministic one (labelled
    # sample) from residual demand so the offline demo can show GB System state.
    if rows["net_imbalance_volume"].isna().all():
        rows["net_imbalance_volume"] = [
            _synthetic_niv(
                int(r["settlement_period"]),
                float(r.get("demand_forecast_mw") or 0.0)
                - float(r.get("wind_forecast_mw") or 0.0)
                - float(r.get("solar_forecast_mw") or 0.0),
                seed_key=f"sample:{actual_day.isoformat()}",
            )
            for _, r in rows.iterrows()
        ]
    keep = ["settlement_period", "start_utc", *MARKET_COLUMNS]
    frame = rows[keep].sort_values("settlement_period").reset_index(drop=True)
    statuses = [
        SourceStatus(name, True, DataKind.SYNTHETIC, "bundled sample")
        for name in ("wholesale", "system_price", "demand", "wind_solar")
    ]
    return MarketSnapshot(
        actual_day, frame, statuses, warnings,
        requested_source="sample", actual_source="sample", requested_day=day,
        network_used=False, cache_used=False,
    )


def _elexon_snapshot(
    day: date,
    network_policy: str,
    settings: DataSettings,
    client: ElexonClient | None,
    cache: ParquetCache | None,
) -> MarketSnapshot:
    if network_policy not in ("live_with_cache", "cache_only", "live_only"):
        raise ValueError(f"Unknown network_policy '{network_policy}'")
    client = client or ElexonClient(settings)
    cache = cache or ParquetCache(settings)
    frm = datetime(day.year, day.month, day.day, 0, 0, tzinfo=UTC)
    to = frm.replace(hour=23, minute=59)
    statuses: list[SourceStatus] = []
    warnings: list[str] = []
    net = {"used": False}
    cch = {"used": False}

    base = pd.DataFrame(
        {
            "settlement_period": [p.settlement_period for p in settlement_periods_for_day(day)],
            "start_utc": [p.start_utc for p in settlement_periods_for_day(day)],
        }
    )

    def _series(
        name: str, cache_key: str, cols: list[str], observed_kind: DataKind, fetch
    ) -> None:
        """Fill ``cols`` for one Elexon series honouring the network policy.

        On failure the columns are left null and a failed status is recorded —
        never silently replaced with synthetic values.
        """
        nonlocal base
        df: pd.DataFrame | None = None
        retrieved_at = None
        detail = ""
        used_cache = False
        if network_policy in ("live_with_cache", "live_only"):
            try:
                net["used"] = True
                df = fetch()
                retrieved_at = df["retrieved_at"].iloc[0] if "retrieved_at" in df and len(df) else None
                cache.put(cache_key, day.isoformat(), df, retrieved_at)  # best-effort
                detail = "live"
            except Exception as exc:  # noqa: BLE001 — surface, do not substitute
                detail = f"live fetch failed: {exc}"
                df = None
        if df is None and network_policy in ("live_with_cache", "cache_only"):
            cached = cache.get(cache_key, day.isoformat())
            if cached is not None and not cached.empty:
                df = cached
                used_cache = True
                cch["used"] = True
                entry = cache.entry(cache_key, day.isoformat())
                retrieved_at = entry.retrieved_at if entry else None
                detail = (detail + "; " if detail else "") + "served from cache"
        if df is None or df.empty:
            statuses.append(SourceStatus(name, False, DataKind.MISSING, detail or "unavailable"))
            warnings.append(f"{name} unavailable ({detail or 'no data'}).")
            return
        keep = ["settlement_period", *[c for c in cols if c in df.columns]]
        base = base.merge(df[keep].drop_duplicates("settlement_period"), on="settlement_period", how="left")
        kind = DataKind.CACHED if used_cache else observed_kind
        statuses.append(SourceStatus(name, True, kind, detail, retrieved_at))

    def _mid() -> pd.DataFrame:
        return client.market_index_data(frm, to).rename(columns={"mid_price": "wholesale_price"})

    def _sys() -> pd.DataFrame:
        return client.system_prices(day).rename(
            columns={
                "system_sell_price": "system_price",
                "published_at": "system_price_published_at",
            }
        )

    def _dem() -> pd.DataFrame:
        d = client.demand_forecast(frm, to).rename(
            columns={"national_demand_forecast_mw": "demand_forecast_mw"}
        )
        return d.dropna(subset=["demand_forecast_mw"]).drop_duplicates("settlement_period")

    def _ws() -> pd.DataFrame:
        return client.wind_solar_forecast(frm, to).drop_duplicates("settlement_period")

    _series("wholesale", "elexon.MID", ["wholesale_price"], DataKind.OBSERVED, _mid)
    _series(
        "system_price", "elexon.system_prices",
        ["system_price", "net_imbalance_volume", "system_price_published_at"],
        DataKind.OBSERVED, _sys,
    )
    _series("demand", "elexon.demand_forecast", ["demand_forecast_mw"], DataKind.FORECAST, _dem)
    _series(
        "wind_solar", "elexon.wind_solar", ["wind_forecast_mw", "solar_forecast_mw"],
        DataKind.FORECAST, _ws,
    )

    for col in MARKET_COLUMNS:
        if col not in base.columns:
            base[col] = pd.NA

    # If the essential wholesale series is entirely absent, the whole snapshot is
    # not usable — signal a clear upstream failure rather than an empty frame.
    if base["wholesale_price"].isna().all():
        from gb_battery.data.http import DataSourceError

        raise DataSourceError(
            "Elexon wholesale (MID) data is unavailable and no cached copy exists "
            f"for {day.isoformat()} under policy '{network_policy}'. "
            + (" ".join(warnings) if warnings else "")
        )

    return MarketSnapshot(
        day, base, statuses, warnings,
        requested_source="elexon", actual_source="elexon", requested_day=day,
        network_used=net["used"], cache_used=cch["used"],
    )
