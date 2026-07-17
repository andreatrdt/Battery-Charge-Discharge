"use client";

import { useOptimise } from "../lib/hooks";
import { MultiSeriesChart } from "../components/charts";
import { ErrorNote, Panel, Spinner } from "../components/ui";

export default function SchedulePage() {
  const { result, loading, error } = useOptimise();

  const rows = (result?.periods || []).map((p) => ({
    sp: p.settlement_period,
    price: p.wholesale_price,
    priceHi: p.wholesale_price + p.wholesale_price_sigma,
    priceLo: p.wholesale_price - p.wholesale_price_sigma,
    charge: p.charge_mw,
    discharge: -p.discharge_mw,
    soc: p.ending_soc_mwh,
    up: p.upward_reserved_mw,
    down: -p.downward_reserved_mw,
    pnl: p.total_expected_pnl_gbp,
    cumPnl: 0,
  }));
  let cum = 0;
  rows.forEach((r) => {
    cum += r.pnl;
    r.cumPnl = Math.round(cum);
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Schedule Visualisation</h1>
        <p className="text-xs text-terminal-muted">
          Aligned by settlement period. Charge shown positive, discharge negative (net export
          convention).
        </p>
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Solving optimisation…" />}

      {result && !loading && (
        <div className="grid gap-4">
          <Panel title="Price forecast (with ±σ band)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              series={[
                { key: "priceHi", name: "Upper", color: "#a78bfa", dashed: true },
                { key: "price", name: "Wholesale £/MWh", color: "#38bdf8" },
                { key: "priceLo", name: "Lower", color: "#a78bfa", dashed: true },
              ]}
            />
          </Panel>

          <Panel title="Charge (+) / Discharge (−) schedule (MW)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              series={[
                { key: "charge", name: "Charge", color: "#22c55e", type: "bar" },
                { key: "discharge", name: "Discharge", color: "#ef4444", type: "bar" },
              ]}
            />
          </Panel>

          <Panel title="State of charge (MWh)">
            <MultiSeriesChart data={rows} series={[{ key: "soc", name: "SoC", color: "#38bdf8", type: "area" }]} />
          </Panel>

          <Panel title="Reserved capability — up (+) / down (−) (MW)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              series={[
                { key: "up", name: "Reserve up", color: "#eab308", type: "bar" },
                { key: "down", name: "Reserve down", color: "#0ea5e9", type: "bar" },
              ]}
            />
          </Panel>

          <Panel title="Expected P&L (£ per period and cumulative)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              leftLabel="£/period"
              rightLabel="£ cum"
              series={[
                { key: "pnl", name: "Period P&L", color: "#22c55e", type: "bar", yAxis: "left" },
                { key: "cumPnl", name: "Cumulative", color: "#38bdf8", yAxis: "right" },
              ]}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
