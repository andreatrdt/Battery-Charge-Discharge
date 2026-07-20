"use client";

import { useMemo, useState } from "react";
import { BatteryVisual } from "../components/BatteryVisual";
import { ProvBadge } from "../components/badges";
import { SettlementTable } from "../components/SettlementTable";
import { ErrorNote, Panel, Spinner, Stat } from "../components/ui";
import { gbp, num, type PeriodResult } from "../lib/api";
import { useOptimise } from "../lib/hooks";
import { useAppState } from "../lib/store";

type PeriodWithSplit = PeriodResult & {
  energy_action?: "CHARGE" | "DISCHARGE" | "IDLE";
  flexibility_position?: "NONE" | "UP" | "DOWN" | "BOTH";
};

function energyAction(p: PeriodWithSplit): "CHARGE" | "DISCHARGE" | "IDLE" {
  if (p.energy_action) return p.energy_action;
  if (p.charge_mw > 1e-4) return "CHARGE";
  if (p.discharge_mw > 1e-4) return "DISCHARGE";
  return "IDLE";
}

function flexibility(p: PeriodWithSplit): "NONE" | "UP" | "DOWN" | "BOTH" {
  if (p.flexibility_position) return p.flexibility_position;
  const up = p.upward_reserved_mw > 1e-4;
  const down = p.downward_reserved_mw > 1e-4;
  return up && down ? "BOTH" : up ? "UP" : down ? "DOWN" : "NONE";
}

export default function TerminalPage() {
  const [mode, setMode] = useState("deterministic");
  const [riskAversion, setRiskAversion] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const { day, source, config } = useAppState();

  const extra = mode === "stochastic" ? { risk_aversion: riskAversion, n_scenarios: 25 } : {};
  const { result, warnings, loading, error, run } = useOptimise(mode, extra);

  const isHindsight = source === "elexon" && day < new Date().toISOString().slice(0, 10);

  const selectedPeriod = useMemo<PeriodWithSplit | null>(
    () => (result?.periods.find((p) => p.settlement_period === selected) as PeriodWithSplit | undefined) || null,
    [result, selected],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Optimisation Terminal</h1>
        <div className="flex items-center gap-2 text-xs">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="bg-terminal-bg border border-terminal-border rounded px-2 py-1">
            <option value="deterministic">Deterministic (expected value)</option>
            <option value="stochastic">Stochastic (scenario + CVaR)</option>
            <option value="robust">Robust (worst-case)</option>
          </select>
          {mode === "stochastic" && (
            <label className="flex items-center gap-2">
              <span className="text-terminal-muted">Risk aversion {riskAversion.toFixed(1)}</span>
              <input type="range" min={0} max={5} step={0.5} value={riskAversion} onChange={(e) => setRiskAversion(parseFloat(e.target.value))} />
            </label>
          )}
          <button onClick={run} className="rounded border border-kind-observed/40 text-kind-observed px-3 py-1 hover:bg-kind-observed/10">
            Re-optimise
          </button>
        </div>
      </div>

      {isHindsight && (
        <div className="inline-flex rounded border border-kind-estimated/50 bg-kind-estimated/15 px-2 py-1 text-[11px] text-kind-estimated">
          Perfect foresight — completed-day realised prices
        </div>
      )}

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Solving optimisation…" />}

      {result && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="Total expected model P&L" value={gbp(result.total_expected_pnl_gbp)} accent="#22c55e" sub="single-shot objective" />
            <Stat label="Wholesale" value={gbp(result.total_wholesale_pnl_gbp)} />
            <Stat label="Service availability" value={gbp(result.total_service_pnl_gbp)} sub="experimental / assumed" />
            <Stat label="Expected BM activation" value={gbp(result.total_bm_activation_pnl_gbp)} sub="experimental / assumed" />
            <Stat label="Degradation" value={`−${gbp(result.total_degradation_cost_gbp)}`} accent="#ef4444" />
            <Stat label="Full cycles" value={num(result.full_cycle_equivalents, 2)} sub={`solver: ${result.solver}`} />
          </div>

          {warnings.length > 0 && (
            <div className="text-xs text-kind-estimated">{warnings.join(" · ")}</div>
          )}

          <SettlementTable periods={result.periods} onSelect={setSelected} selected={selected} />

          {selectedPeriod && <PeriodDetail p={selectedPeriod} config={config} />}
        </>
      )}
    </div>
  );
}

