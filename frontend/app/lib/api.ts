// Typed client for the GB Battery Co-Optimisation API.
// All requests go to /api/* which Next.js proxies to the FastAPI backend.

export type DataKind = "observed" | "forecast" | "estimated" | "assumption" | "synthetic";
export type ActionLabel = "CHARGE" | "DISCHARGE" | "IDLE" | "RESERVE UP" | "RESERVE DOWN";

export interface BatteryConfig {
  name: string;
  energy_capacity_mwh: number;
  minimum_soc_mwh: number;
  maximum_soc_mwh: number;
  initial_soc_mwh: number;
  maximum_charge_mw: number;
  maximum_discharge_mw: number;
  charge_efficiency: number;
  discharge_efficiency: number;
  grid_import_limit_mw: number;
  grid_export_limit_mw: number;
  degradation_cost_gbp_per_mwh_throughput: number;
  minimum_terminal_soc_mwh: number;
  preferred_terminal_soc_mwh: number;
  terminal_soc_value_gbp_per_mwh: number | null;
  maximum_cycles_per_day: number | null;
  upward_service_duration_h: number;
  downward_service_duration_h: number;
  [k: string]: unknown;
}

export interface MarginalValues {
  stored_energy_gbp_per_mwh: number | null;
  empty_capacity_gbp_per_mwh: number | null;
  charge_power_gbp_per_mw: number | null;
  discharge_power_gbp_per_mw: number | null;
}

export interface PeriodResult {
  settlement_date: string;
  settlement_period: number;
  start_utc: string;
  end_utc: string;
  duration_hours: number;
  wholesale_price: number;
  wholesale_price_sigma: number;
  system_price: number | null;
  prob_short: number | null;
  demand_forecast_mw: number | null;
  wind_forecast_mw: number | null;
  solar_forecast_mw: number | null;
  residual_demand_mw: number | null;
  action: ActionLabel;
  charge_mw: number;
  discharge_mw: number;
  energy_charged_mwh: number;
  energy_discharged_mwh: number;
  beginning_soc_mwh: number;
  ending_soc_mwh: number;
  upward_reserved_mw: number;
  downward_reserved_mw: number;
  wholesale_pnl_gbp: number;
  service_pnl_gbp: number;
  bm_activation_pnl_gbp: number;
  degradation_cost_gbp: number;
  imbalance_cost_gbp: number;
  total_expected_pnl_gbp: number;
  binding_constraints: string[];
  marginals: MarginalValues;
  explanation: string;
}

export interface OptimisationResult {
  status: string;
  solver: string;
  objective_gbp: number;
  periods: PeriodResult[];
  total_wholesale_pnl_gbp: number;
  total_service_pnl_gbp: number;
  total_bm_activation_pnl_gbp: number;
  total_degradation_cost_gbp: number;
  total_imbalance_cost_gbp: number;
  terminal_soc_value_gbp: number;
  total_expected_pnl_gbp: number;
  full_cycle_equivalents: number;
  horizon: number;
  portfolio_mode: boolean;
  risk_aversion: number;
  warnings: string[];
}

export interface SourceStatus {
  source: string;
  ok: boolean;
  kind: DataKind;
  detail: string;
  retrieved_at: string | null;
}

