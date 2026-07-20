"use client";

import { useMemo, useState } from "react";
import { MultiSeriesChart } from "../components/charts";
import { InfoTip, Learn, ProvBadge } from "../components/learn";
import { MarketTimeline } from "../components/MarketTimeline";
import { Disclaimer, ErrorNote, Panel, Spinner, Stat } from "../components/ui";
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
  lag_same_sp_1d: "Same SP yesterday",
  lag_same_sp_7d: "Same SP last week",
  rolling_median_7d: "7-day same-SP median",
  climatology_weekday_sp: "Weekday/SP climatology",
  internal_model: "Internal PIT model",
};

type FundamentalRow = {
  settlement_date: string;
  settlement_period: number;
  forecast: number;
  actual: number;
  forecast_published_at?: string;
  provenance?: string;
};

type FundamentalBlock = {
  available: boolean;
  note?: string;
  metrics?: {
    n: number;
    mae: number;
    rmse: number;
    bias: number;
    correlation: number | null;
    directional_accuracy_pct?: number | null;
    ramp_mae?: number;
  };
  series?: FundamentalRow[];
};

type HeatCell = { settlement_period: number; hours_ahead: number; mae: number; n: number };

function modelName(model: string): string {
  return MODEL_LABEL[model] || model.replaceAll("_", " ");
}

function bestBy(rows: ValidationModelRow[], key: "mae" | "rmse" | "strategy_pnl_gbp") {
  const usable = rows.filter((r) => r[key] != null);
  if (!usable.length) return null;
  return usable.reduce((best, row) => {
    if (key === "strategy_pnl_gbp") {
      return (row.strategy_pnl_gbp ?? -Infinity) > (best.strategy_pnl_gbp ?? -Infinity) ? row : best;
    }
    return row[key] < best[key] ? row : best;
  });
}

