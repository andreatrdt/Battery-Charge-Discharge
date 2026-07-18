"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AlternativesResult,
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
import { BatteryVisual } from "../components/BatteryVisual";
import { MarketTimeline } from "../components/MarketTimeline";
import { InfoTip, Learn, ProvBadge } from "../components/learn";
import { Disclaimer, ErrorNote, Panel, Spinner, Stat } from "../components/ui";

type Mode = "historical" | "live" | "perfect";

const MODE_LABELS: Record<Mode, string> = {
  historical: "Historical Replay",
  live: "Live Paper Trading",
  perfect: "Perfect Foresight Benchmark",
};

function fmtLondon(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const uk = d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
  return `${uk} UK`;
}

function fmtBoth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const uk = d.toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  return `${uk} UK (${d.toISOString().slice(11, 16)}Z)`;
}

function actionColor(a: string): string {
  if (a === "CHARGE") return "#22c55e";
  if (a === "DISCHARGE") return "#ef4444";
  return "#64748b";
}

function xLabel(dateIso: string, sp: number, firstDate: string): string {
  return dateIso === firstDate ? `SP${sp}` : `D2·SP${sp}`;
}

export default function ReplayPage() {
  const { config, day, setDay } = useAppState();
  const [mode, setMode] = useState<Mode>("historical");
  const [source, setSource] = useState("sample");
  const [strategy, setStrategy] = useState("rolling_forecast");
  const [horizonHours, setHorizonHours] = useState(48);
  const [nDays, setNDays] = useState(1);
  const [executionMode, setExecutionMode] = useState("ideal");
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [view, setView] = useState(0);
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
      const s = await replayApi.start({
        config,
        day,
        source,
        strategy,
        horizon_hours: horizonHours,
        n_days: nDays,
        execution_mode: executionMode,
      });
      setStatus(s);
      if (s.day !== day) setDay(s.day);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(null);
    }
  }, [config, day, source, strategy, horizonHours, nDays, executionMode, setDay]);

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

  useEffect(() => {
    if (status?.complete && replayId && !metrics && decisions.length > 0) {
      replayApi.metrics(replayId).then(setMetrics).catch(() => {});
    }
  }, [status?.complete, replayId, metrics, decisions.length]);

  const opVintageIdx = Math.min(view, Math.max(decisions.length - 1, 0));
  useEffect(() => {
    if (replayId && decisions.length > 0) void fetchVintage(replayId, opVintageIdx);
  }, [replayId, decisions.length, opVintageIdx, fetchVintage]);

  const runLive = useCallback(async () => {
    setLoading("Replaying today up to now, then optimising forward…");
    setError(null);
    setLive(null);
    try {
      const r = await replayApi.live({
        config,
        source: source === "sample" ? "synthetic" : source,
        horizon_hours: horizonHours,
      });
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
  }, [config, source, horizonHours]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Replay &amp; Live Trading</h1>
          <p className="text-xs text-terminal-muted">
            Rolling-horizon simulation: at each gate the model sees only data published before it,
            forecasts the next {horizonHours} hours (across midnight), optimises, and commits one
            Settlement Period.
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

      <MarketTimeline highlight={mode === "live" ? "delivery" : "intraday"} />

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
          charging cost is negative P&amp;L. Execution is <em>simulated</em> against the MID
          wholesale reference price
          {executionMode === "ideal"
            ? " with no spread, liquidity, partial fills or market impact modelled."
            : ` under the "${executionMode}" assumption set (simulated spread/slippage/fills — all labelled assumptions).`}{" "}
          {mode === "live" && "Paper trading only: no orders are submitted anywhere."}
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
          horizonHours={horizonHours}
          setHorizonHours={setHorizonHours}
          nDays={nDays}
          setNDays={setNDays}
          executionMode={executionMode}
          setExecutionMode={setExecutionMode}
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
          replayId={replayId}
          config={config}
        />
      )}
      {mode === "historical" && status && decisions.length === 0 && !loading && (
        <Panel title="Session ready">
          <p className="text-xs text-terminal-muted">
            Point-in-time store built for {status.day}
            {nDays > 1 ? ` (+${nDays - 1} more day${nDays > 2 ? "s" : ""})` : ""} — {status.n_periods}{" "}
            Settlement Periods to execute with a {horizonHours} h optimisation horizon. Press{" "}
            <em>Play</em> or <em>Step</em> to begin.
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

      {mode === "historical" && metrics && status?.complete && <MetricsDashboard metrics={metrics} />}

      {mode === "live" && (
        <LivePanel source={source} setSource={setSource} live={live} onRun={runLive} loading={!!loading} />
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
  horizonHours: number;
  setHorizonHours: (h: number) => void;
  nDays: number;
  setNDays: (n: number) => void;
  executionMode: string;
  setExecutionMode: (m: string) => void;
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
  const current: DecisionRecord | null = view < decisions.length ? decisions[view] : null;
  const btn =
    "rounded border border-terminal-border px-2.5 py-1 hover:bg-terminal-border/40 disabled:opacity-40";
  const sel = "bg-terminal-bg border border-terminal-border rounded px-2 py-1";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Settlement date</span>
          <input type="date" value={props.day} onChange={(e) => props.setDay(e.target.value)} className={sel} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Source</span>
          <select value={props.source} onChange={(e) => props.setSource(e.target.value)} className={sel}>
            <option value="sample">Bundled sample (synthetic, offline)</option>
            <option value="synthetic">Synthetic (any date, offline)</option>
            <option value="elexon">Elexon MID (real, completed days)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">
            Horizon
            <InfoTip text="How far ahead each decision optimises. The horizon crosses midnight; only the first half-hour is ever executed." />
          </span>
          <select value={props.horizonHours} onChange={(e) => props.setHorizonHours(parseInt(e.target.value, 10))} className={sel}>
            <option value={24}>24 h</option>
            <option value={48}>48 h (default)</option>
            <option value={72}>72 h</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Days replayed</span>
          <select value={props.nDays} onChange={(e) => props.setNDays(parseInt(e.target.value, 10))} className={sel}>
            <option value={1}>1 day</option>
            <option value={2}>2 days</option>
            <option value={3}>3 days</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">
            Execution
            <InfoTip text="Simulated execution assumptions. Ideal = full fills at the MID reference. Simple/stress add a configurable spread, slippage and volume haircuts. All are assumptions — MID is not an executable bid/ask." />
          </span>
          <select value={props.executionMode} onChange={(e) => props.setExecutionMode(e.target.value)} className={sel}>
            <option value="ideal">Ideal (reference price)</option>
            <option value="simple">Simple realistic</option>
            <option value="stress">Stress</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-terminal-muted">Strategy</span>
          <select value={props.strategy} onChange={(e) => props.setStrategy(e.target.value)} className={sel}>
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
            <button className={btn} disabled={!!status.complete && atFrontier} onClick={props.onStep}>
              Next ▶
            </button>
            <button className={btn} disabled={status.complete} onClick={() => props.setPlaying(!props.playing)}>
              {props.playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button className={btn} disabled={status.complete} onClick={props.onRunAll}>
              ⏭ Run to end
            </button>
            <label className="flex flex-col gap-1">
              <span className="text-terminal-muted">Speed</span>
              <select value={props.speedMs} onChange={(e) => props.setSpeedMs(parseInt(e.target.value, 10))} className={sel}>
                <option value={2000}>Slow</option>
                <option value={1000}>Normal</option>
                <option value={400}>Fast</option>
              </select>
            </label>
          </>
        )}
      </div>

      {status && (
        <DecisionTimeline
          gate={gate}
          current={current}
          status={status}
          view={view}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------- decision-time timeline */

function DecisionTimeline({
  gate,
  current,
  status,
  view,
}: {
  gate: DecisionRecord | null;
  current: DecisionRecord | null;
  status: ReplayStatus;
  view: number;
}) {
  // The decision whose gate we are standing at (or the last executed one).
  const d = current ?? gate;
  const asOf = current ? current.as_of : status.next_period_start_utc || gate?.end_utc || null;
  return (
    <div className="rounded-lg border border-kind-forecast/30 bg-kind-forecast/5 px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
        <span className="font-semibold text-kind-forecast">
          Decision gate: {fmtBoth(asOf)} · {current ? `SP${current.settlement_period}` : status.complete ? "replay complete" : `SP${status.next_settlement_period ?? "—"}`}
        </span>
        <span className="text-terminal-muted">
          {view}/{status.n_periods} periods executed · SoC {num(status.soc_mwh)} MWh
        </span>
        {d && (
          <span className="text-terminal-muted">
            PIT audit:{" "}
            {d.basis_max_published_at && d.basis_max_published_at <= d.as_of ? (
              <span className="text-action-charge">every input predates the gate ✓</span>
            ) : (
              <span>—</span>
            )}
          </span>
        )}
      </div>

      {d && (
        <div className="relative">
          <div className="absolute left-0 right-0 top-3 h-0.5 bg-terminal-border" />
          <div className="relative grid grid-cols-4 text-center text-[10px]">
            {[
              { label: "latest input available", t: d.basis_max_published_at, color: "#38bdf8" },
              { label: current ? "decision time — NOW" : "decision time", t: d.as_of, color: "#fbbf24" },
              { label: "SP ends", t: d.end_utc, color: "#7c8896" },
              {
                label: d.actual_price_available_at ? "actual published" : "actual not yet published",
                t: d.actual_price_available_at,
                color: "#a78bfa",
              },
            ].map((p, i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <span className="z-10 h-3 w-3 rounded-full border-2 border-terminal-bg" style={{ backgroundColor: p.color }} />
                <span className="tabular font-semibold" style={{ color: p.color }}>
                  {p.t ? fmtLondon(p.t) : "—"}
                </span>
                <span className="text-terminal-muted">{p.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {d && (
        <div className="grid gap-4 text-[11px] md:grid-cols-2">
          <div>
            <div className="mb-1 font-semibold text-action-charge">Known when deciding</div>
            <ul className="list-disc pl-4 text-terminal-muted space-y-0.5">
              <li>{d.n_input_observations} observed reference prices (newest published {fmtLondon(d.basis_max_published_at)})</li>
              <li>{d.n_input_forecasts} published day-ahead forecast rows (demand / wind / solar{d.forecast_basis === "day_ahead_forecast" ? " / price" : ""})</li>
              <li>Current SoC: {num(d.soc_before_mwh)} MWh; all previously executed actions</li>
              <li>Model state &amp; versions (forecast basis: {d.forecast_basis})</li>
            </ul>
          </div>
          <div>
            <div className="mb-1 font-semibold text-action-discharge">Not known yet</div>
            <ul className="list-disc pl-4 text-terminal-muted space-y-0.5">
              <li>The actual price of this period (published {d.actual_price_available_at ? fmtLondon(d.actual_price_available_at) : "later"})</li>
              <li>Actual demand, wind and solar outturns</li>
              <li>All future prices and the model&apos;s own future errors</li>
            </ul>
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
  replayId,
  config,
}: {
  status: ReplayStatus;
  decisions: DecisionRecord[];
  view: number;
  vintage: ForecastVintagePayload | null;
  selected: number | null;
  setSelected: (s: number | null) => void;
  replayId: string | null;
  config: { maximum_charge_mw: number; maximum_discharge_mw: number; energy_capacity_mwh: number; discharge_efficiency: number };
}) {
  const executed = decisions.slice(0, view);
  const last = executed.length ? executed[executed.length - 1] : null;
  const firstDate = decisions[0]?.settlement_date || status.day;

  const { chartData, nowX, midnightX } = useMemo(() => {
    const rows: Record<string, number | string | null>[] = [];
    const seen = new Set<string>();
    let cum = 0;
    for (const d of executed) {
      const x = xLabel(d.settlement_date, d.settlement_period, firstDate);
      seen.add(`${d.settlement_date}|${d.settlement_period}`);
      let realised: number | null = null;
      if (d.realised_pnl_gbp != null) {
        cum += d.realised_pnl_gbp;
        realised = Math.round(cum * 10) / 10;
      }
      rows.push({
        x,
        actual: d.settlement_status === "settled" ? d.actual_price : null,
        forecastUsed: d.forecast_price,
        futurePoint: null,
        futureQ10: null,
        futureQ90: null,
        charge: d.charge_mw,
        discharge: -d.discharge_mw,
        plannedCharge: null,
        plannedDischarge: null,
        soc: d.soc_after_mwh,
        plannedSoc: null,
        cumRealised: realised,
      });
    }
    const lastPlan = last ? last.proposed_schedule : [];
    const planByKey = new Map(lastPlan.map((p) => [`${p.settlement_date}|${p.settlement_period}`, p]));
    let nowXVal: string | null = null;
    let midnight: string | null = null;
    if (vintage) {
      for (const r of vintage.rows) {
        const key = `${r.settlement_date}|${r.settlement_period}`;
        if (seen.has(key)) continue;
        const x = xLabel(r.settlement_date, r.settlement_period, firstDate);
        if (nowXVal === null) nowXVal = x;
        if (midnight === null && r.settlement_date !== firstDate) midnight = x;
        const p = planByKey.get(key);
        rows.push({
          x,
          actual: null,
          forecastUsed: null,
          futurePoint: r.point,
          futureQ10: r.q10,
          futureQ90: r.q90,
          charge: null,
          discharge: null,
          plannedCharge: p ? p.charge_mw : null,
          plannedDischarge: p ? -p.discharge_mw : null,
          soc: null,
          plannedSoc: p ? p.ending_soc_mwh : null,
          cumRealised: null,
        });
      }
    }
    return { chartData: rows, nowX: nowXVal, midnightX: midnight };
  }, [executed, vintage, firstDate, last]);

  const summary = status.summary;
  const selectedDecision = selected !== null ? executed.find((d) => d.step === selected) || null : null;
  const focus = selectedDecision ?? last;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat
          label="Realised paper P&L (net)"
          value={gbp(summary.realised_pnl_gbp)}
          accent="#22c55e"
          sub={`${summary.n_settled}/${status.n_periods} settled · gross ${gbp(summary.realised_gross_pnl_gbp)}`}
        />
        <Stat
          label="Execution costs (simulated)"
          value={`−${gbp(summary.execution_cost_gbp)}`}
          sub={`${summary.execution_mode} mode · ${num(summary.unfilled_mwh, 1)} MWh unfilled`}
        />
        <Stat label="Wholesale revenue" value={gbp(summary.wholesale_revenue_gbp)} />
        <Stat label="Charging cost" value={`−${gbp(summary.charging_cost_gbp)}`} />
        <Stat label="Degradation" value={`−${gbp(summary.degradation_cost_gbp)}`} accent="#ef4444" />
        <Stat
          label="Forecast MAE (1-step)"
          value={summary.forecast_mae != null ? `£${num(summary.forecast_mae)}` : "—"}
          sub={summary.forecast_bias != null ? `bias ${num(summary.forecast_bias)}` : undefined}
        />
      </div>

      {focus && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={`Battery — after SP${focus.settlement_period} (${focus.settlement_date})`}>
            <BatteryVisual
              socMwh={focus.soc_after_mwh}
              capacityMwh={config.energy_capacity_mwh}
              chargeMw={focus.charge_mw}
              dischargeMw={focus.discharge_mw}
              maxChargeMw={config.maximum_charge_mw}
              maxDischargeMw={config.maximum_discharge_mw}
              upCapabilityMw={focus.up_capability_mw}
              downCapabilityMw={focus.down_capability_mw}
              dischargeEfficiency={config.discharge_efficiency}
            />
          </Panel>
          <NowCard d={focus} />
        </div>
      )}

      <Panel title="Wholesale reference price (MID) — REALISED PAST | NOW | FORECAST FUTURE">
        <p className="mb-2 text-[11px] text-terminal-muted">
          Left of the line: observed outturn (solid, <ProvBadge p="observed" />) vs the 1-step
          forecast actually used (dashed). Right: the current model forecast vintage with its
          q10–q90 band (<ProvBadge p="model_forecast" />). Future actual values are never drawn.
          {midnightX && " The dotted grid marks midnight — an accounting boundary, not an economic one."}
        </p>
        <MultiSeriesChart
          data={chartData}
          xKey="x"
          height={280}
          leftLabel="£/MWh"
          xRefLine={nowX ? { x: nowX, label: "NOW / as-of" } : undefined}
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
        <Panel title="Dispatch — executed (solid) vs planned (dark) MW">
          <MultiSeriesChart
            data={chartData}
            xKey="x"
            height={220}
            zeroLine
            leftLabel="MW"
            xRefLine={nowX ? { x: nowX, label: "NOW" } : undefined}
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
            xKey="x"
            height={220}
            leftLabel="MWh"
            xRefLine={nowX ? { x: nowX, label: "NOW" } : undefined}
            series={[
              { key: "soc", name: "SoC (realised)", color: "#38bdf8", type: "area" },
              { key: "plannedSoc", name: "SoC (planned)", color: "#7c8896", dashed: true },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Cumulative realised paper P&L (settled periods only)">
        <MultiSeriesChart
          data={chartData}
          xKey="x"
          height={180}
          zeroLine
          leftLabel="GBP"
          xRefLine={nowX ? { x: nowX, label: "NOW" } : undefined}
          series={[{ key: "cumRealised", name: "Cumulative realised £", color: "#22c55e" }]}
        />
      </Panel>

      <DecisionLog decisions={executed} selected={selected} setSelected={setSelected} />

      {selectedDecision && (
        <DecisionDetail d={selectedDecision} replayId={replayId} />
      )}
    </>
  );
}

/* ------------------------------------------------ "what is happening now?" */

function NowCard({ d }: { d: DecisionRecord }) {
  const acting = d.energy_action !== "IDLE";
  const dirWord = d.energy_action === "CHARGE" ? "buying" : "selling";
  const mw = Math.max(d.charge_mw, d.discharge_mw);
  const mwh = mw * d.duration_hours;
  return (
    <Panel title="What is happening now?">
      <div className="space-y-2 text-xs leading-relaxed">
        <p>
          The battery is{" "}
          {acting ? (
            <>
              <strong style={{ color: actionColor(d.energy_action) }}>
                {d.energy_action === "CHARGE" ? "charging" : "discharging"} at {num(mw, 1)} MW
              </strong>{" "}
              during SP{d.settlement_period}, i.e. {dirWord} {num(mwh, 1)} MWh of wholesale energy
              in this half-hour.
            </>
          ) : (
            <>
              <strong className="text-terminal-muted">idle at {num(d.soc_after_mwh, 1)} MWh</strong>{" "}
              — it is not buying or selling wholesale energy in this period.
            </>
          )}
        </p>
        <p>
          The model estimates it could additionally{" "}
          <strong>increase grid export by {num(d.up_capability_mw, 1)} MW</strong> or{" "}
          <strong>increase grid consumption by {num(d.down_capability_mw, 1)} MW</strong> for one
          hour. These are physical flexibility estimates —{" "}
          <em>not evidence of a reserve contract or NESO activation</em>.
        </p>
        <div className="rounded bg-terminal-bg px-2 py-1.5 font-mono text-[11px]">
          {acting
            ? `Expected P&L = forecast £${num(d.forecast_price, 1)}/MWh × ${d.energy_action === "CHARGE" ? "−" : "+"}${num(mwh, 1)} MWh − degradation £${num(d.degradation_cost_gbp, 2)} = ${gbp(d.expected_immediate_pnl_gbp, 2)}`
            : `Expected P&L = £${num(d.forecast_price, 1)}/MWh × 0 MWh = £0 (holding is free apart from opportunity cost)`}
        </div>
        <Learn title="Why this exact action?">
          <p>{d.explanation}</p>
          {d.binding_constraints.length > 0 && (
            <p className="mt-1">
              <strong>Binding constraints:</strong> {d.binding_constraints.join(", ")} — these are
              the limits stopping the optimiser doing more of the same.
            </p>
          )}
          <p className="mt-1">
            Formula: SoC[t+1] = SoC[t] + η_c·charge·Δt − discharge·Δt/η_d. Full derivation on the{" "}
            <a href="/methodology" className="underline text-kind-observed">Methodology</a> page;
            implementation in <code>gb_battery/optimiser/model.py</code>.
          </p>
        </Learn>
        <p className="text-terminal-muted">
          Continuation value at horizon end: £{num(d.continuation_gbp_per_mwh, 1)}/MWh (
          {d.continuation_method}
          {d.continuation_window ? `, window ${d.continuation_window}` : ""}) ={" "}
          {gbp(d.continuation_value_gbp)} total
          {d.continuation_share_of_objective_pct != null &&
            ` · ${d.continuation_share_of_objective_pct}% of the objective`}
          .{d.continuation_warning && <span className="text-kind-estimated"> {d.continuation_warning}</span>}
        </p>
      </div>
    </Panel>
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
                "Gate (UK)",
                "Date·SP",
                "Fcst £",
                "Actual £",
                "Error",
                "Energy action",
                "Req MW",
                "Exec MW",
                "Up/Down cap MW",
                "SoC after",
                "Expected £",
                "Realised £ (net)",
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
                <td className="px-2 py-1">{fmtLondon(d.as_of).replace(" UK", "")}</td>
                <td className="px-2 py-1">
                  {d.settlement_date.slice(5)}·SP{d.settlement_period}
                </td>
                <td className="px-2 py-1">{num(d.forecast_price)}</td>
                <td className="px-2 py-1">{d.actual_price != null ? num(d.actual_price) : "—"}</td>
                <td className="px-2 py-1" style={{ color: (d.forecast_error ?? 0) > 0 ? "#f59e0b" : undefined }}>
                  {d.forecast_error != null ? num(d.forecast_error) : "—"}
                </td>
                <td className="px-2 py-1 font-bold" style={{ color: actionColor(d.energy_action) }}>
                  {d.energy_action}
                </td>
                <td className="px-2 py-1">{num(Math.max(d.requested_charge_mw, d.requested_discharge_mw))}</td>
                <td className="px-2 py-1">{num(Math.max(d.charge_mw, d.discharge_mw))}</td>
                <td className="px-2 py-1 text-kind-forecast">
                  {num(d.up_capability_mw, 0)}/{num(d.down_capability_mw, 0)}
                </td>
                <td className="px-2 py-1">{num(d.soc_after_mwh)}</td>
                <td className="px-2 py-1">{gbp(d.expected_immediate_pnl_gbp, 0)}</td>
                <td className="px-2 py-1">{d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 0) : "—"}</td>
                <td className="px-2 py-1 text-terminal-muted">{d.settlement_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-terminal-muted">
        Energy action (charge/discharge/idle) and flexibility capability (up/down MW, dashed) are
        independent: an idle battery can still hold large capability in both directions. Req vs
        Exec MW differ when the simulated execution model caps or haircuts fills.
      </p>
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

function DecisionDetail({ d, replayId }: { d: DecisionRecord; replayId: string | null }) {
  const [alts, setAlts] = useState<AlternativesResult | null>(null);
  const [altLoading, setAltLoading] = useState(false);
  const [altError, setAltError] = useState<string | null>(null);
  useEffect(() => {
    setAlts(null);
    setAltError(null);
  }, [d.step]);

  const loadAlts = async () => {
    if (!replayId) return;
    setAltLoading(true);
    try {
      setAlts(await replayApi.alternatives(replayId, d.step));
    } catch (e) {
      setAltError(e instanceof Error ? e.message : String(e));
    } finally {
      setAltLoading(false);
    }
  };

  return (
    <Panel title={`Decision audit — SP${d.settlement_period} (${d.settlement_date}, gate ${fmtBoth(d.as_of)})`}>
      <div className="grid gap-4 md:grid-cols-2 text-xs">
        <div className="space-y-1.5">
          <h3 className="font-semibold text-terminal-text">Information set</h3>
          <Row k="Information cutoff" v={fmtBoth(d.information_cutoff)} />
          <Row k="Newest input publication" v={fmtBoth(d.basis_max_published_at)} />
          <Row k="Optimisation horizon" v={`${d.horizon_hours} h (${d.horizon_n_periods} SPs, to ${fmtBoth(d.horizon_end_utc)})`} />
          <Row k="Observations visible" v={String(d.n_input_observations)} />
          <Row k="Published forecasts visible" v={String(d.n_input_forecasts)} />
          <Row k="Forecast basis" v={`${d.forecast_basis} (${d.forecast_provenance})`} />
          <Row k="Forecast (q10 / point / q90)" v={`${num(d.forecast_q10)} / ${num(d.forecast_price)} / ${num(d.forecast_q90)} £/MWh`} />
          <h3 className="font-semibold text-terminal-text pt-2">Outcome</h3>
          <Row
            k="Actual reference price"
            v={
              d.actual_price != null
                ? `${num(d.actual_price)} £/MWh (${d.actual_price_provenance}, published ${fmtBoth(d.actual_price_available_at)})`
                : "pending — not yet published"
            }
          />
          {d.buy_execution_price != null && (
            <Row k="Simulated buy execution price" v={`${num(d.buy_execution_price)} £/MWh`} />
          )}
          {d.sell_execution_price != null && (
            <Row k="Simulated sell execution price" v={`${num(d.sell_execution_price)} £/MWh`} />
          )}
          <Row k="Forecast error" v={d.forecast_error != null ? `${num(d.forecast_error)} £/MWh` : "—"} />
          <Row k="Expected model P&L (immediate)" v={gbp(d.expected_immediate_pnl_gbp, 2)} />
          <Row k="Realised gross P&L" v={d.realised_gross_pnl_gbp != null ? gbp(d.realised_gross_pnl_gbp, 2) : "pending"} />
          <Row
            k="Execution costs (simulated)"
            v={
              d.spread_slippage_cost_gbp != null
                ? `−${gbp((d.spread_slippage_cost_gbp || 0) + (d.fee_cost_gbp || 0), 2)}`
                : "—"
            }
          />
          <Row k="Realised net paper P&L" v={d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 2) : "pending"} />
          <Row k="Degradation cost" v={gbp(d.degradation_cost_gbp, 2)} />
          <Row k="Expected remaining-horizon P&L" v={gbp(d.expected_horizon_pnl_gbp, 0)} />
          <Row k="Continuation value at horizon end" v={`${gbp(d.continuation_value_gbp, 0)} (${d.continuation_method})`} />
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
          <div className="pt-1">
            {!alts && (
              <button
                onClick={loadAlts}
                disabled={altLoading || !replayId}
                className="rounded border border-kind-forecast/40 px-2 py-1 text-[11px] text-kind-forecast hover:bg-kind-forecast/10 disabled:opacity-40"
              >
                {altLoading ? "Re-solving 4 alternatives…" : "Compare alternatives (4 genuine re-solves)"}
              </button>
            )}
            {altError && <p className="text-action-discharge text-[11px]">{altError}</p>}
            {alts && <AlternativesTable alts={alts} />}
          </div>
          <h3 className="font-semibold text-terminal-text pt-2">
            Proposed schedule at this gate (only SP{d.settlement_period} was executed)
          </h3>
          <div className="max-h-52 overflow-y-auto">
            <table className="w-full tabular text-[11px]">
              <thead>
                <tr className="text-terminal-muted text-left">
                  <th className="px-1 py-0.5">Date·SP</th>
                  <th className="px-1 py-0.5">Energy action</th>
                  <th className="px-1 py-0.5">MW</th>
                  <th className="px-1 py-0.5">End SoC</th>
                  <th className="px-1 py-0.5">Fcst £</th>
                </tr>
              </thead>
              <tbody>
                {d.proposed_schedule.map((p) => (
                  <tr key={`${p.settlement_date}-${p.settlement_period}`} className="border-t border-terminal-border/30">
                    <td className="px-1 py-0.5">{p.settlement_date.slice(5)}·{p.settlement_period}</td>
                    <td className="px-1 py-0.5" style={{ color: actionColor(p.energy_action) }}>
                      {p.energy_action}
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

function AlternativesTable({ alts }: { alts: AlternativesResult }) {
  const order = ["optimiser_selected", "force_charge", "force_discharge", "force_idle"];
  return (
    <div className="space-y-2">
      <table className="w-full tabular text-[11px]">
        <thead>
          <tr className="text-terminal-muted text-left">
            <th className="px-1 py-0.5">Alternative</th>
            <th className="px-1 py-0.5 text-right">Immediate £</th>
            <th className="px-1 py-0.5 text-right">Future £</th>
            <th className="px-1 py-0.5 text-right">Continuation £</th>
            <th className="px-1 py-0.5 text-right">Total objective £</th>
          </tr>
        </thead>
        <tbody>
          {order
            .filter((k) => alts.alternatives[k])
            .map((k) => {
              const a = alts.alternatives[k];
              const isSel = k === "optimiser_selected";
              const isNext = k === alts.next_best;
              return (
                <tr
                  key={k}
                  className={`border-t border-terminal-border/30 ${isSel ? "text-kind-observed font-semibold" : isNext ? "text-kind-forecast" : ""}`}
                >
                  <td className="px-1 py-0.5">
                    {k.replace("_", " ")}
                    {isSel && " ✓"}
                    {isNext && " (next best)"}
                  </td>
                  <td className="px-1 py-0.5 text-right">{gbp(a.immediate_value_gbp, 0)}</td>
                  <td className="px-1 py-0.5 text-right">{gbp(a.future_value_gbp, 0)}</td>
                  <td className="px-1 py-0.5 text-right">{gbp(a.continuation_value_gbp, 0)}</td>
                  <td className="px-1 py-0.5 text-right">{gbp(a.total_objective_gbp, 0)}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {alts.value_gap_gbp != null && (
        <p className="text-[11px] text-terminal-muted">
          The selected action beats the next-best alternative by {gbp(alts.value_gap_gbp)} of
          model-expected value. {alts.note}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
        {Object.entries(alts.marginals).map(([k, m]) => (
          <span key={k}>
            <span className="text-terminal-muted">{k.replace("_", " ")}: </span>
            {m.value != null ? `£${num(m.value, 2)}` : "—"}{" "}
            <span className="text-terminal-muted">({m.unit})</span>
          </span>
        ))}
      </div>
      <Learn title="Reading marginal values">
        One additional stored MWh is worth the shown £ figure under the current forecast because
        the optimiser expects to sell it at better prices later; the same logic applies to extra
        capacity or power. Marginals come from genuine perturbation re-solves and are only shown
        when the solves succeed.
      </Learn>
    </div>
  );
}

/* ------------------------------------------------------------------- metrics */

function MetricsDashboard({ metrics }: { metrics: ReplayMetrics }) {
  const pt = metrics.peak_trough;
  const att = metrics.attribution;
  const tm = metrics.trader_metrics;
  const waterfall = [
    { label: "Expected model P&L", v: att.expected_model_pnl_gbp },
    { label: "Price forecast effect", v: att.price_forecast_effect_gbp },
    { label: "Volume effect", v: att.volume_effect_gbp },
    { label: "Execution costs (simulated)", v: att.execution_cost_effect_gbp },
    { label: "Residual / interaction", v: att.residual_interaction_gbp },
    { label: "Realised net paper P&L", v: att.realised_net_pnl_gbp },
  ];
  const maxAbs = Math.max(...waterfall.map((w) => Math.abs(w.v)), 1);
  return (
    <>
      <Panel title="Strategy comparison — identical information, inventory marked to close">
        <p className="mb-2 text-[11px] text-terminal-muted">
          {metrics.note} {metrics.inventory_note}
        </p>
        <div className="scroll-x">
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="text-terminal-muted text-left">
                {["Strategy", "Realised £ (net)", "Inventory-adj £", "Exec costs", "Cycles", "End SoC", "Max DD", "MAE", "% of perfect", "Regret £"].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 border-b border-terminal-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.table.map((r) => (
                <tr key={r.strategy} className={`border-b border-terminal-border/40 ${r.strategy === "perfect_foresight" ? "text-kind-estimated" : ""}`}>
                  <td className="px-2 py-1">
                    {r.strategy}
                    {r.strategy === "perfect_foresight" && <span className="ml-1 text-[10px] uppercase">(upper bound, not tradable)</span>}
                  </td>
                  <td className="px-2 py-1">{gbp(r.realised_pnl_gbp)}</td>
                  <td className="px-2 py-1">{r.inventory_adjusted_pnl_gbp != null ? gbp(r.inventory_adjusted_pnl_gbp) : "—"}</td>
                  <td className="px-2 py-1">{r.execution_cost_gbp != null ? gbp(r.execution_cost_gbp) : "—"}</td>
                  <td className="px-2 py-1">{r.cycles != null ? num(r.cycles, 2) : "—"}</td>
                  <td className="px-2 py-1">{r.ending_soc_mwh != null ? num(r.ending_soc_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{r.max_drawdown_gbp != null ? gbp(r.max_drawdown_gbp) : "—"}</td>
                  <td className="px-2 py-1">{r.forecast_mae != null ? num(r.forecast_mae) : "—"}</td>
                  <td className="px-2 py-1">{r.capture_of_perfect_pct != null ? `${r.capture_of_perfect_pct}%` : "—"}</td>
                  <td className="px-2 py-1">{r.regret_gbp != null ? gbp(r.regret_gbp) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-terminal-muted">
          <span>
            Day peak (SP{String(pt.peak_sp)} @ £{num(pt.peak_price as number)}): {pt.peak_captured ? "discharged ✓" : "missed ✗"}
          </span>
          <span>
            Day trough (SP{String(pt.trough_sp)} @ £{num(pt.trough_price as number)}): {pt.trough_captured ? "charged ✓" : "missed ✗"}
          </span>
          <span>Leakage audit: {metrics.leakage_ok ? "all decisions provably point-in-time ✓" : "VIOLATIONS FOUND ✗"}</span>
        </div>
      </Panel>

      <Panel title="P&L attribution — expected → realised (exact reconciliation)">
        <p className="mb-2 text-[11px] text-terminal-muted">{att.note}</p>
        <div className="space-y-1">
          {waterfall.map((w, i) => (
            <div key={w.label} className="flex items-center gap-2 text-[11px]">
              <span className={`w-52 shrink-0 text-right ${i === 0 || i === waterfall.length - 1 ? "font-semibold" : "text-terminal-muted"}`}>
                {w.label}
              </span>
              <div className="relative h-4 flex-1">
                <div
                  className="absolute h-4 rounded-sm"
                  style={{
                    left: w.v >= 0 ? "50%" : `${50 - (Math.abs(w.v) / maxAbs) * 48}%`,
                    width: `${(Math.abs(w.v) / maxAbs) * 48}%`,
                    backgroundColor: i === 0 || i === waterfall.length - 1 ? "#38bdf8" : w.v >= 0 ? "#22c55e" : "#ef4444",
                    opacity: 0.8,
                  }}
                />
                <div className="absolute left-1/2 top-0 h-4 w-px bg-terminal-muted/50" />
              </div>
              <span className="w-24 tabular text-right">{gbp(w.v)}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-terminal-muted">
          Reconciliation: {att.reconciles ? "components sum exactly to realised net P&L ✓" : "RESIDUAL EXCEEDS TOLERANCE ✗"}
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Trader metrics">
          <MetricGrid title="Performance" data={tm.performance} units={{ hit_rate_pct: "%", payoff_ratio: "×", profit_factor: "×", n_active_periods: "" }} />
          <MetricGrid title="Risk" data={tm.risk} units={{}} />
          <MetricGrid title="Battery operation" data={tm.battery} units={{ time_near_empty_pct: "%", time_near_full_pct: "%", power_limit_binding_pct: "%", energy_limit_binding_pct: "%", equivalent_full_cycles: "cycles" }} />
          <MetricGrid title="Execution (simulated)" data={tm.execution} units={{ requested_volume_mwh: "MWh", executed_volume_mwh: "MWh", unfilled_volume_mwh: "MWh" }} />
        </Panel>
        <Panel title="Regime analysis (documented rules)">
          <p className="mb-2 text-[10px] text-terminal-muted">{metrics.regimes.rules}</p>
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="text-terminal-muted text-left">
                {["Regime", "n", "MAE", "Bias", "P&L £", "Hit %", "Avg net MW"].map((h) => (
                  <th key={h} className="px-2 py-1 border-b border-terminal-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.regimes.regimes.map((r) => (
                <tr key={r.regime} className="border-b border-terminal-border/30">
                  <td className="px-2 py-1">{r.regime}</td>
                  <td className="px-2 py-1">{r.n_periods}</td>
                  <td className="px-2 py-1">{r.forecast_mae ?? "—"}</td>
                  <td className="px-2 py-1">{r.forecast_bias ?? "—"}</td>
                  <td className="px-2 py-1">{gbp(r.realised_pnl_gbp)}</td>
                  <td className="px-2 py-1">{r.hit_rate_pct ?? "—"}</td>
                  <td className="px-2 py-1">{num(r.avg_net_export_mw, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

function MetricGrid({
  title,
  data,
  units,
}: {
  title: string;
  data: Record<string, number | null | string>;
  units: Record<string, string>;
}) {
  return (
    <div className="mb-3">
      <h3 className="mb-1 text-xs font-semibold">{title}</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] md:grid-cols-3">
        {Object.entries(data).map(([k, v]) => (
          <span key={k} className="flex justify-between gap-2 border-b border-terminal-border/20">
            <span className="text-terminal-muted truncate" title={k}>
              {k.replaceAll("_", " ").replace(" gbp", " £").replace(" pct", "")}
            </span>
            <span className="tabular">
              {v == null
                ? "—"
                : typeof v === "number"
                  ? `${k.includes("gbp") ? "£" : ""}${num(v, Math.abs(v) >= 100 ? 0 : 2)}${units[k] ? ` ${units[k]}` : ""}`
                  : v}
            </span>
          </span>
        ))}
      </div>
    </div>
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
    if (!live) return [] as Record<string, number | string | null>[];
    const rows: Record<string, number | string | null>[] = [];
    const firstDate = live.day;
    const seen = new Set<string>();
    for (const d of live.decisions) {
      seen.add(`${d.settlement_date}|${d.settlement_period}`);
      rows.push({
        x: xLabel(d.settlement_date, d.settlement_period, firstDate),
        actual: d.settlement_status === "settled" ? d.actual_price : null,
        futurePoint: null,
        futureQ10: null,
        futureQ90: null,
        charge: d.charge_mw,
        discharge: -d.discharge_mw,
        plannedCharge: null,
        plannedDischarge: null,
        soc: d.soc_after_mwh,
        plannedSoc: null,
      });
    }
    const planByKey = new Map(
      (live.forward_proposal || []).map((p) => [`${p.settlement_date}|${p.settlement_period}`, p]),
    );
    for (const r of live.forward_vintage?.rows || []) {
      const key = `${r.settlement_date}|${r.settlement_period}`;
      if (seen.has(key)) continue;
      const p = planByKey.get(key);
      rows.push({
        x: xLabel(r.settlement_date, r.settlement_period, firstDate),
        actual: null,
        futurePoint: r.point,
        futureQ10: r.q10,
        futureQ90: r.q90,
        charge: null,
        discharge: null,
        plannedCharge: p ? p.charge_mw : null,
        plannedDischarge: p ? -p.discharge_mw : null,
        soc: null,
        plannedSoc: p ? p.ending_soc_mwh : null,
      });
    }
    return rows;
  }, [live]);

  const nowX = useMemo(() => {
    if (!live?.forward_vintage?.rows?.length) return null;
    const r = live.forward_vintage.rows[0];
    return xLabel(r.settlement_date, r.settlement_period, live.day);
  }, [live]);

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
            <option value="elexon">Elexon MID (live data / simulated execution)</option>
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
            Now: <span className="tabular text-kind-forecast">{fmtBoth(live.now_utc)}</span> · Day {live.day} ·{" "}
            {live.decisions.length} completed SPs replayed
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
              label="Expected model P&L (future)"
              value={gbp((live.forward_proposal || []).reduce((a, p) => a + p.expected_pnl_gbp, 0))}
              sub="forecast-based — kept separate from realised"
            />
            <Stat label="SoC now" value={`${num(live.soc_mwh)} MWh`} />
            <Stat label="Cycles used" value={num(live.summary.cycles, 2)} />
            <Stat
              label="Forecast MAE (today)"
              value={live.summary.forecast_mae != null ? `£${num(live.summary.forecast_mae)}` : "—"}
            />
          </div>

          <Panel title="Today — REALISED PAST | NOW | FORECAST FUTURE (future actual values do not exist)">
            <MultiSeriesChart
              data={chartData}
              xKey="x"
              height={280}
              leftLabel="£/MWh"
              xRefLine={nowX ? { x: nowX, label: "NOW" } : undefined}
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
                xKey="x"
                height={220}
                zeroLine
                leftLabel="MW"
                xRefLine={nowX ? { x: nowX, label: "NOW" } : undefined}
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
                xKey="x"
                height={220}
                leftLabel="MWh"
                xRefLine={nowX ? { x: nowX, label: "NOW" } : undefined}
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
            decisions settled against published outturns), then optimises the next 48 hours from
            now. Live data, simulated execution — nothing is traded anywhere.
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
              value={gbp(metrics.perfect_foresight_inventory_adjusted_gbp ?? metrics.perfect_foresight_pnl_gbp ?? 0)}
              accent="#fbbf24"
              sub="upper bound — not attainable"
            />
            <Stat
              label="Rolling strategy P&L"
              value={gbp(metrics.table[0]?.inventory_adjusted_pnl_gbp ?? metrics.table[0]?.realised_pnl_gbp ?? 0)}
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
          <MetricsDashboard metrics={metrics} />
        </>
      )}
    </div>
  );
}
