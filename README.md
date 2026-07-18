# GB Battery Co-Optimisation Terminal

A full-stack research and learning terminal for understanding how a GB battery trader
could turn point-in-time market information into charge/discharge decisions, then audit
those decisions against what actually happened.

> **Research only.** This project submits no orders, controls no physical asset and does
> not contain licensed EPEX order-book data. Elexon MID is used as a public wholesale
> reference price, not as a guaranteed executable bid or ask. All paper P&L is illustrative.

## What the project now does

- Builds a **point-in-time information set** for every decision gate
  (`published_at <= as_of`, machine-audited).
- Forecasts the next **24, 48 or 72 hours**; 48 hours is the default.
- Optimises the complete cross-day horizon in Pyomo/HiGHS.
- Executes only the **next Settlement Period**, then reforecasts and reoptimises.
- Carries SoC, cycle usage, degradation and P&L continuously across midnight and DST days.
- Reports an explicit **continuation value** for energy left at horizon end.
- Separates requested from executed volume through ideal, simple and stress execution assumptions.
- Compares rolling decisions with simple forecast/strategy benchmarks and perfect foresight.
- Persists completed replay sessions to DuckDB with data/model/configuration version stamps.
- Provides a visual Learning mode, market-process timeline, battery diagram, decision alternatives,
  trader metrics, P&L attribution, forecast heatmaps and regime analysis.
- Keeps reserve/BM economics in a separate **experimental laboratory**, outside credible
  wholesale replay P&L.

## Three modes that must not be confused

| Mode | Information used | Output |
|---|---|---|
| **Historical Replay** | Only records available at each historical gate | Realised paper P&L from the actions actually selected step by step |
| **Live Paper Trading** | Information available up to the current time | Settled past paper P&L plus a forecast-only future proposal |
| **Perfect Foresight** | The complete realised path | Non-tradable upper benchmark only |

A completed historical replay does **not** rewrite earlier actions after later actual prices
become visible. That difference from perfect foresight is the economic cost of imperfect
information and forecasting.

## Core decision loop

```text
Decision time t
    ↓
Point-in-time data: published_at ≤ t
    ↓
Forecast the next 24/48/72 hours
    ↓
Optimise the complete remaining horizon
    ↓
Apply continuation value at horizon end
    ↓
Execute only the first half-hour through the selected execution model
    ↓
Settle once the outturn is published
    ↓
Carry SoC / cycles / P&L forward and repeat
```

## Pages

- **Market** — observed/forecast fundamentals, MID and imbalance settlement price.
- **Battery** — power, energy, efficiency, grid and degradation configuration.
- **Terminal** — single-shot deterministic/stochastic/robust optimisation, clearly labelled.
- **Replay & Live** — cross-day point-in-time historical replay and live paper trading.
- **Forecast Validation** — benchmark forecasts, probabilistic calibration, heatmaps and
  downstream strategy P&L.
- **Schedule** — single-shot planned schedule; not the rolling replay result.
- **Scenario Lab** — deterministic and stochastic stress exploration.
- **Backtest** — legacy multi-day strategy comparison.
- **Reserve & BM Lab** — experimental physical capability and assumed service economics.
- **Data & Audit** — exact decision inputs, provenance, exports and persistent replay archive.
- **Methodology** — market structure, equations, metrics and limitations.

## Battery model

The default asset is a 50 MW / 100 MWh battery. MW is power; MWh is energy:

```text
Energy (MWh) = Power (MW) × Time (h)
50 MW × 0.5 h = 25 MWh
```

The SoC transition is:

```text
soc[t+1] = soc[t] + η_charge × charge[t] × Δt
                      − discharge[t] × Δt / η_discharge
```

The MILP also models:

- no simultaneous charging and discharging;
- charge/discharge and grid limits;
- minimum/maximum SoC;
- degradation per MWh of throughput;
- cycle limits;
- terminal/continuation value;
- optional ramp and operating-band limits;
- conservative reserve-capability constraints in the experimental model.

**Energy action** (`CHARGE`, `DISCHARGE`, `IDLE`) and **flexibility position**
(`UP`, `DOWN`, `BOTH`, `NONE`) are displayed separately. Flexibility is a physical
capability estimate, not proof of a reserve award or activation.

## Forecast validation

The internal point-in-time forecast is compared with:

- persistence;
- same Settlement Period yesterday;
- same Settlement Period last week;
- seven-day same-SP rolling median;
- weekday/SP climatology.

