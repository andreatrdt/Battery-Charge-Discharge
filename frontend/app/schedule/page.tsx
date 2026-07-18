"use client";

import Link from "next/link";
import { MultiSeriesChart } from "../components/charts";
import { MarketTimeline } from "../components/MarketTimeline";
import { Disclaimer, ErrorNote, Panel, Spinner } from "../components/ui";
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
      <div>
        <h1 className="text-lg font-semibold">Schedule Visualisation</h1>
        <p className="text-xs text-terminal-muted">
          Single-shot planned schedule aligned by Settlement Period. Charge is shown positive,
          discharge negative. This page is not the rolling replay result.
        </p>
      </div>

      <MarketTimeline highlight="intraday" />

      <Disclaimer>
        <strong>Do not compare this directly with completed Replay.</strong> This page visualises one
        whole-horizon plan from the Terminal. Replay repeatedly reforecasts and executes only one
        period at a time. The flexibility chart and service/BM P&amp;L are experimental; inspect them
        separately in the{" "}
        <Link href="/lab" className="underline">
          Reserve &amp; BM Laboratory
        </Link>
        .
      </Disclaimer>

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
            <p className="mt-1 text-[10px] text-terminal-muted">
              These bars change stored energy. Power is MW; one 50 MW half-hour action exchanges 25 MWh before efficiency.
            </p>
          </Panel>

          <Panel title="State of charge — stored energy (MWh)">
            <MultiSeriesChart data={rows} leftLabel="MWh" series={[{ key: "soc", name: "SoC", color: "#38bdf8", type: "area" }]} />
          </Panel>

          <Panel title="Experimental flexibility allocation — up (+) / down (−) (MW)">
            <MultiSeriesChart
              data={rows}
              zeroLine
              leftLabel="MW"
              series={[
                { key: "up", name: "Upward capability", color: "#eab308", type: "bar" },
                { key: "down", name: "Downward capability", color: "#0ea5e9", type: "bar" },
              ]}
            />
            <p className="mt-1 text-[10px] text-terminal-muted">
              Downward capability is drawn below zero only to distinguish direction. These values do not prove a real reserve award or activation.
            </p>
          </Panel>

          <Panel title="P&L comparison — credible wholesale vs assumption-based total">
            <MultiSeriesChart
              data={rows}
              zeroLine
              leftLabel="£/period"
              rightLabel="£ cumulative"
              series={[
                { key: "wholesalePnl", name: "Wholesale period P&L", color: "#38bdf8", type: "bar", yAxis: "left" },
                { key: "servicePnl", name: "Service/BM assumed value", color: "#f472b6", type: "bar", yAxis: "left" },
                { key: "cumWholesale", name: "Cumulative wholesale", color: "#22c55e", yAxis: "right" },
                { key: "cumTotal", name: "Cumulative total model value", color: "#fbbf24", yAxis: "right", dashed: true },
              ]}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
