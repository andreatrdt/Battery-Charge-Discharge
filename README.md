# GB Battery Co-Optimisation Terminal

A research & decision-support platform showing how a battery trader in **Great Britain**
could combine public market data, forecasts, balancing data and constrained optimisation
to decide how much a battery should **charge, discharge or keep available** during each
half-hourly **Settlement Period**.

> **Disclaimer.** This is a research and decision-support project (built for a CV /
> portfolio). It is **not** a live trading or asset-control system. It submits **no**
> market orders, controls **no** physical asset, and makes **no** claim of proprietary
> data access or affiliation with any employer. Public data only (Elexon & NESO open
> licences). No EPEX order-book data is included or redistributed. Backtested returns
> are illustrative and are **not** achievable in live trading.

---

## What it demonstrates

- GB power-market structure (wholesale, Balancing Mechanism, imbalance settlement)
- Battery **state-of-charge optimisation** with physical & economic constraints
- **Wholesale + balancing-service + imbalance co-optimisation** (no double-counting)
- Real public-API ingestion with **data lineage** (source / retrieval / publication / event timestamps)
- **Rigorous, chronological** time-series forecasting (no leakage)
- **Constrained optimisation** in Pyomo solved with the open-source HiGHS solver
- **Scenario & stochastic** optimisation with a CVaR risk penalty
- **Rolling-horizon (MPC-style)** operation and a **leakage-audited backtest**
- A **trader-focused** web interface that explains *why* each action was chosen

## Architecture

```
 External APIs            Raw data layer         Validation /            Feature store
 (Elexon, NESO)   ─────▶  (typed adapters,  ───▶ normalisation    ───▶  (leakage-safe
   + CSV upload           raw payloads,           (Pandera schemas,       features)
   + synthetic            lineage, cache)         Europe/London tz)          │
                                                                             ▼
   Web dashboard   ◀────  FastAPI      ◀────  Optimiser (Pyomo/HiGHS)  ◀── Forecasts &
   (Next.js, TS,          (REST API)          deterministic / stochastic    scenarios
    Recharts,                                 / CVaR + rolling horizon
    TanStack Table)                                    ▲
                                                       └── Backtester (benchmarks,
                                                           perfect-foresight bound,
                                                           leakage audit)
```

See [docs/architecture.md](docs/architecture.md) for detail.

## Repository layout

```
backend/            Python 3.12 package `gb_battery` + tests
  gb_battery/
    settlement.py       GB Settlement Period calendar (DST-aware: 46/48/50 SPs)
    battery/            BatteryConfig (physical & economic parameters)
    optimiser/          Pyomo model, solver, deterministic co-optimisation, explanations
    data/               Elexon + NESO adapters, providers, lineage, cache, market snapshot
    forecast/           Leakage-safe features, baselines, quantile models, chronological CV
    scenario/           Scenario generation, Scenario Lab, stochastic + CVaR optimiser
    backtest/           Rolling backtest engine, benchmarks, leakage audit, metrics
    bm/                 BM acceptance research module (exploratory)
    api/                FastAPI app (routers: market, optimise, analysis, data)
    demo/               Synthetic scenarios + frozen public-data sample
    data_samples/       Frozen synthetic Parquet (offline demo)
  tests/                pytest suite (68 tests)
frontend/           Next.js + TypeScript + Tailwind + Recharts + TanStack Table
docs/               Architecture, data sources, methodology, model, backtesting, limitations
```

## Quick start

### Option A — Docker (one command)

```bash
docker compose up --build
# Frontend: http://localhost:3000   API: http://localhost:8000/docs
```

### Option B — local (Python + Node)

```bash
# 1. Backend
make install            # creates .venv and installs backend[dev]
make ingest-demo        # builds the offline demo snapshot (no network needed)
make test               # run the 68-test suite
make run                # FastAPI on http://localhost:8000  (add GBB_OFFLINE=1 for offline)

# 2. Frontend (separate terminal)
make install-frontend
make run-frontend       # Next.js on http://localhost:3000
```

