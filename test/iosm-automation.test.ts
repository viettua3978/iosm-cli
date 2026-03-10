import { describe, expect, it } from "vitest";
import {
	buildIosmAutomationPrompt,
	evaluateIosmAutomationProgress,
	hasReachedIosmTarget,
	resolveIosmAutomationSettings,
} from "../src/iosm/automation.js";
import type { IosmConfig } from "../src/iosm/config.js";

const config: IosmConfig = {
	iosm: {
		metadata: {
			system_name: "demo",
			scope: "repository",
			criticality_profile: "standard",
			delivery_boundary: "demo",
		},
		planning: {
			use_economic_decision: true,
			prioritization_formula: "wsjf_confidence",
			min_confidence: 0.7,
			hypothesis_required: true,
			cycle_scope_required: true,
		},
		cycle_capacity: {
			max_goals: 3,
			max_scope_items: 5,
			max_expected_change_surface: 3,
		},
		cycle_policy: {
			max_iterations_per_phase: 2,
			stabilization: {
				target_index: 0.91,
				consecutive_cycles: 3,
				global_metric_floor: 0.6,
				max_consecutive_unexplained_declines: 2,
				metric_floors: {
					logic: 0.9,
				},
			},
		},
		quality_gates: {
			gate_I: { semantic_min: 0.95, logical_consistency_min: 1, duplication_max: 0.05 },
			gate_O: {
				latency_ms: { p50_max: 60, p95_max: 150, p99_max: 250 },
				error_budget_respected: true,
				chaos_pass_rate_min: 1,
			},
			gate_S: {
				at_least_one_dimension: true,
				api_surface_reduction_min: 0.2,
				dependency_hygiene_min: 0.95,
				onboarding_time_minutes_max: 15,
				regression_budget_max: 0,
			},
			gate_M: {
				change_surface_max: 3,
				coupling_max: 0.2,
				cohesion_min: 0.8,
				contracts_pass: true,
			},
		},
		guardrails: {
			max_negative_delta: {
				semantic: 0.02,
				logic: 0,
				performance: 0.03,
				simplicity: 0.03,
				modularity: 0.02,
				flow: 0.02,
			},
		},
		evidence: {
			min_decision_confidence: 0.8,
			freshness_sla_hours: { tier_a: 24, tier_b: 168 },
			min_metric_confidence: {
				semantic: 0.7,
				logic: 0.9,
				performance: 0.9,
				simplicity: 0.7,
				modularity: 0.7,
				flow: 0.8,
			},
		},
		waivers: {
			max_duration_days: 14,
			require_human_approval: true,
		},
		metric_targets: {
			semantic: { glossary_coverage_min: 0.95, naming_consistency_min: 0.95, ambiguity_ratio_max: 0.05 },
			logic: { invariant_pass_rate_min: 1 },
			performance: { latency_ms: { p50_max: 60, p95_max: 150, p99_max: 250 } },
			simplicity: { onboarding_time_minutes_max: 15 },
			modularity: { change_surface_max: 3 },
			flow: {
				lead_time_hours_max: 24,
				deploy_frequency_per_week_min: 5,
				change_failure_rate_max: 0.15,
				review_latency_hours_max: 24,
			},
		},
		index: {
			weights: {
				semantic: 0.15,
				logic: 0.2,
				performance: 0.25,
				simplicity: 0.15,
				modularity: 0.15,
				flow: 0.1,
			},
		},
		automation: {
			allow_agents: true,
			human_approval_required_for: ["waivers"],
		},
		reporting: {
			persist_history: true,
			output_format: "json",
		},
		learning: {
			update_pattern_library: true,
			update_decision_log: true,
			update_glossary: true,
		},
	},
};

describe("iosm automation helpers", () => {
	it("uses config defaults for target index and total iteration budget", () => {
		const settings = resolveIosmAutomationSettings(config);

		expect(settings.targetIndex).toBe(0.91);
		expect(settings.maxIterations).toBe(8);
	});

	it("allows explicit target and iteration overrides", () => {
		const settings = resolveIosmAutomationSettings(config, {
			targetIndex: 0.83,
			maxIterations: 5,
		});

		expect(settings.targetIndex).toBe(0.83);
		expect(settings.maxIterations).toBe(5);
	});

	it("treats null iosm index as not reached", () => {
		expect(hasReachedIosmTarget({ iosm_index: null }, 0.8)).toBe(false);
		expect(hasReachedIosmTarget({ iosm_index: 0.79 }, 0.8)).toBe(false);
		expect(hasReachedIosmTarget({ iosm_index: 0.8 }, 0.8)).toBe(true);
	});

	it("separates explicit threshold progress from stabilization decisions", () => {
		expect(
			evaluateIosmAutomationProgress({
				snapshot: { iosm_index: 0.84 },
				targetIndex: 0.83,
				cycleDecision: "CONTINUE",
				explicitTarget: true,
			}),
		).toEqual({
			targetSatisfied: true,
			stabilized: false,
			failed: false,
		});

		expect(
			evaluateIosmAutomationProgress({
				snapshot: { iosm_index: 0.95 },
				targetIndex: 0.91,
				cycleDecision: "CONTINUE",
				explicitTarget: false,
			}),
		).toEqual({
			targetSatisfied: false,
			stabilized: false,
			failed: false,
		});

		expect(
			evaluateIosmAutomationProgress({
				snapshot: { iosm_index: 0.95 },
				targetIndex: 0.91,
				cycleDecision: "STOP",
				explicitTarget: false,
			}),
		).toEqual({
			targetSatisfied: false,
			stabilized: true,
			failed: false,
		});

		expect(
			evaluateIosmAutomationProgress({
				snapshot: { iosm_index: 0.5 },
				targetIndex: 0.91,
				cycleDecision: "FAIL",
				explicitTarget: true,
			}),
		).toEqual({
			targetSatisfied: false,
			stabilized: false,
			failed: true,
		});
	});

	it("builds an IOSM automation prompt with priorities and guardrails", () => {
		const prompt = buildIosmAutomationPrompt({
			rootDir: "/repo",
			cycleId: "iosm-2026-03-07-001",
			targetIndex: 0.83,
			iteration: 2,
			maxIterations: 8,
			currentDecision: "CONTINUE",
			snapshot: {
				metrics: {
					semantic: 0.7,
					logic: 0.62,
					performance: 0.58,
					simplicity: 0.66,
					modularity: 0.73,
					flow: 0.55,
				},
				iosm_index: 0.64,
				decision_confidence: 0.71,
			},
			goals: ["Increase invariant confidence", "Reduce latency drift"],
			criticalityProfile: "critical",
			approvalRequirements: ["public_contract_changes", "waivers"],
			priorities: [
				{
					metric: "flow",
					value: 0.55,
					title: "Flow",
					action: "Reduce review latency.",
				},
			],
		});

		expect(prompt).toContain("Target IOSM index: 0.830");
		expect(prompt).toContain("Iteration: 2/8");
		expect(prompt).toContain("Flow (0.550): Reduce review latency.");
		expect(prompt).toContain("Criticality profile: critical");
		expect(prompt).toContain("public_contract_changes");
		expect(prompt).toContain("Do not run /init");
		expect(prompt).toContain("call ask_user with concise options");
		expect(prompt).toContain("obtain explicit approval");
		expect(prompt).toContain("automation actor provenance");
		expect(prompt).toContain("Remaining bottleneck.");
	});
});
