"use client";

import { useMemo, useState } from "react";
import { MultiSeriesChart } from "../components/charts";
import { ErrorNote, Kpi, Panel, Spinner, Tabs } from "../components/ui";
import {
  gbp,
  num,
  validationApi,
  type ValidationModelRow,
  type ValidationResult,
} from "../lib/api";
import { useAppState } from "../lib/store";

const DEFAULT_MODELS = [
  "persistence",
  "lag_same_sp_1d",
  "lag_same_sp_7d",
  "rolling_median_7d",
  "climatology_weekday_sp",
  "internal_model",
];

const MODEL_LABEL: Record<string, string> = {
  persistence: "Persistence",
  lag_same_sp_1d: "SP yesterday",
  lag_same_sp_7d: "SP last week",
  rolling_median_7d: "7-day median",
  climatology_weekday_sp: "Climatology",
  internal_model: "Internal model",
};

type FundamentalBlock = {
  available: boolean;
  note?: string;
  metrics?: { n: number; mae: number; rmse: number; bias: number; correlation: number | null };
  series?: { settlement_date: string; settlement_period: number; forecast: number; actual: number }[];
};
type HeatCell = { settlement_period: number; hours_ahead: number; mae: number; n: number };

function modelName(m: string): string {
  return MODEL_LABEL[m] || m.replaceAll("_", " ");
}

