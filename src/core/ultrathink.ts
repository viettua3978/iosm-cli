import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { parseCommandArgs } from "./prompt-templates.js";

export const ULTRATHINK_COMMAND = "ultrathink";
export const ULTRATHINK_DEFAULT_ITERATIONS = 5;
export const ULTRATHINK_MAX_ITERATIONS = 12;
export const ULTRATHINK_MAX_CHECKPOINT_CHARS = 2200;
export const ULTRATHINK_MAX_CONTEXT_MESSAGES = 8;
export const ULTRATHINK_MAX_CONTEXT_MESSAGE_CHARS = 260;
export const ULTRATHINK_MAX_EVIDENCE_ENTRIES = 12;
export const ULTRATHINK_VISIBLE_PROMPT_PREFIX = "Ultrathink iteration";
export const ULTRATHINK_NO_NEW_EVIDENCE_MARKER = "[NO_NEW_EVIDENCE_OK]";
export const ULTRATHINK_STAGNATION_LIMIT = 2;
export const ULTRATHINK_MAX_ITERATION_INPUT_TOKENS = 50000;
export const ULTRATHINK_MAX_RUN_INPUT_TOKENS = 180000;
export const ULTRATHINK_MAX_RUN_TOTAL_TOKENS = 220000;
export const ULTRATHINK_MAX_RUN_COST = 0.03;

const CHECKPOINT_SECTIONS = [
	"Goal",
	"Verified Facts",
	"Rejected Hypotheses",
	"Open Questions",
	"Next Checks",
] as const;

const LIST_SECTION_PLACEHOLDERS: Record<(typeof CHECKPOINT_SECTIONS)[number], string> = {
	Goal: "Refine the objective based on discovered constraints.",
	"Verified Facts": "(none yet)",
	"Rejected Hypotheses": "(none yet)",
	"Open Questions": "(none yet)",
	"Next Checks": "Continue analysis with read-only evidence gathering.",
};

const ULTRATHINK_INTERNAL_MARKER = "[ULTRATHINK INTERNAL]";

const ULTRATHINK_READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"rg",
	"fd",
	"ast_grep",
	"comby",
	"jq",
	"yq",
	"semgrep",
	"sed",
	"semantic_search",
	"fetch",
	"web_search",
	"git_read",
	"todo_read",
]);

export interface UltrathinkCommandConfig {
	iterations: number;
	query?: string;
}

export interface UltrathinkToolEvidence {
	toolCallId: string;
	toolName: string;
	summary: string;
}

export interface UltrathinkEvidencePolicyResult {
	hasNumericClaims: boolean;
	hasEvidenceTags: boolean;
	invalidEvidenceTags: string[];
	missingEvidenceForNumbers: boolean;
	needsNoNewEvidenceMarker: boolean;
	hasNoNewEvidenceMarker: boolean;
}

export interface UltrathinkToolGroundingPolicyInput {
	phase: UltrathinkPhase;
	cumulativeEvidenceCount: number;
	toolChecksThisIteration: number;
}

export type UltrathinkCommandParseResult =
	| { kind: "command"; command: UltrathinkCommandConfig }
	| { kind: "error"; error: string; usage: string };

export const ULTRATHINK_USAGE = [
	"Usage:",
	"  /ultrathink",
	"  /ultrathink <query>",
	"  /ultrathink -q <1..12> <query>",
	"  /ultrathink --iterations <1..12> <query>",
	"",
	"Examples:",
	"  /ultrathink -q 7 audit auth architecture",
	"  /ultrathink --iterations 5",
].join("\n");

export type UltrathinkPhase = "Recon" | "Critique" | "Verify" | "Synthesis";

export const ULTRATHINK_CHECKPOINT_COMPRESSION_SYSTEM_PROMPT = [
	"You compress ultrathink checkpoints for iterative reasoning.",
	"Output must be plain text with the exact section names:",
	"Goal:",
	"Verified Facts:",
	"Rejected Hypotheses:",
	"Open Questions:",
	"Next Checks:",
	"Keep only decision-critical details. Preserve concrete file paths, command outputs, and constraints.",
	"Do not add markdown headings, XML tags, or extra commentary.",
].join("\n");

