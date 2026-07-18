"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DecisionRecord,
  type ForecastVintagePayload,
  type LiveResult,
  type ReplayMetrics,
  type ReplayStatus,
  gbp,
  num,
  replayApi,
} from "../lib/api";
import { useAppState } from "../lib/store";
import { MultiSeriesChart } from "../components/charts";
import { Disclaimer, ErrorNote, Panel, Spinner, Stat } from "../components/ui";

type Mode = "historical" | "live" | "perfect";

const MODE_LABELS: Record<Mode, string> = {
  historical: "Historical Replay",
  live: "Live Paper Trading",
  perfect: "Perfect Foresight Benchmark",
};

function fmtT(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toISOString().slice(11, 16)}Z`;
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
}

function actionColor(a: string): string {
  if (a === "CHARGE") return "#22c55e";
  if (a === "DISCHARGE") return "#ef4444";
  return "#64748b";
}

export default function ReplayPage() {
  const { config, day, setDay } = useAppState();
  const [mode, setMode] = useState<Mode>("historical");
  const [source, setSource] = useState("sample");
  const [strategy, setStrategy] = useState("rolling_forecast");
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [view, setView] = useState(0); // scrub position: #executed steps shown
  const [vintages, setVintages] = useState<Map<number, ForecastVintagePayload>>(new Map());
  const [metrics, setMetrics] = useState<ReplayMetrics | null>(null);
  const [live, setLive] = useState<LiveResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(1000);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const busy = useRef(false);

  const replayId = status?.replay_id || null;

  // Persist the active session so the Data page can show *current run* inputs.
  useEffect(() => {
    if (replayId && status) {
      localStorage.setItem(
        "gbb_last_replay",
        JSON.stringify({
          replay_id: replayId,
          day: status.day,
          mode: status.mode,
          source: (status.options as { source?: string }).source || source,
          step_index: status.step_index,
        }),
      );
    }
  }, [replayId, status, source]);

  const fetchVintage = useCallback(
    async (id: string, step: number) => {
      if (vintages.has(step)) return;
      try {
        const v = await replayApi.forecasts(id, step);
        setVintages((m) => new Map(m).set(step, v));
      } catch {
        /* vintage may not exist yet */
      }
    },
    [vintages],
  );

  const start = useCallback(async () => {
    setLoading("Building point-in-time store…");
    setError(null);
    setMetrics(null);
    setDecisions([]);
    setVintages(new Map());
    setView(0);
    setSelected(null);
    setPlaying(false);
    try {
      const s = await replayApi.start({ config, day, source, strategy });
      setStatus(s);
      if (s.day !== day) setDay(s.day); // sample source may fall back to an available day
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(null);
    }
  }, [config, day, source, strategy, setDay]);

  const doStep = useCallback(
    async (n = 1) => {
      if (!replayId || busy.current) return;
      busy.current = true;
      try {
        const s = await replayApi.step(replayId, n);
        setStatus(s);
        if (s.new_decisions?.length) {
          setDecisions((d) => {
            const next = [...d, ...s.new_decisions!];
            setView(next.length);
            return next;
          });
        }
        if (s.complete) setPlaying(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPlaying(false);
      } finally {
        busy.current = false;
      }
    },
    [replayId],
  );

  const runAll = useCallback(async () => {
    if (!replayId) return;
    setLoading("Running remaining periods…");
    setPlaying(false);
    try {
      const s = await replayApi.run(replayId);
      setStatus(s);
      if (s.decisions) {
        setDecisions(s.decisions);
        setView(s.decisions.length);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }, [replayId]);

  // Playback loop.
  useEffect(() => {
    if (!playing || !replayId) return;
    const t = setInterval(() => {
      if (status?.complete) {
        setPlaying(false);
        return;
      }
      void doStep(1);
    }, speedMs);
    return () => clearInterval(t);
  }, [playing, replayId, speedMs, doStep, status?.complete]);

  // Fetch metrics automatically when the replay completes.
  useEffect(() => {
    if (status?.complete && replayId && !metrics && decisions.length > 0) {
      replayApi.metrics(replayId).then(setMetrics).catch(() => {});
    }
  }, [status?.complete, replayId, metrics, decisions.length]);

  // Keep the operative forecast vintage loaded for the current view position.
  const opVintageIdx = Math.min(view, Math.max(decisions.length - 1, 0));
  useEffect(() => {
    if (replayId && decisions.length > 0) void fetchVintage(replayId, opVintageIdx);
  }, [replayId, decisions.length, opVintageIdx, fetchVintage]);

  const runLive = useCallback(async () => {
    setLoading("Replaying today up to now, then optimising forward…");
    setError(null);
    setLive(null);
    try {
      const r = await replayApi.live({ config, source: source === "sample" ? "synthetic" : source });
      setLive(r);
      localStorage.setItem(
        "gbb_last_replay",
        JSON.stringify({
          replay_id: r.replay_id,
          day: r.day,
          mode: "live",
          source: source === "sample" ? "synthetic" : source,
          step_index: r.step_index,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }, [config, source]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Replay &amp; Live Trading</h1>
          <p className="text-xs text-terminal-muted">
            Rolling-horizon simulation: at each gate the model sees only data published before it,
            forecasts the rest of the day, optimises, and commits one Settlement Period.
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-3 py-1.5 border ${
                mode === m
                  ? "border-kind-observed/60 text-kind-observed bg-kind-observed/10"
                  : "border-terminal-border text-terminal-muted hover:text-terminal-text"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {mode === "perfect" && (
        <Disclaimer>
          <strong>Perfect foresight benchmark — not a tradable strategy.</strong> This schedule is
          optimised on the realised price path and exists only as an upper bound for judging the
          rolling strategy. It is never mixed into replay or paper-trading results.
        </Disclaimer>
      )}

      {mode !== "perfect" && (
        <Disclaimer>
          <strong>Sign convention &amp; execution assumption.</strong> P&amp;L positive = revenue;
          charging cost is negative P&amp;L. Committed energy is assumed executable at the MID
          reference price — no bid/ask spread, liquidity, partial fills or market impact are
          modelled. {mode === "live" && "Paper trading only: no orders are submitted anywhere."}
        </Disclaimer>
      )}

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label={loading} />}

      {mode === "historical" && (
        <HistoricalControls
          day={day}
          setDay={setDay}
          source={source}
          setSource={setSource}
          strategy={strategy}
          setStrategy={setStrategy}
          status={status}
          decisions={decisions}
          view={view}
          setView={setView}
          playing={playing}
          setPlaying={setPlaying}
          speedMs={speedMs}
          setSpeedMs={setSpeedMs}
          onStart={start}
          onStep={() => (view < decisions.length ? setView(view + 1) : void doStep(1))}
          onRunAll={runAll}
        />
      )}

      {mode === "historical" && status && decisions.length > 0 && (
        <ReplayBody
          status={status}
          decisions={decisions}
          view={view}
          vintage={vintages.get(opVintageIdx) || null}
          selected={selected}
          setSelected={setSelected}
        />
      )}
      {mode === "historical" && status && decisions.length === 0 && !loading && (
        <Panel title="Session ready">
          <p className="text-xs text-terminal-muted">
            Point-in-time store built for {status.day} ({status.n_periods} Settlement Periods).
            Press <em>Play</em> or <em>Step</em> to begin the chronological replay.
          </p>
          {status.warnings.length > 0 && (
            <ul className="mt-2 text-[11px] text-kind-estimated list-disc pl-4">
              {status.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {mode === "historical" && metrics && status?.complete && (
        <MetricsPanel metrics={metrics} />
      )}

      {mode === "live" && (
        <LivePanel
          source={source}
          setSource={setSource}
          live={live}
          onRun={runLive}
          loading={!!loading}
        />
      )}

      {mode === "perfect" && (
        <PerfectPanel metrics={metrics} status={status} replayId={replayId} setMetrics={setMetrics} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

function HistoricalControls(props: {
  day: string;
  setDay: (d: string) => void;
  source: string;
  setSource: (s: string) => void;
  strategy: string;
  setStrategy: (s: string) => void;
  status: ReplayStatus | null;
  decisions: DecisionRecord[];
  view: number;
  setView: (v: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  speedMs: number;
  setSpeedMs: (v: number) => void;
  onStart: () => void;
  onStep: () => void;
  onRunAll: () => void;
}) {
  const { status, decisions, view } = props;
  const atFrontier = view >= decisions.length;
  const gate: DecisionRecord | null = view > 0 ? decisions[view - 1] : null;
  const asOf =
    view < decisions.length
      ? decisions[view].as_of
      : status?.next_period_start_utc || gate?.end_utc || null;
  const btn =
    "rounded border border-terminal-border px-2.5 py-1 hover:bg-terminal-border/40 disabled:opacity-40";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Settlement date</span>
          <input
            type="date"
            value={props.day}
            onChange={(e) => props.setDay(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Source</span>
          <select
            value={props.source}
            onChange={(e) => props.setSource(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
          >
            <option value="sample">Bundled sample (synthetic, offline)</option>
            <option value="synthetic">Synthetic (any date, offline)</option>
            <option value="elexon">Elexon MID (real, completed days)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Strategy</span>
          <select
            value={props.strategy}
            onChange={(e) => props.setStrategy(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
          >
            <option value="rolling_forecast">Rolling forecast optimiser</option>
            <option value="rolling_threshold">Rolling threshold rule</option>
          </select>
        </label>
        <button onClick={props.onStart} className={`${btn} border-kind-observed/40 text-kind-observed`}>
          {status ? "Reset / new session" : "Start session"}
        </button>
        {status && (
          <>
            <button className={btn} disabled={view === 0} onClick={() => props.setView(Math.max(view - 1, 0))}>
              ◀ Prev
            </button>
            <button
              className={btn}
              disabled={!!status.complete && atFrontier}
              onClick={props.onStep}
            >
              Next ▶
            </button>
            <button
              className={btn}
              disabled={status.complete}
              onClick={() => props.setPlaying(!props.playing)}
            >
              {props.playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button className={btn} disabled={status.complete} onClick={props.onRunAll}>
              ⏭ Run to end
            </button>
            <label className="flex flex-col gap-1">
              <span className="text-terminal-muted">Speed</span>
              <select
                value={props.speedMs}
                onChange={(e) => props.setSpeedMs(parseInt(e.target.value, 10))}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
              >
                <option value={2000}>Slow</option>
                <option value={1000}>Normal</option>
                <option value={400}>Fast</option>
              </select>
            </label>
          </>
        )}
      </div>

      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 rounded-lg border border-kind-forecast/30 bg-kind-forecast/5 px-4 py-2 text-xs">
          <div>
            <div className="text-terminal-muted uppercase text-[10px]">As-of time (information cutoff)</div>
            <div className="tabular font-semibold text-kind-forecast">{fmtTs(asOf)}</div>
          </div>
          <div>
            <div className="text-terminal-muted uppercase text-[10px]">Current Settlement Period</div>
            <div className="tabular font-semibold">
              {view < decisions.length
                ? `SP${decisions[view].settlement_period} (gate)`
                : status.complete
                  ? "day complete"
                  : `SP${status.next_settlement_period ?? "—"} (gate)`}
              {" · "}
              {view}/{status.n_periods} executed
            </div>
          </div>
          <div>
            <div className="text-terminal-muted uppercase text-[10px]">Last data publication used</div>
            <div className="tabular">
              {fmtTs(gate ? gate.basis_max_published_at : decisions[0]?.basis_max_published_at)}
            </div>
          </div>
          <div>
            <div className="text-terminal-muted uppercase text-[10px]">Forecast origin time</div>
            <div className="tabular">{fmtTs(gate ? gate.as_of : decisions[0]?.as_of)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- main body */

function ReplayBody({
  status,
  decisions,
  view,
  vintage,
  selected,
  setSelected,
}: {
  status: ReplayStatus;
  decisions: DecisionRecord[];
  view: number;
  vintage: ForecastVintagePayload | null;
  selected: number | null;
  setSelected: (s: number | null) => void;
}) {
  const executed = decisions.slice(0, view);
  const lastExecutedSp = executed.length ? executed[executed.length - 1].settlement_period : 0;
  const nowSp = lastExecutedSp + 1;

  const chartData = useMemo(() => {
    const rows: Record<string, number | string | null>[] = [];
    const byExec = new Map(executed.map((d) => [d.settlement_period, d]));
    const vinRows = new Map((vintage?.rows || []).map((r) => [r.settlement_period, r]));
    // Planned actions for the future come from the last executed decision's proposal.
    const lastPlan = executed.length ? executed[executed.length - 1].proposed_schedule : [];
    const planBySp = new Map(lastPlan.map((p) => [p.settlement_period, p]));
    let cum = 0;
    for (let sp = 1; sp <= status.n_periods; sp++) {
      const d = byExec.get(sp);
      const v = vinRows.get(sp);
      const p = planBySp.get(sp);
      const isPast = d !== undefined;
      let realised: number | null = null;
      if (d?.realised_pnl_gbp != null) {
        cum += d.realised_pnl_gbp;
        realised = Math.round(cum * 10) / 10;
      }
      rows.push({
        sp,
        actual: isPast && d.settlement_status === "settled" ? d.actual_price : null,
        forecastUsed: isPast ? d.forecast_price : null,
        futurePoint: !isPast && v ? v.point : null,
        futureQ10: !isPast && v ? v.q10 : null,
        futureQ90: !isPast && v ? v.q90 : null,
        charge: isPast ? d.charge_mw : null,
        discharge: isPast ? -d.discharge_mw : null,
        plannedCharge: !isPast && p ? p.charge_mw : null,
        plannedDischarge: !isPast && p ? -p.discharge_mw : null,
        soc: isPast ? d.soc_after_mwh : null,
        plannedSoc: !isPast && p ? p.ending_soc_mwh : null,
        cumRealised: realised,
      });
    }
    return rows;
  }, [executed, vintage, status.n_periods]);

  const summary = status.summary;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat
          label="Realised P&L (settled)"
          value={gbp(summary.realised_pnl_gbp)}
          accent="#22c55e"
          sub={`${summary.n_settled} of ${status.n_periods} SPs settled`}
        />
        <Stat label="Wholesale revenue" value={gbp(summary.wholesale_revenue_gbp)} />
        <Stat label="Charging cost" value={`−${gbp(summary.charging_cost_gbp)}`} />
        <Stat label="Degradation" value={`−${gbp(summary.degradation_cost_gbp)}`} accent="#ef4444" />
        <Stat label="SoC now" value={`${num(status.soc_mwh)} MWh`} />
        <Stat
          label="Forecast MAE"
          value={summary.forecast_mae != null ? `£${num(summary.forecast_mae)}` : "—"}
          sub={summary.forecast_bias != null ? `bias ${num(summary.forecast_bias)}` : undefined}
        />
      </div>

      <Panel title="Wholesale price — REALISED PAST | NOW | FORECAST FUTURE">
        <p className="mb-2 text-[11px] text-terminal-muted">
          Left of the line: observed outturn (solid) vs the 1-step-ahead forecast actually used
          (dashed). Right of the line: the current forecast vintage with its q10–q90 band. Future
          actual values are never drawn.
        </p>
        <MultiSeriesChart
          data={chartData}
          height={280}
          leftLabel="£/MWh"
          xRefLine={nowSp <= status.n_periods ? { x: nowSp, label: "NOW / as-of" } : undefined}
          series={[
            { key: "actual", name: "Actual (observed)", color: "#38bdf8" },
            { key: "forecastUsed", name: "Forecast used (1-step)", color: "#a78bfa", dashed: true },
            { key: "futurePoint", name: "Current forecast (future)", color: "#c084fc" },
            { key: "futureQ10", name: "q10", color: "#c084fc", dashed: true },
            { key: "futureQ90", name: "q90", color: "#c084fc", dashed: true },
          ]}
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Executed (solid) vs planned (hollow) dispatch — MW">
          <MultiSeriesChart
            data={chartData}
            height={220}
            zeroLine
            leftLabel="MW"
            xRefLine={nowSp <= status.n_periods ? { x: nowSp, label: "NOW" } : undefined}
            series={[
              { key: "charge", name: "Charge (executed)", color: "#22c55e", type: "bar" },
              { key: "discharge", name: "Discharge (executed)", color: "#ef4444", type: "bar" },
              { key: "plannedCharge", name: "Charge (planned)", color: "#14532d", type: "bar" },
              { key: "plannedDischarge", name: "Discharge (planned)", color: "#7f1d1d", type: "bar" },
            ]}
          />
        </Panel>
        <Panel title="State of charge — realised then planned (MWh)">
          <MultiSeriesChart
            data={chartData}
            height={220}
            leftLabel="MWh"
            xRefLine={nowSp <= status.n_periods ? { x: nowSp, label: "NOW" } : undefined}
            series={[
              { key: "soc", name: "SoC (realised)", color: "#38bdf8", type: "area" },
              { key: "plannedSoc", name: "SoC (planned)", color: "#7c8896", dashed: true },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Cumulative realised P&L (settled periods only)">
        <MultiSeriesChart
          data={chartData}
          height={180}
          zeroLine
          leftLabel="GBP"
          xRefLine={nowSp <= status.n_periods ? { x: nowSp, label: "NOW" } : undefined}
          series={[{ key: "cumRealised", name: "Cumulative realised £", color: "#22c55e" }]}
        />
      </Panel>

      <DecisionLog decisions={executed} selected={selected} setSelected={setSelected} />

      {selected !== null && executed.find((d) => d.step === selected) && (
        <DecisionDetail d={executed.find((d) => d.step === selected)!} />
      )}
    </>
  );
}

/* -------------------------------------------------------------- decision log */

function DecisionLog({
  decisions,
  selected,
  setSelected,
}: {
  decisions: DecisionRecord[];
  selected: number | null;
  setSelected: (s: number | null) => void;
}) {
  return (
    <Panel title={`Decision log (${decisions.length} executed) — click a row for the full audit`}>
      <div className="scroll-x max-h-[46vh] overflow-y-auto">
        <table className="w-full text-[11px] tabular">
          <thead className="sticky top-0 bg-terminal-panel">
            <tr className="text-terminal-muted text-left">
              {[
                "Decision time",
                "SP",
                "Forecast £",
                "Actual £",
                "Error",
                "Action",
                "MW",
                "SoC before",
                "SoC after",
                "Expected £",
                "Realised £",
                "Status",
              ].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 border-b border-terminal-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => (
              <tr
                key={d.step}
                onClick={() => setSelected(selected === d.step ? null : d.step)}
                className={`cursor-pointer border-b border-terminal-border/40 hover:bg-terminal-border/30 ${
                  selected === d.step ? "bg-kind-observed/10" : ""
                }`}
              >
                <td className="px-2 py-1">{fmtT(d.as_of)}</td>
                <td className="px-2 py-1">SP{d.settlement_period}</td>
                <td className="px-2 py-1">{num(d.forecast_price)}</td>
                <td className="px-2 py-1">{d.actual_price != null ? num(d.actual_price) : "—"}</td>
                <td className="px-2 py-1" style={{ color: (d.forecast_error ?? 0) > 0 ? "#f59e0b" : undefined }}>
                  {d.forecast_error != null ? num(d.forecast_error) : "—"}
                </td>
                <td className="px-2 py-1 font-bold" style={{ color: actionColor(d.action) }}>
                  {d.action}
                </td>
                <td className="px-2 py-1">{num(Math.max(d.charge_mw, d.discharge_mw))}</td>
                <td className="px-2 py-1">{num(d.soc_before_mwh)}</td>
                <td className="px-2 py-1">{num(d.soc_after_mwh)}</td>
                <td className="px-2 py-1">{gbp(d.expected_immediate_pnl_gbp, 0)}</td>
                <td className="px-2 py-1">
                  {d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 0) : "—"}
                </td>
                <td className="px-2 py-1 text-terminal-muted">{d.settlement_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function DecisionDetail({ d }: { d: DecisionRecord }) {
  return (
    <Panel title={`Decision audit — SP${d.settlement_period} (gate ${fmtTs(d.as_of)})`}>
      <div className="grid gap-4 md:grid-cols-2 text-xs">
        <div className="space-y-1.5">
          <h3 className="font-semibold text-terminal-text">Information set</h3>
          <Row k="Information cutoff" v={fmtTs(d.information_cutoff)} />
          <Row k="Newest input publication" v={fmtTs(d.basis_max_published_at)} />
          <Row k="Observations visible" v={String(d.n_input_observations)} />
          <Row k="Published forecasts visible" v={String(d.n_input_forecasts)} />
          <Row k="Forecast basis" v={`${d.forecast_basis} (${d.forecast_provenance})`} />
          <Row
            k="Forecast (q10 / point / q90)"
            v={`${num(d.forecast_q10)} / ${num(d.forecast_price)} / ${num(d.forecast_q90)} £/MWh`}
          />
          <h3 className="font-semibold text-terminal-text pt-2">Outcome</h3>
          <Row
            k="Actual price"
            v={
              d.actual_price != null
                ? `${num(d.actual_price)} £/MWh (${d.actual_price_provenance}, published ${fmtTs(d.actual_price_available_at)})`
                : "pending — not yet published"
            }
          />
          <Row k="Forecast error" v={d.forecast_error != null ? `${num(d.forecast_error)} £/MWh` : "—"} />
          <Row k="Expected immediate P&L" v={gbp(d.expected_immediate_pnl_gbp, 2)} />
          <Row
            k="Realised P&L"
            v={d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 2) : "pending"}
          />
          <Row k="Degradation cost" v={gbp(d.degradation_cost_gbp, 2)} />
          <Row k="Expected remaining-horizon P&L" v={gbp(d.expected_horizon_pnl_gbp, 0)} />
        </div>
        <div className="space-y-1.5">
          <h3 className="font-semibold text-terminal-text">Why this action</h3>
          <p className="text-terminal-muted leading-relaxed">{d.explanation}</p>
          {d.binding_constraints.length > 0 && (
            <p>
              <span className="text-terminal-muted">Binding constraints: </span>
              {d.binding_constraints.join(", ")}
            </p>
          )}
          <h3 className="font-semibold text-terminal-text pt-2">
            Proposed remaining schedule (only SP{d.settlement_period} was executed)
          </h3>
          <div className="max-h-52 overflow-y-auto">
            <table className="w-full tabular text-[11px]">
              <thead>
                <tr className="text-terminal-muted text-left">
                  <th className="px-1 py-0.5">SP</th>
                  <th className="px-1 py-0.5">Action</th>
                  <th className="px-1 py-0.5">MW</th>
                  <th className="px-1 py-0.5">End SoC</th>
                  <th className="px-1 py-0.5">Fcst £</th>
                </tr>
              </thead>
              <tbody>
                {d.proposed_schedule.map((p) => (
                  <tr key={p.settlement_period} className="border-t border-terminal-border/30">
                    <td className="px-1 py-0.5">{p.settlement_period}</td>
                    <td className="px-1 py-0.5" style={{ color: actionColor(p.action) }}>
                      {p.action}
                    </td>
                    <td className="px-1 py-0.5">{num(Math.max(p.charge_mw, p.discharge_mw))}</td>
                    <td className="px-1 py-0.5">{num(p.ending_soc_mwh)}</td>
                    <td className="px-1 py-0.5">{num(p.forecast_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-terminal-border/30 py-0.5">
      <span className="text-terminal-muted">{k}</span>
      <span className="tabular text-right">{v}</span>
    </div>
  );
}

/* ------------------------------------------------------------------- metrics */

function MetricsPanel({ metrics }: { metrics: ReplayMetrics }) {
  const pt = metrics.peak_trough;
  return (
    <Panel title="Strategy comparison — realised P&L on identical information">
      <p className="mb-2 text-[11px] text-terminal-muted">{metrics.note}</p>
      <div className="scroll-x">
        <table className="w-full text-[11px] tabular">
          <thead>
            <tr className="text-terminal-muted text-left">
              {["Strategy", "Realised P&L", "Revenue", "Charging cost", "Degradation", "Cycles", "Max DD", "MAE", "Bias", "% of perfect"].map(
                (h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 border-b border-terminal-border">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {metrics.table.map((r) => (
              <tr
                key={r.strategy}
                className={`border-b border-terminal-border/40 ${
                  r.strategy === "perfect_foresight" ? "text-kind-estimated" : ""
                }`}
              >
                <td className="px-2 py-1">
                  {r.strategy}
                  {r.strategy === "perfect_foresight" && (
                    <span className="ml-1 text-[10px] uppercase">(upper bound, not tradable)</span>
                  )}
                </td>
                <td className="px-2 py-1">{gbp(r.realised_pnl_gbp)}</td>
                <td className="px-2 py-1">{r.wholesale_revenue_gbp != null ? gbp(r.wholesale_revenue_gbp) : "—"}</td>
                <td className="px-2 py-1">{r.charging_cost_gbp != null ? gbp(r.charging_cost_gbp) : "—"}</td>
                <td className="px-2 py-1">{r.degradation_cost_gbp != null ? gbp(r.degradation_cost_gbp) : "—"}</td>
                <td className="px-2 py-1">{r.cycles != null ? num(r.cycles, 2) : "—"}</td>
                <td className="px-2 py-1">{r.max_drawdown_gbp != null ? gbp(r.max_drawdown_gbp) : "—"}</td>
                <td className="px-2 py-1">{r.forecast_mae != null ? num(r.forecast_mae) : "—"}</td>
                <td className="px-2 py-1">{r.forecast_bias != null ? num(r.forecast_bias) : "—"}</td>
                <td className="px-2 py-1">{r.capture_of_perfect_pct != null ? `${r.capture_of_perfect_pct}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-terminal-muted">
        <span>
          Day peak (SP{String(pt.peak_sp)} @ £{num(pt.peak_price as number)}):{" "}
          {pt.peak_captured ? "discharged ✓" : "missed ✗"}
        </span>
        <span>
          Day trough (SP{String(pt.trough_sp)} @ £{num(pt.trough_price as number)}):{" "}
          {pt.trough_captured ? "charged ✓" : "missed ✗"}
        </span>
        <span>
          Leakage audit: {metrics.leakage_ok ? "all decisions provably point-in-time ✓" : "VIOLATIONS FOUND ✗"}
        </span>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------- live */

