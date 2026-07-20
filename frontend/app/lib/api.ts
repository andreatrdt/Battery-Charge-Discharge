// Typed client for the GB Battery Co-Optimisation API.
// All requests go to /api/* which Next.js proxies to the FastAPI backend.

export type DataKind =
  | "observed"
  | "forecast"
  | "estimated"
  | "assumption"
  | "synthetic"
  | "missing"
  | "cached";
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

export interface SourceProvenance {
  requested_source: string;
  actual_source: string;
  requested_day: string;
  actual_data_day: string;
  date_substituted: boolean;
  network_used: boolean;
  cache_used: boolean;
  // Range-based sources (e.g. the multi-day backtest) add these.
  actual_data_day_start?: string;
  actual_data_day_end?: string;
  requested_days?: number;
  actual_days?: number;
  warnings?: string[];
}

/** Explicit "this source is not supported here" state — never a silent fallback. */
export interface UnsupportedSource {
  status: "unsupported_source";
  requested_source: string;
  actual_source: string | null;
  supported_sources: string[];
  reason: string;
  network_used: boolean;
  cache_used: boolean;
  warnings: string[];
}

export interface MarketSnapshot {
  day: string;
  provenance: SourceProvenance;
  periods: Record<string, number | string | null>[];
  statuses: SourceStatus[];
  warnings: string[];
}

export type SourceName = "synthetic" | "sample" | "elexon";
export type NetworkPolicy = "live_with_cache" | "cache_only" | "live_only";

