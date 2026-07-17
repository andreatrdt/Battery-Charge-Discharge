"use client";

import { useMemo, useState } from "react";
import { gbp, num, type PeriodResult } from "../lib/api";
import { useOptimise } from "../lib/hooks";
import { SettlementTable } from "../components/SettlementTable";
import { ActionBadge, Disclaimer, ErrorNote, Panel, Spinner, Stat } from "../components/ui";

export default function TerminalPage() {
  const [mode, setMode] = useState("deterministic");
  const [riskAversion, setRiskAversion] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  const extra = mode === "stochastic" ? { risk_aversion: riskAversion, n_scenarios: 25 } : {};
  const { result, warnings, loading, error, run } = useOptimise(mode, extra);

  const selectedPeriod = useMemo<PeriodResult | null>(
    () => result?.periods.find((p) => p.settlement_period === selected) || null,
    [result, selected],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Optimisation Terminal</h1>
          <p className="text-xs text-terminal-muted">
            Half-hourly co-optimised charge/discharge/reserve schedule. Click a row to inspect why.
          </p>
        </div>
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

      <Disclaimer>
        <strong>Sign convention.</strong> P&amp;L is positive = revenue. Charging at a{" "}
        <em>negative</em> price is revenue (paid to consume). MW columns show power at the grid
        connection; SoC is stored energy (MWh). Prices are forecast/estimated unless the source is
        live Elexon.
      </Disclaimer>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Solving optimisation…" />}

      {result && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="Total expected P&L" value={gbp(result.total_expected_pnl_gbp)} accent="#22c55e" />
            <Stat label="Wholesale" value={gbp(result.total_wholesale_pnl_gbp)} />
            <Stat label="Service (avail)" value={gbp(result.total_service_pnl_gbp)} />
            <Stat label="BM activation" value={gbp(result.total_bm_activation_pnl_gbp)} />
            <Stat label="Degradation" value={`−${gbp(result.total_degradation_cost_gbp)}`} accent="#ef4444" />
            <Stat label="Full cycles" value={num(result.full_cycle_equivalents, 2)} sub={`solver: ${result.solver}`} />
          </div>

          {warnings.length > 0 && (
            <div className="text-xs text-kind-estimated">{warnings.join(" · ")}</div>
          )}

          <SettlementTable periods={result.periods} onSelect={setSelected} selected={selected} />

          {selectedPeriod && <PeriodDetail p={selectedPeriod} />}
        </>
      )}
    </div>
  );
}

function PeriodDetail({ p }: { p: PeriodResult }) {
  return (
    <Panel title={`Inspect — SP${p.settlement_period}`} right={<ActionBadge action={p.action} />}>
      <div className="grid md:grid-cols-3 gap-4 text-xs">
        <div>
          <h3 className="text-terminal-muted mb-1">Decision</h3>
          <ul className="space-y-0.5 tabular">
            <li>Charge: {num(p.charge_mw)} MW ({num(p.energy_charged_mwh)} MWh)</li>
            <li>Discharge: {num(p.discharge_mw)} MW ({num(p.energy_discharged_mwh)} MWh)</li>
            <li>SoC: {num(p.beginning_soc_mwh)} → {num(p.ending_soc_mwh)} MWh</li>
            <li>Reserve up/down: {num(p.upward_reserved_mw)} / {num(p.downward_reserved_mw)} MW</li>
          </ul>
        </div>
        <div>
          <h3 className="text-terminal-muted mb-1">Objective contribution</h3>
          <ul className="space-y-0.5 tabular">
            <li>Wholesale: {gbp(p.wholesale_pnl_gbp)}</li>
            <li>Service: {gbp(p.service_pnl_gbp)}</li>
            <li>BM activation: {gbp(p.bm_activation_pnl_gbp)}</li>
            <li>Degradation: −{gbp(p.degradation_cost_gbp)}</li>
            <li className="font-semibold">Total: {gbp(p.total_expected_pnl_gbp)}</li>
          </ul>
        </div>
        <div>
          <h3 className="text-terminal-muted mb-1">Marginal values &amp; constraints</h3>
          <ul className="space-y-0.5 tabular">
            <li>Value of stored MWh: {p.marginals.stored_energy_gbp_per_mwh != null ? gbp(p.marginals.stored_energy_gbp_per_mwh, 1) : "—"}</li>
            <li>Value of empty MWh: {p.marginals.empty_capacity_gbp_per_mwh != null ? gbp(p.marginals.empty_capacity_gbp_per_mwh, 1) : "—"}</li>
            <li>Binding: {p.binding_constraints.join(", ") || "none"}</li>
          </ul>
        </div>
      </div>
      <p className="mt-3 rounded border border-terminal-border bg-terminal-bg px-3 py-2 text-sm text-terminal-text">
        {p.explanation}
      </p>
    </Panel>
  );
}
