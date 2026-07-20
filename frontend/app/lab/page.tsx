"use client";

import { useMemo, useState } from "react";
import { BatteryVisual } from "../components/BatteryVisual";
import { MultiSeriesChart } from "../components/charts";
import { ProvBadge } from "../components/badges";
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

export default function ReserveBmLabPage() {
  const { config } = useAppState();
  const [selectedSp, setSelectedSp] = useState<number | null>(null);
  const { result, warnings, loading, error, run } = useOptimise("deterministic", {
    streams: {
      wholesale: true,
      upward_availability: true,
      downward_availability: true,
      bm_activation: true,
      imbalance: false,
    },
  });

  const periods = useMemo(() => (result?.periods || []) as PeriodWithSplit[], [result]);
  const selected = periods.find((p) => p.settlement_period === selectedSp) || periods[0] || null;

  const rows = useMemo(
    () =>
      periods.map((p) => ({
        sp: p.settlement_period,
        price: p.wholesale_price,
        charge: p.charge_mw,
        discharge: -p.discharge_mw,
        up: p.upward_reserved_mw,
        down: -p.downward_reserved_mw,
        soc: p.ending_soc_mwh,
        wholesalePnl: p.wholesale_pnl_gbp,
        availabilityPnl: p.service_pnl_gbp,
        activationPnl: p.bm_activation_pnl_gbp,
      })),
    [periods],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Reserve &amp; BM Laboratory</h1>
        <button
          onClick={run}
          className="rounded border border-kind-observed/40 px-3 py-1 text-xs text-kind-observed hover:bg-kind-observed/10"
        >
          Re-run
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <StageCard title="Capability" badge="experimental" status="Estimated" />
        <StageCard title="Offered" badge="assumed" status="Not offered" />
        <StageCard title="Accepted" badge="experimental" status="Not accepted" />
        <StageCard title="Activated" badge="experimental" status="Not activated" />
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Solving the experimental reserve/BM allocation…" />}

      {result && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Stat label="Total model objective" value={gbp(result.total_expected_pnl_gbp)} sub="not realised trading P&L" />
            <Stat label="Wholesale component" value={gbp(result.total_wholesale_pnl_gbp)} />
            <Stat label="Availability component" value={gbp(result.total_service_pnl_gbp)} sub="assumed" />
            <Stat label="Expected activation" value={gbp(result.total_bm_activation_pnl_gbp)} sub="assumed expectation" />
            <Stat label="Degradation" value={`−${gbp(result.total_degradation_cost_gbp)}`} />
            <Stat label="Cycles" value={num(result.full_cycle_equivalents, 2)} />
          </div>

          {warnings.length > 0 && (
            <div className="text-xs text-kind-estimated">{warnings.join(" · ")}</div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Energy action — actual planned charge/discharge (MW)">
              <MultiSeriesChart
                data={rows}
                zeroLine
                leftLabel="MW"
                series={[
                  { key: "charge", name: "Charge", color: "#22c55e", type: "bar" },
                  { key: "discharge", name: "Discharge", color: "#ef4444", type: "bar" },
                ]}
              />
            </Panel>

            <Panel title="Flexibility allocation — up (+) / down (−) capability (MW)">
              <MultiSeriesChart
                data={rows}
                zeroLine
                leftLabel="MW"
                series={[
                  { key: "up", name: "Upward capability", color: "#eab308", type: "bar" },
                  { key: "down", name: "Downward capability", color: "#0ea5e9", type: "bar" },
                ]}
              />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="State of charge (MWh)">
              <MultiSeriesChart
                data={rows}
                leftLabel="MWh"
                series={[{ key: "soc", name: "Stored energy", color: "#38bdf8", type: "area" }]}
              />
            </Panel>
            <Panel title="Modelled P&L components by period (£)">
              <MultiSeriesChart
                data={rows}
                zeroLine
                leftLabel="£/period"
                series={[
                  { key: "wholesalePnl", name: "Wholesale", color: "#38bdf8", type: "bar" },
                  { key: "availabilityPnl", name: "Availability (assumed)", color: "#eab308", type: "bar" },
                  { key: "activationPnl", name: "Expected activation (assumed)", color: "#f472b6", type: "bar" },
                ]}
              />
            </Panel>
          </div>

          <Panel title="Period inspection — energy action and flexibility are separate">
            <div className="mb-3 flex flex-wrap gap-1 text-[11px]">
              {periods.map((p) => (
                <button
                  key={p.settlement_period}
                  onClick={() => setSelectedSp(p.settlement_period)}
                  className={`rounded border px-1.5 py-0.5 ${
                    selected?.settlement_period === p.settlement_period
                      ? "border-kind-observed bg-kind-observed/10 text-kind-observed"
                      : "border-terminal-border text-terminal-muted"
                  }`}
                >
                  SP{p.settlement_period}
                </button>
              ))}
            </div>

            {selected && (
              <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
                <BatteryVisual
                  socMwh={selected.ending_soc_mwh}
                  capacityMwh={config.energy_capacity_mwh}
                  chargeMw={selected.charge_mw}
                  dischargeMw={selected.discharge_mw}
                  maxChargeMw={config.maximum_charge_mw}
                  maxDischargeMw={config.maximum_discharge_mw}
                  upCapabilityMw={selected.upward_reserved_mw}
                  downCapabilityMw={selected.downward_reserved_mw}
                  dischargeEfficiency={config.discharge_efficiency}
                />
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Mini label="Energy action" value={energyAction(selected)} />
                    <Mini label="Flexibility position" value={flexibility(selected)} />
                    <Mini label="Up capability" value={`${num(selected.upward_reserved_mw)} MW`} />
                    <Mini label="Down capability" value={`${num(selected.downward_reserved_mw)} MW`} />
                  </div>
                  <p className="rounded border border-terminal-border bg-terminal-bg px-3 py-2 leading-relaxed">
                    {selected.explanation}
                  </p>
                </div>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function StageCard({ title, badge, status }: { title: string; badge: string; status: string }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong>{title}</strong>
        <ProvBadge p={badge} />
      </div>
      <div className="tabular text-sm text-terminal-text">{status}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-terminal-border/60 px-2 py-1.5">
      <div className="text-[10px] uppercase text-terminal-muted">{label}</div>
      <div className="tabular font-semibold">{value}</div>
    </div>
  );
}
