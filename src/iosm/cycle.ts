import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { type IosmConfig, loadIosmConfig, resolveIosmRootDir } from "./config.js";
import {
	assessDeclineCoverage,
	buildCycleBudget,
	calculateDecisionConfidence,
	calculateIosmIndex,
	calculateIosmMetricsFromRawMeasurements,
	calculateMetricDeltas,
	createMetricRecord,
	hasCompleteNumericMetricRecord,
	hasCompleteTierMetricRecord,
	IOSM_METRICS,
	mergeMetricValues,
	validateGuardrails,
} from "./metrics.js";
import {
	getIosmBaselineReportPath,
	getIosmCycleDir,
	getIosmCycleReportPath,
	getIosmCyclesDir,
	getIosmHypothesesPath,
	getIosmMetricsHistoryPath,
	getIosmPhaseReportPath,
	getIosmPhaseReportsDir,
} from "./paths.js";
import type {
	IosmBaselineReport,
	IosmCycleCapacityReport,
	IosmCycleReport,
	IosmCycleScope,
	IosmDecision,
	IosmEvidenceTier,
	IosmGateResult,
	IosmGuardrailViolation,
	IosmHypothesisCard,
	IosmHypothesisOutcome,
	IosmMetric,
	IosmMetricRecord,
	IosmMetricsHistoryEntry,
	IosmPhase,
	IosmPhasePointer,
	IosmPhaseReport,
} from "./types.js";
import { IOSM_PHASES } from "./types.js";

const IOSM_PHASE_GATES: Record<IosmPhase, "gate_I" | "gate_O" | "gate_S" | "gate_M"> = {
	improve: "gate_I",
	optimize: "gate_O",
	shrink: "gate_S",
	modularize: "gate_M",
};

type UnknownRecord = Record<string, unknown>;

export interface PlanIosmCycleOptions {
	cwd?: string;
	goals: string[];
	cycleId?: string;
	force?: boolean;
}

export interface PlannedIosmCycle {
	cycleId: string;
	cycleDir: string;
	reportPath: string;
	baselineReportPath: string;
	hypothesesPath: string;
}

export interface IosmCycleListItem {
	cycleId: string;
	path: string;
	status: IosmCycleReport["status"] | "unknown";
	goals: string[];
	decision: IosmDecision | "unknown";
}

export interface IosmCycleStatus {
	cycleId: string;
	rootDir: string;
	reportPath: string;
	status: IosmCycleReport["status"];
	decision: IosmDecision;
	reportComplete: boolean;
	learningClosed: boolean;
	historyRecorded: boolean;
	capacityPass: boolean;
	guardrailsPass: boolean | null;
	blockingIssues: string[];
	warnings: string[];
}

export interface IosmCycleHistoryRecordResult {
	cycleId: string;
	historyPath: string;
	replaced: boolean;
}

function isPlainObject(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === "string");
}

