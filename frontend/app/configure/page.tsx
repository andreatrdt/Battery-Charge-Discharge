"use client";

import { useAppState, DEFAULT_CONFIG } from "../lib/store";
import type { BatteryConfig } from "../lib/api";
import { Field, Panel } from "../components/ui";

export default function ConfigurePage() {
  const { config, setConfig } = useAppState();

  const set = (k: keyof BatteryConfig) => (v: number) => setConfig({ ...config, [k]: v });
  const rte = (config.charge_efficiency * config.discharge_efficiency * 100).toFixed(1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Battery Configuration</h1>
        <div className="flex gap-4 text-xs tabular text-terminal-muted">
          <span>Round-trip {rte}%</span>
          <span>Usable {config.minimum_soc_mwh}–{config.maximum_soc_mwh} MWh</span>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Panel title="Energy ratings (MWh)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Energy capacity" value={config.energy_capacity_mwh} onChange={set("energy_capacity_mwh")} />
            <Field label="Initial SoC" value={config.initial_soc_mwh} onChange={set("initial_soc_mwh")} />
            <Field label="Minimum SoC" value={config.minimum_soc_mwh} onChange={set("minimum_soc_mwh")} />
            <Field label="Maximum SoC" value={config.maximum_soc_mwh} onChange={set("maximum_soc_mwh")} />
          </div>
        </Panel>

        <Panel title="Power ratings (MW)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max charge" value={config.maximum_charge_mw} onChange={set("maximum_charge_mw")} />
            <Field label="Max discharge" value={config.maximum_discharge_mw} onChange={set("maximum_discharge_mw")} />
            <Field label="Grid import limit" value={config.grid_import_limit_mw} onChange={set("grid_import_limit_mw")} />
            <Field label="Grid export limit" value={config.grid_export_limit_mw} onChange={set("grid_export_limit_mw")} />
          </div>
        </Panel>

        <Panel title="Efficiencies & degradation">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Charge eff (0–1)" value={config.charge_efficiency} onChange={set("charge_efficiency")} step={0.01} />
            <Field label="Discharge eff (0–1)" value={config.discharge_efficiency} onChange={set("discharge_efficiency")} step={0.01} />
            <Field
              label="Degradation £/MWh"
              value={config.degradation_cost_gbp_per_mwh_throughput}
              onChange={set("degradation_cost_gbp_per_mwh_throughput")}
              step={0.5}
              hint="per MWh of throughput (charge + discharge)"
            />
            <Field
              label="Max cycles/day"
              value={config.maximum_cycles_per_day ?? 0}
              onChange={set("maximum_cycles_per_day")}
              step={0.5}
            />
          </div>
        </Panel>

        <Panel title="Terminal SoC">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min terminal SoC" value={config.minimum_terminal_soc_mwh} onChange={set("minimum_terminal_soc_mwh")} />
            <Field label="Preferred terminal SoC" value={config.preferred_terminal_soc_mwh} onChange={set("preferred_terminal_soc_mwh")} />
            <Field
              label="Terminal value £/MWh"
              value={config.terminal_soc_value_gbp_per_mwh ?? 0}
              onChange={set("terminal_soc_value_gbp_per_mwh")}
              hint="0 ⇒ auto (median horizon price)"
            />
          </div>
        </Panel>

        <Panel title="Service-duration requirements (h)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Upward duration" value={config.upward_service_duration_h} onChange={set("upward_service_duration_h")} step={0.5} />
            <Field label="Downward duration" value={config.downward_service_duration_h} onChange={set("downward_service_duration_h")} step={0.5} />
          </div>
        </Panel>

        <Panel title="Reset">
          <button
            onClick={() => setConfig(DEFAULT_CONFIG)}
            className="rounded border border-terminal-border px-3 py-1.5 text-sm hover:bg-terminal-border/40"
          >
            Restore demo defaults
          </button>
        </Panel>
      </div>
    </div>
  );
}