export function parseUltrathinkCommand(text: string): UltrathinkCommandParseResult | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith(`/${ULTRATHINK_COMMAND}`)) return undefined;
	if (!new RegExp(`^/${ULTRATHINK_COMMAND}(?:\\s|$)`).test(trimmed)) return undefined;

	const argsText = trimmed.slice(ULTRATHINK_COMMAND.length + 1).trim();
	const tokens = argsText ? parseCommandArgs(argsText) : [];
	let iterations = ULTRATHINK_DEFAULT_ITERATIONS;
	let query: string | undefined;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (token === "--") {
			query = tokens.slice(index + 1).join(" ").trim() || undefined;
			break;
		}

		if (token === "-q" || token === "--iterations") {
			const value = tokens[index + 1];
			if (!value) {
				return {
					kind: "error",
					error: `Missing value for ${token}.`,
					usage: ULTRATHINK_USAGE,
				};
			}
			const parsed = parseIterations(value);
			if (!parsed.ok) {
				return {
					kind: "error",
					error: parsed.error,
					usage: ULTRATHINK_USAGE,
				};
			}
			iterations = parsed.value;
			index += 1;
			continue;
		}

		if (token.startsWith("-q=")) {
			const value = token.slice(3);
			const parsed = parseIterations(value);
			if (!parsed.ok) {
				return {
					kind: "error",
					error: parsed.error,
					usage: ULTRATHINK_USAGE,
				};
			}
			iterations = parsed.value;
			continue;
		}

		if (token.startsWith("--iterations=")) {
			const value = token.slice("--iterations=".length);
			const parsed = parseIterations(value);
			if (!parsed.ok) {
				return {
					kind: "error",
					error: parsed.error,
					usage: ULTRATHINK_USAGE,
				};
			}
			iterations = parsed.value;
			continue;
		}

		if (token.startsWith("-")) {
			return {
				kind: "error",
				error: `Unknown option for /${ULTRATHINK_COMMAND}: ${token}`,
				usage: ULTRATHINK_USAGE,
			};
		}

		query = tokens.slice(index).join(" ").trim() || undefined;
		break;
	}

	return {
		kind: "command",
		command: { iterations, query },
	};
}

function parseIterations(value: string): { ok: true; value: number } | { ok: false; error: string } {
	if (!/^\d+$/.test(value)) {
		return {
			ok: false,
			error: `Invalid iteration count "${value}". Expected an integer from 1 to ${ULTRATHINK_MAX_ITERATIONS}.`,
		};
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > ULTRATHINK_MAX_ITERATIONS) {
		return {
			ok: false,
			error: `Invalid iteration count "${value}". Expected an integer from 1 to ${ULTRATHINK_MAX_ITERATIONS}.`,
		};
	}
	return { ok: true, value: parsed };
}

export function getUltrathinkPhase(iteration: number, totalIterations: number): UltrathinkPhase {
	if (totalIterations <= 1) return "Synthesis";
	if (iteration === 1) return "Recon";
	if (iteration === totalIterations) return "Synthesis";
	if (iteration === totalIterations - 1) return "Verify";
	return "Critique";
}

export function resolveUltrathinkReadOnlyTools(activeToolNames: string[]): string[] {
	return activeToolNames.filter((toolName) => ULTRATHINK_READ_ONLY_TOOL_NAMES.has(toolName));
}

export function findLastMeaningfulUserIntent(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const text = normalizeWhitespace(extractUserText(message));
		if (!text) continue;
		if (text.startsWith("/")) continue;
		if (text.startsWith("!")) continue;
		if (text.includes(ULTRATHINK_INTERNAL_MARKER)) continue;
		if (text.startsWith(ULTRATHINK_VISIBLE_PROMPT_PREFIX)) continue;
		return text;
	}
	return undefined;
}

export function buildUltrathinkContextTail(messages: AgentMessage[]): string {
	const rows: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		if (rows.length >= ULTRATHINK_MAX_CONTEXT_MESSAGES) break;
		const message = messages[index];
		const text = normalizeWhitespace(extractMessageText(message));
		if (!text) continue;
		if (text.includes(ULTRATHINK_INTERNAL_MARKER)) continue;
		if (isUltrathinkStructuredResponse(text)) continue;
		if (message.role === "user" && (text.startsWith("/") || text.startsWith("!"))) continue;
		if (message.role === "user" && text.startsWith(ULTRATHINK_VISIBLE_PROMPT_PREFIX)) continue;
		rows.push(`[${message.role}] ${truncate(text, ULTRATHINK_MAX_CONTEXT_MESSAGE_CHARS)}`);
	}
	if (rows.length === 0) return "";
	return rows.reverse().join("\n");
}

