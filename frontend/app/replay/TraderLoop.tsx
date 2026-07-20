"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type BatteryConfig,
  type DecisionRecord,
  type ReplayStatus,
  gbp,
  num,
  replayApi,
} from "../lib/api";
import { BatteryVisual } from "../components/BatteryVisual";
import { InfoTip, Learn } from "../components/learn";
import { Disclaimer, ErrorNote, Panel, Spinner, Stat } from "../components/ui";

/**
 * Trader-in-the-loop: model recommendation → trader instruction → market
 * execution → confirmed physical state → next optimisation. The controls are
 * gated by the backend state machine (`status.state`); nothing advances until
 * the current gate is resolved.
 */

type Stage =
  | "READY_FOR_RECOMMENDATION"
  | "AWAITING_TRADER_DECISION"
  | "AWAITING_EXECUTION"
  | "AWAITING_STATE_CONFIRMATION"
  | "READY_FOR_NEXT_PERIOD"
  | "COMPLETE";

function actionColor(a: string): string {
  if (a === "CHARGE") return "#22c55e";
  if (a === "DISCHARGE") return "#ef4444";
  return "#64748b";
}

export function TraderLoop({
  config,
  day,
  source,
}: {
  config: BatteryConfig;
  day: string;
  source: string;
}) {
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modCharge, setModCharge] = useState(0);
  const [modDischarge, setModDischarge] = useState(0);
  const [reason, setReason] = useState("");
  const [confirmSoc, setConfirmSoc] = useState<string>("");

  const replayId = status?.replay_id || null;
  const stage = (status?.state as Stage) || "READY_FOR_RECOMMENDATION";
  const rec = status?.recommendation || null;
  const instr = status?.trader_instruction || null;
  const exec = status?.execution || null;
  const lastDecision = status?.decision || null;

  const call = useCallback(
    async (label: string, fn: () => Promise<ReplayStatus>) => {
      setLoading(label);
      setError(null);
      try {
        const s = await fn();
        setStatus(s);
        return s;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(null);
      }
    },
    [],
  );

  const start = useCallback(async () => {
    setDecisions([]);
    const s = await call("Building session…", () =>
      replayApi.start({ config, day, source, horizon_hours: 24 }),
    );
    if (s) setStatus(s);
  }, [call, config, day, source]);

  const onRecommend = () => replayId && call("Optimising recommendation…", () => replayApi.recommend(replayId));
  const onDecision = (decision: string) => {
    if (!replayId) return;
    void call("Recording trader decision…", () =>
      replayApi.traderDecision({
        replay_id: replayId,
        decision,
        charge_mw: decision === "MODIFY" ? modCharge : 0,
        discharge_mw: decision === "MODIFY" ? modDischarge : 0,
        reason: reason || null,
      }),
    );
  };
  const onExecute = () => replayId && call("Simulating execution…", () => replayApi.execute(replayId));
  const onConfirm = () => {
    if (!replayId) return;
    const soc = confirmSoc.trim() === "" ? null : parseFloat(confirmSoc);
    void call("Confirming physical state…", () =>
      replayApi.confirmState({
        replay_id: replayId,
        confirmed_soc_after_mwh: soc,
        soc_source: soc === null ? "executed_action_estimate" : "manual_confirmation",
      }),
    ).then((s) => {
      if (s?.decision) setDecisions((d) => [...d, s.decision as DecisionRecord]);
      setConfirmSoc("");
    });
  };
  const onAdvance = () => {
    if (!replayId) return;
    setModCharge(0);
    setModDischarge(0);
    setReason("");
    void call("Advancing…", () => replayApi.advanceGate(replayId));
  };

  useEffect(() => {
    // Prefill modify fields from the recommendation.
    if (rec) {
      setModCharge(rec.charge_mw);
      setModDischarge(rec.discharge_mw);
    }
  }, [rec]);

  const done = ["READY_FOR_RECOMMENDATION", "COMPLETE"].includes(stage);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <button
          onClick={start}
          className="rounded border border-kind-observed/40 text-kind-observed px-3 py-1.5 hover:bg-kind-observed/10"
        >
          {status ? "Reset / new session" : "Start trader session"}
        </button>
        {status && (
          <span className="text-terminal-muted">
            {source} · {status.day} · SoC{" "}
            <span className="tabular text-kind-observed">{num(status.soc_mwh)} MWh</span> ·{" "}
            {status.step_index}/{status.n_periods} committed · state{" "}
            <span className="tabular text-kind-forecast">{stage}</span>
          </span>
        )}
      </div>

      <Disclaimer>
        <strong>Model recommendation ≠ trader instruction ≠ execution ≠ confirmed state.</strong> The
        optimiser only advises. You accept, modify or reject it; a simulated market fills the
        instruction; and the confirmed physical state — telemetry if you supply it — is what the next
        optimisation starts from. Paper only: no orders are submitted.
      </Disclaimer>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label={loading} />}

      {status?.complete && stage === "COMPLETE" && (
        <Panel title="Session complete">
          <p className="text-xs text-terminal-muted">
            All {status.n_periods} Settlement Periods resolved. Realised paper P&amp;L{" "}
            {gbp(status.summary.realised_pnl_gbp)}.
          </p>
        </Panel>
      )}

      {status && !status.complete && (
        <>
          {/* Prompt to produce the recommendation when at the top of a gate. */}
          {stage === "READY_FOR_RECOMMENDATION" && (
            <Panel title={`Next gate — SP${status.next_settlement_period ?? "—"}`}>
              <p className="mb-2 text-xs text-terminal-muted">
                The battery is at {num(status.soc_mwh)} MWh. Ask the optimiser for its advisory
                recommendation for this Settlement Period.
              </p>
              <button
                onClick={onRecommend}
                className="rounded border border-kind-forecast/50 text-kind-forecast px-3 py-1.5 text-xs hover:bg-kind-forecast/10"
              >
                Get model recommendation
              </button>
            </Panel>
          )}

          {!done && (
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Card 1 — Model recommendation */}
              <Panel title="1 · Model recommendation">
                <div className="mb-2 inline-block rounded bg-kind-estimated/15 px-2 py-0.5 text-[10px] font-bold uppercase text-kind-estimated">
                  Advisory — not executed
                </div>
                {rec ? (
                  <div className="space-y-1 text-xs">
                    <Row k="Recommended action" v={<span style={{ color: actionColor(rec.energy_action) }} className="font-bold">{rec.energy_action} {num(Math.max(rec.charge_mw, rec.discharge_mw))} MW</span>} />
                    <Row k="Expected immediate P&L" v={gbp(rec.expected_immediate_pnl_gbp, 2)} />
                    <Row k="Expected horizon P&L" v={gbp(rec.expected_horizon_pnl_gbp, 0)} />
                    <Row k="Expected SoC after" v={`${num(rec.expected_soc_after_mwh)} MWh`} />
                    <Row k="Forecast price" v={`${num(rec.forecast_price)} £/MWh`} />
                    <Row k="Information cutoff" v={rec.information_cutoff.replace("T", " ").slice(0, 16) + "Z"} />
                    {rec.binding_constraints.length > 0 && (
                      <Row k="Binding" v={rec.binding_constraints.join(", ")} />
                    )}
                    <p className="pt-1 text-terminal-muted leading-relaxed">{rec.explanation}</p>
                  </div>
                ) : (
                  <p className="text-xs text-terminal-muted">No recommendation yet.</p>
                )}
              </Panel>

              {/* Card 2 — Trader decision */}
              <Panel title="2 · Trader decision">
                {stage === "AWAITING_TRADER_DECISION" ? (
                  <div className="space-y-2 text-xs">
                    <p className="text-terminal-muted">
                      Accept the recommendation, modify the MW, or reject to idle.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => onDecision("ACCEPT_RECOMMENDATION")} className="rounded border border-action-charge/50 text-action-charge px-2 py-1 hover:bg-action-charge/10">
                        Accept
                      </button>
                      <button onClick={() => onDecision("REJECT_TO_IDLE")} className="rounded border border-terminal-muted/50 text-terminal-muted px-2 py-1 hover:bg-terminal-border/40">
                        Reject / stay idle
                      </button>
                    </div>
                    <div className="rounded border border-terminal-border p-2">
                      <div className="mb-1 font-semibold">Modify</div>
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-0.5">
                          <span className="text-terminal-muted">Charge MW</span>
                          <input type="number" value={modCharge} min={0} max={config.maximum_charge_mw} onChange={(e) => setModCharge(parseFloat(e.target.value) || 0)} className="w-20 bg-terminal-bg border border-terminal-border rounded px-1 py-0.5" />
                        </label>
                        <label className="flex flex-col gap-0.5">
                          <span className="text-terminal-muted">Discharge MW</span>
                          <input type="number" value={modDischarge} min={0} max={config.maximum_discharge_mw} onChange={(e) => setModDischarge(parseFloat(e.target.value) || 0)} className="w-20 bg-terminal-bg border border-terminal-border rounded px-1 py-0.5" />
                        </label>
                        <label className="flex flex-col gap-0.5 flex-1">
                          <span className="text-terminal-muted">Reason (optional)</span>
                          <input value={reason} onChange={(e) => setReason(e.target.value)} className="bg-terminal-bg border border-terminal-border rounded px-1 py-0.5" />
                        </label>
                        <button onClick={() => onDecision("MODIFY")} className="rounded border border-kind-forecast/50 text-kind-forecast px-2 py-1 hover:bg-kind-forecast/10">
                          Submit modify
                        </button>
                      </div>
                    </div>
                  </div>
                ) : instr ? (
                  <div className="space-y-1 text-xs">
                    <Row k="Decision" v={<span className="font-bold">{instr.decision.replaceAll("_", " ")}</span>} />
                    <Row k="Instructed" v={`${num(instr.charge_mw)} MW charge / ${num(instr.discharge_mw)} MW discharge`} />
                    {rec && (instr.charge_mw !== rec.charge_mw || instr.discharge_mw !== rec.discharge_mw) && (
                      <Row
                        k="Δ vs model"
                        v={
                          <span className="text-kind-estimated">
                            {num((instr.charge_mw - instr.discharge_mw) - (rec.charge_mw - rec.discharge_mw))} MW net
                          </span>
                        }
                      />
                    )}
                    {instr.reason && <Row k="Reason" v={instr.reason} />}
                    <Row k="Actor / source" v={`${instr.actor ?? "—"} (${instr.source})`} />
                  </div>
                ) : (
                  <p className="text-xs text-terminal-muted">Waiting for a recommendation.</p>
                )}
              </Panel>

              {/* Card 3 — Execution */}
              <Panel title="3 · Market execution">
                <div className="mb-2 inline-block rounded bg-kind-forecast/15 px-2 py-0.5 text-[10px] font-bold uppercase text-kind-forecast">
                  Simulated
                </div>
                {stage === "AWAITING_EXECUTION" && (
                  <button onClick={onExecute} className="rounded border border-kind-forecast/50 text-kind-forecast px-3 py-1.5 text-xs hover:bg-kind-forecast/10">
                    Simulate fill of the instruction
                  </button>
                )}
                {exec && (
                  <div className="mt-1 space-y-1 text-xs">
                    <Row k="Status" v={exec.status.replaceAll("_", " ")} />
                    <Row k="Requested" v={`${num(exec.requested_charge_mw)} / ${num(exec.requested_discharge_mw)} MW`} />
                    <Row k="Executed" v={`${num(exec.executed_charge_mw)} / ${num(exec.executed_discharge_mw)} MW`} />
                    <Row k="Fill" v={`${num(exec.executed_energy_mwh)} MWh · ${num(exec.unfilled_mwh)} unfilled`} />
                    <Row k="Source" v={exec.execution_source} />
                  </div>
                )}
                {!exec && stage !== "AWAITING_EXECUTION" && (
                  <p className="text-xs text-terminal-muted">Not yet executed.</p>
                )}
              </Panel>

              {/* Card 4 — Physical state */}
              <Panel title="4 · Confirmed physical state">
                {stage === "AWAITING_STATE_CONFIRMATION" ? (
                  <div className="space-y-2 text-xs">
                    <p className="text-terminal-muted">
                      Confirm the physical state. Leave SoC blank to use the executed-action estimate,
                      or enter a telemetry / metered SoC (authoritative).
                    </p>
                    <label className="flex items-end gap-2">
                      <span className="text-terminal-muted flex flex-col">
                        Confirmed SoC (MWh)
                        <InfoTip text="If provided, this is treated as the authoritative physical state (telemetry/meter/manual) and drives the next optimisation, with any discrepancy vs the executed estimate recorded." />
                      </span>
                      <input value={confirmSoc} onChange={(e) => setConfirmSoc(e.target.value)} placeholder="(estimate)" className="w-24 bg-terminal-bg border border-terminal-border rounded px-1 py-0.5" />
                      <button onClick={onConfirm} className="rounded border border-action-charge/50 text-action-charge px-2 py-1 hover:bg-action-charge/10">
                        Confirm state
                      </button>
                    </label>
                  </div>
                ) : lastDecision?.physical_state ? (
                  <PhysicalStateView d={lastDecision} />
                ) : (
                  <p className="text-xs text-terminal-muted">Not yet confirmed.</p>
                )}
              </Panel>
            </div>
          )}

          {/* Advance gate */}
          {stage === "READY_FOR_NEXT_PERIOD" && (
            <Panel title="Ready for the next period">
              {lastDecision && <CommittedSummary d={lastDecision} config={config} />}
              <div className="mt-2">
                <button onClick={onAdvance} className="rounded border border-kind-observed/50 text-kind-observed px-3 py-1.5 text-xs hover:bg-kind-observed/10">
                  Recalculate next period →
                </button>
                <p className="mt-1 text-[11px] text-terminal-muted">
                  The next optimisation will start from confirmed SoC ={" "}
                  {num(lastDecision?.physical_state?.confirmed_soc_after_mwh ?? status.soc_mwh)} MWh. The
                  previous future schedule is advisory and is now superseded.
                </p>
              </div>
            </Panel>
          )}
        </>
      )}

      {decisions.length > 0 && <TraderAuditLog decisions={decisions} />}
    </div>
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