function jsonWrite(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function formatLocalDate(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function createObservationWindow(now: Date): string {
	const date = formatLocalDate(now);
	return `${date}/${date}`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

function countScopeItems(scope: IosmCycleScope): number {
	return scope.modules.length + scope.services.length + scope.domains.length + scope.contracts.length;
}

function estimateExpectedChangeSurface(hypotheses: IosmHypothesisCard[], cycleScope: IosmCycleScope): number {
	const scopeSize = countScopeItems(cycleScope);
	return scopeSize > 0 ? scopeSize : Math.max(hypotheses.length, 1);
}

function nextCycleId(rootDir: string): string {
	const today = formatLocalDate(new Date());
	const prefix = `iosm-${today}-`;
	const cycleDir = getIosmCyclesDir(rootDir);
	if (!existsSync(cycleDir)) {
		return `${prefix}001`;
	}

	const suffixes = readdirSync(cycleDir)
		.filter((entry) => entry.startsWith(prefix))
		.map((entry) => Number.parseInt(entry.slice(prefix.length), 10))
		.filter((value) => Number.isFinite(value));

	const nextIndex = suffixes.length === 0 ? 1 : Math.max(...suffixes) + 1;
	return `${prefix}${String(nextIndex).padStart(3, "0")}`;
}

function createCycleScopeTemplate(): IosmCycleScope {
	return {
		modules: [],
		services: [],
		domains: [],
		contracts: [],
		rationale: "Fill in cycle scope before phase execution.",
	};
}

function normalizeCycleScope(value: unknown): IosmCycleScope {
	const object = isPlainObject(value) ? value : {};
	return {
		modules: asStringArray(object.modules),
		services: asStringArray(object.services),
		domains: asStringArray(object.domains),
		contracts: asStringArray(object.contracts),
		rationale: asString(object.rationale) ?? "",
	};
}

function normalizeMetricNumbers(value: unknown, fallback: number | null): IosmMetricRecord<number | null> {
	const object = isPlainObject(value) ? value : {};
	return createMetricRecord((metric) => asNumber(object[metric]) ?? fallback);
}

function normalizeMetricTiers(value: unknown): IosmMetricRecord<IosmEvidenceTier | null> {
	const object = isPlainObject(value) ? value : {};
	return createMetricRecord((metric) => {
		const tier = asString(object[metric]);
		return tier === "A" || tier === "B" || tier === "C" ? tier : null;
	});
}

function normalizeMetricBooleans(value: unknown, fallback: boolean): IosmMetricRecord<boolean> {
	const object = isPlainObject(value) ? value : {};
	return createMetricRecord((metric) => asBoolean(object[metric]) ?? fallback);
}

function createCycleCapacity(
	goals: string[],
	cycleScope: IosmCycleScope,
	hypotheses: IosmHypothesisCard[],
	config: IosmConfig["iosm"]["cycle_capacity"],
): IosmCycleCapacityReport {
	const goalCount = goals.length;
	const scopeSize = countScopeItems(cycleScope);
	const expectedChangeSurface = estimateExpectedChangeSurface(hypotheses, cycleScope);
	return {
		goal_count: goalCount,
		scope_size: scopeSize,
		expected_change_surface: expectedChangeSurface,
		pass:
			goalCount <= config.max_goals &&
			scopeSize <= config.max_scope_items &&
			expectedChangeSurface <= config.max_expected_change_surface,
	};
}

function createHypotheses(goals: string[], config: IosmConfig): IosmHypothesisCard[] {
	return goals.map((goal, index) => {
		const slug = slugify(goal) || `goal-${index + 1}`;
		return {
			id: `hyp-${slug}-${String(index + 1).padStart(3, "0")}`,
			goal_id: slug,
			owner: "unassigned",
			statement: `If ${goal.toLowerCase()}, the target metrics should improve without violating guardrails.`,
			expected_positive_delta: {},
			allowed_negative_delta: { ...config.iosm.guardrails.max_negative_delta },
			expected_business_signal: {
				metric: "",
				direction: "up",
			},
			validation: {
				method: "fill-in",
				window: "fill-in",
			},
			rollback_trigger: [],
			confidence: config.iosm.planning.min_confidence,
		};
	});
}

function buildHypothesisInteractions(hypotheses: IosmHypothesisCard[]): {
	pass: boolean;
	conflicts: Array<Record<string, unknown>>;
} {
	const seenGoalIds = new Set<string>();
	const conflicts: Array<Record<string, unknown>> = [];

	for (const hypothesis of hypotheses) {
		if (seenGoalIds.has(hypothesis.goal_id)) {
			conflicts.push({
				type: "duplicate_goal_id",
				goal_id: hypothesis.goal_id,
				hypothesis_id: hypothesis.id,
			});
			continue;
		}
		seenGoalIds.add(hypothesis.goal_id);
	}

	return {
		pass: conflicts.length === 0,
		conflicts,
	};
}

function createPhaseReport(phase: IosmPhase): IosmPhaseReport {
	return {
		phase,
		gate: IOSM_PHASE_GATES[phase],
		status: "pending",
		pass: null,
		inputs: [],
		actions_taken: [],
		outputs: [],
		linked_hypotheses: [],
		gate_measurements: {},
	};
}

function createPhasePointers(cycleId: string, rootDir: string): Record<IosmPhase, IosmPhasePointer> {
	return Object.fromEntries(
		IOSM_PHASES.map((phase) => [
			phase,
			{
				path: getIosmPhaseReportPath(cycleId, phase, rootDir),
				gate: IOSM_PHASE_GATES[phase],
				status: "pending" as const,
				pass: null,
			},
		]),
	) as Record<IosmPhase, IosmPhasePointer>;
}

function createGateResults(): Record<"gate_I" | "gate_O" | "gate_S" | "gate_M", IosmGateResult> {
	return {
		gate_I: { pass: null, waived: false, status: "pending" },
		gate_O: { pass: null, waived: false, status: "pending" },
		gate_S: { pass: null, waived: false, status: "pending" },
		gate_M: { pass: null, waived: false, status: "pending" },
	};
}

function createBaselineReport(
	rootDir: string,
	cycleId: string,
	config: IosmConfig,
	cycleScope: IosmCycleScope,
): IosmBaselineReport {
	return {
		cycle_id: cycleId,
		captured_at: new Date().toISOString(),
		system: config.iosm.metadata.system_name || basename(rootDir),
		scope: config.iosm.metadata.scope,
		delivery_boundary: config.iosm.metadata.delivery_boundary,
		cycle_scope: cycleScope,
		baseline_metrics: {
			values: createMetricRecord(() => null),
			raw_measurements: {},
		},
		source_systems: [config.iosm.metadata.system_name],
	};
}

function createCycleReport(
	rootDir: string,
	cycleId: string,
	goals: string[],
	hypotheses: IosmHypothesisCard[],
	config: IosmConfig,
): IosmCycleReport {
	const cycleScope = createCycleScopeTemplate();
	const cycleCapacity = createCycleCapacity(goals, cycleScope, hypotheses, config.iosm.cycle_capacity);
	const hypothesisInteractions = buildHypothesisInteractions(hypotheses);
	const effectiveBudget = buildCycleBudget(config.iosm.guardrails.max_negative_delta, hypotheses);

	return {
		cycle_id: cycleId,
		status: "planned",
		system: config.iosm.metadata.system_name || basename(rootDir),
		scope: config.iosm.metadata.scope,
		criticality_profile: config.iosm.metadata.criticality_profile,
		delivery_boundary: config.iosm.metadata.delivery_boundary,
		cycle_scope: cycleScope,
		cycle_capacity: cycleCapacity,
		window: createObservationWindow(new Date()),
		goals,
		hypotheses: hypotheses.map((hypothesis) => ({ ...hypothesis, pass: null, notes: [] })),
		hypothesis_interactions: hypothesisInteractions,
		phase_reports: createPhasePointers(cycleId, rootDir),
		gates: createGateResults(),
		metrics: createMetricRecord(() => null),
		metric_confidences: createMetricRecord(() => null),
		metric_tiers: createMetricRecord(() => null),
		raw_measurements: {},
		guardrails: {
			pass: null,
			effective_budget: effectiveBudget,
			violations: [],
		},
		metric_deltas: createMetricRecord(() => null),
		decline_coverage: createMetricRecord(() => true),
		iosm_index: null,
		decision_confidence: null,
		waivers: [],
		automation_actors: [{ type: "agent", role: "analyst", identity: "iosm-cli" }],
		approval_path: [],
		anti_patterns: [],
		learning_artifacts: [],
		incomplete: true,
		decision: "CONTINUE",
	};
}

function writeScaffoldFile(filePath: string, value: unknown, force: boolean): void {
	if (existsSync(filePath) && !force) {
		throw new Error(`Refusing to overwrite existing file: ${filePath}. Use --force to replace it.`);
	}

	jsonWrite(filePath, value);
}

function parseExistingHypothesisState(
	value: unknown,
): Map<string, { pass: boolean | null; notes: string[] }> {
	const result = new Map<string, { pass: boolean | null; notes: string[] }>();
	if (!Array.isArray(value)) {
		return result;
	}

	for (const entry of value) {
		if (!isPlainObject(entry)) {
			continue;
		}

		const id = asString(entry.id);
		if (!id) {
			continue;
		}

		const pass = entry.pass === null || typeof entry.pass === "boolean" ? entry.pass : null;
		result.set(id, {
			pass,
			notes: asStringArray(entry.notes),
		});
	}

	return result;
}

function normalizeHypotheses(
	reportHypotheses: unknown,
	hypothesisCards: IosmHypothesisCard[],
): IosmHypothesisOutcome[] {
	const existingState = parseExistingHypothesisState(reportHypotheses);
	return hypothesisCards.map((hypothesis) => {
		const state = existingState.get(hypothesis.id);
		return {
			...hypothesis,
			pass: state?.pass ?? null,
			notes: state?.notes ?? [],
		};
	});
}

function normalizePhaseReport(value: unknown, phase: IosmPhase): IosmPhaseReport {
	const object = isPlainObject(value) ? value : {};
	return {
		phase,
		gate: asString(object.gate) ?? IOSM_PHASE_GATES[phase],
		status:
			asString(object.status) === "passed" ||
			asString(object.status) === "failed" ||
			asString(object.status) === "waived"
				? (asString(object.status) as IosmPhaseReport["status"])
				: "pending",
		pass: object.pass === null || typeof object.pass === "boolean" ? object.pass : null,
		inputs: asStringArray(object.inputs),
		actions_taken: asStringArray(object.actions_taken),
		outputs: asStringArray(object.outputs),
		linked_hypotheses: asStringArray(object.linked_hypotheses),
		gate_measurements: isPlainObject(object.gate_measurements) ? object.gate_measurements : {},
	};
}

function loadPhaseReports(rootDir: string, cycleId: string): Record<IosmPhase, IosmPhaseReport> {
	return Object.fromEntries(
		IOSM_PHASES.map((phase) => {
			const path = getIosmPhaseReportPath(cycleId, phase, rootDir);
			if (!existsSync(path)) {
				return [phase, createPhaseReport(phase)];
			}
			return [phase, normalizePhaseReport(readJson<unknown>(path), phase)];
		}),
	) as Record<IosmPhase, IosmPhaseReport>;
}

function deriveGateResults(
	phaseReports: Record<IosmPhase, IosmPhaseReport>,
	existingGates: unknown,
): Record<"gate_I" | "gate_O" | "gate_S" | "gate_M", IosmGateResult> {
	const object = isPlainObject(existingGates) ? existingGates : {};
	const results = createGateResults();
	for (const phase of IOSM_PHASES) {
		const gate = IOSM_PHASE_GATES[phase];
		const existing = isPlainObject(object[gate]) ? object[gate] : {};
		const phaseReport = phaseReports[phase];
		results[gate] = {
			pass: phaseReport.pass,
			waived: asBoolean(existing.waived) ?? phaseReport.status === "waived",
			status: phaseReport.status,
		};
	}
	return results;
}

function derivePhasePointers(
	rootDir: string,
	cycleId: string,
	phaseReports: Record<IosmPhase, IosmPhaseReport>,
): Record<IosmPhase, IosmPhasePointer> {
	return Object.fromEntries(
		IOSM_PHASES.map((phase) => [
			phase,
			{
				path: getIosmPhaseReportPath(cycleId, phase, rootDir),
				gate: IOSM_PHASE_GATES[phase],
				status: phaseReports[phase].status,
				pass: phaseReports[phase].pass,
			},
		]),
	) as Record<IosmPhase, IosmPhasePointer>;
}

function loadBaselineMetrics(rootDir: string, cycleId: string, config: IosmConfig): IosmMetricRecord<number | null> {
	const path = getIosmBaselineReportPath(cycleId, rootDir);
	if (!existsSync(path)) {
		return createMetricRecord(() => null);
	}

	const baseline = readJson<IosmBaselineReport>(path);
	const storedMetrics = normalizeMetricNumbers(baseline.baseline_metrics?.values, null);
	const computedMetrics = calculateIosmMetricsFromRawMeasurements(
		baseline.baseline_metrics?.raw_measurements ?? {},
		config,
	);
	return mergeMetricValues(storedMetrics, computedMetrics);
}

function hasBlockingFailure(report: IosmCycleReport): boolean {
	return Object.values(report.gates).some((gate) => gate.pass === false && !gate.waived);
}

function hasActiveBlockingWaivers(waivers: Array<Record<string, unknown>>): boolean {
	return waivers.some((waiver) => {
		if (!isPlainObject(waiver)) {
			return false;
		}
		const status = asString(waiver.status);
		if (!status) {
			return true;
		}
		return status !== "expired" && status !== "closed" && status !== "resolved";
	});
}

function hasActiveBlockingWaiver(report: IosmCycleReport): boolean {
	return hasActiveBlockingWaivers(report.waivers);
}

function metricFloorsMet(
	metrics: IosmMetricRecord<number>,
	stabilization: IosmConfig["iosm"]["cycle_policy"]["stabilization"],
): boolean {
	for (const metric of IOSM_METRICS) {
		if (metrics[metric] < stabilization.global_metric_floor) {
			return false;
		}
		const specificFloor = stabilization.metric_floors[metric];
		if (specificFloor !== undefined && metrics[metric] < specificFloor) {
			return false;
		}
	}
	return true;
}

function evidenceThresholdsMet(
	confidences: IosmMetricRecord<number>,
	minimums: IosmMetricRecord<number>,
): boolean {
	return IOSM_METRICS.every((metric) => confidences[metric] >= minimums[metric]);
}

function hasTierAWindow(entries: IosmMetricsHistoryEntry[], metrics: IosmMetric[]): boolean {
	return entries.some((entry) => metrics.every((metric) => entry.metric_tiers[metric] === "A"));
}

function hasExcessUnexplainedDrift(entries: IosmMetricsHistoryEntry[], maxConsecutiveDeclines: number): boolean {
	for (const metric of IOSM_METRICS) {
		let streak = 0;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.metric_deltas[metric] < 0 && !entry.decline_coverage[metric]) {
				streak += 1;
				continue;
			}
			break;
		}
		if (streak > maxConsecutiveDeclines) {
			return true;
		}
	}
	return false;
}

function readMetricsHistoryEntries(rootDir: string): IosmMetricsHistoryEntry[] {
	const historyPath = getIosmMetricsHistoryPath(rootDir);
	if (!existsSync(historyPath)) {
		return [];
	}

	return readFileSync(historyPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as IosmMetricsHistoryEntry];
			} catch {
				return [];
			}
		});
}