export function extractUltrathinkToolEvidence(messages: AgentMessage[]): UltrathinkToolEvidence[] {
	const byId = new Map<string, UltrathinkToolEvidence>();
	for (const message of messages) {
		if (!isToolResultMessage(message)) continue;
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
		if (!toolCallId) continue;
		const summary = truncate(normalizeWhitespace(extractToolResultText(message) || "(no text output)"), 160);
		byId.set(toolCallId, { toolCallId, toolName, summary });
	}
	return [...byId.values()];
}

export function buildUltrathinkEvidenceCatalog(evidence: UltrathinkToolEvidence[]): string {
	if (evidence.length === 0) return "- (none captured yet)";
	const recent = evidence.slice(-ULTRATHINK_MAX_EVIDENCE_ENTRIES);
	return recent.map((entry) => `- [evidence:${entry.toolCallId}] ${entry.toolName}: ${entry.summary}`).join("\n");
}

export function extractUltrathinkEvidenceTags(text: string): string[] {
	const tags = new Set<string>();
	for (const match of text.matchAll(/\[evidence:([^\]\s]+)\]/gi)) {
		const value = match[1]?.trim();
		if (value) tags.add(value);
	}
	return [...tags];
}

export function hasUltrathinkNoNewEvidenceMarker(text: string): boolean {
	return text.includes(ULTRATHINK_NO_NEW_EVIDENCE_MARKER);
}

export function evaluateUltrathinkEvidencePolicy(input: {
	text: string;
	phase: UltrathinkPhase;
	toolChecksThisIteration: number;
	knownEvidenceIds: string[];
}): UltrathinkEvidencePolicyResult {
	const hasNumericClaims = hasUltrathinkNumericClaims(input.text);
	const evidenceTags = extractUltrathinkEvidenceTags(input.text);
	const hasEvidenceTags = evidenceTags.length > 0;
	const knownEvidence = new Set(input.knownEvidenceIds);
	const invalidEvidenceTags = evidenceTags.filter((tag) => !knownEvidence.has(tag));
	const hasNoNewEvidenceMarker = hasUltrathinkNoNewEvidenceMarker(input.text);
	const needsNoNewEvidenceMarker =
		(input.phase === "Verify" || input.phase === "Synthesis") && input.toolChecksThisIteration === 0;

	return {
		hasNumericClaims,
		hasEvidenceTags,
		invalidEvidenceTags,
		missingEvidenceForNumbers: hasNumericClaims && !hasEvidenceTags,
		needsNoNewEvidenceMarker,
		hasNoNewEvidenceMarker,
	};
}

export function createInitialUltrathinkCheckpoint(objective: string): string {
	return normalizeUltrathinkCheckpoint(
		[
			`Goal: ${objective}`,
			"Verified Facts:",
			"- (none yet)",
			"Rejected Hypotheses:",
			"- (none yet)",
			"Open Questions:",
			"- (none yet)",
			"Next Checks:",
			"- Continue analysis with read-only evidence gathering.",
		].join("\n"),
		objective,
	);
}

export function normalizeUltrathinkCheckpoint(rawCheckpoint: string, objective: string): string {
	const source = rawCheckpoint.trim();
	const goal = normalizeGoal(extractCheckpointSection(source, "Goal") ?? objective, objective);
	const verifiedFacts = normalizeListSection(extractCheckpointSection(source, "Verified Facts"), "Verified Facts");
	const rejectedHypotheses = normalizeListSection(
		extractCheckpointSection(source, "Rejected Hypotheses"),
		"Rejected Hypotheses",
	);
	const openQuestions = normalizeListSection(extractCheckpointSection(source, "Open Questions"), "Open Questions");
	const nextChecks = normalizeListSection(extractCheckpointSection(source, "Next Checks"), "Next Checks");

	return [
		`Goal: ${goal}`,
		"Verified Facts:",
		verifiedFacts,
		"Rejected Hypotheses:",
		rejectedHypotheses,
		"Open Questions:",
		openQuestions,
		"Next Checks:",
		nextChecks,
	].join("\n");
}

