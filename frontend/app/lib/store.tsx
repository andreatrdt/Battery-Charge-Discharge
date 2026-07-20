"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { BatteryConfig } from "./api";

export const DEFAULT_CONFIG: BatteryConfig = {
  name: "Demo 50MW / 100MWh battery",
  energy_capacity_mwh: 100,
  minimum_soc_mwh: 0,
  maximum_soc_mwh: 100,
  initial_soc_mwh: 50,
  maximum_charge_mw: 50,
  maximum_discharge_mw: 50,
  charge_efficiency: 0.95,
  discharge_efficiency: 0.95,
  grid_import_limit_mw: 50,
  grid_export_limit_mw: 50,
  degradation_cost_gbp_per_mwh_throughput: 3,
  minimum_terminal_soc_mwh: 20,
  preferred_terminal_soc_mwh: 50,
  terminal_soc_value_gbp_per_mwh: null,
  maximum_cycles_per_day: 2,
  upward_service_duration_h: 1,
  downward_service_duration_h: 1,
};

export type SourceName = "synthetic" | "sample" | "elexon";
export type NetworkPolicy = "live_with_cache" | "cache_only" | "live_only";

export interface AppState {
  config: BatteryConfig;
  setConfig: (c: BatteryConfig) => void;
  day: string;
  setDay: (d: string) => void;
  /** The single global data source honoured by every page. */
  source: SourceName;
  setSource: (s: SourceName) => void;
  /** Network policy for the Elexon source only (synthetic/sample never fetch). */
  networkPolicy: NetworkPolicy;
  setNetworkPolicy: (p: NetworkPolicy) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<BatteryConfig>(DEFAULT_CONFIG);
  const [day, setDay] = useState("2025-01-15");
  const [source, setSource] = useState<SourceName>("synthetic");
  const [networkPolicy, setNetworkPolicy] = useState<NetworkPolicy>("live_with_cache");

  useEffect(() => {
    try {
      const raw = localStorage.getItem("gbb_state");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.config) setConfig(s.config);
        if (s.day) setDay(s.day);
        if (s.source) setSource(s.source);
        if (s.networkPolicy) setNetworkPolicy(s.networkPolicy);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "gbb_state",
      JSON.stringify({ config, day, source, networkPolicy }),
    );
  }, [config, day, source, networkPolicy]);

  return (
    <Ctx.Provider
      value={{
        config, setConfig, day, setDay, source, setSource,
        networkPolicy, setNetworkPolicy,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState must be used within AppProvider");
  return v;
}