function PhysicalStateView({ d }: { d: DecisionRecord }) {
  const ps = d.physical_state!;
  const recon = ps.reconciliation_difference_mwh;
  return (
    <div className="space-y-1 text-xs">
      <Row k="SoC before" v={`${num(ps.soc_before_mwh)} MWh`} />
      <Row k="Model-expected SoC" v={`${num(ps.model_expected_soc_after_mwh)} MWh`} />
      <Row k="Execution-implied SoC" v={`${num(ps.executed_implied_soc_after_mwh)} MWh`} />
      <Row
        k="Confirmed SoC"
        v={<span className="font-bold text-kind-observed">{num(ps.confirmed_soc_after_mwh)} MWh</span>}
      />
      <Row k="Source" v={ps.soc_source.replaceAll("_", " ")} />
      <Row
        k="Reconciliation Δ"
        v={<span style={{ color: Math.abs(recon) > 0.001 ? "#f59e0b" : undefined }}>{num(recon)} MWh</span>}
      />
      <Row k="State status" v={ps.status} />
    </div>
  );
}

function CommittedSummary({ d, config }: { d: DecisionRecord; config: BatteryConfig }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <BatteryVisual
        socMwh={d.physical_state?.confirmed_soc_after_mwh ?? d.soc_after_mwh}
        capacityMwh={config.energy_capacity_mwh}
        chargeMw={d.charge_mw}
        dischargeMw={d.discharge_mw}
        maxChargeMw={config.maximum_charge_mw}
        maxDischargeMw={config.maximum_discharge_mw}
        upCapabilityMw={d.up_capability_mw}
        downCapabilityMw={d.down_capability_mw}
        dischargeEfficiency={config.discharge_efficiency}
      />
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Committed action" value={`${d.energy_action} ${num(Math.max(d.charge_mw, d.discharge_mw))} MW`} accent={actionColor(d.energy_action)} />
        <Stat label="Realised P&L" value={d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 2) : "pending"} />
        <Stat label="Actual price" value={d.actual_price != null ? `${num(d.actual_price)} £/MWh` : "—"} />
        <Stat label="Forecast error" value={d.forecast_error != null ? `${num(d.forecast_error)} £/MWh` : "—"} />
      </div>
    </div>
  );
}

