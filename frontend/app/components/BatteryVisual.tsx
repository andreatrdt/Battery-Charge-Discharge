"use client";

/** Visual battery: stored energy vs power flows vs capability (Phase 5).
 *
 * Energy (MWh) is the tank level; power (MW) is the flow rate. Capability
 * arrows are dashed because they are physical estimates, not contracts.
 */

import { Learn } from "./learn";
import { num } from "../lib/api";

export function BatteryVisual({
  socMwh,
  capacityMwh,
  chargeMw,
  dischargeMw,
  maxChargeMw,
  maxDischargeMw,
  upCapabilityMw,
  downCapabilityMw,
  dischargeEfficiency = 0.95,
}: {
  socMwh: number;
  capacityMwh: number;
  chargeMw: number;
  dischargeMw: number;
  maxChargeMw: number;
  maxDischargeMw: number;
  upCapabilityMw?: number;
  downCapabilityMw?: number;
  dischargeEfficiency?: number;
}) {
  const fillPct = Math.min(Math.max(socMwh / Math.max(capacityMwh, 1e-9), 0), 1);
  const empty = capacityMwh - socMwh;
  const flowMw = Math.max(dischargeMw, maxDischargeMw / 2, 1);
  const durationH = dischargeMw > 1e-6 ? socMwh * dischargeEfficiency / dischargeMw : socMwh * dischargeEfficiency / flowMw;
  const durationLabel =
    dischargeMw > 1e-6
      ? `≈ ${num(durationH, 1)} h at the current ${num(dischargeMw, 1)} MW discharge`
      : `≈ ${num((socMwh * dischargeEfficiency) / Math.max(maxDischargeMw, 1e-9), 1)} h at full ${num(maxDischargeMw, 0)} MW discharge`;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4">
        {/* Charging arrow (energy flowing IN) */}
        <div className="flex w-28 flex-col items-end text-right text-[11px]">
          <span className={chargeMw > 1e-6 ? "text-action-charge font-bold" : "text-terminal-muted"}>
            {chargeMw > 1e-6 ? `⟶ charging ${num(chargeMw, 1)} MW` : "no charging"}
          </span>
          <span className="text-terminal-muted">max {num(maxChargeMw, 0)} MW</span>
          {downCapabilityMw !== undefined && (
            <span className="mt-1 border-t border-dashed border-kind-forecast/60 pt-1 text-kind-forecast">
              ⇢ could absorb +{num(downCapabilityMw, 1)} MW
            </span>
          )}
        </div>

        {/* The tank */}
        <div className="relative h-40 w-24 rounded-lg border-2 border-terminal-muted/60 bg-terminal-bg overflow-hidden">
          <div className="absolute -top-2 left-1/2 h-2 w-8 -translate-x-1/2 rounded-t border-2 border-b-0 border-terminal-muted/60 bg-terminal-bg" />
          <div
            className="absolute bottom-0 left-0 right-0 bg-kind-observed/40 border-t-2 border-kind-observed transition-all duration-500"
            style={{ height: `${fillPct * 100}%` }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="tabular text-sm font-bold">{num(socMwh, 1)}</span>
            <span className="text-[10px] text-terminal-muted">of {num(capacityMwh, 0)} MWh</span>
          </div>
        </div>

        {/* Discharging arrow (energy flowing OUT) */}
        <div className="flex w-28 flex-col text-[11px]">
          <span className={dischargeMw > 1e-6 ? "text-action-discharge font-bold" : "text-terminal-muted"}>
            {dischargeMw > 1e-6 ? `⟶ discharging ${num(dischargeMw, 1)} MW` : "no discharging"}
          </span>
          <span className="text-terminal-muted">max {num(maxDischargeMw, 0)} MW</span>
          {upCapabilityMw !== undefined && (
            <span className="mt-1 border-t border-dashed border-kind-forecast/60 pt-1 text-kind-forecast">
              ⇢ could export +{num(upCapabilityMw, 1)} MW
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular md:grid-cols-4">
        <span><span className="text-terminal-muted">Stored: </span>{num(socMwh, 1)} MWh</span>
        <span><span className="text-terminal-muted">Empty space: </span>{num(empty, 1)} MWh</span>
        <span><span className="text-terminal-muted">Charge power: </span>{num(chargeMw, 1)} / {num(maxChargeMw, 0)} MW</span>
        <span><span className="text-terminal-muted">Discharge power: </span>{num(dischargeMw, 1)} / {num(maxDischargeMw, 0)} MW</span>
      </div>
      <div className="text-[11px] text-terminal-muted">Duration: {durationLabel}</div>

      <Learn title="MW vs MWh — power vs energy">
        <p>
          <strong>MW is a flow rate</strong> (how fast energy moves right now);{" "}
          <strong>MWh is an amount</strong> (how much is in the tank). They relate through time:
        </p>
        <p className="my-1 rounded bg-terminal-bg px-2 py-1 font-mono text-[11px]">
          Energy (MWh) = Power (MW) × Time (h) &nbsp;&nbsp;→&nbsp;&nbsp; 50 MW for 30 minutes = 25 MWh
        </p>
        <p className="my-1 rounded bg-terminal-bg px-2 py-1 font-mono text-[11px]">
          Duration (h) = Stored energy (MWh) ÷ Power (MW)
        </p>
        <p>
          The <em>power limits</em> ({num(maxChargeMw, 0)} MW) cap how fast this battery can move
          energy; the <em>energy capacity</em> ({num(capacityMwh, 0)} MWh) caps how much it can
          hold. The dashed arrows are <em>physical capability estimates</em> — what the battery
          could additionally do for one hour — not reserve contracts.
        </p>
      </Learn>
    </div>
  );
}
