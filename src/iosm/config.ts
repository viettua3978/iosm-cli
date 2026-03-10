import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { IOSM_METRICS } from "./metrics.js";
import { getIosmConfigPath } from "./paths.js";
import type { IosmMetric, IosmMetricRecord } from "./types.js";

type UnknownRecord = Record<string, unknown>;

type IosmCriticalityProfile = "exploratory" | "standard" | "critical";

export interface IosmMetadataConfig {
	system_name: string;
	scope: string;
	criticality_profile: IosmCriticalityProfile;
	delivery_boundary: string;
}

export interface IosmPlanningConfig {
	use_economic_decision: boolean;
	prioritization_formula: string;
	min_confidence: number;
	hypothesis_required: boolean;
	cycle_scope_required: boolean;
}

export interface IosmCycleCapacityConfig {
	max_goals: number;
	max_scope_items: number;
	max_expected_change_surface: number;
}

export interface IosmStabilizationConfig {
	target_index: number;
	consecutive_cycles: number;
	global_metric_floor: number;
	max_consecutive_unexplained_declines: number;
	metric_floors: Partial<IosmMetricRecord<number>>;
}

export interface IosmCyclePolicyConfig {
	max_iterations_per_phase: number;
	stabilization: IosmStabilizationConfig;
}

export interface IosmQualityGateIConfig {
	semantic_min: number;
	logical_consistency_min: number;
	duplication_max: number;
}

export interface IosmQualityGateOConfig {
	latency_ms: {
		p50_max: number;
		p95_max: number;
		p99_max: number;
	};
	error_budget_respected: boolean;
	chaos_pass_rate_min: number;
}

export interface IosmQualityGateSConfig {
	at_least_one_dimension: boolean;
	api_surface_reduction_min: number;
	dependency_hygiene_min: number;
	onboarding_time_minutes_max: number;
	regression_budget_max: number;
}

export interface IosmQualityGateMConfig {
	change_surface_max: number;
	coupling_max: number;
	cohesion_min: number;
	contracts_pass: boolean;
}

export interface IosmQualityGatesConfig {
	gate_I: IosmQualityGateIConfig;
	gate_O: IosmQualityGateOConfig;
	gate_S: IosmQualityGateSConfig;
	gate_M: IosmQualityGateMConfig;
}

export interface IosmGuardrailsConfig {
	max_negative_delta: IosmMetricRecord<number>;
}

export interface IosmEvidenceConfig {
	min_decision_confidence: number;
	freshness_sla_hours: {
		tier_a: number;
		tier_b: number;
	};
	min_metric_confidence: IosmMetricRecord<number>;
}

export interface IosmWaiversConfig {
	max_duration_days: number;
	require_human_approval: boolean;
}

export interface IosmMetricTargetsConfig {
	semantic: {
		glossary_coverage_min: number;
		naming_consistency_min: number;
		ambiguity_ratio_max: number;
	};
	logic: {
		invariant_pass_rate_min: number;
	};
	performance: {
		latency_ms: {
			p50_max: number;
			p95_max: number;
			p99_max: number;
		};
	};
	simplicity: {
		onboarding_time_minutes_max: number;
	};
	modularity: {
		change_surface_max: number;
	};
	flow: {
		lead_time_hours_max: number;
		deploy_frequency_per_week_min: number;
		change_failure_rate_max: number;
		review_latency_hours_max: number;
	};
}

export interface IosmIndexConfig {
	weights: IosmMetricRecord<number>;
}

export interface IosmAutomationConfig {
	allow_agents: boolean;
	human_approval_required_for: string[];
}

export interface IosmReportingConfig {
	persist_history: boolean;
	output_format: string;
}

export interface IosmLearningConfig {
	update_pattern_library: boolean;
	update_decision_log: boolean;
	update_glossary: boolean;
}

