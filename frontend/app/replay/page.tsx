"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  gbp,
  num,
  replayApi,
  type BalanceSnapshot,
  type DecisionRecord,
  type ReplayMetrics,
  type ReplayStatus,
} from "../lib/api";
import { useAppState } from "../lib/store";
import { MultiSeriesChart } from "../components/charts";
import { DirectionBadge, StatusBadge } from "../components/badges";
import { ErrorNote, Kpi, Panel, Spinner, Tabs } from "../components/ui";

type Mode = "manual" | "auto";
type Stage =
  | "READY_FOR_RECOMMENDATION"
  | "AWAITING_TRADER_DECISION"
  | "AWAITING_EXECUTION"
  | "AWAITING_STATE_CONFIRMATION"
  | "READY_FOR_NEXT_PERIOD"
  | "COMPLETE";

function actionColor(a: string): string {
  return a === "CHARGE" ? "#22c55e" : a === "DISCHARGE" ? "#ef4444" : "#64748b";
}
function signed(x: number | null | undefined, dp = 1): string {
  if (x == null) return "—";
  const s = x.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return x > 0 ? `+${s}` : s;
}

/** Append newly committed decisions, keyed by settlement date + period. */
function mergeDecisions(prev: DecisionRecord[], incoming: DecisionRecord[]): DecisionRecord[] {
  if (!incoming.length) return prev;
  const seen = new Set(prev.map((d) => `${d.settlement_date}|${d.settlement_period}`));
  const added = incoming.filter((d) => !seen.has(`${d.settlement_date}|${d.settlement_period}`));
  return added.length ? [...prev, ...added] : prev;
}

