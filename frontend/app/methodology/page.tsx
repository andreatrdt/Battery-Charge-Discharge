import { MarketTimeline } from "../components/MarketTimeline";
import { Panel } from "../components/ui";

export const metadata = { title: "Methodology — GB Battery Co-Optimisation Terminal" };

export default function MethodologyPage() {
  return (
    <div className="space-y-4 max-w-5xl">
      <h1 className="text-lg font-semibold">Methodology &amp; Limitations</h1>

      <MarketTimeline />

      <Panel title="GB Settlement Periods">
        <p className="text-sm text-terminal-muted">
          The GB market settles in half-hourly Settlement Periods (SPs). A settlement date runs from
          local (Europe/London) midnight to the next. Because of British Summer Time transitions a day
          has <strong>46 SPs</strong> (spring-forward), <strong>48</strong> (normal) or{" "}
          <strong>50</strong> (autumn-back). Each SP is always 30 real minutes, so the optimiser
          derives duration from timestamps and never assumes 48 periods.
        </p>
      </Panel>

      <Panel title="Wholesale vs Balancing Mechanism vs Imbalance">
        <ul className="text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li><strong>Wholesale:</strong> day-ahead / intraday energy. We use Elexon Market Index Data (MID) as a short-term reference price — <em>not</em> a full EPEX order book or guaranteed execution price.</li>
          <li><strong>Balancing Mechanism (BM):</strong> NESO accepts Bids/Offers in real time; acceptances appear in BOALF/BOAV. Submitting a price alone earns nothing — value depends on acceptance, accepted volume and delivery.</li>
          <li><strong>Imbalance:</strong> residual position settled at the single system price after delivery.</li>
        </ul>
      </Panel>

      <Panel title="Battery physics — MW versus MWh">
        <div className="space-y-2 text-sm text-terminal-muted">
          <p><strong>MW is power</strong>: the instantaneous rate at which the battery charges or discharges. <strong>MWh is energy</strong>: the amount stored or exchanged over time.</p>
          <pre className="rounded bg-terminal-bg p-2 text-xs text-terminal-text">Energy (MWh) = Power (MW) × Time (h){"\n"}50 MW × 0.5 h = 25 MWh</pre>
          <p>A 50 MW / 100 MWh battery is a two-hour battery before efficiency: 100 MWh ÷ 50 MW = 2 h.</p>
        </div>
      </Panel>

      <Panel title="Optimisation model">
        <p className="text-sm text-terminal-muted">
          A MILP over SPs with grid-side charge/discharge power, an SoC balance{" "}
          <code className="text-kind-observed">soc[t+1] = soc[t] + η_c·charge·Δt − discharge·Δt/η_d</code>,
          binaries preventing simultaneous charge/discharge, power and grid limits, cycle limits,
          degradation, and explicit terminal/continuation treatment. HiGHS solves the model through
          Pyomo. Reserve constraints remain conservative research simplifications.
        </p>
      </Panel>

      <Panel title="Energy action and flexibility are independent">
        <p className="text-sm text-terminal-muted">
          <strong>Energy action</strong> is Charge, Discharge or Idle and changes SoC. <strong>Flexibility
          position</strong> is Up, Down, Both or None and describes how far the battery could move from
          that operating point. An idle half-full battery can therefore be <em>Idle + Both</em>. Physical
          capability is not evidence of a reserve contract, award or activation.
        </p>
      </Panel>

      <Panel title="Replay & Live Trading — point-in-time rolling simulation">
        <p className="text-sm text-terminal-muted">
          At every decision gate the engine proves what was available, forecasts forward, optimises a
          24/48/72-hour horizon that can cross midnight, executes only the first SP, settles it when the
          outturn becomes available, carries SoC/cycles/P&amp;L forward and repeats.
        </p>
        <ul className="mt-2 text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li><strong>Historical Replay:</strong> completed days replayed chronologically with <code className="text-kind-observed">published_at ≤ as_of</code>.</li>
          <li><strong>Live Paper Trading:</strong> completed periods are settled; future periods contain forecasts only. No order is sent anywhere.</li>
          <li><strong>Perfect Foresight:</strong> realised-path upper bound, always labelled as non-tradable.</li>
        </ul>
      </Panel>

      <Panel title="Cross-day horizon and continuation value">
        <p className="text-sm text-terminal-muted">
          The optimisation horizon defaults to 48 hours and crosses midnight so the battery is not
          forced into artificial end-of-day behaviour. Only the immediate SP is executed. At the end
          of the chosen horizon, stored energy receives an explicit continuation value estimated from
          forecast prices beyond the active horizon. The UI reports the £/MWh coefficient, total value,
          window used and share of the objective.
        </p>
      </Panel>

      <Panel title="Forecasting and validation">
        <p className="text-sm text-terminal-muted">
          Forecasts are evaluated in two framings: one-step-ahead forecasts used by the rolling strategy,
          and start-of-day full paths used for peak/trough timing and ramp analysis. The internal PIT
          model is compared with persistence, same-SP yesterday, same-SP last week, rolling median and
          weekday/SP climatology.
        </p>
        <ul className="mt-2 text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li>Point metrics: MAE, RMSE, bias, correlation, directional accuracy, ramp MAE, peak/trough timing error.</li>
          <li>Probabilistic metrics: q10/q50/q90 pinball loss, q10–q90 coverage, interval width and quantile calibration.</li>
          <li>Economic validation: every benchmark can drive the same rolling battery replay; strategy P&amp;L is shown beside statistical metrics.</li>
          <li>MAPE is deliberately not a headline metric because power prices and solar can be zero or negative.</li>
        </ul>
      </Panel>

      <Panel title="Trader metrics and P&L attribution">
        <p className="text-sm text-terminal-muted">
          Completed replays report realised gross/net P&amp;L, expected-vs-realised surprise, hit rate,
          average win/loss, payoff ratio, profit factor, maximum drawdown, P&amp;L volatility, historical
          VaR and Expected Shortfall, throughput, equivalent cycles, time near limits, execution costs,
          regret and perfect-foresight capture. The attribution reconciles expected model P&amp;L to
          realised net P&amp;L through price-forecast, volume, execution-cost and residual interaction
          effects without claiming unsupported precision.
        </p>
      </Panel>

      <Panel title="Execution modes">
        <ul className="text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li><strong>Ideal:</strong> full simulated fill at MID — theoretical reference-price benchmark.</li>
          <li><strong>Simple realistic:</strong> simulated spread, fee, slippage and volume cap.</li>
          <li><strong>Stress:</strong> wider costs and lower executable volume.</li>
        </ul>
        <p className="mt-2 text-sm text-terminal-muted">
          Executed volume, not requested volume, drives SoC. These are transparent assumptions, not
          reconstructed order-book fills.
        </p>
      </Panel>

      <Panel title="Persistence and reproducibility">
        <p className="text-sm text-terminal-muted">
          Completed runs are archived to DuckDB with options, battery configuration, strategy/forecast/
          optimiser/execution versions, decision logs, forecast vintages, metrics and data snapshot
          information. Archived runs survive backend restarts and are read-only.
        </p>
      </Panel>

      <Panel title="Reserve & BM Laboratory">
        <p className="text-sm text-terminal-muted">
          Reserve and BM content is isolated from the credible wholesale replay. The laboratory clearly
          distinguishes physical capability, offered capacity, accepted capacity, availability payment,
          activation and SoC impact. Until product-specific procurement and acceptance logic exists,
          reserve/BM values remain <strong>experimental / assumed</strong> and are never called realised revenue.
        </p>
      </Panel>

      <Panel title="Data licences">
        <ul className="text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li>Elexon Insights / BMRS — open data; attribute Elexon.</li>
          <li>NESO data portal — dataset-specific open licences; attribute NESO.</li>
          <li>EPEX SPOT order-book data — licensed; <strong>not</strong> included or redistributed.</li>
        </ul>
      </Panel>

      <Panel title="Known limitations">
        <ul className="text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li>MID has no per-record publication time; availability is reconstructed as period end + a configurable lag.</li>
          <li>MID is a reference price, not a bid/ask, market depth or guaranteed fill.</li>
          <li>The internal forecaster is a transparent baseline, not a production-grade power-price model.</li>
          <li>Execution modes are simulated assumptions; there is no exchange connectivity or live order submission.</li>
          <li>Reserve/BM product rules, awards, activations, penalties and physical activation SoC paths are not yet faithfully replayed.</li>
          <li>This is research and decision support, not asset control or production trading.</li>
        </ul>
      </Panel>
    </div>
  );
}