function writeMetricsHistoryEntries(rootDir: string, entries: IosmMetricsHistoryEntry[]): void {
	const historyPath = getIosmMetricsHistoryPath(rootDir);
	const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(historyPath, contents.length > 0 ? `${contents}\n` : "", "utf8");
}

function toHistoryEntry(report: IosmCycleReport): IosmMetricsHistoryEntry | null {
	if (
		!hasCompleteNumericMetricRecord(report.metrics) ||
		!hasCompleteNumericMetricRecord(report.metric_confidences) ||
		!hasCompleteTierMetricRecord(report.metric_tiers) ||
		!hasCompleteNumericMetricRecord(report.metric_deltas) ||
		report.iosm_index === null ||
		report.decision_confidence === null
	) {
		return null;
	}

	return {
		cycle_id: report.cycle_id,
		recorded_at: new Date().toISOString(),
		status: report.status,
		metrics: report.metrics,
		metric_confidences: report.metric_confidences,
		metric_tiers: report.metric_tiers,
		metric_deltas: report.metric_deltas,
		decline_coverage: report.decline_coverage,
		iosm_index: report.iosm_index,
		decision_confidence: report.decision_confidence,
		has_blocking_failure: hasBlockingFailure(report),
		has_guardrail_violation: report.guardrails.pass === false,
		has_active_blocking_waiver: hasActiveBlockingWaiver(report),
		incomplete: report.incomplete,
	};
}

