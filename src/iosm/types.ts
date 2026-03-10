export type IosmDecision = "CONTINUE" | "STOP" | "FAIL";
export type IosmPhase = "improve" | "optimize" | "shrink" | "modularize";
export type IosmMetric = "semantic" | "logic" | "performance" | "simplicity" | "modularity" | "flow";
export type IosmEvidenceTier = "A" | "B" | "C";
export type IosmMetricRecord<T> = Record<IosmMetric, T>;

/** Canonical ordered list of IOSM phases. */
export const IOSM_PHASES: readonly IosmPhase[] = ["improve", "optimize", "shrink", "modularize"] as const;

export interface IosmCycleScope {
	modules: string[];
	services: string[];
	domains: string[];
	contracts: string[];
	rationale: string;
}

export interface IosmCycleCapacityReport {
	goal_count: number;
	scope_size: number;
	expected_change_surface: number;
	pass: boolean;
}

export interface IosmHypothesisCard {
	id: string;
	goal_id: string;
	owner: string;
	statement: string;
	expected_positive_delta: Partial<Record<IosmMetric, number>>;
	allowed_negative_delta: IosmMetricRecord<number>;
	expected_business_signal: {
		metric: string;
		direction: "up" | "down" | "stable";
	};
	validation: {
		method: string;
		window: string;
	};
	rollback_trigger: string[];
	confidence: number;
}

export interface IosmHypothesisOutcome extends IosmHypothesisCard {
	pass: boolean | null;
	notes: string[];
}

export interface IosmPhaseReport {
	phase: IosmPhase;
	gate: string;
	status: "pending" | "passed" | "failed" | "waived";
	pass: boolean | null;
	inputs: string[];
	actions_taken: string[];
	outputs: string[];
	linked_hypotheses: string[];
	gate_measurements: Record<string, unknown>;
}

export interface IosmPhasePointer {
	path: string;
	gate: string;
	status: "pending" | "passed" | "failed" | "waived";
	pass: boolean | null;
}

export interface IosmGateResult {
	pass: boolean | null;
	waived: boolean;
	status: "pending" | "passed" | "failed" | "waived";
}

export interface IosmGuardrailViolation {
	metric: IosmMetric;
	negative_delta: number;
	budget: number;
}

export interface IosmAutomationActor {
	type: string;
	role: string;
	identity?: string;
	provenance?: string;
}

export interface IosmApprovalStep {
	action: string;
	required: boolean;
	approved_by?: string;
	approved_at?: string;
	notes?: string;
}

export interface IosmBaselineReport {
	cycle_id: string;
	captured_at: string;
	system: string;
	scope: string;
	delivery_boundary: string;
	cycle_scope: IosmCycleScope;
	baseline_metrics: {
		values: IosmMetricRecord<number | null>;
		raw_measurements: Record<string, unknown>;
	};
	source_systems: string[];
}

export interface IosmMetricsHistoryEntry {
	cycle_id: string;
	recorded_at: string;
	status: IosmCycleReport["status"];
	metrics: IosmMetricRecord<number>;
	metric_confidences: IosmMetricRecord<number>;
	metric_tiers: IosmMetricRecord<IosmEvidenceTier>;
	metric_deltas: IosmMetricRecord<number>;
	decline_coverage: IosmMetricRecord<boolean>;
	iosm_index: number;
	decision_confidence: number;
	has_blocking_failure: boolean;
	has_guardrail_violation: boolean;
	has_active_blocking_waiver: boolean;
	incomplete: boolean;
}

export interface IosmCycleReport {
	cycle_id: string;
	status: "planned" | "active" | "completed" | "failed";
	system: string;
	scope: string;
	criticality_profile: string;
	delivery_boundary: string;
	cycle_scope: IosmCycleScope;
	cycle_capacity: IosmCycleCapacityReport;
	window: string;
	goals: string[];
	hypotheses: IosmHypothesisOutcome[];
	hypothesis_interactions: {
		pass: boolean;
		conflicts: Array<Record<string, unknown>>;
	};
	phase_reports: Record<IosmPhase, IosmPhasePointer>;
	gates: Record<"gate_I" | "gate_O" | "gate_S" | "gate_M", IosmGateResult>;
	metrics: IosmMetricRecord<number | null>;
	metric_confidences: IosmMetricRecord<number | null>;
	metric_tiers: IosmMetricRecord<IosmEvidenceTier | null>;
	raw_measurements: Record<string, unknown>;
	guardrails: {
		pass: boolean | null;
		effective_budget: IosmMetricRecord<number>;
		violations: IosmGuardrailViolation[];
	};
	metric_deltas: IosmMetricRecord<number | null>;
	decline_coverage: IosmMetricRecord<boolean>;
	iosm_index: number | null;
	decision_confidence: number | null;
	waivers: Array<Record<string, unknown>>;
	automation_actors: IosmAutomationActor[];
	approval_path: IosmApprovalStep[];
	anti_patterns: Array<Record<string, unknown>>;
	learning_artifacts: string[];
	incomplete: boolean;
	decision: IosmDecision;
}