export default function ForecastValidationPage() {
  const { day, setDay, source, setSource, config } = useAppState();
  const [nDays, setNDays] = useState(1);
  const [models, setModels] = useState<string[]>(DEFAULT_MODELS);
  const [selectedModel, setSelectedModel] = useState("internal_model");
  const [selectedFundamental, setSelectedFundamental] = useState("demand_mw");
  const [withStrategyPnl, setWithStrategyPnl] = useState(true);
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
      if (!models.includes(selectedModel)) setSelectedModel(models[0] || "internal_model");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const table = result?.price.table || [];
  const bestMae = bestBy(table, "mae");
  const bestRmse = bestBy(table, "rmse");
  const bestPnl = bestBy(table, "strategy_pnl_gbp");
  const internal = table.find((r) => r.model === "internal_model") || null;

  const priceChart = useMemo(() => {
    if (!result) return [] as Record<string, number | string | null>[];
    const rows = result.price.start_of_day_series[selectedModel] || [];
    return rows.map((r) => ({
      x: `${r.settlement_date.slice(5)}·SP${r.settlement_period}`,
      actual: r.actual,
      forecast: r.forecast,
      q10: selectedModel === "internal_model" ? r.q10 : null,
      q90: selectedModel === "internal_model" ? r.q90 : null,
      error: r.forecast - r.actual,
    }));
  }, [result, selectedModel]);

  const fundamentals = (result?.fundamentals || {}) as Record<string, FundamentalBlock | unknown>;
  const fundamentalBlock = fundamentals[selectedFundamental] as FundamentalBlock | undefined;
  const fundamentalChart = (fundamentalBlock?.series || []).map((r) => ({
    x: `${r.settlement_date.slice(5)}·SP${r.settlement_period}`,
    forecast: r.forecast,
    actual: r.actual,
    error: r.forecast - r.actual,
  }));

  const toggleModel = (model: string) => {
    setModels((current) =>
      current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Forecast Validation</h1>
        <p className="text-xs text-terminal-muted">
          Compare point-in-time forecasts with actual outcomes, simple benchmarks and downstream
          battery P&amp;L. Statistical accuracy alone does not declare a trading model better.
        </p>
      </div>

      <MarketTimeline highlight="forecast" />

      <Disclaimer>
        <strong>Point-in-time only.</strong> Every forecast is reconstructed from information available
        at its decision gate. Actual values are used only after publication for validation. MAPE is not
        used because power prices and solar can be zero or negative.
      </Disclaimer>

      <Panel title="Validation controls">
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-terminal-muted">Start date</span>
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="rounded border border-terminal-border bg-terminal-bg px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-terminal-muted">Source</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className="rounded border border-terminal-border bg-terminal-bg px-2 py-1"
            >
              <option value="sample">Bundled sample</option>
              <option value="synthetic">Synthetic</option>
              <option value="elexon">Elexon</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-terminal-muted">Days</span>
            <select
              value={nDays}
              onChange={(e) => setNDays(parseInt(e.target.value, 10))}
              className="rounded border border-terminal-border bg-terminal-bg px-2 py-1"
            >
              <option value={1}>1 day</option>
              <option value={2}>2 days</option>
              <option value={3}>3 days</option>
            </select>
          </label>
          <label className="flex items-center gap-2 rounded border border-terminal-border px-2 py-1.5">
            <input
              type="checkbox"
              checked={withStrategyPnl}
              onChange={(e) => setWithStrategyPnl(e.target.checked)}
            />
            Re-run rolling strategy for economic P&amp;L
            <InfoTip text="Each forecast model is fed through the same rolling battery replay. This is slower, but it reveals whether a statistically better forecast actually creates more economic value." />
          </label>
          <button
            onClick={run}
            disabled={loading || models.length === 0}
            className="rounded border border-kind-observed/50 px-3 py-1.5 text-kind-observed hover:bg-kind-observed/10 disabled:opacity-40"
          >
            Run validation
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          {DEFAULT_MODELS.map((model) => (
            <label
              key={model}
              className={`flex items-center gap-1 rounded border px-2 py-1 ${
                models.includes(model)
                  ? "border-kind-forecast/50 bg-kind-forecast/10 text-kind-forecast"
                  : "border-terminal-border text-terminal-muted"
              }`}
            >
              <input
                type="checkbox"
                checked={models.includes(model)}
                onChange={() => toggleModel(model)}
              />
              {modelName(model)}
            </label>
          ))}
        </div>
      </Panel>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Building point-in-time forecast vintages and replaying each benchmark…" />}

      {result && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Lowest price MAE"
              value={bestMae ? `£${num(bestMae.mae)}/MWh` : "—"}
              sub={bestMae ? modelName(bestMae.model) : undefined}
            />
            <Stat
              label="Lowest price RMSE"
              value={bestRmse ? `£${num(bestRmse.rmse)}/MWh` : "—"}
              sub={bestRmse ? modelName(bestRmse.model) : undefined}
            />
            <Stat
              label="Best strategy P&L (capped subset)"
              value={bestPnl?.strategy_pnl_gbp != null ? gbp(bestPnl.strategy_pnl_gbp) : "—"}
              sub={
                bestPnl
                  ? `${modelName(bestPnl.model)} — of ${result.price.strategy_pnl_models.length} replayed`
                  : "not requested"
              }
              accent="#22c55e"
            />
            <Stat
              label="Internal q10–q90 coverage"
              value={
                internal?.probabilistic
                  ? `${num(internal.probabilistic.coverage_q10_q90_pct, 1)}%`
                  : "—"
              }
              sub="target ≈ 80%"
            />
          </div>

          <Learn title="How to judge a forecast as a trader">
            <p>
              First check whether it beats simple benchmarks on MAE, RMSE, bias, direction and peak
              timing. Then check whether those improvements survive the battery optimisation and create
              higher realised net P&amp;L. A lower MAE model can still trade worse if it misses the timing
              of peaks and troughs.
            </p>
          </Learn>

          <Panel title="Benchmark comparison — statistical (all models) + economic (capped subset)">
            <div className="mb-3 space-y-2 rounded border border-kind-estimated/40 bg-kind-estimated/10 px-3 py-2 text-[11px]">
              <div>
                <span className="inline-block rounded bg-kind-observed/20 px-1.5 py-0.5 font-bold uppercase text-kind-observed">
                  Statistical — all {table.length} models
                </span>{" "}
                <span className="text-terminal-muted">
                  MAE, RMSE, bias, correlation, direction, ramp and peak/trough timing are computed
                  for every selected model over the full point-in-time path.
                </span>
              </div>
              <div>
                <span className="inline-block rounded bg-kind-estimated/25 px-1.5 py-0.5 font-bold uppercase text-kind-estimated">
                  Economic — capped diagnostic ({result.price.strategy_pnl_models.length} of {table.length})
                </span>{" "}
                <span className="text-terminal-muted">
                  Strategy P&amp;L replays a full rolling day per model, so it is bounded for
                  interactive use: only{" "}
                  <strong>{result.price.strategy_pnl_models.map(modelName).join(" and ")}</strong>{" "}
                  were replayed, over the selected day range with a{" "}
                  <strong>shrinking within-range horizon</strong> (not the 48 h cross-day horizon the
                  product uses) and a fixed continuation value. Models marked{" "}
                  <em>not computed</em> were not replayed at all.
                </span>
              </div>
              <div className="font-semibold text-kind-estimated">
                This is a performance-bounded indicator, not a complete economic comparison. Do not
                rank all models by economics from this table.
              </div>
            </div>
            <div className="scroll-x">
              <table className="w-full text-[11px] tabular">
                <thead>
                  <tr className="text-left text-terminal-muted">
                    {[
                      "Model",
                      "n",
                      "MAE",
                      "RMSE",
                      "Bias",
                      "Corr",
                      "Direction %",
                      "Ramp MAE",
                      "Peak error SP",
                      "Trough error SP",
                      "Start-day MAE",
                      "Strategy P&L",
                    ].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1.5">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.map((row) => (
                    <tr
                      key={row.model}
                      onClick={() => setSelectedModel(row.model)}
                      className={`cursor-pointer border-b border-terminal-border/30 hover:bg-terminal-border/30 ${
                        selectedModel === row.model ? "bg-kind-observed/10" : ""
                      }`}
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-semibold">{modelName(row.model)}</td>
                      <td className="px-2 py-1">{row.n}</td>
                      <td className="px-2 py-1">{num(row.mae)}</td>
                      <td className="px-2 py-1">{num(row.rmse)}</td>
                      <td className="px-2 py-1">{num(row.bias)}</td>
                      <td className="px-2 py-1">{row.correlation == null ? "—" : num(row.correlation, 2)}</td>
                      <td className="px-2 py-1">{row.directional_accuracy_pct == null ? "—" : num(row.directional_accuracy_pct, 1)}</td>
                      <td className="px-2 py-1">{row.ramp_mae == null ? "—" : num(row.ramp_mae)}</td>
                      <td className="px-2 py-1">{row.peak_timing_error_sp}</td>
                      <td className="px-2 py-1">{row.trough_timing_error_sp}</td>
                      <td className="px-2 py-1">{num(row.start_of_day_mae)}</td>
                      <td className="px-2 py-1 font-semibold text-action-charge">
                        {row.strategy_pnl_gbp == null ? (
                          <span className="text-terminal-muted italic font-normal">not computed</span>
                        ) : (
                          gbp(row.strategy_pnl_gbp)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] text-terminal-muted">{result.price.framing_note}</p>
          </Panel>

          <Panel
            title={`Start-of-day path — ${modelName(selectedModel)} forecast vs actual`}
            right={
              <div className="flex gap-1">
                <ProvBadge p="model_forecast" />
                <ProvBadge p="observed" />
              </div>
            }
          >
            <MultiSeriesChart
              data={priceChart}
              xKey="x"
              height={300}
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

          {internal?.probabilistic && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Probabilistic calibration — internal model">
                <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                  <Metric label="Pinball q10" value={num(internal.probabilistic.pinball_q10)} />
                  <Metric label="Pinball q50" value={num(internal.probabilistic.pinball_q50)} />
                  <Metric label="Pinball q90" value={num(internal.probabilistic.pinball_q90)} />
                  <Metric label="q10–q90 coverage" value={`${num(internal.probabilistic.coverage_q10_q90_pct, 1)}%`} />
                  <Metric label="Average interval width" value={`£${num(internal.probabilistic.avg_interval_width)}/MWh`} />
                  <Metric
                    label="Actual below q90"
                    value={`${num(internal.probabilistic.calibration.share_below_q90_pct, 1)}%`}
                  />
                </div>
                <Learn title="Coverage and sharpness must be read together">
                  <p>
                    An 80% q10–q90 interval should contain roughly 80% of actual prices. A very wide
                    interval can achieve good coverage while being unhelpful, so compare coverage with
                    average width and pinball loss.
                  </p>
                </Learn>
              </Panel>

              <Panel title="Metric guide">
                <div className="space-y-1 text-[11px]">
                  {Object.entries(result.price.metric_guide).map(([metric, guide]) => (
                    <div key={metric} className="grid grid-cols-[11rem_5rem_1fr] gap-2 border-b border-terminal-border/30 py-1">
                      <strong>{metric.replaceAll("_", " ")}</strong>
                      <span className="text-kind-forecast">{guide.better}</span>
                      <span className="text-terminal-muted">{guide.means} ({guide.unit})</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          )}

          {result.price.price_heatmap_sp_by_hours_ahead?.cells?.length ? (
            <Panel title="Internal-model price MAE heatmap — Settlement Period × hours ahead">
              <PriceHeatmap cells={result.price.price_heatmap_sp_by_hours_ahead.cells} />
              <p className="mt-2 text-[10px] text-terminal-muted">
                Darker cells mean larger forecast errors. This makes it easy to see whether the model
                struggles at long horizons, during morning ramps or around evening peaks.
              </p>
            </Panel>
          ) : null}

          <Panel title="Fundamental forecasts — demand, wind, solar and residual demand">
            <div className="mb-3 flex flex-wrap gap-1 text-xs">
              {[
                ["demand_mw", "Demand"],
                ["wind_mw", "Wind"],
                ["solar_mw", "Solar"],
                ["residual_demand_mw", "Residual demand"],
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

            {!fundamentalBlock?.available ? (
              <p className="text-xs text-terminal-muted">
                {fundamentalBlock?.note || "No point-in-time forecast/outturn pairs are available for this variable."}
              </p>
            ) : (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
                  <Metric label="MAE" value={`${num(fundamentalBlock.metrics?.mae)} MW`} />
                  <Metric label="RMSE" value={`${num(fundamentalBlock.metrics?.rmse)} MW`} />
                  <Metric label="Bias" value={`${num(fundamentalBlock.metrics?.bias)} MW`} />
                  <Metric
                    label="Correlation"
                    value={fundamentalBlock.metrics?.correlation == null ? "—" : num(fundamentalBlock.metrics.correlation, 2)}
                  />
                  <Metric
                    label="Directional accuracy"
                    value={
                      fundamentalBlock.metrics?.directional_accuracy_pct == null
                        ? "—"
                        : `${num(fundamentalBlock.metrics.directional_accuracy_pct, 1)}%`
                    }
                  />
                </div>
                <MultiSeriesChart
                  data={fundamentalChart}
                  xKey="x"
                  height={280}
                  zeroLine={selectedFundamental === "solar_mw" || selectedFundamental === "residual_demand_mw"}
                  leftLabel="MW"
                  series={[
                    { key: "actual", name: "Actual", color: "#38bdf8" },
                    { key: "forecast", name: "Published forecast", color: "#c084fc", dashed: true },
                  ]}
                />
              </>
            )}
          </Panel>

          <Disclaimer>{result.note}</Disclaimer>
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
                    title={cell ? `SP${sp}, ${h}h ahead: MAE £${cell.mae}/MWh (n=${cell.n})` : "no data"}
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