function deriveDecision(
	report: IosmCycleReport,
	config: IosmConfig,
	historyEntries: IosmMetricsHistoryEntry[],
): IosmDecision {
	if (report.status === "failed" || hasBlockingFailure(report) || report.guardrails.pass === false) {
		return "FAIL";
	}

	if (config.iosm.metadata.criticality_profile === "exploratory") {
		return "CONTINUE";
	}

	if (
		report.incomplete ||
		!hasCompleteNumericMetricRecord(report.metrics) ||
		!hasCompleteNumericMetricRecord(report.metric_confidences) ||
		!hasCompleteTierMetricRecord(report.metric_tiers) ||
		report.iosm_index === null ||
		report.decision_confidence === null
	) {
		return "CONTINUE";
	}

	if (report.decision_confidence < config.iosm.evidence.min_decision_confidence) {
		return "CONTINUE";
	}

	if (!metricFloorsMet(report.metrics, config.iosm.cycle_policy.stabilization)) {
		return "CONTINUE";
	}

	if (!evidenceThresholdsMet(report.metric_confidences, config.iosm.evidence.min_metric_confidence)) {
		return "CONTINUE";
	}

	if (hasActiveBlockingWaiver(report)) {
		return "CONTINUE";
	}

	const currentEntry = toHistoryEntry(report);
	if (!currentEntry) {
		return "CONTINUE";
	}

	const relevantHistory = historyEntries.filter((entry) => entry.cycle_id !== report.cycle_id);
	const combined = [...relevantHistory, currentEntry];
	if (
		hasExcessUnexplainedDrift(
			combined,
			config.iosm.cycle_policy.stabilization.max_consecutive_unexplained_declines,
		)
	) {
		return "CONTINUE";
	}

	const recent = combined.slice(-config.iosm.cycle_policy.stabilization.consecutive_cycles);
	if (recent.length < config.iosm.cycle_policy.stabilization.consecutive_cycles) {
		return "CONTINUE";
	}

	if (
		recent.some(
			(entry) =>
				entry.has_blocking_failure ||
				entry.has_guardrail_violation ||
				entry.has_active_blocking_waiver ||
				entry.incomplete ||
				!metricFloorsMet(entry.metrics, config.iosm.cycle_policy.stabilization),
		)
	) {
		return "CONTINUE";
	}

	if (
		config.iosm.metadata.criticality_profile === "critical" &&
		!hasTierAWindow(recent, ["logic", "performance"])
	) {
		return "CONTINUE";
	}

	if (recent.every((entry) => entry.iosm_index >= config.iosm.cycle_policy.stabilization.target_index)) {
		return "STOP";
	}

	return "CONTINUE";
}