export function truncateUltrathinkCheckpoint(checkpoint: string, maxChars: number): string {
	if (checkpoint.length <= maxChars) return checkpoint;
	return `${checkpoint.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function extractUltrathinkIterationSummary(text: string): string {
	const summary = extractMarkdownSection(text, "Iteration Summary");
	if (summary) {
		return truncate(normalizeWhitespace(summary), 420);
	}
	const fallback = normalizeWhitespace(text);
	return truncate(fallback || "Iteration completed without a structured summary.", 420);
}

export function extractUltrathinkCheckpoint(text: string): string | undefined {
	const checkpoint = extractMarkdownSection(text, "Next Checkpoint");
	return checkpoint?.trim() || undefined;
}

export function buildUltrathinkIterationPrompt(input: {
	iteration: number;
	totalIterations: number;
	phase: UltrathinkPhase;
	objective: string;
	checkpoint: string;
	previousSummary?: string;
	contextTail?: string;
	evidenceCatalog?: string;
	budgetStatus?: string;
}): string {
	const isFinalIteration = input.iteration === input.totalIterations;

	const formatBlock = buildUltrathinkResponseFormat(isFinalIteration);

	return [
		`${ULTRATHINK_INTERNAL_MARKER} iteration ${input.iteration}/${input.totalIterations}`,
		`Phase: ${input.phase}`,
		"You are running an ultrathink analysis pass with the ROOT agent and tools.",
		"STRICT RULES:",
		"- Operate in read-only mode only.",
		"- You may inspect files and repository state, but do not modify files or run mutating commands.",
		"- No implementation changes in this mode; analysis and verification only.",
		"- Do not invent metrics, counts, percentages, coverage numbers, or ROI claims.",
		"- Any quantitative claim must include evidence tags: `[evidence:<toolCallId>]`.",
		"- In Verify/Synthesis with zero new tool checks, include `[NO_NEW_EVIDENCE_OK]` in Evidence Notes.",
		"",
		"Objective:",
		input.objective,
		"",
		input.contextTail
			? ["Session context tail (compact):", input.contextTail, ""].join("\n")
			: "",
		input.previousSummary
			? ["Previous iteration summary (compact):", input.previousSummary, ""].join("\n")
			: "",
		input.evidenceCatalog
			? ["Known evidence from tool results (carry-forward):", input.evidenceCatalog, ""].join("\n")
			: "",
		input.budgetStatus
			? ["Current budget status:", input.budgetStatus, ""].join("\n")
			: "",
		"Current checkpoint:",
		input.checkpoint,
		"",
		"Return in the exact markdown shape below:",
		formatBlock,
		"",
		"Keep this response concise and evidence-based.",
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

export function buildUltrathinkVisibleIterationPrompt(input: {
	iteration: number;
	totalIterations: number;
	phase: UltrathinkPhase;
	objective: string;
}): string {
	return `${ULTRATHINK_VISIBLE_PROMPT_PREFIX} ${input.iteration}/${input.totalIterations} (${input.phase}). Objective: ${truncate(input.objective, 160)}. Running ROOT-agent read-only analysis pass.`;
}

export function buildUltrathinkBudgetStatusLine(input: {
	accumulatedInputTokens: number;
	accumulatedTotalTokens: number;
	accumulatedCost: number;
}): string {
	return [
		`input_tokens=${input.accumulatedInputTokens}/${ULTRATHINK_MAX_RUN_INPUT_TOKENS}`,
		`total_tokens=${input.accumulatedTotalTokens}/${ULTRATHINK_MAX_RUN_TOTAL_TOKENS}`,
		`cost=${input.accumulatedCost.toFixed(6)}/${ULTRATHINK_MAX_RUN_COST.toFixed(6)}`,
		`iter_input_limit=${ULTRATHINK_MAX_ITERATION_INPUT_TOKENS}`,
	].join(", ");
}

export function buildUltrathinkComplianceRepairPrompt(input: {
	iteration: number;
	totalIterations: number;
	phase: UltrathinkPhase;
	objective: string;
	originalResponse: string;
	issues: string[];
	checkpoint: string;
	evidenceCatalog?: string;
}): string {
	const isFinalIteration = input.iteration === input.totalIterations;
	return [
		`${ULTRATHINK_INTERNAL_MARKER} compliance repair ${input.iteration}/${input.totalIterations}`,
		`Phase: ${input.phase}`,
		"You must rewrite the previous iteration response to satisfy ultrathink evidence policy.",
		"",
		"Issues detected:",
		...input.issues.map((issue) => `- ${issue}`),
		"",
		"Objective:",
		input.objective,
		"",
		input.evidenceCatalog
			? ["Known evidence from tool results:", input.evidenceCatalog, ""].join("\n")
			: "",
		"Current checkpoint:",
		input.checkpoint,
		"",
		"Previous non-compliant response:",
		input.originalResponse,
		"",
		"Rewrite with these constraints:",
		"- Keep conclusions concise and evidence-grounded.",
		"- Remove any unsupported quantitative claims.",
		"- Any quantitative claim must include `[evidence:<toolCallId>]`.",
		"- If no new tool checks were needed in Verify/Synthesis, include `[NO_NEW_EVIDENCE_OK]` in Evidence Notes.",
		"",
		"Return in the exact markdown shape below:",
		buildUltrathinkResponseFormat(isFinalIteration),
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

export function shouldUltrathinkForceToolGrounding(input: UltrathinkToolGroundingPolicyInput): boolean {
	if (input.toolChecksThisIteration > 0) return false;
	if (input.phase === "Recon") return true;
	if (input.phase === "Critique" && input.cumulativeEvidenceCount === 0) return true;
	return false;
}

export function buildUltrathinkToolGroundingPrompt(input: {
	iteration: number;
	totalIterations: number;
	phase: UltrathinkPhase;
	objective: string;
	checkpoint: string;
	availableReadOnlyTools: string[];
	evidenceCatalog?: string;
}): string {
	const isFinalIteration = input.iteration === input.totalIterations;
	const tools = input.availableReadOnlyTools.join(", ");
	return [
		`${ULTRATHINK_INTERNAL_MARKER} grounding retry ${input.iteration}/${input.totalIterations}`,
		`Phase: ${input.phase}`,
		"Grounding retry is required because no tool evidence was captured in this phase.",
		"MANDATORY ACTIONS:",
		"- Use read-only tools against the current workspace before finalizing this response.",
		"- Run at least 2 concrete checks (e.g., ls/rg/read/git_read).",
		"- Reference concrete file paths and observations from tool outputs.",
		"- Do not answer from prior knowledge only.",
		"",
		`Available read-only tools: ${tools || "(none listed)"}`,
		"",
		"Objective:",
		input.objective,
		"",
		input.evidenceCatalog
			? ["Known evidence from tool results:", input.evidenceCatalog, ""].join("\n")
			: "",
		"Current checkpoint:",
		input.checkpoint,
		"",
		"Return in the exact markdown shape below:",
		buildUltrathinkResponseFormat(isFinalIteration),
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

export function buildUltrathinkCheckpointCompressionPrompt(input: {
	objective: string;
	checkpoint: string;
	maxChars: number;
}): string {
	return [
		"Compress this checkpoint while preserving all decision-critical details.",
		`Maximum length target: ${input.maxChars} characters.`,
		"",
		"Objective:",
		input.objective,
		"",
		"Checkpoint to compress:",
		input.checkpoint,
	].join("\n");
}

export function hasUltrathinkEvidenceViolations(policy: UltrathinkEvidencePolicyResult): boolean {
	if (policy.invalidEvidenceTags.length > 0) return true;
	if (policy.missingEvidenceForNumbers) return true;
	if (policy.needsNoNewEvidenceMarker && !policy.hasNoNewEvidenceMarker) return true;
	return false;
}

export function isUltrathinkStagnated(input: {
	previousCheckpoint: string;
	nextCheckpoint: string;
	toolChecksThisIteration: number;
}): boolean {
	if (input.toolChecksThisIteration > 0) return false;
	return normalizeWhitespace(input.previousCheckpoint) === normalizeWhitespace(input.nextCheckpoint);
}

function buildUltrathinkResponseFormat(isFinalIteration: boolean): string {
	const rows = [
		"### Iteration Summary",
		"- 2-4 bullets, max 350 characters total.",
	];
	if (isFinalIteration) {
		rows.push("### Final Analysis");
		rows.push("- Explain the best approach with concrete evidence and tradeoffs.");
		rows.push("- Start this section with: `I used ultrathink mode.`");
	}
	rows.push("### Evidence Notes");
	rows.push("- Add evidence tags for quantitative claims: `[evidence:<toolCallId>]`.");
	rows.push(`- If no new tool checks were needed in Verify/Synthesis, include ${ULTRATHINK_NO_NEW_EVIDENCE_MARKER}.`);
	rows.push("### Next Checkpoint");
	rows.push("Goal: <single line>");
	rows.push("Verified Facts:");
	rows.push("- ...");
	rows.push("Rejected Hypotheses:");
	rows.push("- ...");
	rows.push("Open Questions:");
	rows.push("- ...");
	rows.push("Next Checks:");
	rows.push("- ...");
	return rows.join("\n");
}

function hasUltrathinkNumericClaims(text: string): boolean {
	const finalAnalysis = extractMarkdownSection(text, "Final Analysis");
	const source = normalizeWhitespace(finalAnalysis ?? text);
	if (!source) return false;
	if (/\b\d+\s*(?:%|percent|hours?|hrs?|minutes?|mins?|sec|seconds?|tokens?|files?|tests?|issues?|iterations?|insights?)\b/i.test(source)) {
		return true;
	}
	if (/\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/.test(source)) {
		return true;
	}
	if (/\b\d+\+\b/.test(source)) {
		return true;
	}
	return false;
}

function isUltrathinkStructuredResponse(text: string): boolean {
	return text.includes("### Iteration Summary") && text.includes("### Next Checkpoint");
}

function extractMessageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return extractUserText(message);
		case "assistant":
			return extractAssistantText(message as AssistantMessage);
		case "bashExecution":
			return [message.command, message.output].filter((part) => typeof part === "string" && part.trim()).join(" | ");
		case "branchSummary":
		case "compactionSummary":
			return typeof message.summary === "string" ? message.summary : "";
		default:
			return "";
	}
}

function extractUserText(message: AgentMessage & { role: "user" }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isToolResultMessage(
	message: AgentMessage,
): message is AgentMessage & { role: "toolResult"; toolCallId: string; toolName: string; content: TextContent[] } {
	if (message.role !== "toolResult") return false;
	const candidate = message as AgentMessage & {
		role: "toolResult";
		toolCallId?: unknown;
		toolName?: unknown;
		content?: unknown;
	};
	return (
		typeof candidate.toolCallId === "string" &&
		candidate.toolCallId.length > 0 &&
		typeof candidate.toolName === "string" &&
		candidate.toolName.length > 0 &&
		Array.isArray(candidate.content)
	);
}

function extractToolResultText(message: AgentMessage & { role: "toolResult"; content: TextContent[] }): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function extractMarkdownSection(text: string, heading: string): string | undefined {
	const escapedHeading = escapeRegExp(heading);
	const regex = new RegExp(`(?:^|\\n)###\\s*${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "i");
	const match = text.match(regex);
	if (!match) return undefined;
	return match[1]?.trim() || undefined;
}

