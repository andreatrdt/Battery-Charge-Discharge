import { Panel } from "../components/ui";

export const metadata = { title: "Methodology — GB Battery Co-Optimisation Terminal" };

export default function MethodologyPage() {
  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-semibold">Methodology &amp; Limitations</h1>

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
          <li><strong>Wholesale:</strong> day-ahead / intraday energy. We use Elexon Market Index Data (MID) as a short-term reference price — <em>not</em> a full EPEX order book.</li>
          <li><strong>Balancing Mechanism (BM):</strong> NESO accepts Bids/Offers (BOD) in real time; acceptances appear in BOALF/BOAV. Submitting a price alone earns nothing — value depends on acceptance probability × accepted volume × margin.</li>
          <li><strong>Imbalance:</strong> residual position settled at the (single) system price. Being short pays the system price; being long receives it.</li>
        </ul>
      </Panel>

      <Panel title="Optimisation model">
        <p className="text-sm text-terminal-muted">
          A MILP over SPs with grid-side charge/discharge power, an SoC balance{" "}
          <code className="text-kind-observed">soc[t+1] = soc[t] + η_c·charge·Δt − discharge·Δt/η_d</code>,
          binaries preventing simultaneous charge/discharge, power &amp; grid limits, conservative
          reserve headroom (power and energy-duration), ramp and cycle limits, and a terminal-SoC
          floor + value. The objective maximises wholesale + service availability + expected BM
          activation + terminal value, minus charging cost, degradation, efficiency losses and
          imbalance exposure — avoiding double-counting of the same energy/capacity. Solved with the
          open-source HiGHS solver (optional Gurobi if licensed).
        </p>
      </Panel>

      <Panel title="Service value (not one magic price)">
        <p className="text-sm text-terminal-muted">
          Service value = availability payment + expected activation margin − wholesale opportunity
          cost − energy restoration cost − degradation − efficiency losses − expected non-delivery
          penalty. Estimated components are clearly labelled and shown with sensitivity, never as a
          known future payment.
        </p>
      </Panel>

      <Panel title="Replay & Live Trading (point-in-time simulation)">
        <p className="text-sm text-terminal-muted">
          The Replay page answers: <em>at every decision timestamp, what information was available,
          what did the model forecast, what action did it choose, and how did it perform once the
          outcome became known?</em> Three modes are kept strictly separate:
        </p>
        <ul className="mt-2 text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li>
            <strong>Historical Replay</strong> — a completed day is simulated chronologically. At
            each Settlement Period&apos;s gate the engine builds an information set containing only
            records with <code className="text-kind-observed">published_at ≤ as_of</code>, forecasts
            the rest of the day, optimises the remaining horizon, executes <em>only the first
            period</em>, then settles it against the outturn once published. SoC, cycle budget and
            cumulative P&amp;L persist across steps. MID availability is reconstructed as period end
            + 10 min (documented assumption — the API exposes no per-record publish time).
          </li>
          <li>
            <strong>Live Paper Trading</strong> — the same loop for today: completed periods are
            settled with published outturns; the future carries forecasts only (future actuals are
            null by construction). Realised paper P&amp;L and expected future P&amp;L are reported
            separately. No orders are submitted anywhere.
          </li>
          <li>
            <strong>Perfect Foresight</strong> — a single optimisation on the realised price path,
            labelled &ldquo;not a tradable strategy&rdquo; and used only as an upper bound.
          </li>
        </ul>
        <p className="mt-2 text-sm text-terminal-muted">
          The credible rolling strategy is <strong>wholesale-only</strong>: reserve and BM revenue
          lines elsewhere in the app are experimental / assumption-based and never mixed into replay
          results. Executed energy is assumed to clear at the MID reference price — no bid/ask
          spread, liquidity, partial fills or market impact are modelled. Every decision carries a
          machine-checkable audit (newest input publication vs decision gate) exposed in{" "}
          <code className="text-kind-observed">/api/replay/&#123;id&#125;/metrics</code>.
        </p>
      </Panel>

      <Panel title="Forecasting">
        <p className="text-sm text-terminal-muted">
          Three levels: user-supplied; transparent baselines (previous day/week same SP, rolling
          median); and statistical quantile models (scikit-learn HistGradientBoosting). Validation is
          strictly chronological (expanding window), with MAE, RMSE and pinball loss. Features use only
          information available at the day-ahead decision time — calendar variables, day-ahead
          demand/wind/solar forecasts, and lagged outturn prices — never same-period outturns.
        </p>
      </Panel>

      <Panel title="Backtesting integrity">
        <p className="text-sm text-terminal-muted">
          Decisions are taken on forecasts and settled on outturn prices, rolling the SoC forward day
          by day. Benchmarks: no-operation, charge-low/discharge-high, fixed percentile, deterministic
          optimiser, and a perfect-foresight upper bound (which sees outturns — unachievable live). An
          automated leakage audit confirms forecasts, not outturns, drove decisions.
        </p>
      </Panel>

      <Panel title="Data licences">
        <ul className="text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li>Elexon Insights / BMRS — open data; attribute Elexon.</li>
          <li>NESO data portal — dataset-specific open licences; attribute NESO.</li>
          <li>EPEX SPOT order-book data — licensed; <strong>not</strong> included or redistributed. Only a documented stub adapter is provided.</li>
        </ul>
      </Panel>

      <Panel title="Limitations">
        <ul className="text-sm text-terminal-muted list-disc pl-5 space-y-1">
          <li>Reserve constraints are conservative simplifications of real Dynamic Containment / Balancing Reserve product rules.</li>
          <li>MID is a reference price, not full order-book depth or achievable execution.</li>
          <li>BM acceptance modelling is exploratory; production uses user/historical service-value assumptions.</li>
          <li>Synthetic/estimated inputs are for demonstration and clearly labelled — this is decision-support, not live trading, and no orders are placed.</li>
        </ul>
      </Panel>
    </div>
  );
}
