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

export interface AppState {
  config: BatteryConfig;
  setConfig: (c: BatteryConfig) => void;
  day: string;
  setDay: (d: string) => void;
  source: string;
  setSource: (s: string) => void;
  offline: boolean;
  setOffline: (o: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<BatteryConfig>(DEFAULT_CONFIG);
  const [day, setDay] = useState("2025-01-15");
  const [source, setSource] = useState("synthetic");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("gbb_state");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.config) setConfig(s.config);
        if (s.day) setDay(s.day);
        if (s.source) setSource(s.source);
        if (typeof s.offline === "boolean") setOffline(s.offline);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("gbb_state", JSON.stringify({ config, day, source, offline }));
  }, [config, day, source, offline]);

  return (
    <Ctx.Provider value={{ config, setConfig, day, setDay, source, setSource, offline, setOffline }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState must be used within AppProvider");
  return v;
}