export default function ValidationPage() {
  const { day, source, config } = useAppState();
  const [nDays, setNDays] = useState(1);
  const [models] = useState<string[]>(DEFAULT_MODELS);
  const [selectedModel, setSelectedModel] = useState("internal_model");
  const [selectedFundamental, setSelectedFundamental] = useState("demand_mw");
  const [withStrategyPnl, setWithStrategyPnl] = useState(true);
  const [tab, setTab] = useState("Calibration");
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await validationApi.run({
        source,
        day,
        n_days: nDays,
        models,
        with_strategy_pnl: withStrategyPnl,
        config,
      } as Parameters<typeof validationApi.run>[0] & { config: typeof config });
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const table = result?.price.table || [];
  const headline = table.find((r) => r.model === selectedModel) || table.find((r) => r.model === "internal_model") || null;

  const priceChart = useMemo(() => {
    if (!result) return [] as Record<string, number | string | null>[];
    const rows = result.price.start_of_day_series[selectedModel] || [];
    return rows.map((r) => ({
      x: `${r.settlement_date.slice(5)}·SP${r.settlement_period}`,
      actual: r.actual,
      forecast: r.forecast,
      q10: selectedModel === "internal_model" ? r.q10 : null,
      q90: selectedModel === "internal_model" ? r.q90 : null,
    }));
  }, [result, selectedModel]);

  const errorByHorizon = useMemo(() => {
    const cells = result?.price.price_heatmap_sp_by_hours_ahead?.cells || [];
    const byH = new Map<number, { sum: number; n: number }>();
    for (const c of cells) {
      const e = byH.get(c.hours_ahead) || { sum: 0, n: 0 };
      e.sum += c.mae * c.n;
      e.n += c.n;
      byH.set(c.hours_ahead, e);
    }
    return [...byH.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([h, e]) => ({ h, mae: e.n ? Math.round((e.sum / e.n) * 100) / 100 : null }));
  }, [result]);

  const fundamentals = (result?.fundamentals || {}) as Record<string, FundamentalBlock | unknown>;
  const fBlock = fundamentals[selectedFundamental] as FundamentalBlock | undefined;
  const fChart = (fBlock?.series || []).map((r) => ({
    x: `${r.settlement_date.slice(5)}·SP${r.settlement_period}`,
    forecast: r.forecast,
    actual: r.actual,
  }));
  const internal = table.find((r) => r.model === "internal_model") || null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-terminal-border bg-terminal-panel px-4 py-2 text-xs">
        <span className="text-sm font-semibold">Validation</span>
        <span className="text-terminal-muted">{day} · {source}</span>
        <label className="ml-auto flex items-center gap-1">
          <span className="text-terminal-muted">Days</span>
          <select value={nDays} onChange={(e) => setNDays(parseInt(e.target.value, 10))} className="rounded border border-terminal-border bg-terminal-bg px-2 py-1">
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={withStrategyPnl} onChange={(e) => setWithStrategyPnl(e.target.checked)} />
          <span className="text-terminal-muted">Strategy P&amp;L</span>
        </label>
        <button onClick={run} disabled={loading} className="rounded border border-kind-observed/50 px-3 py-1 text-kind-observed hover:bg-kind-observed/10 disabled:opacity-40">
          Run
        </button>
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Building forecast vintages and replaying benchmarks…" />}

      {result && !loading && headline && (
        <>
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
            <Kpi label="MAE" value={num(headline.mae, 2)} unit="£/MWh" />
            <Kpi label="RMSE" value={num(headline.rmse, 2)} unit="£/MWh" />
            <Kpi label="Bias" value={num(headline.bias, 2)} unit="£/MWh" />
            <Kpi label="Directional acc." value={headline.directional_accuracy_pct != null ? num(headline.directional_accuracy_pct, 1) : "—"} unit="%" />
            <Kpi label="Pinball (q50)" value={headline.probabilistic ? num(headline.probabilistic.pinball_q50, 2) : "—"} unit="£/MWh" />
            <Kpi label="Coverage q10–q90" value={headline.probabilistic ? num(headline.probabilistic.coverage_q10_q90_pct, 1) : "—"} unit="%" />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title={`Forecast vs actual — ${modelName(selectedModel)} (£/MWh)`}>
              <MultiSeriesChart
                data={priceChart}
                xKey="x"
                height={260}
                zeroLine
                leftLabel="£/MWh"
                series={[
                  { key: "actual", name: "Actual", color: "#38bdf8" },
                  { key: "forecast", name: "Forecast", color: "#c084fc", dashed: true },
                  { key: "q10", name: "q10", color: "#a78bfa", dashed: true },
                  { key: "q90", name: "q90", color: "#a78bfa", dashed: true },
                ]}
              />
            </Panel>
            <Panel title="Error vs horizon — internal model MAE (£/MWh)">
              <MultiSeriesChart
                data={errorByHorizon}
                xKey="h"
                height={260}
                leftLabel="MAE £/MWh"
                series={[{ key: "mae", name: "MAE by hours ahead", color: "#f59e0b", type: "area" }]}
              />
            </Panel>
          </div>

          <Panel title="Benchmark comparison">
            <div className="scroll-x">
              <table className="w-full text-[11px] tabular">
                <thead>
                  <tr className="text-left text-terminal-muted">
                    {["Model", "MAE", "RMSE", "Bias", "Direction %", "Pinball", "Coverage %", "Strategy P&L"].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1.5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.map((row: ValidationModelRow) => (
                    <tr
                      key={row.model}
                      onClick={() => setSelectedModel(row.model)}
                      className={`cursor-pointer border-b border-terminal-border/30 hover:bg-terminal-border/30 ${
                        selectedModel === row.model ? "bg-kind-observed/10" : ""
                      }`}
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-semibold">{modelName(row.model)}</td>
                      <td className="px-2 py-1">{num(row.mae, 2)}</td>
                      <td className="px-2 py-1">{num(row.rmse, 2)}</td>
                      <td className="px-2 py-1">{num(row.bias, 2)}</td>
                      <td className="px-2 py-1">{row.directional_accuracy_pct == null ? "—" : num(row.directional_accuracy_pct, 1)}</td>
                      <td className="px-2 py-1">{row.probabilistic ? num(row.probabilistic.pinball_q50, 2) : "—"}</td>
                      <td className="px-2 py-1">{row.probabilistic ? num(row.probabilistic.coverage_q10_q90_pct, 1) : "—"}</td>
                      <td className="px-2 py-1">
                        {row.strategy_pnl_gbp == null ? <span className="text-terminal-muted">—</span> : gbp(row.strategy_pnl_gbp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Tabs tabs={["Calibration", "Heatmap", "Fundamentals"]} active={tab} onChange={setTab} />

          {tab === "Calibration" && (
            <Panel title="Probabilistic calibration — internal model">
              {internal?.probabilistic ? (
                <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                  <Metric label="Pinball q10" value={num(internal.probabilistic.pinball_q10, 2)} />
                  <Metric label="Pinball q50" value={num(internal.probabilistic.pinball_q50, 2)} />
                  <Metric label="Pinball q90" value={num(internal.probabilistic.pinball_q90, 2)} />
                  <Metric label="Coverage q10–q90" value={`${num(internal.probabilistic.coverage_q10_q90_pct, 1)}%`} />
                  <Metric label="Interval width" value={`£${num(internal.probabilistic.avg_interval_width, 2)}`} />
                  <Metric label="Below q90" value={`${num(internal.probabilistic.calibration.share_below_q90_pct, 1)}%`} />
                </div>
              ) : (
                <p className="text-xs text-terminal-muted">No probabilistic metrics.</p>
              )}
            </Panel>
          )}

          {tab === "Heatmap" && (
            <Panel title="Internal-model MAE — Settlement Period × hours ahead">
              {result.price.price_heatmap_sp_by_hours_ahead?.cells?.length ? (
                <PriceHeatmap cells={result.price.price_heatmap_sp_by_hours_ahead.cells} />
              ) : (
                <p className="text-xs text-terminal-muted">No heatmap data.</p>
              )}
            </Panel>
          )}

          {tab === "Fundamentals" && (
            <Panel title="Fundamental forecasts">
              <div className="mb-3 flex flex-wrap gap-1 text-xs">
                {[
                  ["demand_mw", "Demand"],
                  ["wind_mw", "Wind"],
                  ["solar_mw", "Solar"],
                  ["residual_demand_mw", "Residual"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSelectedFundamental(key)}
                    className={`rounded border px-2 py-1 ${
                      selectedFundamental === key
                        ? "border-kind-observed/50 bg-kind-observed/10 text-kind-observed"
                        : "border-terminal-border text-terminal-muted"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {!fBlock?.available ? (
                <p className="text-xs text-terminal-muted">{fBlock?.note || "No data."}</p>
              ) : (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Metric label="MAE" value={`${num(fBlock.metrics?.mae)} MW`} />
                    <Metric label="RMSE" value={`${num(fBlock.metrics?.rmse)} MW`} />
                    <Metric label="Bias" value={`${num(fBlock.metrics?.bias)} MW`} />
                    <Metric label="Corr" value={fBlock.metrics?.correlation == null ? "—" : num(fBlock.metrics.correlation, 2)} />
                  </div>
                  <MultiSeriesChart
                    data={fChart}
                    xKey="x"
                    height={260}
                    leftLabel="MW"
                    series={[
                      { key: "actual", name: "Actual", color: "#38bdf8" },
                      { key: "forecast", name: "Forecast", color: "#c084fc", dashed: true },
                    ]}
                  />
                </>
              )}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-terminal-border/60 px-2 py-1.5">
      <div className="text-[10px] uppercase text-terminal-muted">{label}</div>
      <div className="tabular font-semibold">{value}</div>
    </div>
  );
}

function PriceHeatmap({ cells }: { cells: HeatCell[] }) {
  const hours = Array.from(new Set(cells.map((c) => c.hours_ahead))).sort((a, b) => a - b);
  const sps = Array.from(new Set(cells.map((c) => c.settlement_period))).sort((a, b) => a - b);
  const byKey = new Map(cells.map((c) => [`${c.hours_ahead}|${c.settlement_period}`, c]));
  const max = Math.max(...cells.map((c) => c.mae), 1);
  return (
    <div className="scroll-x">
      <table className="border-collapse text-[9px] tabular">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-terminal-panel px-1 py-1 text-terminal-muted">h\SP</th>
            {sps.map((sp) => (
              <th key={sp} className="px-1 py-1 text-terminal-muted">{sp}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hours.map((h) => (
            <tr key={h}>
              <th className="sticky left-0 z-10 bg-terminal-panel px-1 py-1 text-terminal-muted">{h}</th>
              {sps.map((sp) => {
                const cell = byKey.get(`${h}|${sp}`);
                const opacity = cell ? 0.12 + 0.78 * (cell.mae / max) : 0;
                return (
                  <td
                    key={sp}
                    title={cell ? `SP${sp}, ${h}h: £${cell.mae}/MWh (n=${cell.n})` : ""}
                    className="h-5 min-w-5 border border-terminal-bg text-center"
                    style={{ backgroundColor: cell ? `rgba(239,68,68,${opacity})` : "transparent" }}
                  >
                    {cell ? Math.round(cell.mae) : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
