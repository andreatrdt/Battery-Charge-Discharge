"use client";

import { useState } from "react";
import {
  ApiError,
  api,
  gbp,
  num,
  type SourceProvenance,
  type UnsupportedSource,
} from "../lib/api";
import { useAppState } from "../lib/store";
import { MultiSeriesChart } from "../components/charts";
import { SourceBanner } from "../components/SourceBanner";
import { ErrorNote, Panel, Spinner, Stat } from "../components/ui";

type Row = Record<string, number | string>;

const NICE: Record<string, string> = {
  no_operation: "No-operation battery",
  threshold_rule: "Charge-low / discharge-high",
  fixed_percentile: "Fixed 25/75 percentile",
  deterministic_optimiser: "Deterministic optimiser",
  perfect_foresight: "Perfect foresight (upper bound)",
};

export default function BacktestPage() {
  const { config, source } = useAppState();
  const [days, setDays] = useState(21);
  const [table, setTable] = useState<Row[]>([]);
  const [equity, setEquity] = useState<{ index: number; cumulative_pnl: number }[]>([]);
  const [perfect, setPerfect] = useState<number | null>(null);
  const [audit, setAudit] = useState<{ check: string; ok: boolean; detail: string }[]>([]);
  const [provenance, setProvenance] = useState<SourceProvenance | null>(null);
  const [unsupported, setUnsupported] = useState<UnsupportedSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTable([]);
    setEquity([]);
    setPerfect(null);
    setAudit([]);
    setProvenance(null);
    setUnsupported(null);
    setError(null);
  };

  const run = () => {
    setLoading(true);
    reset();
    api
      .backtest({ config, days, source })
      .then((r) => {
        setTable(r.table);
        setEquity(r.equity_curve);
        setPerfect(r.perfect_foresight_pnl_gbp);
        setAudit(r.leakage_audit);
        setProvenance(r.provenance);
      })
      .catch((e) => {
        // An unsupported source is an explicit state, not a generic error —
        // and nothing is substituted.
        const detail = e instanceof ApiError ? (e.detail as UnsupportedSource | undefined) : undefined;
        if (detail && detail.status === "unsupported_source") setUnsupported(detail);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Chronological Backtest</h1>
          <p className="text-xs text-terminal-muted">
            Forecast-driven decisions settled on outturn prices. Benchmarks vs a perfect-foresight
            upper bound. Backtested returns are <em>not</em> achievable live.
          </p>
          <p className="mt-1 text-[11px] text-terminal-muted">
            Runs on the global source (<strong>{source}</strong>). The daily backtest needs a
            day-ahead price forecast <em>and</em> a realised outturn per period, so Elexon is
            reported as unsupported rather than silently replaced.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-terminal-muted">Days</label>
          <input type="number" min={5} max={35} value={days} onChange={(e) => setDays(parseInt(e.target.value || "21"))} className="w-16 bg-terminal-bg border border-terminal-border rounded px-2 py-1" />
          <button onClick={run} className="rounded border border-kind-observed/40 text-kind-observed px-3 py-1 hover:bg-kind-observed/10">
            Run backtest
          </button>
        </div>
      </div>

      {provenance && <SourceBanner provenance={provenance} warnings={provenance.warnings} />}

      {unsupported && (
        <Panel title={`Backtest unavailable for source “${unsupported.requested_source}”`}>
          <div className="space-y-2 text-xs">
            <div className="inline-block rounded bg-kind-estimated/15 px-2 py-0.5 text-[10px] font-bold uppercase text-kind-estimated">
              Unsupported source — nothing was run, nothing was substituted
            </div>
            <p className="text-terminal-muted leading-relaxed">{unsupported.reason}</p>
            <p>
              <span className="text-terminal-muted">Requested source: </span>
              {unsupported.requested_source} ·{" "}
              <span className="text-terminal-muted">Actual source: </span>
              {unsupported.actual_source ?? "none (no data produced)"} ·{" "}
              <span className="text-terminal-muted">Network used: </span>
              {unsupported.network_used ? "yes" : "no"} ·{" "}
              <span className="text-terminal-muted">Cache used: </span>
              {unsupported.cache_used ? "yes" : "no"}
            </p>
            <p className="text-terminal-muted">
              Supported here: {unsupported.supported_sources.join(", ")}. Change the Source selector
              in the header, or use{" "}
              <a href="/replay" className="underline text-kind-observed">Replay &amp; Live</a> for
              point-in-time Elexon analysis.
            </p>
          </div>
        </Panel>
      )}

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label={`Running rolling backtest on ${source}…`} />}

      {table.length > 0 && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Perfect-foresight bound" value={gbp(perfect)} accent="#a78bfa" />
            {table
              .filter((r) => r.strategy === "deterministic_optimiser")
              .map((r) => (
                <Stat key="opt" label="Optimiser P&L" value={gbp(r.total_pnl_gbp as number)} accent="#22c55e" sub={`${r.capture_of_perfect_pct}% of bound`} />
              ))}
            {table
              .filter((r) => r.strategy === "deterministic_optimiser")
              .map((r) => (
                <Stat key="dd" label="Max drawdown" value={gbp(r.max_drawdown_gbp as number)} accent="#ef4444" />
              ))}
            {table
              .filter((r) => r.strategy === "deterministic_optimiser")
              .map((r) => (
                <Stat key="mae" label="Price forecast MAE" value={`£${num(r.price_forecast_mae as number)}`} />
              ))}
          </div>

          <Panel title="Strategy comparison">
            <div className="scroll-x">
              <table className="w-full text-xs tabular">
                <thead>
                  <tr className="text-terminal-muted text-left border-b border-terminal-border">
                    <th className="py-2 pr-3">Strategy</th>
                    <th className="py-2 px-3 text-right">P&L</th>
                    <th className="py-2 px-3 text-right">Capture %</th>
                    <th className="py-2 px-3 text-right">Cycles</th>
                    <th className="py-2 px-3 text-right">Max DD</th>
                    <th className="py-2 px-3 text-right">CVaR95</th>
                    <th className="py-2 px-3 text-right">Avg SoC</th>
                    <th className="py-2 px-3 text-right">% at limits</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((r) => (
                    <tr key={r.strategy as string} className="border-b border-terminal-border/50">
                      <td className="py-2 pr-3">{NICE[r.strategy as string] || r.strategy}</td>
                      <td className="py-2 px-3 text-right text-action-charge">{gbp(r.total_pnl_gbp as number)}</td>
                      <td className="py-2 px-3 text-right">{r.capture_of_perfect_pct != null ? `${r.capture_of_perfect_pct}%` : "—"}</td>
                      <td className="py-2 px-3 text-right">{num(r.full_cycle_equivalents as number, 1)}</td>
                      <td className="py-2 px-3 text-right text-action-discharge">{gbp(r.max_drawdown_gbp as number)}</td>
                      <td className="py-2 px-3 text-right">{gbp(r.cvar95_period_pnl_gbp as number, 0)}</td>
                      <td className="py-2 px-3 text-right">{num(r.avg_soc_mwh as number)}</td>
                      <td className="py-2 px-3 text-right">{num(r.pct_time_at_limits as number)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Optimiser equity curve (cumulative £)">
            <MultiSeriesChart data={equity} xKey="index" series={[{ key: "cumulative_pnl", name: "Cumulative P&L", color: "#22c55e", type: "area" }]} height={280} />
          </Panel>

          <Panel title="Leakage audit">
            <ul className="text-xs space-y-1">
              {audit.map((a) => (
                <li key={a.check} className={a.ok ? "text-action-charge" : "text-action-discharge"}>
                  {a.ok ? "✓" : "✗"} {a.check}: {a.detail}
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
      {table.length === 0 && !loading && !unsupported && !error && (
        <p className="text-sm text-terminal-muted">Click “Run backtest”.</p>
      )}
    </div>
  );
}