On Windows without `make`, run the underlying commands in [docs/deployment.md](docs/deployment.md).

### Try it without the network

Everything runs **offline** using the frozen synthetic sample and demo scenarios:

```bash
GBB_OFFLINE=1 make run                          # backend serves synthetic/demo data
python -m gb_battery.cli backtest --days 21     # rolling backtest, prints a summary
```

## Data sources

| Source | Datasets used | Licence |
|--------|---------------|---------|
| **Elexon Insights (BMRS)** | Market Index Data (MID), system/imbalance prices, demand outturn & forecast, wind/solar forecast, generation by fuel, BOD, BOALF | Elexon open data — attribute Elexon |
| **NESO data portal (CKAN)** | Demand/forecasts, balancing & constraint costs, EAC/DC/DM/DR & reserve services | Dataset-specific open licences — attribute NESO |
| **EPEX SPOT** | *(none included)* — licensed order-book data; only a documented stub adapter | Not redistributed |
| **User CSV** | price forecasts, order-book depth, telemetry, contracted positions, service prices | your own |

Endpoint paths & field names were confirmed against the live APIs (see
[docs/data_sources.md](docs/data_sources.md)), not assumed.

## Mathematical formulation (summary)

For each Settlement Period *t* of duration Δt:

**State of charge**
```
soc[t+1] = soc[t] + η_c · charge_mw[t] · Δt − discharge_mw[t] · Δt / η_d
soc_min ≤ soc[t] ≤ soc_max
```

**No simultaneous charge/discharge** (binaries): `cbin[t] + dbin[t] ≤ 1`, with
`0 ≤ charge ≤ P_c·cbin`, `0 ≤ discharge ≤ P_d·dbin`.

**Conservative reserve headroom** (power and energy-duration), grid import/export limits,
ramp and daily-cycle limits, and a terminal-SoC floor + value.

**Objective (maximise)** wholesale + service availability + expected BM activation +
terminal value, minus charging cost, degradation, efficiency losses and imbalance
exposure — avoiding double-counting the same energy/capacity. See
[docs/optimisation_model.md](docs/optimisation_model.md).

## Example result

A demo day (50 MW / 100 MWh, 2 GBP/MWh degradation) charges overnight, discharges into the
evening peak, and reserves capability on the ramps. A 35-day chronological backtest:

| Strategy | P&L | Capture of perfect foresight |
|----------|-----|------------------------------|
| No-operation | £0 | 0% |
| Charge-low / discharge-high | ~£213k | ~57% |
| Fixed percentile | ~£195k | ~52% |
| **Deterministic optimiser** | **~£308k** | **~82%** |
| Perfect foresight (upper bound) | £374k | 100% |

*(Synthetic sample; illustrative only — not achievable live.)*

## Testing

```bash
make test        # pytest: settlement/DST, constraints, the 6 deterministic cases,
                 # economics, forecasting, backtest ordering, scenario/stochastic, API
make lint        # ruff
make typecheck   # mypy (backend)
cd frontend && npm run build   # Next.js production build + type-check
```

The suite includes the six named deterministic acceptance cases (negative-price charging,
capacity preservation, service value preservation, degradation-aware cycling, terminal SoC).

## Data limitations

- Market Index Data is a **short-term wholesale reference**, not a full live EPEX order book.
- Reserve constraints are **conservative simplifications** of real DC/DM/DR & Balancing Reserve rules.
- BM acceptance modelling is **exploratory**; the production optimiser uses user/historical
  service-value assumptions and labels every estimate.
- Synthetic/estimated inputs are for demonstration and **clearly distinguished** from observed data in the UI.

See [docs/limitations.md](docs/limitations.md).

## Licence

Code: MIT (see [LICENSE](LICENSE)). Third-party **data** is governed by Elexon and NESO open
licences; EPEX order-book data is licensed and **not** included. Attribute Elexon and NESO
when redistributing data.
