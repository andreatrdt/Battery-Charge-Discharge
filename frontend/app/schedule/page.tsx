"use client";

import { MultiSeriesChart } from "../components/charts";
import { ErrorNote, Panel, Spinner } from "../components/ui";
import { useOptimise } from "../lib/hooks";

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
    wholesalePnl: p.wholesale_pnl_gbp,
    servicePnl: p.service_pnl_gbp + p.bm_activation_pnl_gbp,
    totalPnl: p.total_expected_pnl_gbp,
    cumWholesale: 0,
    cumTotal: 0,
  }));
  let cumWholesale = 0;
  let cumTotal = 0;
  rows.forEach((r) => {
    cumWholesale += r.wholesalePnl;
    cumTotal += r.totalPnl;
    r.cumWholesale = Math.round(cumWholesale);
    r.cumTotal = Math.round(cumTotal);
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Schedule</h1>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Solving optimisation…" />}

      {result && !loading && (
        <div className="grid gap-4">
          <Panel title="Wholesale reference-price path (with ±σ uncertainty lines)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              leftLabel="£/MWh"
              series={[
                { key: "priceHi", name: "Upper", color: "#a78bfa", dashed: true },
                { key: "price", name: "Wholesale reference price — MID", color: "#38bdf8" },
                { key: "priceLo", name: "Lower", color: "#a78bfa", dashed: true },
              ]}
            />
          </Panel>

          <Panel title="Energy action — charge (+) / discharge (−) (MW)">
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

          <Panel title="State of charge — stored energy (MWh)">
            <MultiSeriesChart data={rows} leftLabel="MWh" series={[{ key: "soc", name: "SoC", color: "#38bdf8", type: "area" }]} />
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

          <Panel title="P&L — wholesale vs total model value (£)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              leftLabel="£/period"
              rightLabel="£ cumulative"
              series={[
                { key: "wholesalePnl", name: "Wholesale period P&L", color: "#38bdf8", type: "bar", yAxis: "left" },
                { key: "servicePnl", name: "Service/BM (assumed)", color: "#f472b6", type: "bar", yAxis: "left" },
                { key: "cumWholesale", name: "Cumulative wholesale", color: "#22c55e", yAxis: "right" },
                { key: "cumTotal", name: "Cumulative total", color: "#fbbf24", yAxis: "right", dashed: true },
              ]}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
