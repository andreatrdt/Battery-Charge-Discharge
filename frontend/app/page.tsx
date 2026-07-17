"use client";

import { useEffect, useState } from "react";
import { api, num, type MarketSnapshot, type DataKind } from "./lib/api";
import { useAppState } from "./lib/store";
import { MultiSeriesChart } from "./components/charts";
import { ErrorNote, KindBadge, Panel, Spinner, Stat } from "./components/ui";

export default function MarketOverview() {
  const { day, offline, setOffline } = useAppState();
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .snapshot(day, offline)
      .then(setSnap)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [day, offline]);

  const rows = (snap?.periods || []).map((p) => ({
    sp: p.settlement_period as number,
    price: p.wholesale_price as number,
    system: p.system_price as number,
    demand: p.demand_forecast_mw as number,
    wind: p.wind_forecast_mw as number,
    solar: p.solar_forecast_mw as number,
    residual:
      p.demand_forecast_mw != null
        ? (p.demand_forecast_mw as number) - ((p.wind_forecast_mw as number) || 0) - ((p.solar_forecast_mw as number) || 0)
        : null,
  }));

  const avgPrice = rows.length ? rows.reduce((a, r) => a + (r.price || 0), 0) / rows.length : 0;
  const peakPrice = rows.length ? Math.max(...rows.map((r) => r.price || 0)) : 0;
  const troughPrice = rows.length ? Math.min(...rows.map((r) => r.price || 0)) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Market Overview — {day}</h1>
          <p className="text-xs text-terminal-muted">
            National demand, wind/solar, residual demand, wholesale (MID) &amp; system price.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-terminal-muted">
          <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} />
          Offline demo mode
        </label>
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Fetching market data…" />}

      {snap && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Avg wholesale" value={`£${num(avgPrice)}/MWh`} />
            <Stat label="Peak" value={`£${num(peakPrice)}/MWh`} accent="#ef4444" />
            <Stat label="Trough" value={`£${num(troughPrice)}/MWh`} accent="#22c55e" />
            <Stat label="Settlement periods" value={String(rows.length)} sub="DST-aware" />
          </div>

          <Panel title="Data sources & provenance">
            <div className="flex flex-wrap gap-3">
              {snap.statuses.map((s) => (
                <div key={s.source} className="flex items-center gap-2 rounded border border-terminal-border px-3 py-2">
                  <span className={`h-2 w-2 rounded-full ${s.ok ? "bg-action-charge" : "bg-action-discharge"}`} />
                  <span className="text-sm">{s.source}</span>
                  <KindBadge kind={s.kind as DataKind} />
                  <span className="text-xs text-terminal-muted">
                    {s.retrieved_at ? new Date(s.retrieved_at).toLocaleTimeString() : s.detail}
                  </span>
                </div>
              ))}
            </div>
            {snap.warnings.length > 0 && (
              <ul className="mt-2 text-xs text-kind-estimated list-disc pl-5">
                {snap.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="grid lg:grid-cols-2 gap-4">
            <Panel title="Prices (£/MWh)">
              <MultiSeriesChart
                data={rows}
                zeroLine
                series={[
                  { key: "price", name: "Wholesale (MID)", color: "#38bdf8" },
                  { key: "system", name: "System price", color: "#a78bfa", dashed: true },
                ]}
              />
            </Panel>
            <Panel title="Demand, wind & solar (MW)">
              <MultiSeriesChart
                data={rows}
                series={[
                  { key: "demand", name: "Demand", color: "#f59e0b" },
                  { key: "wind", name: "Wind", color: "#22c55e" },
                  { key: "solar", name: "Solar", color: "#eab308" },
                ]}
              />
            </Panel>
            <Panel title="Residual demand (MW)">
              <MultiSeriesChart
                data={rows}
                series={[{ key: "residual", name: "Residual = demand − wind − solar", color: "#0ea5e9", type: "area" }]}
              />
            </Panel>
            <Panel title="Wholesale vs residual demand">
              <MultiSeriesChart
                data={rows}
                series={[
                  { key: "price", name: "Wholesale £/MWh", color: "#38bdf8", yAxis: "left" },
                  { key: "residual", name: "Residual MW", color: "#f59e0b", yAxis: "right", dashed: true },
                ]}
                leftLabel="£/MWh"
                rightLabel="MW"
              />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