export interface IosmConfigModel {
	metadata: IosmMetadataConfig;
	planning: IosmPlanningConfig;
	cycle_capacity: IosmCycleCapacityConfig;
	cycle_policy: IosmCyclePolicyConfig;
	quality_gates: IosmQualityGatesConfig;
	guardrails: IosmGuardrailsConfig;
	evidence: IosmEvidenceConfig;
	waivers: IosmWaiversConfig;
	metric_targets: IosmMetricTargetsConfig;
	index: IosmIndexConfig;
	automation: IosmAutomationConfig;
	reporting: IosmReportingConfig;
	learning: IosmLearningConfig;
}

export interface IosmConfig {
	iosm: IosmConfigModel;
}

function expectObject(value: unknown, path: string): UnknownRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Expected object at ${path}`);
	}

	return value as UnknownRecord;
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Expected non-empty string at ${path}`);
	}

	return value;
}

function expectBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Expected boolean at ${path}`);
	}

	return value;
}

function expectNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
		throw new Error(`Expected finite number at ${path}`);
	}

	return value;
}

function expectInteger(value: unknown, path: string): number {
	const number = expectNumber(value, path);
	if (!Number.isInteger(number)) {
		throw new Error(`Expected integer at ${path}`);
	}

	return number;
}

function expectStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`Expected array at ${path}`);
	}

	return value.map((entry, index) => expectString(entry, `${path}[${index}]`));
}

function assertUnitInterval(value: number, path: string): void {
	if (value < 0 || value > 1) {
		throw new Error(`Expected ${path} to be in [0.0, 1.0], received ${value}`);
	}
}

function assertPositiveInteger(value: number, path: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`Expected ${path} to be an integer >= 1, received ${value}`);
	}
}

function assertNonNegativeInteger(value: number, path: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`Expected ${path} to be an integer >= 0, received ${value}`);
	}
}

function assertNonNegative(value: number, path: string): void {
	if (value < 0) {
		throw new Error(`Expected ${path} to be >= 0, received ${value}`);
	}
}

function parseMetricNumberRecord(value: unknown, path: string): IosmMetricRecord<number> {
	const object = expectObject(value, path);
	return {
		semantic: expectNumber(object.semantic, `${path}.semantic`),
		logic: expectNumber(object.logic, `${path}.logic`),
		performance: expectNumber(object.performance, `${path}.performance`),
		simplicity: expectNumber(object.simplicity, `${path}.simplicity`),
		modularity: expectNumber(object.modularity, `${path}.modularity`),
		flow: expectNumber(object.flow, `${path}.flow`),
	};
}

function parseMetricFloorRecord(value: unknown, path: string): Partial<IosmMetricRecord<number>> {
	const object = expectObject(value, path);
	const result: Partial<IosmMetricRecord<number>> = {};
	for (const metric of IOSM_METRICS) {
		const metricValue = object[metric];
		if (metricValue !== undefined) {
			result[metric] = expectNumber(metricValue, `${path}.${metric}`);
		}
	}
	return result;
}

function validateMetricIntervals(values: Partial<IosmMetricRecord<number>>, path: string): void {
	for (const metric of IOSM_METRICS) {
		const value = values[metric];
		if (value !== undefined) {
			assertUnitInterval(value, `${path}.${metric}`);
		}
	}
}

function validateMetricRecord(values: IosmMetricRecord<number>, path: string): void {
	for (const metric of IOSM_METRICS) {
		assertUnitInterval(values[metric], `${path}.${metric}`);
	}
}

export function findIosmRootDir(startDir: string = process.cwd()): string | undefined {
	let currentDir = resolve(startDir);
	while (true) {
		if (existsSync(getIosmConfigPath(currentDir))) {
			return currentDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}

		currentDir = parentDir;
	}
}

export function resolveIosmRootDir(startDir: string = process.cwd()): string {
	const rootDir = findIosmRootDir(startDir);
	if (!rootDir) {
		throw new Error(`Missing iosm.yaml in ${resolve(startDir)} or its parent directories. Run "iosm init" first.`);
	}
	return rootDir;
}

export function loadIosmConfig(cwd: string = process.cwd()): { rootDir: string; path: string; config: IosmConfig } {
	const rootDir = resolveIosmRootDir(cwd);
	const path = getIosmConfigPath(rootDir);
	const contents = readFileSync(path, "utf8");
	const parsed = parse(contents);
	const document = expectObject(parsed, "config");
	const iosm = expectObject(document.iosm, "iosm");

	const metadataObject = expectObject(iosm.metadata, "iosm.metadata");
	const planningObject = expectObject(iosm.planning, "iosm.planning");
	const cycleCapacityObject = expectObject(iosm.cycle_capacity, "iosm.cycle_capacity");
	const cyclePolicyObject = expectObject(iosm.cycle_policy, "iosm.cycle_policy");
	const stabilizationObject = expectObject(cyclePolicyObject.stabilization, "iosm.cycle_policy.stabilization");
	const qualityGatesObject = expectObject(iosm.quality_gates, "iosm.quality_gates");
	const gateIObject = expectObject(qualityGatesObject.gate_I, "iosm.quality_gates.gate_I");
	const gateOObject = expectObject(qualityGatesObject.gate_O, "iosm.quality_gates.gate_O");
	const gateOLatencyObject = expectObject(gateOObject.latency_ms, "iosm.quality_gates.gate_O.latency_ms");
	const gateSObject = expectObject(qualityGatesObject.gate_S, "iosm.quality_gates.gate_S");
	const gateMObject = expectObject(qualityGatesObject.gate_M, "iosm.quality_gates.gate_M");
	const guardrailsObject = expectObject(iosm.guardrails, "iosm.guardrails");
	const evidenceObject = expectObject(iosm.evidence, "iosm.evidence");
	const freshnessObject = expectObject(evidenceObject.freshness_sla_hours, "iosm.evidence.freshness_sla_hours");
	const waiversObject = expectObject(iosm.waivers, "iosm.waivers");
	const metricTargetsObject = expectObject(iosm.metric_targets, "iosm.metric_targets");
	const semanticTargetsObject = expectObject(metricTargetsObject.semantic, "iosm.metric_targets.semantic");
	const logicTargetsObject = expectObject(metricTargetsObject.logic, "iosm.metric_targets.logic");
	const performanceTargetsObject = expectObject(metricTargetsObject.performance, "iosm.metric_targets.performance");
	const performanceLatencyObject = expectObject(
		performanceTargetsObject.latency_ms,
		"iosm.metric_targets.performance.latency_ms",
	);
	const simplicityTargetsObject = expectObject(metricTargetsObject.simplicity, "iosm.metric_targets.simplicity");
	const modularityTargetsObject = expectObject(metricTargetsObject.modularity, "iosm.metric_targets.modularity");
	const flowTargetsObject = expectObject(metricTargetsObject.flow, "iosm.metric_targets.flow");
	const indexObject = expectObject(iosm.index, "iosm.index");
	const automationObject = expectObject(iosm.automation, "iosm.automation");
	const reportingObject = expectObject(iosm.reporting, "iosm.reporting");
	const learningObject = expectObject(iosm.learning, "iosm.learning");

	const config: IosmConfig = {
		iosm: {
			metadata: {
				system_name: expectString(metadataObject.system_name, "iosm.metadata.system_name"),
				scope: expectString(metadataObject.scope, "iosm.metadata.scope"),
				criticality_profile: expectString(
					metadataObject.criticality_profile,
					"iosm.metadata.criticality_profile",
				) as IosmCriticalityProfile,
				delivery_boundary: expectString(metadataObject.delivery_boundary, "iosm.metadata.delivery_boundary"),
			},
			planning: {
				use_economic_decision: expectBoolean(
					planningObject.use_economic_decision,
					"iosm.planning.use_economic_decision",
				),
				prioritization_formula: expectString(
					planningObject.prioritization_formula,
					"iosm.planning.prioritization_formula",
				),
				min_confidence: expectNumber(planningObject.min_confidence, "iosm.planning.min_confidence"),
				hypothesis_required: expectBoolean(
					planningObject.hypothesis_required,
					"iosm.planning.hypothesis_required",
				),
				cycle_scope_required: expectBoolean(
					planningObject.cycle_scope_required,
					"iosm.planning.cycle_scope_required",
				),
			},
			cycle_capacity: {
				max_goals: expectInteger(cycleCapacityObject.max_goals, "iosm.cycle_capacity.max_goals"),
				max_scope_items: expectInteger(
					cycleCapacityObject.max_scope_items,
					"iosm.cycle_capacity.max_scope_items",
				),
				max_expected_change_surface: expectInteger(
					cycleCapacityObject.max_expected_change_surface,
					"iosm.cycle_capacity.max_expected_change_surface",
				),
			},
			cycle_policy: {
				max_iterations_per_phase: expectInteger(
					cyclePolicyObject.max_iterations_per_phase,
					"iosm.cycle_policy.max_iterations_per_phase",
				),
				stabilization: {
					target_index: expectNumber(stabilizationObject.target_index, "iosm.cycle_policy.stabilization.target_index"),
					consecutive_cycles: expectInteger(
						stabilizationObject.consecutive_cycles,
						"iosm.cycle_policy.stabilization.consecutive_cycles",
					),
					global_metric_floor: expectNumber(
						stabilizationObject.global_metric_floor,
						"iosm.cycle_policy.stabilization.global_metric_floor",
					),
					max_consecutive_unexplained_declines: expectInteger(
						stabilizationObject.max_consecutive_unexplained_declines,
						"iosm.cycle_policy.stabilization.max_consecutive_unexplained_declines",
					),
					metric_floors: parseMetricFloorRecord(
						stabilizationObject.metric_floors,
						"iosm.cycle_policy.stabilization.metric_floors",
					),
				},
			},
			quality_gates: {
				gate_I: {
					semantic_min: expectNumber(gateIObject.semantic_min, "iosm.quality_gates.gate_I.semantic_min"),
					logical_consistency_min: expectNumber(
						gateIObject.logical_consistency_min,
						"iosm.quality_gates.gate_I.logical_consistency_min",
					),
					duplication_max: expectNumber(gateIObject.duplication_max, "iosm.quality_gates.gate_I.duplication_max"),
				},
				gate_O: {
					latency_ms: {
						p50_max: expectNumber(
							gateOLatencyObject.p50_max,
							"iosm.quality_gates.gate_O.latency_ms.p50_max",
						),
						p95_max: expectNumber(
							gateOLatencyObject.p95_max,
							"iosm.quality_gates.gate_O.latency_ms.p95_max",
						),
						p99_max: expectNumber(
							gateOLatencyObject.p99_max,
							"iosm.quality_gates.gate_O.latency_ms.p99_max",
						),
					},
					error_budget_respected: expectBoolean(
						gateOObject.error_budget_respected,
						"iosm.quality_gates.gate_O.error_budget_respected",
					),
					chaos_pass_rate_min: expectNumber(
						gateOObject.chaos_pass_rate_min,
						"iosm.quality_gates.gate_O.chaos_pass_rate_min",
					),
				},
				gate_S: {
					at_least_one_dimension: expectBoolean(
						gateSObject.at_least_one_dimension,
						"iosm.quality_gates.gate_S.at_least_one_dimension",
					),
					api_surface_reduction_min: expectNumber(
						gateSObject.api_surface_reduction_min,
						"iosm.quality_gates.gate_S.api_surface_reduction_min",
					),
					dependency_hygiene_min: expectNumber(
						gateSObject.dependency_hygiene_min,
						"iosm.quality_gates.gate_S.dependency_hygiene_min",
					),
					onboarding_time_minutes_max: expectNumber(
						gateSObject.onboarding_time_minutes_max,
						"iosm.quality_gates.gate_S.onboarding_time_minutes_max",
					),
					regression_budget_max: expectInteger(
						gateSObject.regression_budget_max,
						"iosm.quality_gates.gate_S.regression_budget_max",
					),
				},
				gate_M: {
					change_surface_max: expectInteger(
						gateMObject.change_surface_max,
						"iosm.quality_gates.gate_M.change_surface_max",
					),
					coupling_max: expectNumber(gateMObject.coupling_max, "iosm.quality_gates.gate_M.coupling_max"),
					cohesion_min: expectNumber(gateMObject.cohesion_min, "iosm.quality_gates.gate_M.cohesion_min"),
					contracts_pass: expectBoolean(
						gateMObject.contracts_pass,
						"iosm.quality_gates.gate_M.contracts_pass",
					),
				},
			},
			guardrails: {
				max_negative_delta: parseMetricNumberRecord(
					guardrailsObject.max_negative_delta,
					"iosm.guardrails.max_negative_delta",
				),
			},
			evidence: {
				min_decision_confidence: expectNumber(
					evidenceObject.min_decision_confidence,
					"iosm.evidence.min_decision_confidence",
				),
				freshness_sla_hours: {
					tier_a: expectInteger(freshnessObject.tier_a, "iosm.evidence.freshness_sla_hours.tier_a"),
					tier_b: expectInteger(freshnessObject.tier_b, "iosm.evidence.freshness_sla_hours.tier_b"),
				},
				min_metric_confidence: parseMetricNumberRecord(
					evidenceObject.min_metric_confidence,
					"iosm.evidence.min_metric_confidence",
				),
			},
			waivers: {
				max_duration_days: expectInteger(waiversObject.max_duration_days, "iosm.waivers.max_duration_days"),
				require_human_approval: expectBoolean(
					waiversObject.require_human_approval,
					"iosm.waivers.require_human_approval",
				),
			},
			metric_targets: {
				semantic: {
					glossary_coverage_min: expectNumber(
						semanticTargetsObject.glossary_coverage_min,
						"iosm.metric_targets.semantic.glossary_coverage_min",
					),
					naming_consistency_min: expectNumber(
						semanticTargetsObject.naming_consistency_min,
						"iosm.metric_targets.semantic.naming_consistency_min",
					),
					ambiguity_ratio_max: expectNumber(
						semanticTargetsObject.ambiguity_ratio_max,
						"iosm.metric_targets.semantic.ambiguity_ratio_max",
					),
				},
				logic: {
					invariant_pass_rate_min: expectNumber(
						logicTargetsObject.invariant_pass_rate_min,
						"iosm.metric_targets.logic.invariant_pass_rate_min",
					),
				},
				performance: {
					latency_ms: {
						p50_max: expectNumber(
							performanceLatencyObject.p50_max,
							"iosm.metric_targets.performance.latency_ms.p50_max",
						),
						p95_max: expectNumber(
							performanceLatencyObject.p95_max,
							"iosm.metric_targets.performance.latency_ms.p95_max",
						),
						p99_max: expectNumber(
							performanceLatencyObject.p99_max,
							"iosm.metric_targets.performance.latency_ms.p99_max",
						),
					},
				},
				simplicity: {
					onboarding_time_minutes_max: expectNumber(
						simplicityTargetsObject.onboarding_time_minutes_max,
						"iosm.metric_targets.simplicity.onboarding_time_minutes_max",
					),
				},
				modularity: {
					change_surface_max: expectInteger(
						modularityTargetsObject.change_surface_max,
						"iosm.metric_targets.modularity.change_surface_max",
					),
				},
				flow: {
					lead_time_hours_max: expectNumber(
						flowTargetsObject.lead_time_hours_max,
						"iosm.metric_targets.flow.lead_time_hours_max",
					),
					deploy_frequency_per_week_min: expectNumber(
						flowTargetsObject.deploy_frequency_per_week_min,
						"iosm.metric_targets.flow.deploy_frequency_per_week_min",
					),
					change_failure_rate_max: expectNumber(
						flowTargetsObject.change_failure_rate_max,
						"iosm.metric_targets.flow.change_failure_rate_max",
					),
					review_latency_hours_max: expectNumber(
						flowTargetsObject.review_latency_hours_max,
						"iosm.metric_targets.flow.review_latency_hours_max",
					),
				},
			},
			index: {
				weights: parseMetricNumberRecord(indexObject.weights, "iosm.index.weights"),
			},
			automation: {
				allow_agents: expectBoolean(automationObject.allow_agents, "iosm.automation.allow_agents"),
				human_approval_required_for: expectStringArray(
					automationObject.human_approval_required_for,
					"iosm.automation.human_approval_required_for",
				),
			},
			reporting: {
				persist_history: expectBoolean(reportingObject.persist_history, "iosm.reporting.persist_history"),
				output_format: expectString(reportingObject.output_format, "iosm.reporting.output_format"),
			},
			learning: {
				update_pattern_library: expectBoolean(
					learningObject.update_pattern_library,
					"iosm.learning.update_pattern_library",
				),
				update_decision_log: expectBoolean(
					learningObject.update_decision_log,
					"iosm.learning.update_decision_log",
				),
				update_glossary: expectBoolean(learningObject.update_glossary, "iosm.learning.update_glossary"),
			},
		},
	};

	if (!["exploratory", "standard", "critical"].includes(config.iosm.metadata.criticality_profile)) {
		throw new Error(
			`Unsupported iosm.metadata.criticality_profile: ${config.iosm.metadata.criticality_profile}`,
		);
	}

	assertUnitInterval(config.iosm.planning.min_confidence, "iosm.planning.min_confidence");
	if (!config.iosm.planning.cycle_scope_required) {
		throw new Error("iosm.planning.cycle_scope_required must be true");
	}

	assertPositiveInteger(config.iosm.cycle_capacity.max_goals, "iosm.cycle_capacity.max_goals");
	assertPositiveInteger(config.iosm.cycle_capacity.max_scope_items, "iosm.cycle_capacity.max_scope_items");
	assertPositiveInteger(
		config.iosm.cycle_capacity.max_expected_change_surface,
		"iosm.cycle_capacity.max_expected_change_surface",
	);
	assertPositiveInteger(
		config.iosm.cycle_policy.max_iterations_per_phase,
		"iosm.cycle_policy.max_iterations_per_phase",
	);

	assertUnitInterval(config.iosm.cycle_policy.stabilization.target_index, "iosm.cycle_policy.stabilization.target_index");
	assertPositiveInteger(
		config.iosm.cycle_policy.stabilization.consecutive_cycles,
		"iosm.cycle_policy.stabilization.consecutive_cycles",
	);
	assertUnitInterval(
		config.iosm.cycle_policy.stabilization.global_metric_floor,
		"iosm.cycle_policy.stabilization.global_metric_floor",
	);
	assertNonNegativeInteger(
		config.iosm.cycle_policy.stabilization.max_consecutive_unexplained_declines,
		"iosm.cycle_policy.stabilization.max_consecutive_unexplained_declines",
	);
	validateMetricIntervals(
		config.iosm.cycle_policy.stabilization.metric_floors,
		"iosm.cycle_policy.stabilization.metric_floors",
	);

	assertUnitInterval(config.iosm.quality_gates.gate_I.semantic_min, "iosm.quality_gates.gate_I.semantic_min");
	assertUnitInterval(
		config.iosm.quality_gates.gate_I.logical_consistency_min,
		"iosm.quality_gates.gate_I.logical_consistency_min",
	);
	assertUnitInterval(config.iosm.quality_gates.gate_I.duplication_max, "iosm.quality_gates.gate_I.duplication_max");
	assertUnitInterval(
		config.iosm.quality_gates.gate_O.chaos_pass_rate_min,
		"iosm.quality_gates.gate_O.chaos_pass_rate_min",
	);
	assertUnitInterval(
		config.iosm.quality_gates.gate_S.api_surface_reduction_min,
		"iosm.quality_gates.gate_S.api_surface_reduction_min",
	);
	assertUnitInterval(
		config.iosm.quality_gates.gate_S.dependency_hygiene_min,
		"iosm.quality_gates.gate_S.dependency_hygiene_min",
	);
	assertNonNegative(config.iosm.quality_gates.gate_S.onboarding_time_minutes_max, "iosm.quality_gates.gate_S.onboarding_time_minutes_max");
	assertNonNegativeInteger(config.iosm.quality_gates.gate_S.regression_budget_max, "iosm.quality_gates.gate_S.regression_budget_max");
	assertPositiveInteger(config.iosm.quality_gates.gate_M.change_surface_max, "iosm.quality_gates.gate_M.change_surface_max");
	assertUnitInterval(config.iosm.quality_gates.gate_M.coupling_max, "iosm.quality_gates.gate_M.coupling_max");
	assertUnitInterval(config.iosm.quality_gates.gate_M.cohesion_min, "iosm.quality_gates.gate_M.cohesion_min");

	validateMetricRecord(config.iosm.guardrails.max_negative_delta, "iosm.guardrails.max_negative_delta");
	assertUnitInterval(config.iosm.evidence.min_decision_confidence, "iosm.evidence.min_decision_confidence");
	validateMetricRecord(config.iosm.evidence.min_metric_confidence, "iosm.evidence.min_metric_confidence");
	assertPositiveInteger(config.iosm.evidence.freshness_sla_hours.tier_a, "iosm.evidence.freshness_sla_hours.tier_a");
	assertPositiveInteger(config.iosm.evidence.freshness_sla_hours.tier_b, "iosm.evidence.freshness_sla_hours.tier_b");
	assertPositiveInteger(config.iosm.waivers.max_duration_days, "iosm.waivers.max_duration_days");

	assertUnitInterval(config.iosm.metric_targets.semantic.glossary_coverage_min, "iosm.metric_targets.semantic.glossary_coverage_min");
	assertUnitInterval(config.iosm.metric_targets.semantic.naming_consistency_min, "iosm.metric_targets.semantic.naming_consistency_min");
	assertUnitInterval(config.iosm.metric_targets.semantic.ambiguity_ratio_max, "iosm.metric_targets.semantic.ambiguity_ratio_max");
	assertUnitInterval(config.iosm.metric_targets.logic.invariant_pass_rate_min, "iosm.metric_targets.logic.invariant_pass_rate_min");
	assertNonNegative(
		config.iosm.metric_targets.simplicity.onboarding_time_minutes_max,
		"iosm.metric_targets.simplicity.onboarding_time_minutes_max",
	);
	assertPositiveInteger(
		config.iosm.metric_targets.modularity.change_surface_max,
		"iosm.metric_targets.modularity.change_surface_max",
	);
	assertNonNegative(config.iosm.metric_targets.flow.lead_time_hours_max, "iosm.metric_targets.flow.lead_time_hours_max");
	assertNonNegative(
		config.iosm.metric_targets.flow.deploy_frequency_per_week_min,
		"iosm.metric_targets.flow.deploy_frequency_per_week_min",
	);
	assertUnitInterval(config.iosm.metric_targets.flow.change_failure_rate_max, "iosm.metric_targets.flow.change_failure_rate_max");
	assertNonNegative(config.iosm.metric_targets.flow.review_latency_hours_max, "iosm.metric_targets.flow.review_latency_hours_max");

	validateMetricRecord(config.iosm.index.weights, "iosm.index.weights");
	const weightSum = IOSM_METRICS.reduce((sum, metric) => sum + config.iosm.index.weights[metric], 0);
	if (Math.abs(weightSum - 1) > 0.001) {
		throw new Error(`iosm.index.weights must sum to 1.0, received ${weightSum.toFixed(3)}`);
	}

	return { rootDir, path, config };
}
