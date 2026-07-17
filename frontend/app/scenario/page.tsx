"use client";

import { useEffect, useState } from "react";
import { api, gbp, num, type OptimisationResult } from "../lib/api";
import { useAppState } from "../lib/store";
import { MultiSeriesChart } from "../components/charts";
import { ErrorNote, Panel, Spinner, Stat } from "../components/ui";

const LABELS: Record<string, string> = {
  negative_price_afternoon: "Negative-price afternoon",
  evening_price_spike: "Evening price spike",
  falling_wind_tightening_system: "Falling wind, tightening system",
  high_upward_service_value: "High upward-service value",
  high_downward_service_value: "High downward-service value",
  forecast_reversal: "Forecast reversal",
  extreme_imbalance_event: "Extreme imbalance event",
  service_activation: "Service activation",
  battery_nearly_full: "Battery nearly full",
  battery_nearly_empty: "Battery nearly empty",
};

export default function ScenarioPage() {
  const { config, day, source } = useAppState();
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [name, setName] = useState("negative_price_afternoon");
  const [base, setBase] = useState<OptimisationResult | null>(null);
  const [scen, setScen] = useState<OptimisationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.scenarioList().then((r) => setScenarios(r.scenarios)).catch(() => {});
  }, []);

  const runScenario = () => {
    setLoading(true);
    setError(null);
    api
      .scenario({ config, day, source, scenario_name: name })
      .then((r) => {
        setBase(r.base);
        setScen(r.scenario);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    runScenario();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, JSON.stringify(config), day, source]);

  const rows =
    base && scen
      ? base.periods.map((b, i) => ({
          sp: b.settlement_period,
          basePrice: b.wholesale_price,
          scenPrice: scen.periods[i]?.wholesale_price ?? null,
          baseNet: b.discharge_mw - b.charge_mw,
          scenNet: (scen.periods[i]?.discharge_mw ?? 0) - (scen.periods[i]?.charge_mw ?? 0),
          baseSoc: b.ending_soc_mwh,
          scenSoc: scen.periods[i]?.ending_soc_mwh ?? null,
        }))
      : [];

  const delta = base && scen ? scen.total_expected_pnl_gbp - base.total_expected_pnl_gbp : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Scenario Lab</h1>
          <p className="text-xs text-terminal-muted">Re-optimise under a stress scenario and compare with the base case.</p>
        </div>
        <select value={name} onChange={(e) => setName(e.target.value)} className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm">
          {scenarios.map((s) => (
            <option key={s} value={s}>
              {LABELS[s] || s}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Re-optimising scenario…" />}

      {base && scen && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat label="Base P&L" value={gbp(base.total_expected_pnl_gbp)} />
            <Stat label="Scenario P&L" value={gbp(scen.total_expected_pnl_gbp)} accent="#38bdf8" />
            <Stat label="Δ P&L" value={`${delta >= 0 ? "+" : "−"}${gbp(Math.abs(delta))}`} accent={delta >= 0 ? "#22c55e" : "#ef4444"} />
          </div>

          <Panel title="Price — base vs scenario (£/MWh)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              series={[
                { key: "basePrice", name: "Base", color: "#7c8896", dashed: true },
                { key: "scenPrice", name: "Scenario", color: "#38bdf8" },
              ]}
            />
          </Panel>

          <div className="grid lg:grid-cols-2 gap-4">
            <Panel title="Net export — base vs scenario (MW)">
              <MultiSeriesChart
                data={rows}
                zeroLine
                series={[
                  { key: "baseNet", name: "Base", color: "#7c8896", dashed: true },
                  { key: "scenNet", name: "Scenario", color: "#22c55e" },
                ]}
              />
            </Panel>
            <Panel title="SoC trajectory — base vs scenario (MWh)">
              <MultiSeriesChart
                data={rows}
                series={[
                  { key: "baseSoc", name: "Base", color: "#7c8896", dashed: true },
                  { key: "scenSoc", name: "Scenario", color: "#38bdf8" },
                ]}
              />
            </Panel>
          </div>
          <p className="text-xs text-terminal-muted">
            Cycles: base {num(base.full_cycle_equivalents, 2)} vs scenario {num(scen.full_cycle_equivalents, 2)}.
          </p>
        </>
      )}
    </div>
  );
}