function TraderAuditLog({ decisions }: { decisions: DecisionRecord[] }) {
  return (
    <Panel title={`Trader audit log (${decisions.length} committed) — immutable history`}>
      <div className="scroll-x max-h-[40vh] overflow-y-auto">
        <table className="w-full text-[11px] tabular">
          <thead className="sticky top-0 bg-terminal-panel">
            <tr className="text-terminal-muted text-left">
              {["SP", "Model rec", "Trader decision", "Executed", "Confirmed SoC", "SoC source", "Δ model↔trader", "Realised £"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 border-b border-terminal-border">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => {
              const rec = d.recommendation;
              const instr = d.trader_instruction;
              const dev = rec && instr ? (instr.charge_mw - instr.discharge_mw) - (rec.charge_mw - rec.discharge_mw) : 0;
              return (
                <tr key={d.step} className="border-b border-terminal-border/40">
                  <td className="px-2 py-1">SP{d.settlement_period}</td>
                  <td className="px-2 py-1" style={{ color: rec ? actionColor(rec.energy_action) : undefined }}>
                    {rec ? `${rec.energy_action} ${num(Math.max(rec.charge_mw, rec.discharge_mw), 0)}` : "—"}
                  </td>
                  <td className="px-2 py-1">{instr ? instr.decision.replaceAll("_", " ") : "—"}</td>
                  <td className="px-2 py-1" style={{ color: actionColor(d.energy_action) }}>
                    {d.energy_action} {num(Math.max(d.charge_mw, d.discharge_mw), 0)}
                  </td>
                  <td className="px-2 py-1">{num(d.physical_state?.confirmed_soc_after_mwh ?? d.soc_after_mwh)}</td>
                  <td className="px-2 py-1 text-terminal-muted">{d.physical_state?.soc_source.replaceAll("_", " ") ?? "—"}</td>
                  <td className="px-2 py-1" style={{ color: Math.abs(dev) > 1e-4 ? "#f59e0b" : undefined }}>{num(dev, 1)}</td>
                  <td className="px-2 py-1">{d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 0) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-terminal-muted">
        Every row records the model recommendation, the trader&apos;s instruction, the simulated
        execution and the confirmed physical state at the time — never rewritten by later information.
      </p>
    </Panel>
  );
}