function PeriodDetail({
  p,
  config,
}: {
  p: PeriodWithSplit;
  config: {
    energy_capacity_mwh: number;
    maximum_charge_mw: number;
    maximum_discharge_mw: number;
    discharge_efficiency: number;
  };
}) {
  return (
    <Panel
      title={`Inspect — SP${p.settlement_period}`}
      right={
        <div className="flex items-center gap-2 text-[10px]">
          <SplitBadge label={`ENERGY: ${energyAction(p)}`} color={energyAction(p) === "CHARGE" ? "#22c55e" : energyAction(p) === "DISCHARGE" ? "#ef4444" : "#7c8896"} />
          <SplitBadge label={`FLEX: ${flexibility(p)}`} color={flexibility(p) === "NONE" ? "#7c8896" : "#c084fc"} />
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
        <BatteryVisual
          socMwh={p.ending_soc_mwh}
          capacityMwh={config.energy_capacity_mwh}
          chargeMw={p.charge_mw}
          dischargeMw={p.discharge_mw}
          maxChargeMw={config.maximum_charge_mw}
          maxDischargeMw={config.maximum_discharge_mw}
          upCapabilityMw={p.upward_reserved_mw}
          downCapabilityMw={p.downward_reserved_mw}
          dischargeEfficiency={config.discharge_efficiency}
        />

        <div className="grid md:grid-cols-3 gap-4 text-xs">
          <div>
            <h3 className="text-terminal-muted mb-1">Physical decision</h3>
            <ul className="space-y-0.5 tabular">
              <li>Energy action: <strong>{energyAction(p)}</strong></li>
              <li>Flexibility position: <strong>{flexibility(p)}</strong></li>
              <li>Charge: {num(p.charge_mw)} MW ({num(p.energy_charged_mwh)} MWh)</li>
              <li>Discharge: {num(p.discharge_mw)} MW ({num(p.energy_discharged_mwh)} MWh)</li>
              <li>SoC: {num(p.beginning_soc_mwh)} → {num(p.ending_soc_mwh)} MWh</li>
              <li>Up/down capability: {num(p.upward_reserved_mw)} / {num(p.downward_reserved_mw)} MW</li>
            </ul>
          </div>
          <div>
            <h3 className="text-terminal-muted mb-1">Objective contribution</h3>
            <ul className="space-y-0.5 tabular">
              <li>Wholesale: {gbp(p.wholesale_pnl_gbp)}</li>
              <li>Availability: {gbp(p.service_pnl_gbp)} <ProvBadge p="assumed" /></li>
              <li>Expected BM activation: {gbp(p.bm_activation_pnl_gbp)} <ProvBadge p="experimental" /></li>
              <li>Degradation: −{gbp(p.degradation_cost_gbp)}</li>
              <li className="font-semibold">Total model value: {gbp(p.total_expected_pnl_gbp)}</li>
            </ul>
          </div>
          <div>
            <h3 className="text-terminal-muted mb-1">Marginals and constraints</h3>
            <ul className="space-y-0.5 tabular">
              <li>Value of stored MWh: {p.marginals.stored_energy_gbp_per_mwh != null ? gbp(p.marginals.stored_energy_gbp_per_mwh, 1) : "—"}</li>
              <li>Value of empty MWh: {p.marginals.empty_capacity_gbp_per_mwh != null ? gbp(p.marginals.empty_capacity_gbp_per_mwh, 1) : "—"}</li>
              <li>Binding: {p.binding_constraints.join(", ") || "none"}</li>
            </ul>
          </div>
        </div>
      </div>
      <p className="mt-3 rounded border border-terminal-border bg-terminal-bg px-3 py-2 text-sm text-terminal-text">
        {p.explanation}
      </p>
    </Panel>
  );
}

function SplitBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="rounded px-1.5 py-0.5 font-bold" style={{ color, backgroundColor: `${color}1f` }}>
      {label}
    </span>
  );
}