function hydrateCycleReport(rootDir: string, cycleId: string, config: IosmConfig): IosmCycleReport {
	const reportPath = getIosmCycleReportPath(cycleId, rootDir);
	if (!existsSync(reportPath)) {
		throw new Error(`Missing cycle report for ${cycleId}: ${reportPath}`);
	}

	const rawReport = readJson<unknown>(reportPath);
	const reportObject = isPlainObject(rawReport) ? rawReport : {};
	const goals = asStringArray(reportObject.goals);
	const hypothesisCards = existsSync(getIosmHypothesesPath(cycleId, rootDir))
		? readJson<IosmHypothesisCard[]>(getIosmHypothesesPath(cycleId, rootDir))
		: [];
	const hypotheses = normalizeHypotheses(reportObject.hypotheses, hypothesisCards);
	const cycleScope = normalizeCycleScope(reportObject.cycle_scope);
	const phaseReports = loadPhaseReports(rootDir, cycleId);
	const gates = deriveGateResults(phaseReports, reportObject.gates);
	const phasePointers = derivePhasePointers(rootDir, cycleId, phaseReports);
	const metrics = mergeMetricValues(
		normalizeMetricNumbers(reportObject.metrics, null),
		calculateIosmMetricsFromRawMeasurements(
			isPlainObject(reportObject.raw_measurements) ? reportObject.raw_measurements : {},
			config,
		),
	);
	const metricConfidences = normalizeMetricNumbers(reportObject.metric_confidences, null);
	const metricTiers = normalizeMetricTiers(reportObject.metric_tiers);
	const baselineMetrics = loadBaselineMetrics(rootDir, cycleId, config);
	const cycleCapacity = createCycleCapacity(goals, cycleScope, hypothesisCards, config.iosm.cycle_capacity);
	const effectiveBudget = buildCycleBudget(config.iosm.guardrails.max_negative_delta, hypothesisCards);
	const waivers = Array.isArray(reportObject.waivers) ? reportObject.waivers.filter(isPlainObject) : [];
	const metricDeltas = mergeMetricValues(
		normalizeMetricNumbers(reportObject.metric_deltas, null),
		calculateMetricDeltas(baselineMetrics, metrics),
	);
	const declineCoverage =
		hasCompleteNumericMetricRecord(baselineMetrics) && hasCompleteNumericMetricRecord(metrics)
			? assessDeclineCoverage(baselineMetrics, metrics, hypothesisCards, hasActiveBlockingWaivers(waivers))
			: normalizeMetricBooleans(reportObject.decline_coverage, true);
	const guardrailResult = validateGuardrails(baselineMetrics, metrics, effectiveBudget);
	const historyEntries = readMetricsHistoryEntries(rootDir);

	const report: IosmCycleReport = {
		cycle_id: cycleId,
		status:
			asString(reportObject.status) === "active" ||
			asString(reportObject.status) === "completed" ||
			asString(reportObject.status) === "failed"
				? (asString(reportObject.status) as IosmCycleReport["status"])
				: "planned",
		system: asString(reportObject.system) ?? config.iosm.metadata.system_name,
		scope: asString(reportObject.scope) ?? config.iosm.metadata.scope,
		criticality_profile:
			asString(reportObject.criticality_profile) ?? config.iosm.metadata.criticality_profile,
		delivery_boundary:
			asString(reportObject.delivery_boundary) ?? config.iosm.metadata.delivery_boundary,
		cycle_scope: cycleScope,
		cycle_capacity: cycleCapacity,
		window: asString(reportObject.window) ?? "",
		goals,
		hypotheses,
		hypothesis_interactions:
			isPlainObject(reportObject.hypothesis_interactions)
				? {
						pass: asBoolean(reportObject.hypothesis_interactions.pass) ?? buildHypothesisInteractions(hypothesisCards).pass,
						conflicts: Array.isArray(reportObject.hypothesis_interactions.conflicts)
							? reportObject.hypothesis_interactions.conflicts.filter(isPlainObject)
							: buildHypothesisInteractions(hypothesisCards).conflicts,
					}
				: buildHypothesisInteractions(hypothesisCards),
		phase_reports: phasePointers,
		gates,
		metrics,
		metric_confidences: metricConfidences,
		metric_tiers: metricTiers,
		raw_measurements: isPlainObject(reportObject.raw_measurements) ? reportObject.raw_measurements : {},
		guardrails: {
			pass:
				guardrailResult.pass ??
				(isPlainObject(reportObject.guardrails) ? (asBoolean(reportObject.guardrails.pass) ?? null) : null),
			effective_budget: effectiveBudget,
			violations:
				guardrailResult.pass !== null
					? guardrailResult.violations
					: (() => {
							const rawViolations = isPlainObject(reportObject.guardrails) ? reportObject.guardrails.violations : undefined;
							if (!Array.isArray(rawViolations)) {
								return [];
							}
							return rawViolations.filter(isPlainObject).flatMap((entry) => {
								const metric = asString(entry.metric);
								const negativeDelta = asNumber(entry.negative_delta);
								const budget = asNumber(entry.budget);
								if (
									(metric !== "semantic" &&
										metric !== "logic" &&
										metric !== "performance" &&
										metric !== "simplicity" &&
										metric !== "modularity" &&
										metric !== "flow") ||
									negativeDelta === undefined ||
									budget === undefined
								) {
									return [];
								}
								return [
									{
										metric,
										negative_delta: negativeDelta,
										budget,
									} satisfies IosmGuardrailViolation,
								];
							});
						})(),
		},
		metric_deltas: metricDeltas,
		decline_coverage: declineCoverage,
		iosm_index:
			calculateIosmIndex(metrics, config.iosm.index.weights) ??
			(asNumber(reportObject.iosm_index) ?? null),
		decision_confidence:
			calculateDecisionConfidence(metricConfidences, config.iosm.index.weights) ??
			(asNumber(reportObject.decision_confidence) ?? null),
		waivers,
		automation_actors: Array.isArray(reportObject.automation_actors)
			? reportObject.automation_actors.filter(isPlainObject).map((entry) => ({
					type: asString(entry.type) ?? "unknown",
					role: asString(entry.role) ?? "observer",
					identity: asString(entry.identity),
					provenance: asString(entry.provenance),
				}))
			: [{ type: "agent", role: "analyst", identity: "iosm-cli" }],
		approval_path: Array.isArray(reportObject.approval_path)
			? reportObject.approval_path.filter(isPlainObject).map((entry) => ({
					action: asString(entry.action) ?? "unspecified",
					required: asBoolean(entry.required) ?? false,
					approved_by: asString(entry.approved_by),
					approved_at: asString(entry.approved_at),
					notes: asString(entry.notes),
				}))
			: [],
		anti_patterns: Array.isArray(reportObject.anti_patterns)
			? reportObject.anti_patterns.filter(isPlainObject)
			: [],
		learning_artifacts: asStringArray(reportObject.learning_artifacts),
		incomplete: true,
		decision: "CONTINUE",
	};

	report.incomplete =
		!hasCompleteNumericMetricRecord(report.metrics) ||
		!hasCompleteNumericMetricRecord(report.metric_confidences) ||
		!hasCompleteTierMetricRecord(report.metric_tiers) ||
		report.window.length === 0;
	report.decision = deriveDecision(report, config, historyEntries);
	return report;
}

