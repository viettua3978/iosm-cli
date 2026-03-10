import type { IosmConfig, IosmConfigModel } from "./config.js";
import type {
	IosmEvidenceTier,
	IosmGuardrailViolation,
	IosmHypothesisCard,
	IosmMetric,
	IosmMetricRecord,
} from "./types.js";

type RawMeasurements = Record<string, unknown>;

export const IOSM_METRICS: IosmMetric[] = ["semantic", "logic", "performance", "simplicity", "modularity", "flow"];

export function createMetricRecord<T>(createValue: (metric: IosmMetric) => T): IosmMetricRecord<T> {
	return {
		semantic: createValue("semantic"),
		logic: createValue("logic"),
		performance: createValue("performance"),
		simplicity: createValue("simplicity"),
		modularity: createValue("modularity"),
		flow: createValue("flow"),
	};
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export function normalizeHigherIsBetter(actual: number, target: number): number {
	if (target <= 0) {
		return 1;
	}
	return clamp01(actual / target);
}

export function normalizeLowerIsBetter(actual: number, target: number): number {
	if (actual <= 0) {
		return 1;
	}
	if (target <= 0) {
		return 0;
	}
	return clamp01(target / actual);
}

function readPath(source: unknown, ...segments: string[]): unknown {
	let current: unknown = source;
	for (const segment of segments) {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function readNumber(source: unknown, ...segments: string[]): number | undefined {
	const value = readPath(source, ...segments);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(source: unknown, ...segments: string[]): boolean | undefined {
	const value = readPath(source, ...segments);
	return typeof value === "boolean" ? value : undefined;
}

function measureSemantic(rawMeasurements: RawMeasurements, config: IosmConfigModel): number | null {
	const glossaryCoverage =
		readNumber(rawMeasurements, "glossary_coverage") ??
		readNumber(rawMeasurements, "semantic", "glossary_coverage");
	const namingConsistency =
		readNumber(rawMeasurements, "naming_consistency") ??
		readNumber(rawMeasurements, "semantic", "naming_consistency");
	const ambiguityInverse =
		readNumber(rawMeasurements, "ambiguity_inverse") ??
		readNumber(rawMeasurements, "semantic", "ambiguity_inverse") ??
		(() => {
			const ambiguityRatio =
				readNumber(rawMeasurements, "ambiguity_ratio") ??
				readNumber(rawMeasurements, "semantic", "ambiguity_ratio");
			return ambiguityRatio === undefined ? undefined : 1 - ambiguityRatio;
		})();

	if (glossaryCoverage === undefined || namingConsistency === undefined || ambiguityInverse === undefined) {
		return null;
	}

	return round3(
		(normalizeHigherIsBetter(glossaryCoverage, config.metric_targets.semantic.glossary_coverage_min) +
			normalizeHigherIsBetter(namingConsistency, config.metric_targets.semantic.naming_consistency_min) +
			clamp01(ambiguityInverse)) /
			3,
	);
}

function measureLogic(rawMeasurements: RawMeasurements, config: IosmConfigModel): number | null {
	const invariantPassRate =
		readNumber(rawMeasurements, "invariant_pass_rate") ??
		readNumber(rawMeasurements, "logic", "invariant_pass_rate");
	if (invariantPassRate !== undefined) {
		return round3(clamp01(invariantPassRate));
	}

	const passedInvariants =
		readNumber(rawMeasurements, "passed_invariants") ??
		readNumber(rawMeasurements, "logic", "passed_invariants");
	const totalInvariants =
		readNumber(rawMeasurements, "total_invariants") ??
		readNumber(rawMeasurements, "logic", "total_invariants");
	if (passedInvariants === undefined || totalInvariants === undefined) {
		return null;
	}

	const denominator = Math.max(totalInvariants, 1);
	return round3(normalizeHigherIsBetter(passedInvariants / denominator, config.metric_targets.logic.invariant_pass_rate_min));
}

function measurePerformance(rawMeasurements: RawMeasurements, config: IosmConfigModel): number | null {
	const latencyScore =
		readNumber(rawMeasurements, "latency_score") ??
		readNumber(rawMeasurements, "performance", "latency_score") ??
		(() => {
			const p50 = readNumber(rawMeasurements, "latency_ms", "p50") ?? readNumber(rawMeasurements, "performance", "latency_ms", "p50");
			const p95 = readNumber(rawMeasurements, "latency_ms", "p95") ?? readNumber(rawMeasurements, "performance", "latency_ms", "p95");
			const p99 = readNumber(rawMeasurements, "latency_ms", "p99") ?? readNumber(rawMeasurements, "performance", "latency_ms", "p99");
			if (p50 === undefined || p95 === undefined || p99 === undefined) {
				return undefined;
			}

			const targets = config.metric_targets.performance.latency_ms;
			return (
				normalizeLowerIsBetter(p50, targets.p50_max) +
				normalizeLowerIsBetter(p95, targets.p95_max) +
				normalizeLowerIsBetter(p99, targets.p99_max)
			) / 3;
		})();
	const reliabilityScore =
		readNumber(rawMeasurements, "reliability_score") ??
		readNumber(rawMeasurements, "performance", "reliability_score") ??
		(() => {
			const respected =
				readBoolean(rawMeasurements, "error_budget_respected") ??
				readBoolean(rawMeasurements, "performance", "error_budget_respected");
			return respected === undefined ? undefined : respected ? 1 : 0;
		})();
	const resilienceScore =
		readNumber(rawMeasurements, "resilience_score") ??
		readNumber(rawMeasurements, "performance", "resilience_score") ??
		readNumber(rawMeasurements, "chaos_pass_rate") ??
		readNumber(rawMeasurements, "performance", "chaos_pass_rate");

	if (latencyScore === undefined || reliabilityScore === undefined || resilienceScore === undefined) {
		return null;
	}

	return round3(
		0.5 * clamp01(latencyScore) + 0.3 * clamp01(reliabilityScore) + 0.2 * clamp01(resilienceScore),
	);
}

function measureSimplicity(rawMeasurements: RawMeasurements, config: IosmConfigModel): number | null {
	const apiSurfaceScore =
		readNumber(rawMeasurements, "api_surface_score") ??
		readNumber(rawMeasurements, "simplicity", "api_surface_score") ??
		(() => {
			const reduction =
				readNumber(rawMeasurements, "api_surface_reduction") ??
				readNumber(rawMeasurements, "simplicity", "api_surface_reduction");
			return reduction === undefined
				? undefined
				: normalizeHigherIsBetter(reduction, config.quality_gates.gate_S.api_surface_reduction_min);
		})();
	const dependencyHygiene =
		readNumber(rawMeasurements, "dependency_hygiene") ??
		readNumber(rawMeasurements, "simplicity", "dependency_hygiene") ??
		(() => {
			const unused =
				readNumber(rawMeasurements, "unused_or_shadow_dependencies") ??
				readNumber(rawMeasurements, "simplicity", "unused_or_shadow_dependencies");
			const total =
				readNumber(rawMeasurements, "total_dependencies") ??
				readNumber(rawMeasurements, "simplicity", "total_dependencies");
			if (unused === undefined || total === undefined || total <= 0) {
				return undefined;
			}
			return clamp01(1 - unused / total);
		})();
	const onboardingScore =
		readNumber(rawMeasurements, "onboarding_score") ??
		readNumber(rawMeasurements, "simplicity", "onboarding_score") ??
		(() => {
			const onboardingTime =
				readNumber(rawMeasurements, "onboarding_time_minutes") ??
				readNumber(rawMeasurements, "simplicity", "onboarding_time_minutes");
			return onboardingTime === undefined
				? undefined
				: normalizeLowerIsBetter(onboardingTime, config.metric_targets.simplicity.onboarding_time_minutes_max);
		})();

	if (apiSurfaceScore === undefined || dependencyHygiene === undefined || onboardingScore === undefined) {
		return null;
	}

	return round3(
		0.4 * clamp01(apiSurfaceScore) + 0.3 * clamp01(dependencyHygiene) + 0.3 * clamp01(onboardingScore),
	);
}

function measureModularity(rawMeasurements: RawMeasurements, config: IosmConfigModel): number | null {
	const couplingScore =
		readNumber(rawMeasurements, "coupling_score") ??
		readNumber(rawMeasurements, "modularity", "coupling_score") ??
		(() => {
			const coupling =
				readNumber(rawMeasurements, "coupling") ?? readNumber(rawMeasurements, "modularity", "coupling");
			return coupling === undefined ? undefined : normalizeLowerIsBetter(coupling, config.quality_gates.gate_M.coupling_max);
		})();
	const cohesionScore =
		readNumber(rawMeasurements, "cohesion_score") ??
		readNumber(rawMeasurements, "modularity", "cohesion_score") ??
		(() => {
			const cohesion =
				readNumber(rawMeasurements, "cohesion") ?? readNumber(rawMeasurements, "modularity", "cohesion");
			return cohesion === undefined ? undefined : normalizeHigherIsBetter(cohesion, config.quality_gates.gate_M.cohesion_min);
		})();
	const contractScore =
		readNumber(rawMeasurements, "contract_score") ??
		readNumber(rawMeasurements, "modularity", "contract_score") ??
		(() => {
			const contractsPass =
				readBoolean(rawMeasurements, "contracts_pass") ??
				readBoolean(rawMeasurements, "modularity", "contracts_pass");
			return contractsPass === undefined ? undefined : contractsPass ? 1 : 0;
		})();
	const changeSurfaceScore =
		readNumber(rawMeasurements, "change_surface_score") ??
		readNumber(rawMeasurements, "modularity", "change_surface_score") ??
		(() => {
			const changeSurface =
				readNumber(rawMeasurements, "change_surface") ??
				readNumber(rawMeasurements, "modularity", "change_surface");
			return changeSurface === undefined
				? undefined
				: normalizeLowerIsBetter(changeSurface, config.metric_targets.modularity.change_surface_max);
		})();

	if (couplingScore === undefined || cohesionScore === undefined || contractScore === undefined || changeSurfaceScore === undefined) {
		return null;
	}

	return round3(
		0.35 * clamp01(couplingScore) +
			0.25 * clamp01(cohesionScore) +
			0.2 * clamp01(contractScore) +
			0.2 * clamp01(changeSurfaceScore),
	);
}

function measureFlow(rawMeasurements: RawMeasurements, config: IosmConfigModel): number | null {
	const leadTimeScore =
		readNumber(rawMeasurements, "lead_time_score") ??
		readNumber(rawMeasurements, "flow", "lead_time_score") ??
		(() => {
			const leadTime =
				readNumber(rawMeasurements, "lead_time_hours") ??
				readNumber(rawMeasurements, "flow", "lead_time_hours");
			return leadTime === undefined ? undefined : normalizeLowerIsBetter(leadTime, config.metric_targets.flow.lead_time_hours_max);
		})();
	const deployFrequencyScore =
		readNumber(rawMeasurements, "deploy_frequency_score") ??
		readNumber(rawMeasurements, "flow", "deploy_frequency_score") ??
		(() => {
			const deployFrequency =
				readNumber(rawMeasurements, "deploy_frequency_per_week") ??
				readNumber(rawMeasurements, "flow", "deploy_frequency_per_week");
			return deployFrequency === undefined
				? undefined
				: normalizeHigherIsBetter(deployFrequency, config.metric_targets.flow.deploy_frequency_per_week_min);
		})();
	const changeFailureScore =
		readNumber(rawMeasurements, "change_failure_score") ??
		readNumber(rawMeasurements, "flow", "change_failure_score") ??
		(() => {
			const changeFailureRate =
				readNumber(rawMeasurements, "change_failure_rate") ??
				readNumber(rawMeasurements, "flow", "change_failure_rate");
			return changeFailureRate === undefined
				? undefined
				: normalizeLowerIsBetter(changeFailureRate, config.metric_targets.flow.change_failure_rate_max);
		})();
	const reviewLatencyScore =
		readNumber(rawMeasurements, "review_latency_score") ??
		readNumber(rawMeasurements, "flow", "review_latency_score") ??
		(() => {
			const reviewLatency =
				readNumber(rawMeasurements, "review_latency_hours") ??
				readNumber(rawMeasurements, "flow", "review_latency_hours");
			return reviewLatency === undefined
				? undefined
				: normalizeLowerIsBetter(reviewLatency, config.metric_targets.flow.review_latency_hours_max);
		})();

	if (
		leadTimeScore === undefined ||
		deployFrequencyScore === undefined ||
		changeFailureScore === undefined ||
		reviewLatencyScore === undefined
	) {
		return null;
	}

	return round3(
		0.35 * clamp01(leadTimeScore) +
			0.25 * clamp01(deployFrequencyScore) +
			0.25 * clamp01(changeFailureScore) +
			0.15 * clamp01(reviewLatencyScore),
	);
}

export function calculateIosmMetricsFromRawMeasurements(
	rawMeasurements: RawMeasurements,
	config: IosmConfig,
): IosmMetricRecord<number | null> {
	const model = config.iosm;
	return {
		semantic: measureSemantic(rawMeasurements, model),
		logic: measureLogic(rawMeasurements, model),
		performance: measurePerformance(rawMeasurements, model),
		simplicity: measureSimplicity(rawMeasurements, model),
		modularity: measureModularity(rawMeasurements, model),
		flow: measureFlow(rawMeasurements, model),
	};
}

export function hasCompleteNumericMetricRecord(
	record: IosmMetricRecord<number | null>,
): record is IosmMetricRecord<number> {
	return IOSM_METRICS.every((metric) => record[metric] !== null);
}

export function hasCompleteTierMetricRecord(
	record: IosmMetricRecord<IosmEvidenceTier | null>,
): record is IosmMetricRecord<IosmEvidenceTier> {
	return IOSM_METRICS.every((metric) => record[metric] !== null);
}

export function calculateIosmIndex(
	metrics: IosmMetricRecord<number | null>,
	weights: IosmMetricRecord<number>,
): number | null {
	if (!hasCompleteNumericMetricRecord(metrics)) {
		return null;
	}

	return round3(
		weights.semantic * metrics.semantic +
			weights.logic * metrics.logic +
			weights.performance * metrics.performance +
			weights.simplicity * metrics.simplicity +
			weights.modularity * metrics.modularity +
			weights.flow * metrics.flow,
	);
}

export function calculateDecisionConfidence(
	metricConfidences: IosmMetricRecord<number | null>,
	weights: IosmMetricRecord<number>,
): number | null {
	if (!hasCompleteNumericMetricRecord(metricConfidences)) {
		return null;
	}

	return round3(
		weights.semantic * metricConfidences.semantic +
			weights.logic * metricConfidences.logic +
			weights.performance * metricConfidences.performance +
			weights.simplicity * metricConfidences.simplicity +
			weights.modularity * metricConfidences.modularity +
			weights.flow * metricConfidences.flow,
	);
}

export function mergeMetricValues(
	current: IosmMetricRecord<number | null>,
	computed: IosmMetricRecord<number | null>,
): IosmMetricRecord<number | null> {
	return createMetricRecord((metric) => computed[metric] ?? current[metric]);
}

export function buildCycleBudget(
	globalBudget: IosmMetricRecord<number>,
	hypotheses: IosmHypothesisCard[],
): IosmMetricRecord<number> {
	return createMetricRecord((metric) => {
		let effectiveBudget = globalBudget[metric];
		for (const hypothesis of hypotheses) {
			const candidate = hypothesis.allowed_negative_delta[metric];
			effectiveBudget = Math.min(effectiveBudget, candidate);
		}
		return round3(effectiveBudget);
	});
}

export function calculateMetricDeltas(
	beforeMetrics: IosmMetricRecord<number | null>,
	afterMetrics: IosmMetricRecord<number | null>,
): IosmMetricRecord<number | null> {
	return createMetricRecord((metric) => {
		const beforeValue = beforeMetrics[metric];
		const afterValue = afterMetrics[metric];
		if (beforeValue === null || afterValue === null) {
			return null;
		}
		return round3(afterValue - beforeValue);
	});
}

export function assessDeclineCoverage(
	beforeMetrics: IosmMetricRecord<number | null>,
	afterMetrics: IosmMetricRecord<number | null>,
	hypotheses: IosmHypothesisCard[],
	hasActiveBlockingWaiver: boolean,
): IosmMetricRecord<boolean> {
	return createMetricRecord((metric) => {
		const beforeValue = beforeMetrics[metric];
		const afterValue = afterMetrics[metric];
		if (beforeValue === null || afterValue === null) {
			return false;
		}
		const delta = afterValue - beforeValue;
		if (delta >= 0) {
			return true;
		}

		return (
			hasActiveBlockingWaiver ||
			hypotheses.some((hypothesis) => hypothesis.allowed_negative_delta[metric] > 0)
		);
	});
}

export function validateGuardrails(
	beforeMetrics: IosmMetricRecord<number | null>,
	afterMetrics: IosmMetricRecord<number | null>,
	budgets: IosmMetricRecord<number>,
): { pass: boolean | null; violations: IosmGuardrailViolation[] } {
	const violations: IosmGuardrailViolation[] = [];
	for (const metric of IOSM_METRICS) {
		const beforeValue = beforeMetrics[metric];
		const afterValue = afterMetrics[metric];
		if (beforeValue === null || afterValue === null) {
			return { pass: null, violations: [] };
		}

		const negativeDelta = round3(beforeValue - afterValue);
		if (negativeDelta > budgets[metric]) {
			violations.push({
				metric,
				negative_delta: negativeDelta,
				budget: budgets[metric],
			});
		}
	}

	return {
		pass: violations.length === 0,
		violations,
	};
}
