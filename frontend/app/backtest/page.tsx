"use client";

import { useState } from "react";
import { api, gbp, num } from "../lib/api";
import { useAppState } from "../lib/store";
import { MultiSeriesChart } from "../components/charts";
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
  const { config } = useAppState();
  const [days, setDays] = useState(21);
  const [table, setTable] = useState<Row[]>([]);
  const [equity, setEquity] = useState<{ index: number; cumulative_pnl: number }[]>([]);
  const [perfect, setPerfect] = useState<number | null>(null);
  const [audit, setAudit] = useState<{ check: string; ok: boolean; detail: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api
      .backtest({ config, days })
      .then((r) => {
        setTable(r.table);
        setEquity(r.equity_curve);
        setPerfect(r.perfect_foresight_pnl_gbp);
        setAudit(r.leakage_audit);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-terminal-muted">Days</label>
          <input type="number" min={5} max={35} value={days} onChange={(e) => setDays(parseInt(e.target.value || "21"))} className="w-16 bg-terminal-bg border border-terminal-border rounded px-2 py-1" />
          <button onClick={run} className="rounded border border-kind-observed/40 text-kind-observed px-3 py-1 hover:bg-kind-observed/10">
            Run backtest
          </button>
        </div>
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Running rolling backtest…" />}

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
      {table.length === 0 && !loading && <p className="text-sm text-terminal-muted">Click “Run backtest”.</p>}
    </div>
  );
}