function resolveCycleId(rootDir: string, cycleId?: string): string {
	const cyclesDir = getIosmCyclesDir(rootDir);
	if (!existsSync(cyclesDir)) {
		throw new Error(`No cycles found in ${cyclesDir}.`);
	}

	const entries = readdirSync(cyclesDir)
		.filter((entry) => entry !== ".gitkeep")
		.sort();

	if (entries.length === 0) {
		throw new Error(`No cycles found in ${cyclesDir}.`);
	}

	if (!cycleId) {
		return entries[entries.length - 1];
	}

	const exactMatch = entries.find((entry) => entry === cycleId);
	if (exactMatch) {
		return exactMatch;
	}

	const prefixMatches = entries.filter((entry) => entry.startsWith(cycleId));
	if (prefixMatches.length === 1) {
		return prefixMatches[0];
	}
	if (prefixMatches.length > 1) {
		throw new Error(`Cycle id "${cycleId}" is ambiguous: ${prefixMatches.join(", ")}`);
	}

	throw new Error(`Cycle "${cycleId}" not found.`);
}

export function planIosmCycle(options: PlanIosmCycleOptions): PlannedIosmCycle {
	const { rootDir, config } = loadIosmConfig(options.cwd ?? process.cwd());

	if (options.goals.length === 0) {
		throw new Error("At least one goal is required. Example: iosm cycle plan \"reduce latency\"");
	}

	if (options.goals.length > config.iosm.cycle_capacity.max_goals) {
		throw new Error(
			`Goal count ${options.goals.length} exceeds iosm.cycle_capacity.max_goals=${config.iosm.cycle_capacity.max_goals}. Reduce the plan before starting a cycle.`,
		);
	}

	const cycleId = options.cycleId ?? nextCycleId(rootDir);
	const cycleDir = getIosmCycleDir(cycleId, rootDir);
	const force = options.force ?? false;

	if (existsSync(cycleDir) && !force) {
		throw new Error(`Cycle ${cycleId} already exists. Use --force to overwrite its scaffold.`);
	}

	mkdirSync(cycleDir, { recursive: true });
	mkdirSync(getIosmPhaseReportsDir(cycleId, rootDir), { recursive: true });

	const hypotheses = createHypotheses(options.goals, config);
	const report = createCycleReport(rootDir, cycleId, options.goals, hypotheses, config);
	if (!report.cycle_capacity.pass) {
		throw new Error(
			`Cycle ${cycleId} exceeds configured capacity. Reduce goals or scope before planning.`,
		);
	}

	const interactions = buildHypothesisInteractions(hypotheses);
	if (!interactions.pass) {
		throw new Error(`Hypothesis interactions are not safe: ${JSON.stringify(interactions.conflicts)}`);
	}

	const baselineReport = createBaselineReport(rootDir, cycleId, config, report.cycle_scope);

	writeScaffoldFile(getIosmBaselineReportPath(cycleId, rootDir), baselineReport, force);
	writeScaffoldFile(getIosmHypothesesPath(cycleId, rootDir), hypotheses, force);
	writeScaffoldFile(getIosmCycleReportPath(cycleId, rootDir), report, force);

	for (const phase of IOSM_PHASES) {
		writeScaffoldFile(getIosmPhaseReportPath(cycleId, phase, rootDir), createPhaseReport(phase), force);
	}

	return {
		cycleId,
		cycleDir,
		reportPath: getIosmCycleReportPath(cycleId, rootDir),
		baselineReportPath: getIosmBaselineReportPath(cycleId, rootDir),
		hypothesesPath: getIosmHypothesesPath(cycleId, rootDir),
	};
}