Metrics include:

- MAE, RMSE, bias and correlation;
- directional accuracy and ramp error;
- peak/trough timing error;
- q10/q50/q90 pinball loss;
- q10–q90 coverage and interval width;
- error by Settlement Period and hours ahead;
- downstream rolling-strategy P&L.

A model is not declared better solely because its MAE is lower. The terminal also checks
whether it creates more net economic value after battery constraints and execution costs.

## Trader metrics

Completed replays expose:

- gross and net realised paper P&L;
- expected-versus-realised P&L surprise;
- hit rate, average win/loss, payoff ratio and profit factor;
- maximum drawdown, P&L volatility, historical VaR and Expected Shortfall;
- perfect-foresight capture and regret;
- requested/executed/unfilled volume and turnover;
- spread, slippage and fee assumptions;
- charge/discharge throughput, cycles, degradation and time near physical limits;
- performance and forecast error by transparent market regime.

The P&L waterfall reconciles expected model P&L to realised net P&L through price,
volume, execution-cost and residual/interaction effects without inventing false precision.

## Execution assumptions

| Mode | Treatment |
|---|---|
| **Ideal** | Full simulated fill at MID; theoretical reference-price benchmark |
| **Simple** | Configurable spread, fee, slippage and maximum executable power |
| **Stress** | Wider costs and lower executable volume |

Executed volume—not requested volume—drives SoC. These are transparent assumptions,
not reconstructed exchange fills.

## Data and provenance

Sources include public Elexon Insights/BMRS endpoints and a bundled seeded synthetic sample.
Every important value is labelled as observed, published forecast, internal model forecast,
reconstructed, synthetic, assumed, paper trade, experimental or perfect foresight.

MID has no per-record publication timestamp. Historical availability is therefore
reconstructed as Settlement Period end plus a configurable lag (10 minutes by default)
and flagged accordingly.

## Architecture

```text
Next.js / TypeScript frontend
        ↓ REST
FastAPI routers and typed schemas
        ↓
Point-in-time data store + Elexon adapters + Parquet/DuckDB persistence
        ↓
Forecast vintages and benchmark validation
        ↓
Pyomo MILP → HiGHS
        ↓
Execution model → settlement → replay metrics / audit / charts
```

Key directories:

```text
backend/gb_battery/
  api/          FastAPI application and routers
  battery/      asset configuration
  data/         Elexon/NESO adapters, cache and provenance
  forecast/     chronological forecasting utilities
  optimiser/    Pyomo/HiGHS model and result extraction
  replay/       PIT store, forecasts, cross-day engine, execution, metrics,
                alternatives, continuation value and persistence
  scenario/     stochastic and robust research tools
  backtest/     legacy daily backtest
frontend/app/
  replay/       rolling replay and live paper UI
  validation/   forecast validation dashboard
  lab/          reserve/BM laboratory
  components/   charts, battery visual, learning components and timeline
```

## Run locally

### Backend

```powershell
cd C:\Users\andre\git_repos\Battery-Charge-Discharge
.\.venv\Scripts\python.exe -m uvicorn gb_battery.api.main:app `
    --app-dir backend `
    --host 127.0.0.1 `
    --port 8000
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

### Frontend

```powershell
cd C:\Users\andre\git_repos\Battery-Charge-Discharge\frontend
npm ci
npm run dev
```

Open `http://localhost:3000/replay`.

### Docker

```bash
docker compose up --build
```

Docker files are included, but should still be treated as environment-dependent until
verified on the target machine.

## Verification

```bash
cd backend
python -m pytest
ruff check gb_battery tests
mypy gb_battery

cd ../frontend
npx tsc --noEmit
npx next lint
npm run build
```

CI runs the same backend static checks/test suite and frontend typecheck/lint/production build.

## Main limitations

- No EPEX bid/ask order book, depth, latency, partial-fill randomness or market impact data.
- MID is a public reference, not a guaranteed executable price.
- Execution modes are simulated assumptions.
- The internal forecast is a transparent baseline, not a production power-price model.
- Reserve procurement, product-specific stacking, accepted awards, real activations and
  non-delivery penalties are not yet faithfully replayed.
- No live market orders, asset telemetry integration or operational controls.
- Perfect foresight is an unattainable benchmark, never a strategy.

See [`docs/replay_methodology.md`](docs/replay_methodology.md),
[`docs/limitations.md`](docs/limitations.md) and the in-app Methodology page for details.