export interface MarketSnapshot {
  day: string;
  periods: Record<string, number | string | null>[];
  statuses: SourceStatus[];
  warnings: string[];
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface OptimiseRequest {
  config?: BatteryConfig;
  day: string;
  source: string;
  offline?: boolean;
  streams?: Record<string, boolean>;
  mode?: string;
  risk_aversion?: number;
  cvar_alpha?: number;
  n_scenarios?: number;
  compute_marginals?: boolean;
}

export const api = {
  health: () => jsonFetch<{ status: string; version: string }>("/api/health"),
  defaultConfig: () => jsonFetch<BatteryConfig>("/api/config/default"),
  snapshot: (day: string, offline = false) =>
    jsonFetch<MarketSnapshot>(`/api/market/snapshot?day=${day}&offline=${offline}`),
  dataStatus: () => jsonFetch<{ offline: boolean; sources: unknown[] }>("/api/market/status"),
  optimise: (req: OptimiseRequest) =>
    jsonFetch<{ result: OptimisationResult; source: string; snapshot: MarketSnapshot | null }>(
      "/api/optimise",
      { method: "POST", body: JSON.stringify(req) },
    ),
  scenarioList: () => jsonFetch<{ scenarios: string[] }>("/api/scenario/list"),
  scenario: (req: { config?: BatteryConfig; day: string; source: string; scenario_name: string }) =>
    jsonFetch<{ scenario_name: string; base: OptimisationResult; scenario: OptimisationResult }>(
      "/api/scenario",
      { method: "POST", body: JSON.stringify(req) },
    ),
  backtest: (req: { config?: BatteryConfig; days: number; up_availability_price?: number; down_availability_price?: number }) =>
    jsonFetch<{
      table: Record<string, number | string>[];
      perfect_foresight_pnl_gbp: number;
      leakage_audit: { check: string; ok: boolean; detail: string }[];
      equity_curve: { index: number; cumulative_pnl: number }[];
    }>("/api/backtest", { method: "POST", body: JSON.stringify(req) }),
  forecastValidate: (req: { days: number; models: string[]; n_splits?: number }) =>
    jsonFetch<{ reports: ForecastReport[] }>("/api/forecast/validate", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  sample: (limit = 96) =>
    jsonFetch<{ columns: string[]; rows: Record<string, unknown>[]; total_rows: number; note: string }>(
      `/api/data/sample?limit=${limit}`,
    ),
};

// ---------------------------------------------------------------- Replay & Live

export type Provenance =
  | "observed"
  | "published_forecast"
  | "model_forecast"
  | "reconstructed"
  | "synthetic"
  | "assumed"
  | "perfect_foresight";

export interface ProposedPeriod {
  settlement_period: number;
  start_utc: string;
  action: string;
  charge_mw: number;
  discharge_mw: number;
  ending_soc_mwh: number;
  forecast_price: number;
  expected_pnl_gbp: number;
}

export interface DecisionRecord {
  step: number;
  settlement_date: string;
  settlement_period: number;
  start_utc: string;
  end_utc: string;
  duration_hours: number;
  as_of: string;
  information_cutoff: string;
  basis_max_published_at: string | null;
  n_input_observations: number;
  n_input_forecasts: number;
  forecast_price: number;
  forecast_q10: number;
  forecast_q90: number;
  forecast_sigma: number;
  forecast_basis: string;
  forecast_provenance: Provenance;
  action: string;
  charge_mw: number;
  discharge_mw: number;
  soc_before_mwh: number;
  soc_after_mwh: number;
  expected_immediate_pnl_gbp: number;
  expected_horizon_pnl_gbp: number;
  explanation: string;
  binding_constraints: string[];
  proposed_schedule: ProposedPeriod[];
  settlement_status: "settled" | "pending";
  actual_price: number | null;
  actual_price_available_at: string | null;
  actual_price_provenance: Provenance | null;
  realised_pnl_gbp: number | null;
  degradation_cost_gbp: number;
  forecast_error: number | null;
  warnings: string[];
}

export interface ReplaySummary {
  n_steps: number;
  n_settled: number;
  n_pending: number;
  realised_pnl_gbp: number;
  wholesale_revenue_gbp: number;
  charging_cost_gbp: number;
  degradation_cost_gbp: number;
  cycles: number;
  max_drawdown_gbp: number;
  ending_soc_mwh: number;
  forecast_mae: number | null;
  forecast_rmse: number | null;
  forecast_bias: number | null;
  execution_assumption: string;
}

export interface ReplayStatus {
  replay_id: string;
  mode: string;
  day: string;
  options: Record<string, unknown>;
  n_periods: number;
  step_index: number;
  complete: boolean;
  soc_mwh: number;
  next_settlement_period: number | null;
  next_period_start_utc: string | null;
  summary: ReplaySummary;
  warnings: string[];
  execution_assumption: string;
  decisions?: DecisionRecord[];
  new_decisions?: DecisionRecord[];
}

export interface VintageRow {
  settlement_date: string;
  settlement_period: number;
  start_utc: string;
  point: number;
  q10: number;
  q50: number;
  q90: number;
  sigma: number;
  basis: string;
  intraday_bias: number;
  provenance: Provenance;
  demand_forecast_mw: number | null;
  wind_forecast_mw: number | null;
  solar_forecast_mw: number | null;
}

export interface ForecastVintagePayload {
  step: number;
  n_vintages: number;
  issued_at: string;
  information_cutoff: string;
  basis_max_published_at: string | null;
  n_input_observations: number;
  n_input_forecasts: number;
  rows: VintageRow[];
  warnings: string[];
}

export interface StrategyRow {
  strategy: string;
  label?: string;
  realised_pnl_gbp: number;
  wholesale_revenue_gbp?: number;
  charging_cost_gbp?: number;
  degradation_cost_gbp?: number;
  cycles?: number;
  max_drawdown_gbp?: number;
  forecast_mae?: number | null;
  forecast_rmse?: number | null;
  forecast_bias?: number | null;
  capture_of_perfect_pct?: number;
}

export interface PfSchedulePeriod {
  settlement_period: number;
  action: string;
  charge_mw: number;
  discharge_mw: number;
  ending_soc_mwh: number;
  price: number;
}

export interface ReplayMetrics {
  table: StrategyRow[];
  perfect_foresight_pnl_gbp: number | null;
  perfect_foresight_label: string;
  perfect_foresight_schedule: PfSchedulePeriod[] | null;
  peak_trough: Record<string, number | boolean | null>;
  note: string;
  leakage_audit: {
    step: number;
    settlement_period: number;
    as_of: string;
    basis_max_published_at: string | null;
    inputs_predate_decision: boolean;
    outturn_published_after_decision: boolean;
  }[];
  leakage_ok: boolean;
}

export interface LiveResult extends ReplayStatus {
  now_utc: string;
  decisions: DecisionRecord[];
  forward_proposal: ProposedPeriod[] | null;
  forward_vintage: {
    issued_at: string;
    information_cutoff: string;
    rows: {
      settlement_period: number;
      start_utc: string;
      point: number;
      q10: number;
      q90: number;
      basis: string;
      provenance: Provenance;
    }[];
  } | null;
  disclaimer: string;
}

export interface ReplayInputsPayload {
  step: number;
  as_of: string;
  settlement_period: number;
  observations_visible: {
    variable: string;
    settlement_date: string;
    settlement_period: number;
    value: number;
    published_at: string;
    source: string;
    provenance: Provenance;
    publication_reconstructed: boolean;
  }[];
  n_observations_visible: number;
  forecasts_used: {
    variable: string;
    settlement_date: string;
    settlement_period: number;
    point: number;
    q10: number;
    q90: number;
    basis: string;
    provenance: Provenance;
    issued_at: string;
  }[];
  store_notes: string[];
}

export const replayApi = {
  start: (req: {
    config?: BatteryConfig;
    day: string;
    source: string;
    strategy?: string;
    auto_run?: boolean;
  }) => jsonFetch<ReplayStatus>("/api/replay/start", { method: "POST", body: JSON.stringify(req) }),
  step: (replay_id: string, n_steps = 1) =>
    jsonFetch<ReplayStatus>("/api/replay/step", {
      method: "POST",
      body: JSON.stringify({ replay_id, n_steps }),
    }),
  run: (replay_id: string) =>
    jsonFetch<ReplayStatus>("/api/replay/run", { method: "POST", body: JSON.stringify({ replay_id }) }),
  status: (replay_id: string) => jsonFetch<ReplayStatus>(`/api/replay/${replay_id}`),
  decisions: (replay_id: string) =>
    jsonFetch<{ decisions: DecisionRecord[] }>(`/api/replay/${replay_id}/decisions`),
  forecasts: (replay_id: string, step?: number) =>
    jsonFetch<ForecastVintagePayload>(
      `/api/replay/${replay_id}/forecasts${step !== undefined ? `?step=${step}` : ""}`,
    ),
  metrics: (replay_id: string) => jsonFetch<ReplayMetrics>(`/api/replay/${replay_id}/metrics`),
  inputs: (replay_id: string, step?: number) =>
    jsonFetch<ReplayInputsPayload>(
      `/api/replay/${replay_id}/inputs${step !== undefined ? `?step=${step}` : ""}`,
    ),
  live: (req: { config?: BatteryConfig; source: string }) =>
    jsonFetch<LiveResult>("/api/live/optimise", { method: "POST", body: JSON.stringify(req) }),
};

export const PROVENANCE_COLOR: Record<Provenance, string> = {
  observed: "#38bdf8",
  published_forecast: "#a78bfa",
  model_forecast: "#c084fc",
  reconstructed: "#f59e0b",
  synthetic: "#64748b",
  assumed: "#f472b6",
  perfect_foresight: "#fbbf24",
};

export interface ForecastReport {
  model: string;
  mean_mae: number;
  mean_rmse: number;
  mean_pinball: Record<string, number>;
  n_folds: number;
  folds: { train_end: string; test_start: string; test_end: string; mae: number; rmse: number }[];
}

export const KIND_COLOR: Record<DataKind, string> = {
  observed: "#38bdf8",
  forecast: "#a78bfa",
  estimated: "#f59e0b",
  assumption: "#f472b6",
  synthetic: "#64748b",
};

export const ACTION_COLOR: Record<ActionLabel, string> = {
  CHARGE: "#22c55e",
  DISCHARGE: "#ef4444",
  IDLE: "#64748b",
  "RESERVE UP": "#eab308",
  "RESERVE DOWN": "#0ea5e9",
};

export function gbp(x: number | null | undefined, dp = 0): string {
  if (x === null || x === undefined) return "—";
  return `£${x.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function num(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined) return "—";
  return x.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