export function listIosmCycles(cwd: string = process.cwd()): IosmCycleListItem[] {
	const rootDir = resolveIosmRootDir(cwd);
	const { config } = loadIosmConfig(rootDir);
	const cyclesDir = getIosmCyclesDir(rootDir);
	if (!existsSync(cyclesDir)) {
		return [];
	}

	return readdirSync(cyclesDir)
		.filter((entry) => entry !== ".gitkeep")
		.sort((left, right) => right.localeCompare(left))
		.map((cycleId) => {
			const reportPath = getIosmCycleReportPath(cycleId, rootDir);
			if (!existsSync(reportPath)) {
				return {
					cycleId,
					path: getIosmCycleDir(cycleId, rootDir),
					status: "unknown",
					goals: [],
					decision: "unknown",
				};
			}

			const report = hydrateCycleReport(rootDir, cycleId, config);
			return {
				cycleId,
				path: getIosmCycleDir(cycleId, rootDir),
				status: report.status,
				goals: report.goals,
				decision: report.decision,
			};
		});
}

/**
 * Async variant of listIosmCycles that hydrates all cycle reports in parallel.
 * Significantly faster than the synchronous version when many cycles exist.
 */
export async function listIosmCyclesAsync(cwd: string = process.cwd()): Promise<IosmCycleListItem[]> {
	const rootDir = resolveIosmRootDir(cwd);
	const { config } = loadIosmConfig(rootDir);
	const cyclesDir = getIosmCyclesDir(rootDir);
	if (!existsSync(cyclesDir)) {
		return [];
	}

	const cycleIds = readdirSync(cyclesDir)
		.filter((entry) => entry !== ".gitkeep")
		.sort((left, right) => right.localeCompare(left));

	return Promise.all(
		cycleIds.map(async (cycleId): Promise<IosmCycleListItem> => {
			const reportPath = getIosmCycleReportPath(cycleId, rootDir);
			if (!existsSync(reportPath)) {
				return {
					cycleId,
					path: getIosmCycleDir(cycleId, rootDir),
					status: "unknown",
					goals: [],
					decision: "unknown",
				};
			}
			// hydrateCycleReport is sync CPU-bound but I/O is already in the OS cache
			// after the readdirSync above; Promise.all still de-serialises JS execution
			const report = hydrateCycleReport(rootDir, cycleId, config);
			return {
				cycleId,
				path: getIosmCycleDir(cycleId, rootDir),
				status: report.status,
				goals: report.goals,
				decision: report.decision,
			};
		}),
	);
}