export default function TradingPage() {
  const { config, day, source } = useAppState();
  const [mode, setMode] = useState<Mode>("manual");
  const [horizonHours, setHorizonHours] = useState(24);
  const [executionMode, setExecutionMode] = useState("ideal");
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [market, setMarket] = useState<BalanceSnapshot | null>(null);
  const [metrics, setMetrics] = useState<ReplayMetrics | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState("Performance");
  const [chartView, setChartView] = useState<"price" | "position">("price");
  const [modCharge, setModCharge] = useState(0);
  const [modDischarge, setModDischarge] = useState(0);
  const [reason, setReason] = useState("");
  const [confirmSoc, setConfirmSoc] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Single-flight guard: refs, not state, because rapid double-clicks land
  // before React re-renders and the disabled attribute takes effect.
  const busyRef = useRef(false);
  const runCancelRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runCancelRef.current = true;
    };
  }, []);

  const replayId = status?.replay_id || null;
  const stage = (status?.state as Stage) || "READY_FOR_RECOMMENDATION";
  const rec = status?.recommendation || null;
  const instr = status?.trader_instruction || null;
  const exec = status?.execution || null;
  const lastDecision = decisions.length ? decisions[decisions.length - 1] : null;

  useEffect(() => {
    if (rec) {
      setModCharge(rec.charge_mw);
      setModDischarge(rec.discharge_mw);
    }
  }, [rec]);

  useEffect(() => {
    if (replayId && status) {
      localStorage.setItem(
        "gbb_last_replay",
        JSON.stringify({ replay_id: replayId, day: status.day, mode: status.mode, source, step_index: status.step_index }),
      );
    }
  }, [replayId, status, source]);

  useEffect(() => {
    if (!status || status.complete) return;
    const sp = status.next_settlement_period;
    if (sp == null) return;
    api
      .balance(status.day, sp, source as "synthetic" | "sample" | "elexon", "live_with_cache", replayId)
      .then(setMarket)
      .catch(() => {});
  }, [status, source, replayId]);

  /** One mutation, no guard — used by the run loop which holds the guard itself. */
  const perform = useCallback(async (label: string, fn: () => Promise<ReplayStatus>) => {
    setLoading(label);
    setError(null);
    try {
      const s = await fn();
      if (!mountedRef.current) return null;
      setStatus(s);
      return s;
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (mountedRef.current) setLoading(null);
    }
  }, []);

  /** Guarded mutation: a second concurrent replay mutation is dropped. */
  const call = useCallback(
    async (label: string, fn: () => Promise<ReplayStatus>) => {
      if (busyRef.current) return null;
      busyRef.current = true;
      try {
        return await perform(label, fn);
      } finally {
        busyRef.current = false;
      }
    },
    [perform],
  );

  const refreshDecisions = useCallback(async (id: string) => {
    const r = await replayApi.decisions(id);
    setDecisions(r.decisions);
  }, []);

  const start = useCallback(async () => {
    setDecisions([]);
    setMetrics(null);
    setSelected(null);
    const s = await call("Building session…", () =>
      replayApi.start({ config, day, source, horizon_hours: horizonHours, execution_mode: executionMode }),
    );
    if (s) setStatus(s);
  }, [call, config, day, source, horizonHours, executionMode]);

  const onRecommend = () => replayId && call("Optimising…", () => replayApi.recommend(replayId));
  const onDecision = (decision: string) =>
    replayId &&
    call("Recording decision…", () =>
      replayApi.traderDecision({
        replay_id: replayId,
        decision,
        charge_mw: decision === "MODIFY" ? modCharge : 0,
        discharge_mw: decision === "MODIFY" ? modDischarge : 0,
        reason: reason || null,
      }),
    );
  const onExecute = () => replayId && call("Simulating fill…", () => replayApi.execute(replayId));
  const onConfirm = () => {
    if (!replayId) return;
    const soc = confirmSoc.trim() === "" ? null : parseFloat(confirmSoc);
    void call("Confirming state…", () =>
      replayApi.confirmState({
        replay_id: replayId,
        confirmed_soc_after_mwh: soc,
        soc_source: soc === null ? "executed_action_estimate" : "manual_confirmation",
      }),
    ).then((s) => {
      if (s) void refreshDecisions(replayId);
      setConfirmSoc("");
    });
  };
  const onAdvance = () => {
    if (!replayId) return;
    setReason("");
    void call("Advancing…", () => replayApi.advanceGate(replayId));
  };
  const onStep = async () => {
    if (!replayId) return;
    const s = await call("Stepping…", () => replayApi.step(replayId, 1));
    if (s) setDecisions((prev) => mergeDecisions(prev, s.new_decisions || []));
  };

  /**
   * Run to end as a controlled sequence of single-period steps. One committed
   * Settlement Period per request keeps every call well inside the dev-proxy
   * timeout; the loop yields to the renderer between requests and stops on
   * completion, error, Stop or unmount.
   */
  const onRunAll = useCallback(async () => {
    if (!replayId || busyRef.current) return;
    busyRef.current = true;
    runCancelRef.current = false;
    setRunning(true);
    setError(null);
    try {
      // Bounded: a settlement day is at most 50 periods (×3 days).
      for (let guard = 0; guard < 200; guard += 1) {
        if (runCancelRef.current || !mountedRef.current) break;
        let s: ReplayStatus;
        try {
          s = await replayApi.step(replayId, 1);
        } catch (e) {
          if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
          break;
        }
        if (!mountedRef.current) break;
        setStatus(s);
        setDecisions((prev) => mergeDecisions(prev, s.new_decisions || []));
        if (s.complete) break;
        // Let React paint the progress before the next request.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setRunning(false);
        setLoading(null);
      }
    }
  }, [replayId]);

  const onStop = () => {
    runCancelRef.current = true;
  };

  const changeMode = (m: Mode) => {
    // Manual input must never race an in-flight automatic run.
    if (m === "manual") runCancelRef.current = true;
    setMode(m);
  };

  useEffect(() => {
    if (status?.complete && replayId && !metrics && decisions.length > 0) {
      replayApi.metrics(replayId).then(setMetrics).catch(() => {});
    }
  }, [status?.complete, replayId, metrics, decisions.length]);

  const chartData = useMemo(
    () =>
      decisions.map((d) => ({
        x: `${d.settlement_date.slice(5)}·${d.settlement_period}`,
        actual: d.settlement_status === "settled" ? d.actual_price : null,
        forecast: d.forecast_price,
        soc: d.soc_after_mwh,
        net: d.discharge_mw - d.charge_mw,
      })),
    [decisions],
  );

  const focus = selected != null ? decisions.find((d) => d.step === selected) || lastDecision : lastDecision;
  const done = ["READY_FOR_RECOMMENDATION", "COMPLETE"].includes(stage);
  // Any replay mutation in flight (single stage or the run loop).
  const busy = loading !== null || running;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-terminal-border bg-terminal-panel px-4 py-2 text-xs">
        <span className="text-sm font-semibold">Trading</span>
        <div className="flex overflow-hidden rounded border border-terminal-border">
          {(["manual", "auto"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => changeMode(m)}
              disabled={loading !== null}
              className={`px-2 py-1 disabled:opacity-40 ${mode === m ? "bg-kind-observed/15 text-kind-observed" : "text-terminal-muted"}`}
            >
              {m === "manual" ? "Manual" : "Auto"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1">
          <span className="text-terminal-muted">Horizon</span>
          <select value={horizonHours} onChange={(e) => setHorizonHours(parseInt(e.target.value, 10))} disabled={busy} className="rounded border border-terminal-border bg-terminal-bg px-1 py-0.5 disabled:opacity-40">
            <option value={24}>24h</option>
            <option value={48}>48h</option>
            <option value={72}>72h</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-terminal-muted">Execution</span>
          <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value)} disabled={busy} className="rounded border border-terminal-border bg-terminal-bg px-1 py-0.5 disabled:opacity-40">
            <option value="ideal">Ideal</option>
            <option value="simple">Simple</option>
            <option value="stress">Stress</option>
          </select>
        </label>
        <button
          onClick={start}
          disabled={busy}
          className="rounded border border-kind-observed/40 px-2 py-1 text-kind-observed hover:bg-kind-observed/10 disabled:opacity-40"
        >
          {status ? "Reset" : "Start"}
        </button>
        {status && mode === "auto" && !status.complete && (
          <>
            <button
              onClick={onStep}
              disabled={busy}
              className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40 disabled:opacity-40"
            >
              Step
            </button>
            {running ? (
              <button
                onClick={onStop}
                className="rounded border border-kind-estimated/60 px-2 py-1 text-kind-estimated hover:bg-kind-estimated/10"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={onRunAll}
                disabled={busy}
                className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40 disabled:opacity-40"
              >
                Run to end
              </button>
            )}
          </>
        )}
        {status && (
          <span className="ml-auto flex items-center gap-1.5 tabular text-terminal-muted">
            {running && (
              <span className="text-kind-observed">
                Running · {status.step_index}/{status.n_periods}
              </span>
            )}
            {source} · {status.day} · {status.step_index}/{status.n_periods} · SoC{" "}
            <span className="text-kind-observed">{num(status.soc_mwh, 1)} MWh</span> <StatusBadge status={stage} />
          </span>
        )}
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label={loading} />}

      {!status && !loading && (
        <Panel title="No session"><p className="text-xs text-terminal-muted">Start a session to begin.</p></Panel>
      )}

      {status && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Settlement Period" value={status.next_settlement_period != null ? String(status.next_settlement_period) : "—"} sub={status.complete ? "complete" : undefined} />
            <Kpi label="Wholesale ref" value={rec?.forecast_price != null ? num(rec.forecast_price, 2) : lastDecision ? num(lastDecision.forecast_price, 2) : "—"} unit="£/MWh" />
            <Kpi label="System Price" value={market?.system?.system_price_gbp_per_mwh != null ? num(market.system.system_price_gbp_per_mwh, 2) : "—"} unit="£/MWh" />
            <Kpi label="GB System" value={market?.system?.direction ? market.system.direction.replace("GB SYSTEM ", "") : "—"} badge={<DirectionBadge dir={market?.system?.direction} />} />
            <Kpi label="Frequency" value={market?.frequency?.latest_frequency_hz != null ? num(market.frequency.latest_frequency_hz, 3) : "—"} unit="Hz" />
            <Kpi label="SoC" value={num(status.soc_mwh, 1)} unit="MWh" />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Current decision">
              {mode === "manual" && !status.complete ? (
                <ManualStages
                  stage={stage} rec={rec} instr={instr} exec={exec} done={done} busy={busy}
                  socMwh={status.soc_mwh} nextSp={status.next_settlement_period}
                  maxCharge={config.maximum_charge_mw} maxDischarge={config.maximum_discharge_mw}
                  modCharge={modCharge} setModCharge={setModCharge}
                  modDischarge={modDischarge} setModDischarge={setModDischarge}
                  reason={reason} setReason={setReason}
                  confirmSoc={confirmSoc} setConfirmSoc={setConfirmSoc}
                  onRecommend={onRecommend} onDecision={onDecision} onExecute={onExecute}
                  onConfirm={onConfirm} onAdvance={onAdvance} lastDecision={lastDecision}
                />
              ) : focus ? (
                <DecisionCard d={focus} />
              ) : (
                <p className="text-xs text-terminal-muted">No committed decision yet.</p>
              )}
            </Panel>

            <Panel
              title="Price · position · SoC"
              right={
                <div className="flex gap-1 text-[10px]">
                  {(["price", "position"] as const).map((v) => (
                    <button key={v} onClick={() => setChartView(v)} className={`rounded border px-1.5 py-0.5 ${chartView === v ? "border-kind-observed/60 text-kind-observed" : "border-terminal-border text-terminal-muted"}`}>
                      {v === "price" ? "Price/SoC" : "Net MW"}
                    </button>
                  ))}
                </div>
              }
            >
              {decisions.length === 0 ? (
                <div className="flex h-[240px] items-center justify-center text-xs text-terminal-muted">No committed periods yet.</div>
              ) : chartView === "price" ? (
                <MultiSeriesChart
                  data={chartData} xKey="x" height={240} leftLabel="£/MWh" rightLabel="MWh"
                  series={[
                    { key: "actual", name: "Actual £", color: "#38bdf8", yAxis: "left" },
                    { key: "forecast", name: "Forecast £", color: "#a78bfa", dashed: true, yAxis: "left" },
                    { key: "soc", name: "SoC", color: "#22c55e", yAxis: "right" },
                  ]}
                />
              ) : (
                <MultiSeriesChart
                  data={chartData} xKey="x" height={240} zeroLine leftLabel="MW"
                  series={[{ key: "net", name: "Net export (MW)", color: "#f59e0b", type: "bar" }]}
                />
              )}
            </Panel>
          </div>

          {decisions.length > 0 && (
            <DecisionHistory decisions={decisions} selected={selected} setSelected={setSelected} />
          )}

          {metrics && (
            <>
              <Tabs tabs={["Performance", "Forecast", "Audit"]} active={tab} onChange={setTab} />
              {tab === "Performance" && <PerformanceTab metrics={metrics} />}
              {tab === "Forecast" && <ForecastTab metrics={metrics} />}
              {tab === "Audit" && <AuditTab metrics={metrics} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ManualStages(props: {
  stage: Stage;
  rec: DecisionRecord["recommendation"];
  instr: DecisionRecord["trader_instruction"];
  exec: DecisionRecord["execution"];
  done: boolean;
  busy: boolean;
  socMwh: number;
  nextSp: number | null;
  maxCharge: number;
  maxDischarge: number;
  modCharge: number;
  setModCharge: (n: number) => void;
  modDischarge: number;
  setModDischarge: (n: number) => void;
  reason: string;
  setReason: (s: string) => void;
  confirmSoc: string;
  setConfirmSoc: (s: string) => void;
  onRecommend: () => void;
  onDecision: (d: string) => void;
  onExecute: () => void;
  onConfirm: () => void;
  onAdvance: () => void;
  lastDecision: DecisionRecord | null;
}) {
  const { stage, rec, instr, exec, busy } = props;
  const btn = "rounded border px-2 py-1 text-xs disabled:opacity-40";
  return (
    <div className="space-y-2 text-xs">
      {stage === "READY_FOR_RECOMMENDATION" && (
        <div className="flex items-center justify-between">
          <span className="text-terminal-muted">Next gate — SP{props.nextSp ?? "—"} · SoC {num(props.socMwh, 1)} MWh</span>
          <button onClick={props.onRecommend} disabled={busy} className={`${btn} border-kind-forecast/50 text-kind-forecast hover:bg-kind-forecast/10`}>Recommend</button>
        </div>
      )}
      {rec && (
        <Row k="Recommended" v={<span style={{ color: actionColor(rec.energy_action) }} className="font-bold">{rec.energy_action} {num(Math.max(rec.charge_mw, rec.discharge_mw), 1)} MW</span>} />
      )}
      {rec && <Row k="Expected P&L" v={`${gbp(rec.expected_immediate_pnl_gbp, 2)} · horizon ${gbp(rec.expected_horizon_pnl_gbp, 0)}`} />}

      {stage === "AWAITING_TRADER_DECISION" && (
        <div className="space-y-2 rounded border border-terminal-border p-2">
          <div className="flex gap-2">
            <button onClick={() => props.onDecision("ACCEPT_RECOMMENDATION")} disabled={busy} className={`${btn} border-action-charge/50 text-action-charge hover:bg-action-charge/10`}>Accept</button>
            <button onClick={() => props.onDecision("REJECT_TO_IDLE")} disabled={busy} className={`${btn} border-terminal-muted/50 text-terminal-muted hover:bg-terminal-border/40`}>Reject</button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5"><span className="text-terminal-muted">Charge MW</span>
              <input type="number" value={props.modCharge} min={0} max={props.maxCharge} onChange={(e) => props.setModCharge(parseFloat(e.target.value) || 0)} className="w-20 rounded border border-terminal-border bg-terminal-bg px-1 py-0.5" />
            </label>
            <label className="flex flex-col gap-0.5"><span className="text-terminal-muted">Discharge MW</span>
              <input type="number" value={props.modDischarge} min={0} max={props.maxDischarge} onChange={(e) => props.setModDischarge(parseFloat(e.target.value) || 0)} className="w-20 rounded border border-terminal-border bg-terminal-bg px-1 py-0.5" />
            </label>
            <button onClick={() => props.onDecision("MODIFY")} disabled={busy} className={`${btn} border-kind-forecast/50 text-kind-forecast hover:bg-kind-forecast/10`}>Modify</button>
          </div>
        </div>
      )}
      {instr && stage !== "AWAITING_TRADER_DECISION" && (
        <Row k="Instructed" v={`${instr.decision.replaceAll("_", " ")} · ${num(instr.charge_mw, 1)}c/${num(instr.discharge_mw, 1)}d MW`} />
      )}

      {stage === "AWAITING_EXECUTION" && (
        <button onClick={props.onExecute} disabled={busy} className={`${btn} border-kind-forecast/50 text-kind-forecast hover:bg-kind-forecast/10`}>Execute (simulated)</button>
      )}
      {exec && <Row k="Executed" v={`${num(exec.executed_charge_mw, 1)}c/${num(exec.executed_discharge_mw, 1)}d MW · ${num(exec.unfilled_mwh, 1)} unfilled`} />}

      {stage === "AWAITING_STATE_CONFIRMATION" && (
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-0.5"><span className="text-terminal-muted">Confirmed SoC (MWh)</span>
            <input value={props.confirmSoc} onChange={(e) => props.setConfirmSoc(e.target.value)} placeholder="(estimate)" className="w-24 rounded border border-terminal-border bg-terminal-bg px-1 py-0.5" />
          </label>
          <button onClick={props.onConfirm} disabled={busy} className={`${btn} border-action-charge/50 text-action-charge hover:bg-action-charge/10`}>Confirm</button>
        </div>
      )}

      {stage === "READY_FOR_NEXT_PERIOD" && props.lastDecision && (
        <>
          <CommercialSummary d={props.lastDecision} />
          <button onClick={props.onAdvance} disabled={busy} className={`${btn} border-kind-observed/50 text-kind-observed hover:bg-kind-observed/10`}>Next period</button>
        </>
      )}
    </div>
  );
}

function DecisionCard({ d }: { d: DecisionRecord }) {
  return (
    <div className="space-y-2 text-xs">
      <Row k="Committed" v={<span style={{ color: actionColor(d.energy_action) }} className="font-bold">{d.energy_action} {num(Math.max(d.charge_mw, d.discharge_mw), 1)} MW</span>} />
      <Row k="SP" v={`${d.settlement_date.slice(5)}·SP${d.settlement_period}`} />
      <Row k="Realised P&L" v={d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 2) : "pending"} />
      <CommercialSummary d={d} />
    </div>
  );
}

const STAGES: [keyof NonNullable<DecisionRecord["commercial"]>, string][] = [
  ["contracted_net_export_mwh", "Contracted"],
  ["model_recommended_net_export_mwh", "Recommended"],
  ["trader_instructed_net_export_mwh", "Instructed"],
  ["executed_net_export_mwh", "Executed"],
  ["confirmed_metered_net_export_mwh", "Metered"],
];

function CommercialSummary({ d }: { d: DecisionRecord }) {
  const c = d.commercial;
  if (!c || c.status === "unavailable") {
    return <div className="text-[11px] text-terminal-muted">Commercial position unavailable</div>;
  }
  return (
    <div className="rounded border border-terminal-border/60 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase text-terminal-muted">Commercial Imbalance (net export MWh)</span>
        <DirectionBadge dir={c.direction} />
      </div>
      <div className="grid grid-cols-5 gap-1 text-center text-[10px]">
        {STAGES.map(([k, label]) => (
          <div key={k}>
            <div className="text-terminal-muted">{label}</div>
            <div className="tabular font-semibold">{c[k] != null ? num(c[k] as number, 1) : "—"}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between border-t border-terminal-border/50 pt-1 text-[11px] tabular">
        <span>Imbalance <span className="font-semibold">{signed(c.commercial_imbalance_mwh, 2)} MWh</span></span>
        <span className="text-terminal-muted">{c.indicative_imbalance_cashflow_gbp != null ? gbp(c.indicative_imbalance_cashflow_gbp, 0) : ""}</span>
      </div>
    </div>
  );
}

function DecisionHistory({
  decisions,
  selected,
  setSelected,
}: {
  decisions: DecisionRecord[];
  selected: number | null;
  setSelected: (s: number | null) => void;
}) {
  const detail = selected != null ? decisions.find((d) => d.step === selected) : null;
  return (
    <Panel title={`Decision history (${decisions.length})`}>
      <div className="scroll-x max-h-[40vh] overflow-y-auto">
        <table className="w-full text-[11px] tabular">
          <thead className="sticky top-0 bg-terminal-panel">
            <tr className="text-left text-terminal-muted">
              {["SP", "Contracted", "Rec MW", "Instr MW", "Exec MW", "Metered", "Comm.imb", "SoC", "Net P&L", "State"].map((h) => (
                <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => {
              const c = d.commercial;
              return (
                <tr key={d.step} onClick={() => setSelected(selected === d.step ? null : d.step)} className={`cursor-pointer border-b border-terminal-border/40 hover:bg-terminal-border/30 ${selected === d.step ? "bg-kind-observed/10" : ""}`}>
                  <td className="px-2 py-1">{d.settlement_date.slice(5)}·{d.settlement_period}</td>
                  <td className="px-2 py-1">{c?.contracted_net_export_mwh != null ? num(c.contracted_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1" style={{ color: actionColor(d.energy_action) }}>{num(Math.max(d.requested_charge_mw, d.requested_discharge_mw), 1)}</td>
                  <td className="px-2 py-1">{num(Math.max(d.requested_charge_mw, d.requested_discharge_mw), 1)}</td>
                  <td className="px-2 py-1">{num(Math.max(d.charge_mw, d.discharge_mw), 1)}</td>
                  <td className="px-2 py-1">{c?.confirmed_metered_net_export_mwh != null ? num(c.confirmed_metered_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{c?.commercial_imbalance_mwh != null ? signed(c.commercial_imbalance_mwh, 2) : "—"}</td>
                  <td className="px-2 py-1">{num(d.soc_after_mwh, 1)}</td>
                  <td className="px-2 py-1">{d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 0) : "—"}</td>
                  <td className="px-2 py-1"><StatusBadge status={d.settlement_status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detail && <DecisionDrawer d={detail} />}
    </Panel>
  );
}

function DecisionDrawer({ d }: { d: DecisionRecord }) {
  return (
    <div className="mt-2 grid gap-3 rounded border border-terminal-border/60 p-3 text-[11px] md:grid-cols-2">
      <div className="space-y-1">
        <Row k="Gate (as-of)" v={d.as_of.replace("T", " ").slice(0, 16) + "Z"} />
        <Row k="Info cutoff" v={d.information_cutoff.replace("T", " ").slice(0, 16) + "Z"} />
        <Row k="Forecast q10/pt/q90" v={`${num(d.forecast_q10)} / ${num(d.forecast_price)} / ${num(d.forecast_q90)}`} />
        <Row k="Actual price" v={d.actual_price != null ? `${num(d.actual_price)} £/MWh` : "pending"} />
        <Row k="Forecast error" v={d.forecast_error != null ? num(d.forecast_error) : "—"} />
        <Row k="Continuation" v={`${gbp(d.continuation_value_gbp, 0)} (${d.continuation_method})`} />
      </div>
      <div className="space-y-1">
        <Row k="Provenance" v={d.forecast_provenance} />
        {d.physical_state && <Row k="SoC source" v={d.physical_state.soc_source.replaceAll("_", " ")} />}
        {d.physical_state && <Row k="Reconciliation Δ" v={`${num(d.physical_state.reconciliation_difference_mwh)} MWh`} />}
        {d.execution && <Row k="Exec source" v={d.execution.execution_source.replaceAll("_", " ")} />}
        {d.commercial && <Row k="Calc method" v={d.commercial.calculation_method} />}
        {d.commercial && d.commercial.assumption_flags.length > 0 && (
          <Row k="Assumptions" v={d.commercial.assumption_flags.join(", ")} />
        )}
      </div>
    </div>
  );
}

function PerformanceTab({ metrics }: { metrics: ReplayMetrics }) {
  return (
    <Panel title="Strategy comparison">
      <div className="scroll-x">
        <table className="w-full text-[11px] tabular">
          <thead>
            <tr className="text-left text-terminal-muted">
              {["Strategy", "Realised £", "Inv-adj £", "Cycles", "End SoC", "Max DD", "% of perfect"].map((h) => (
                <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.table.map((r) => (
              <tr key={r.strategy} className={`border-b border-terminal-border/40 ${r.strategy === "perfect_foresight" ? "text-kind-estimated" : ""}`}>
                <td className="px-2 py-1">{r.strategy.replaceAll("_", " ")}</td>
                <td className="px-2 py-1">{gbp(r.realised_pnl_gbp)}</td>
                <td className="px-2 py-1">{r.inventory_adjusted_pnl_gbp != null ? gbp(r.inventory_adjusted_pnl_gbp) : "—"}</td>
                <td className="px-2 py-1">{r.cycles != null ? num(r.cycles, 2) : "—"}</td>
                <td className="px-2 py-1">{r.ending_soc_mwh != null ? num(r.ending_soc_mwh, 1) : "—"}</td>
                <td className="px-2 py-1">{r.max_drawdown_gbp != null ? gbp(r.max_drawdown_gbp) : "—"}</td>
                <td className="px-2 py-1">{r.capture_of_perfect_pct != null ? `${r.capture_of_perfect_pct}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ForecastTab({ metrics }: { metrics: ReplayMetrics }) {
  const tm = metrics.trader_metrics;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel title="Regime analysis">
        <table className="w-full text-[11px] tabular">
          <thead>
            <tr className="text-left text-terminal-muted">
              {["Regime", "n", "MAE", "Bias", "P&L", "Hit %"].map((h) => (
                <th key={h} className="border-b border-terminal-border px-2 py-1">{h}</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Trader metrics">
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
          {Object.entries(tm.performance).map(([k, v]) => (
            <span key={k} className="flex justify-between border-b border-terminal-border/20">
              <span className="text-terminal-muted">{k.replaceAll("_", " ")}</span>
              <span className="tabular">{v == null ? "—" : typeof v === "number" ? num(v, 2) : v}</span>
            </span>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function AuditTab({ metrics }: { metrics: ReplayMetrics }) {
  return (
    <Panel title="Point-in-time leakage audit">
      <div className="mb-2 text-[11px]">
        <StatusBadge status={metrics.leakage_ok ? "confirmed" : "inconsistent"} />{" "}
        <span className="text-terminal-muted">{metrics.leakage_ok ? "all decisions point-in-time" : "violations found"}</span>
      </div>
      <div className="scroll-x max-h-64 overflow-y-auto">
        <table className="w-full text-[11px] tabular">
          <thead className="sticky top-0 bg-terminal-panel">
            <tr className="text-left text-terminal-muted">
              {["SP", "As-of", "Latest input", "Inputs predate", "Outturn after"].map((h) => (
                <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.leakage_audit.map((a) => (
              <tr key={a.step} className="border-b border-terminal-border/30">
                <td className="px-2 py-1">{a.settlement_period}</td>
                <td className="px-2 py-1">{a.as_of.replace("T", " ").slice(0, 16)}</td>
                <td className="px-2 py-1">{a.basis_max_published_at ? a.basis_max_published_at.replace("T", " ").slice(0, 16) : "—"}</td>
                <td className="px-2 py-1">{a.inputs_predate_decision ? "✓" : "✗"}</td>
                <td className="px-2 py-1">{a.outturn_published_after_decision ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-terminal-border/30 py-0.5">
      <span className="text-terminal-muted">{k}</span>
      <span className="tabular text-right">{v}</span>
    </div>
  );
}