/** An API error that preserves the HTTP status and any structured `detail`. */
export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let detail: unknown = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.detail ?? parsed;
    } catch {
      /* non-JSON body: keep the raw text */
    }
    const msg =
      typeof detail === "string" ? detail : (detail as { reason?: string })?.reason || text;
    throw new ApiError(res.status, detail, `API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export interface OptimiseRequest {
  config?: BatteryConfig;
  day: string;
  source: string;
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
  snapshot: (day: string, source: SourceName = "synthetic", networkPolicy: NetworkPolicy = "live_with_cache") =>
    jsonFetch<MarketSnapshot>(
      `/api/market/snapshot?day=${day}&source=${source}&network_policy=${networkPolicy}`,
    ),
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
  backtest: (req: {
    config?: BatteryConfig;
    days: number;
    source?: string;
    up_availability_price?: number;
    down_availability_price?: number;
  }) =>
    jsonFetch<{
      table: Record<string, number | string>[];
      perfect_foresight_pnl_gbp: number;
      leakage_audit: { check: string; ok: boolean; detail: string }[];
      equity_curve: { index: number; cumulative_pnl: number }[];
      provenance: SourceProvenance;
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
  settlement_date: string;
  settlement_period: number;
  start_utc: string;
  energy_action: string;
  charge_mw: number;
  discharge_mw: number;
  ending_soc_mwh: number;
  forecast_price: number;
  expected_pnl_gbp: number;
}

export interface ModelRecommendation {
  energy_action: "CHARGE" | "DISCHARGE" | "IDLE";
  charge_mw: number;
  discharge_mw: number;
  expected_immediate_pnl_gbp: number;
  expected_horizon_pnl_gbp: number;
  expected_soc_after_mwh: number;
  explanation: string;
  binding_constraints: string[];
  forecast_price: number;
  issued_at: string;
  information_cutoff: string;
  forecast_vintage_step: number;
}

export interface TraderInstruction {
  decision: "ACCEPT_RECOMMENDATION" | "MODIFY" | "REJECT_TO_IDLE";
  charge_mw: number;
  discharge_mw: number;
  reason: string | null;
  decided_at: string;
  actor: string | null;
  source: "manual_ui" | "automatic_policy" | "imported_instruction";
}

export interface ExecutionRecord {
  status: "pending" | "simulated" | "confirmed" | "partially_filled" | "rejected";
  requested_charge_mw: number;
  requested_discharge_mw: number;
  executed_charge_mw: number;
  executed_discharge_mw: number;
  executed_energy_mwh: number;
  unfilled_mwh: number;
  buy_price: number | null;
  sell_price: number | null;
  spread_slippage_cost_gbp: number | null;
  fee_cost_gbp: number | null;
  execution_source: string;
}

export interface PhysicalStateRecord {
  soc_before_mwh: number;
  model_expected_soc_after_mwh: number;
  executed_implied_soc_after_mwh: number;
  confirmed_soc_after_mwh: number;
  soc_source:
    | "telemetry"
    | "meter_reconciliation"
    | "manual_confirmation"
    | "executed_action_estimate"
    | "model_simulation";
  confirmed_at: string | null;
  reconciliation_difference_mwh: number;
  status: "estimated" | "confirmed" | "stale" | "inconsistent";
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
  recommendation?: ModelRecommendation | null;
  trader_instruction?: TraderInstruction | null;
  execution?: ExecutionRecord | null;
  physical_state?: PhysicalStateRecord | null;
  n_input_observations: number;
  n_input_forecasts: number;
  horizon_hours: number;
  horizon_n_periods: number;
  horizon_end_utc: string;
  forecast_price: number;
  forecast_q10: number;
  forecast_q90: number;
  forecast_sigma: number;
  forecast_basis: string;
  forecast_provenance: Provenance;
  demand_forecast_mw: number | null;
  wind_forecast_mw: number | null;
  solar_forecast_mw: number | null;
  /** Energy action and flexibility are independent concepts. */
  energy_action: "CHARGE" | "DISCHARGE" | "IDLE";
  flexibility_position: "NONE" | "UP" | "DOWN" | "BOTH";
  up_capability_mw: number;
  down_capability_mw: number;
  requested_charge_mw: number;
  requested_discharge_mw: number;
  charge_mw: number; // executed
  discharge_mw: number; // executed
  unfilled_mwh: number;
  soc_before_mwh: number;
  soc_after_mwh: number;
  expected_immediate_pnl_gbp: number;
  expected_horizon_pnl_gbp: number;
  explanation: string;
  binding_constraints: string[];
  proposed_schedule: ProposedPeriod[];
  continuation_gbp_per_mwh: number;
  continuation_method: string;
  continuation_value_gbp: number;
  continuation_share_of_objective_pct: number | null;
  continuation_window: string | null;
  continuation_warning: string | null;
  settlement_status: "settled" | "pending";
  actual_price: number | null;
  actual_price_available_at: string | null;
  actual_price_provenance: Provenance | null;
  execution_mode: string;
  buy_execution_price: number | null;
  sell_execution_price: number | null;
  spread_slippage_cost_gbp: number | null;
  fee_cost_gbp: number | null;
  realised_gross_pnl_gbp: number | null;
  realised_pnl_gbp: number | null;
  degradation_cost_gbp: number;
  forecast_error: number | null;
  warnings: string[];
  action: string; // legacy alias of energy_action
}

export interface ReplaySummary {
  n_steps: number;
  n_settled: number;
  n_pending: number;
  realised_pnl_gbp: number;
  realised_gross_pnl_gbp: number;
  execution_cost_gbp: number;
  unfilled_mwh: number;
  wholesale_revenue_gbp: number;
  charging_cost_gbp: number;
  degradation_cost_gbp: number;
  cycles: number;
  max_drawdown_gbp: number;
  ending_soc_mwh: number;
  forecast_mae: number | null;
  forecast_rmse: number | null;
  forecast_bias: number | null;
  execution_mode: string;
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
  state?: string; // trader-in-the-loop state machine
  soc_mwh: number;
  next_settlement_period: number | null;
  next_period_start_utc: string | null;
  summary: ReplaySummary;
  warnings: string[];
  execution_assumption: string;
  decisions?: DecisionRecord[];
  new_decisions?: DecisionRecord[];
  // Trader-in-the-loop stage payloads
  recommendation?: ModelRecommendation | null;
  proposed_schedule?: ProposedPeriod[];
  trader_instruction?: TraderInstruction | null;
  execution?: ExecutionRecord | null;
  decision?: DecisionRecord | null;
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
  inventory_adjusted_pnl_gbp?: number | null;
  execution_cost_gbp?: number;
  ending_soc_mwh?: number;
  wholesale_revenue_gbp?: number;
  charging_cost_gbp?: number;
  degradation_cost_gbp?: number;
  cycles?: number;
  max_drawdown_gbp?: number;
  forecast_mae?: number | null;
  forecast_rmse?: number | null;
  forecast_bias?: number | null;
  capture_of_perfect_pct?: number;
  regret_gbp?: number;
}

export interface AttributionResult {
  expected_model_pnl_gbp: number;
  price_forecast_effect_gbp: number;
  volume_effect_gbp: number;
  execution_cost_effect_gbp: number;
  residual_interaction_gbp: number;
  realised_net_pnl_gbp: number;
  reconciles: boolean;
  note: string;
}

export interface AlternativeRow {
  charge_mw: number;
  discharge_mw: number;
  immediate_value_gbp: number;
  future_value_gbp: number;
  continuation_value_gbp: number;
  total_objective_gbp: number;
  end_of_horizon_soc_mwh: number;
}

export interface AlternativesResult {
  step: number;
  settlement_period: number;
  as_of: string;
  soc_before_mwh: number;
  alternatives: Record<string, AlternativeRow>;
  selected: string;
  next_best: string | null;
  value_gap_gbp: number | null;
  binding_constraints: string[];
  marginals: Record<string, { value: number | null; unit: string }>;
  note: string;
}

export interface PfSchedulePeriod {
  settlement_period: number;
  action: string;
  charge_mw: number;
  discharge_mw: number;
  ending_soc_mwh: number;
  price: number;
}

export interface RegimeRow {
  regime: string;
  n_periods: number;
  forecast_mae: number | null;
  forecast_bias: number | null;
  realised_pnl_gbp: number;
  hit_rate_pct: number | null;
  avg_net_export_mw: number;
}

export interface ReplayMetrics {
  table: StrategyRow[];
  perfect_foresight_pnl_gbp: number | null;
  perfect_foresight_inventory_adjusted_gbp: number | null;
  perfect_foresight_label: string;
  perfect_foresight_schedule: PfSchedulePeriod[] | null;
  peak_trough: Record<string, number | boolean | null>;
  inventory_note: string;
  note: string;
  trader_metrics: {
    performance: Record<string, number | null>;
    risk: Record<string, number | null>;
    battery: Record<string, number | null>;
    execution: Record<string, number | null>;
  };
  attribution: AttributionResult;
  regimes: { rules: string; regimes: RegimeRow[] };
  price_heatmap: { metric: string; cells: { settlement_period: number; hours_ahead: number; mae: number; n: number }[] };
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
      settlement_date: string;
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

export interface ValidationModelRow {
  model: string;
  n: number;
  mae: number;
  rmse: number;
  bias: number;
  correlation: number | null;
  directional_accuracy_pct?: number | null;
  ramp_mae?: number;
  peak_timing_error_sp: number;
  trough_timing_error_sp: number;
  start_of_day_mae: number;
  probabilistic?: {
    pinball_q10: number;
    pinball_q50: number;
    pinball_q90: number;
    coverage_q10_q90_pct: number;
    avg_interval_width: number;
    calibration: Record<string, number>;
  };
  strategy_pnl_gbp: number | null;
}

export interface ValidationResult {
  day: string;
  n_days: number;
  source: string;
  price: {
    variable: string;
    framing_note: string;
    /** Models for which the (capped) economic strategy replay was actually run. */
    strategy_pnl_models: string[];
    table: ValidationModelRow[];
    metric_guide: Record<string, { unit: string; better: string; means: string }>;
    start_of_day_series: Record<
      string,
      { settlement_date: string; settlement_period: number; forecast: number; q10: number; q90: number; actual: number }[]
    >;
    price_heatmap_sp_by_hours_ahead: {
      metric: string;
      cells: { settlement_period: number; hours_ahead: number; mae: number; n: number }[];
    } | null;
  };
  fundamentals: Record<string, unknown>;
  note: string;
}

export const replayApi = {
  start: (req: {
    config?: BatteryConfig;
    day: string;
    source: string;
    strategy?: string;
    auto_run?: boolean;
    horizon_hours?: number;
    n_days?: number;
    execution_mode?: string;
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
  live: (req: { config?: BatteryConfig; source: string; horizon_hours?: number }) =>
    jsonFetch<LiveResult>("/api/live/optimise", { method: "POST", body: JSON.stringify(req) }),
  // Trader-in-the-loop stages
  recommend: (replay_id: string) =>
    jsonFetch<ReplayStatus>("/api/replay/recommend", {
      method: "POST",
      body: JSON.stringify({ replay_id }),
    }),
  traderDecision: (req: {
    replay_id: string;
    decision: string;
    charge_mw?: number;
    discharge_mw?: number;
    reason?: string | null;
    actor?: string;
  }) => jsonFetch<ReplayStatus>("/api/replay/trader-decision", { method: "POST", body: JSON.stringify(req) }),
  execute: (replay_id: string) =>
    jsonFetch<ReplayStatus>("/api/replay/execute", { method: "POST", body: JSON.stringify({ replay_id }) }),
  confirmState: (req: {
    replay_id: string;
    executed_charge_mw?: number | null;
    executed_discharge_mw?: number | null;
    confirmed_soc_after_mwh?: number | null;
    soc_source?: string;
    execution_source?: string | null;
  }) => jsonFetch<ReplayStatus>("/api/replay/confirm-state", { method: "POST", body: JSON.stringify(req) }),
  advanceGate: (replay_id: string) =>
    jsonFetch<ReplayStatus>("/api/replay/advance", { method: "POST", body: JSON.stringify({ replay_id }) }),
  attribution: (replay_id: string) =>
    jsonFetch<AttributionResult>(`/api/replay/${replay_id}/attribution`),
  alternatives: (replay_id: string, step: number) =>
    jsonFetch<AlternativesResult>(`/api/replay/${replay_id}/alternatives?step=${step}`),
  archivedRuns: () =>
    jsonFetch<{ runs: { replay_id: string; day: string; mode: string; complete: boolean; saved_at: string | null; summary: ReplaySummary | null }[] }>(
      "/api/replay/runs",
    ),
};

export const validationApi = {
  run: (req: {
    source: string;
    day: string;
    n_days?: number;
    models?: string[];
    with_strategy_pnl?: boolean;
  }) =>
    jsonFetch<ValidationResult>("/api/validation/forecast", {
      method: "POST",
      body: JSON.stringify(req),
    }),
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
  missing: "#ef4444",
  cached: "#14b8a6",
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