export function readIosmCycleReport(cwd: string = process.cwd(), cycleId?: string): IosmCycleReport {
	const { rootDir, config } = loadIosmConfig(cwd);
	const resolvedCycleId = resolveCycleId(rootDir, cycleId);
	return hydrateCycleReport(rootDir, resolvedCycleId, config);
}

export function inspectIosmCycle(cwd: string = process.cwd(), cycleId?: string): IosmCycleStatus {
	const { rootDir } = loadIosmConfig(cwd);
	const resolvedCycleId = resolveCycleId(rootDir, cycleId);
	const report = readIosmCycleReport(rootDir, resolvedCycleId);
	const warnings: string[] = [];
	const blockingIssues: string[] = [];

	if (!existsSync(getIosmBaselineReportPath(resolvedCycleId, rootDir))) {
		blockingIssues.push("Baseline Report is missing.");
	}

	if (!existsSync(getIosmHypothesesPath(resolvedCycleId, rootDir))) {
		blockingIssues.push("Hypothesis Card Set is missing.");
	}

	for (const phase of IOSM_PHASES) {
		if (!existsSync(getIosmPhaseReportPath(resolvedCycleId, phase, rootDir))) {
			blockingIssues.push(`Phase report is missing for ${phase}.`);
		}
	}

	if (countScopeItems(report.cycle_scope) === 0) {
		blockingIssues.push("Cycle Scope is empty.");
	}

	if (!report.cycle_capacity.pass) {
		blockingIssues.push("Cycle exceeds configured capacity.");
	}

	if (!report.hypothesis_interactions.pass) {
		blockingIssues.push("Hypothesis interactions are not resolved.");
	}

	if (report.guardrails.pass === false) {
		blockingIssues.push("Guardrails are violated.");
	}

	if (hasBlockingFailure(report)) {
		blockingIssues.push("One or more quality gates failed without waiver.");
	}

	const learningClosed = report.learning_artifacts.length > 0;
	if (!learningClosed) {
		warnings.push("Learning closure is still empty.");
	}

	const historyRecorded = readMetricsHistoryEntries(rootDir).some((entry) => entry.cycle_id === report.cycle_id);
	if (report.status === "completed" && !historyRecorded) {
		warnings.push("Metrics history does not contain this completed cycle.");
	}

	if (report.incomplete) {
		warnings.push("Report is incomplete: metrics, confidences, tiers, or observation window are missing.");
	}

	return {
		cycleId: resolvedCycleId,
		rootDir,
		reportPath: getIosmCycleReportPath(resolvedCycleId, rootDir),
		status: report.status,
		decision: report.decision,
		reportComplete: !report.incomplete && blockingIssues.length === 0,
		learningClosed,
		historyRecorded,
		capacityPass: report.cycle_capacity.pass,
		guardrailsPass: report.guardrails.pass,
		blockingIssues,
		warnings,
	};
}

export function recordIosmCycleHistory(
	cwd: string = process.cwd(),
	cycleId?: string,
): IosmCycleHistoryRecordResult {
	const { rootDir } = loadIosmConfig(cwd);
	const report = readIosmCycleReport(rootDir, cycleId);
	const entry = toHistoryEntry(report);
	if (!entry) {
		throw new Error(
			`Cycle ${report.cycle_id} is incomplete. Metrics, confidences, tiers, IOSM-Index, and decision confidence must be present before recording history.`,
		);
	}

	const existingEntries = readMetricsHistoryEntries(rootDir);
	const replaced = existingEntries.some((existingEntry) => existingEntry.cycle_id === entry.cycle_id);
	const nextEntries = [...existingEntries.filter((existingEntry) => existingEntry.cycle_id !== entry.cycle_id), entry].sort(
		(left, right) => left.cycle_id.localeCompare(right.cycle_id),
	);
	writeMetricsHistoryEntries(rootDir, nextEntries);

	return {
		cycleId: entry.cycle_id,
		historyPath: getIosmMetricsHistoryPath(rootDir),
		replaced,
	};
}