function extractCheckpointSection(raw: string, sectionName: (typeof CHECKPOINT_SECTIONS)[number]): string | undefined {
	const escapedSection = escapeRegExp(sectionName);
	const otherSections = CHECKPOINT_SECTIONS.filter((name) => name !== sectionName).map((name) => escapeRegExp(name));
	const lookahead = otherSections.length > 0 ? `(?=\\n(?:${otherSections.join("|")})\\s*:|$)` : "$";
	const regex = new RegExp(`(?:^|\\n)${escapedSection}\\s*:\\s*([\\s\\S]*?)${lookahead}`, "i");
	const match = raw.match(regex);
	if (!match) return undefined;
	return match[1]?.trim() || undefined;
}

function normalizeGoal(goalCandidate: string, fallbackGoal: string): string {
	const normalized = normalizeWhitespace(goalCandidate);
	if (normalized.length > 0) return truncate(normalized, 280);
	return truncate(normalizeWhitespace(fallbackGoal), 280);
}

function normalizeListSection(
	candidate: string | undefined,
	sectionName: Exclude<(typeof CHECKPOINT_SECTIONS)[number], "Goal">,
): string {
	const normalized = normalizeWhitespace(candidate ?? "");
	if (!normalized) {
		return `- ${LIST_SECTION_PLACEHOLDERS[sectionName]}`;
	}

	const lines = normalized
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^[*-]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
		.filter((line) => line.length > 0)
		.map((line) => `- ${truncate(line, 280)}`);

	if (lines.length === 0) {
		return `- ${LIST_SECTION_PLACEHOLDERS[sectionName]}`;
	}

	return lines.join("\n");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeWhitespace(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