function LivePanel({
  source,
  setSource,
  live,
  onRun,
  loading,
}: {
  source: string;
  setSource: (s: string) => void;
  live: LiveResult | null;
  onRun: () => void;
  loading: boolean;
}) {
  const chartData = useMemo(() => {
    if (!live) return [];
    const rows: Record<string, number | string | null>[] = [];
    const byExec = new Map(live.decisions.map((d) => [d.settlement_period, d]));
    const vinRows = new Map((live.forward_vintage?.rows || []).map((r) => [r.settlement_period, r]));
    const planBySp = new Map((live.forward_proposal || []).map((p) => [p.settlement_period, p]));
    for (let sp = 1; sp <= live.n_periods; sp++) {
      const d = byExec.get(sp);
      const v = vinRows.get(sp);
      const p = planBySp.get(sp);
      rows.push({
        sp,
        actual: d && d.settlement_status === "settled" ? d.actual_price : null,
        futurePoint: v ? v.point : null,
        futureQ10: v ? v.q10 : null,
        futureQ90: v ? v.q90 : null,
        charge: d ? d.charge_mw : null,
        discharge: d ? -d.discharge_mw : null,
        plannedCharge: p ? p.charge_mw : null,
        plannedDischarge: p ? -p.discharge_mw : null,
        soc: d ? d.soc_after_mwh : null,
        plannedSoc: p ? p.ending_soc_mwh : null,
      });
    }
    return rows;
  }, [live]);

  const nowSp = live?.decisions.length ? live.decisions[live.decisions.length - 1].settlement_period + 1 : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Source</span>
          <select
            value={source === "sample" ? "synthetic" : source}
            onChange={(e) => setSource(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
          >
            <option value="synthetic">Synthetic (offline demo)</option>
            <option value="elexon">Elexon MID (real, today)</option>
          </select>
        </label>
        <button
          onClick={onRun}
          disabled={loading}
          className="rounded border border-kind-observed/40 text-kind-observed px-3 py-1 hover:bg-kind-observed/10 disabled:opacity-40"
        >
          Run live paper session
        </button>
        {live && (
          <span className="text-terminal-muted">
            Now: <span className="tabular text-kind-forecast">{fmtTs(live.now_utc)}</span> · Day{" "}
            {live.day} · {live.decisions.length} completed SPs replayed
          </span>
        )}
      </div>

      {live && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat
              label="Realised paper P&L"
              value={gbp(live.summary.realised_pnl_gbp)}
              accent="#22c55e"
              sub={`${live.summary.n_settled} settled, ${live.summary.n_pending} awaiting outturn`}
            />
            <Stat
              label="Expected future P&L"
              value={gbp(
                (live.forward_proposal || []).reduce((a, p) => a + p.expected_pnl_gbp, 0),
              )}
              sub="forecast-based, separate from realised"
            />
            <Stat label="SoC now" value={`${num(live.soc_mwh)} MWh`} />
            <Stat label="Cycles used" value={num(live.summary.cycles, 2)} />
            <Stat
              label="Forecast MAE (today)"
              value={live.summary.forecast_mae != null ? `£${num(live.summary.forecast_mae)}` : "—"}
            />
          </div>

          <Panel title="Today — REALISED PAST | NOW | FORECAST FUTURE (future actuals do not exist)">
            <MultiSeriesChart
              data={chartData}
              height={280}
              leftLabel="£/MWh"
              xRefLine={nowSp <= live.n_periods ? { x: nowSp, label: "NOW" } : undefined}
              series={[
                { key: "actual", name: "Actual (observed)", color: "#38bdf8" },
                { key: "futurePoint", name: "Forecast (future)", color: "#c084fc" },
                { key: "futureQ10", name: "q10", color: "#c084fc", dashed: true },
                { key: "futureQ90", name: "q90", color: "#c084fc", dashed: true },
              ]}
            />
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Dispatch — executed then proposed (MW)">
              <MultiSeriesChart
                data={chartData}
                height={220}
                zeroLine
                leftLabel="MW"
                xRefLine={nowSp <= live.n_periods ? { x: nowSp, label: "NOW" } : undefined}
                series={[
                  { key: "charge", name: "Charge (executed)", color: "#22c55e", type: "bar" },
                  { key: "discharge", name: "Discharge (executed)", color: "#ef4444", type: "bar" },
                  { key: "plannedCharge", name: "Charge (proposed)", color: "#14532d", type: "bar" },
                  { key: "plannedDischarge", name: "Discharge (proposed)", color: "#7f1d1d", type: "bar" },
                ]}
              />
            </Panel>
            <Panel title="State of charge (MWh)">
              <MultiSeriesChart
                data={chartData}
                height={220}
                leftLabel="MWh"
                xRefLine={nowSp <= live.n_periods ? { x: nowSp, label: "NOW" } : undefined}
                series={[
                  { key: "soc", name: "SoC (realised)", color: "#38bdf8", type: "area" },
                  { key: "plannedSoc", name: "SoC (proposed)", color: "#7c8896", dashed: true },
                ]}
              />
            </Panel>
          </div>

          <Disclaimer>{live.disclaimer}</Disclaimer>
        </>
      )}
      {!live && !loading && (
        <Panel title="Live paper trading">
          <p className="text-xs text-terminal-muted">
            Replays today&apos;s completed Settlement Periods with point-in-time information (paper
            decisions settled against published outturns), then optimises the remainder of the day
            from now. Nothing is traded anywhere.
          </p>
        </Panel>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- perfect foresight */

function PerfectPanel({
  metrics,
  status,
  replayId,
  setMetrics,
}: {
  metrics: ReplayMetrics | null;
  status: ReplayStatus | null;
  replayId: string | null;
  setMetrics: (m: ReplayMetrics) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (!replayId) return;
    setLoading(true);
    setError(null);
    try {
      setMetrics(await replayApi.metrics(replayId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  if (!status || !replayId) {
    return (
      <Panel title="Perfect foresight benchmark">
        <p className="text-xs text-terminal-muted">
          Run a Historical Replay first — the benchmark is computed on the same day and data store,
          then compared against the rolling strategy here.
        </p>
      </Panel>
    );
  }

  const sched = metrics?.perfect_foresight_schedule;
  const chartData =
    sched?.map((p) => ({
      sp: p.settlement_period,
      price: p.price,
      charge: p.charge_mw,
      discharge: -p.discharge_mw,
      soc: p.ending_soc_mwh,
    })) || [];

  return (
    <div className="space-y-4">
      {!metrics && (
        <Panel title="Perfect foresight benchmark">
          <button
            onClick={load}
            disabled={loading || !status.complete}
            className="rounded border border-kind-estimated/40 text-kind-estimated px-3 py-1 text-xs hover:bg-kind-estimated/10 disabled:opacity-40"
          >
            {status.complete ? "Compute benchmark" : "Finish the replay first"}
          </button>
          {loading && <Spinner label="Optimising on the realised path…" />}
          {error && <ErrorNote error={error} />}
        </Panel>
      )}
      {metrics && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat
              label="Perfect-foresight P&L"
              value={gbp(metrics.perfect_foresight_pnl_gbp)}
              accent="#fbbf24"
              sub="upper bound — not attainable"
            />
            <Stat
              label="Rolling strategy P&L"
              value={gbp(metrics.table[0]?.realised_pnl_gbp ?? 0)}
              sub={`captured ${metrics.table[0]?.capture_of_perfect_pct ?? "—"}% of perfect`}
            />
            <Stat label="Day peak captured" value={metrics.peak_trough.peak_captured ? "Yes" : "No"} />
            <Stat label="Day trough captured" value={metrics.peak_trough.trough_captured ? "Yes" : "No"} />
          </div>
          {sched && (
            <Panel title="Hindsight-optimal schedule (labelled benchmark — decided on realised prices)">
              <MultiSeriesChart
                data={chartData}
                height={280}
                zeroLine
                leftLabel="MW"
                rightLabel="£/MWh"
                series={[
                  { key: "charge", name: "Charge", color: "#22c55e", type: "bar" },
                  { key: "discharge", name: "Discharge", color: "#ef4444", type: "bar" },
                  { key: "price", name: "Realised price", color: "#fbbf24", yAxis: "right" },
                  { key: "soc", name: "SoC (MWh)", color: "#38bdf8" },
                ]}
              />
            </Panel>
          )}
          <MetricsPanel metrics={metrics} />
        </>
      )}
    </div>
  );
}
