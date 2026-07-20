# Limitations

Honest boundaries of this research platform. If a claim is not on the "modelled" side
of this page, the project does not make it.

## Market data

- **Market Index Data (MID)** is a short-term wholesale *reference* price, not a full
  EPEX order book. Executing at MID is an assumption, not a guarantee.
- MID exposes no per-record publish time; replay availability is **reconstructed** as
  period end + 10 minutes and flagged as such (`publication_reconstructed`).
- No EPEX licensed data is included or redistributed; the EPEX adapter is a documented
  stub that raises `NotConfigured`.

## Execution

The execution model is a **simulated assumption** (`ideal` / `simple` / `stress`):
a configurable half-spread, proportional slippage, per-MWh fee, a maximum executable
MW and a deterministic fill ratio. Executed volume (never requested volume) drives
SoC. Not modelled: a real order book, market depth, random partial fills, market
impact beyond the simple model, credit/collateral, intraday gate closures. MID is a
reference price, not an executable bid/ask.

## Trader-in-the-loop & confirmed state

- Manual "trader-in-the-loop" mode is a **decision-support simulation**: model
  recommendation → trader instruction → simulated execution → confirmed physical
  state → next optimisation. No order is submitted and no physical asset is
  controlled.
- "Confirmed physical state" supports a `telemetry` / `meter_reconciliation` /
  `manual_confirmation` SoC source, but **no real telemetry or metering is
  integrated** — those sources are operator-entered values, labelled as such. The
  default source is the executed-action estimate.
- The immediate-period override counterfactual is a one-period comparison (trader
  instruction vs model recommendation, marked to the actual price); it is **not** a
  full-horizon causal attribution.

## Data sources

- One global source (`synthetic` / `sample` / `elexon`) is honoured across Market,
  Terminal, Schedule, Replay, Validation, Backtest and Data. Synthetic and sample
  never touch the network (enforced by tests that fail on any outbound call);
  Elexon failures surface explicitly and are never silently replaced.
- The **daily Backtest** needs both a day-ahead price forecast and a realised
  outturn per period. Elexon publishes the realised MID reference price but no
  day-ahead *price forecast* series, so `elexon` is reported as an explicit
  **unsupported source** (HTTP 422, nothing run, nothing substituted) rather than
  silently falling back. Synthetic and sample are supported; point-in-time Elexon
  analysis lives on the Replay page.

## Reserve & Balancing Mechanism

- Reserve headroom/energy constraints are conservative simplifications of real
  Dynamic Containment / Dynamic Moderation / Dynamic Regulation / Balancing Reserve
  product rules (no EFA-block procurement, no performance monitoring).
- Default availability prices and BM activation margins are **assumptions**.
- BM acceptance modelling is exploratory; pairId↔BOALF attribution from public
  schemas is approximate.
- Consequently, reserve/BM revenue is **experimental / assumption-based** and is
  excluded from the credible rolling-strategy P&L in Replay & Live.

## Forecasting

The point-in-time forecaster is a transparent baseline (lags + intraday bias +
empirical dispersion), not a state-of-the-art price model. Quantiles use a normal
approximation. Historical *published* wholesale-price forecast vintages are not
freely available, so replay forecasts are model-generated and labelled
`model_forecast`.

## Backtesting & results

- Backtested and replayed P&L is illustrative and **not achievable live**.
- The bundled sample is synthetic (seeded generator), clearly labelled, and never
  presented as observed market data.
- Perfect foresight is an upper bound, labelled "not a tradable strategy".

## Operational

- **Durable audit trail.** Every trader-in-the-loop state transition
  (recommendation → trader instruction → execution → physical-state confirmation →
  advance/supersession) is appended to an immutable DuckDB log with a monotonic
  sequence number, and is never updated or deleted. A **mid-flight** session is
  recovered after a process restart by deterministically replaying that log,
  restoring the exact state-machine position, SoC, committed decisions and the
  superseded schedules. Completed runs remain archived and read-only. Older
  archived runs without the trader-hierarchy fields still load.
- DuckDB permits one writer process per file. If the database cannot be opened
  (e.g. another backend or a test run holds it), persistence **degrades to a
  disabled no-op**: replays continue in memory, `persistence_available` is
  `false`, and a warning explains that the run will not survive a restart. It is
  never an unexplained 500. Recovery of a session whose transitions were not
  persisted honestly reports "replayed 0 of 0".
- This system submits no orders and controls no physical asset.

## Forecast-validation disclosure

The Forecast Validation page computes **statistical** metrics for every selected
model, but the **economic** strategy-P&L diagnostic is capped (2 models by
default, internal model first) and runs over the selected day range with a
*shrinking within-range horizon* and a fixed continuation value — not the 48 h
cross-day horizon the product uses. Models outside the cap are shown as
"not computed". It is a performance-bounded indicator, not a complete economic
comparison, and the UI says so.
