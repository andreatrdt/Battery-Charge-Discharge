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
