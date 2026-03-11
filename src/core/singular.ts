import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { EngineeringContract } from "./contract.js";

export type SingularComplexity = "low" | "medium" | "high";
export type SingularBlastRadius = "low" | "medium" | "high";
export type SingularRecommendation = "implement_now" | "implement_incrementally" | "defer";
export type SingularStageFit = "needed_now" | "optional_now" | "later";

export interface SingularImpactAnalysis {
	codebase: string;
	delivery: string;
	risks: string;
	operations: string;
}

export interface SingularOption {
	id: string;
	title: string;
	summary: string;
	complexity: SingularComplexity;
	blast_radius: SingularBlastRadius;
	suggested_files: string[];
	plan: string[];
	pros: string[];
	cons: string[];
	when_to_choose?: string;
}

export interface SingularAnalysisResult {
	runId: string;
	request: string;
	generatedAt: string;
	scannedFiles: number;
	sourceFiles: number;
	testFiles: number;
	matchedFiles: string[];
	baselineComplexity: SingularComplexity;
	baselineBlastRadius: SingularBlastRadius;
	recommendation: SingularRecommendation;
	recommendationReason: string;
	stageFit?: SingularStageFit;
	stageFitReason?: string;
	impactAnalysis?: SingularImpactAnalysis;
	contractSignals: string[];
	options: SingularOption[];
}

export interface SingularLastRun {
	runId: string;
	analysisPath: string;
	metaPath?: string;
	request?: string;
	recommendation?: SingularRecommendation;
	generatedAt?: string;
}

export interface SingularAnalyzeOptions {
	request: string;
	contract?: EngineeringContract;
	autosave?: boolean;
}

export interface SingularServiceOptions {
	cwd: string;
}

const SCAN_TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".json",
	".yaml",
	".yml",
	".toml",
	".md",
	".sh",
	".sql",
	".html",
	".css",
]);

const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", "dist", "build", ".iosm", ".next", "coverage"]);

const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"for",
	"with",
	"from",
	"into",
	"about",
	"что",
	"как",
	"для",
	"это",
	"надо",
	"нужно",
	"добавить",
	"сделать",
	"функционал",
	"feature",
	"implement",
	"add",
]);

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

function getExtension(filePath: string): string {
	const normalized = filePath.toLowerCase();
	const index = normalized.lastIndexOf(".");
	return index >= 0 ? normalized.slice(index) : "";
}

function nowIso(): string {
	return new Date().toISOString();
}

function buildRunId(date = new Date()): string {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	const seconds = String(date.getUTCSeconds()).padStart(2, "0");
	return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

function normalizeRequestTokens(request: string): string[] {
	return request
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function scoreToComplexity(score: number): SingularComplexity {
	if (score >= 4) return "high";
	if (score >= 2) return "medium";
	return "low";
}

function scoreToBlastRadius(score: number): SingularBlastRadius {
	if (score >= 4) return "high";
	if (score >= 2) return "medium";
	return "low";
}

function defaultSuggestedFiles(matches: string[]): string[] {
	if (matches.length > 0) return matches.slice(0, 6);
	return ["src/**/*", "test/**/*"];
}

export class SingularService {
	private readonly cwd: string;

	constructor(options: SingularServiceOptions) {
		this.cwd = options.cwd;
	}

	getAnalysesRoot(): string {
		return join(this.cwd, ".iosm", "singular");
	}

	getLastRun(): SingularLastRun | undefined {
		const root = this.getAnalysesRoot();
		if (!existsSync(root)) return undefined;
		const candidates = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
		const runId = candidates[candidates.length - 1];
		if (!runId) return undefined;

		const runDir = join(root, runId);
		const analysisPath = join(runDir, "analysis.json");
		if (!existsSync(analysisPath)) return undefined;
		const metaPath = join(runDir, "meta.json");

		let request: string | undefined;
		let recommendation: SingularRecommendation | undefined;
		let generatedAt: string | undefined;
		if (existsSync(metaPath)) {
			try {
				const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
				request = typeof parsed.request === "string" ? parsed.request : undefined;
				recommendation =
					parsed.recommendation === "implement_now" ||
					parsed.recommendation === "implement_incrementally" ||
					parsed.recommendation === "defer"
						? (parsed.recommendation as SingularRecommendation)
						: undefined;
				generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined;
			} catch {
				// metadata is optional
			}
		}

		return {
			runId,
			analysisPath,
			metaPath: existsSync(metaPath) ? metaPath : undefined,
			request,
			recommendation,
			generatedAt,
		};
	}

	async analyze(options: SingularAnalyzeOptions): Promise<SingularAnalysisResult> {
		const request = options.request.trim();
		const contract = options.contract ?? {};
		const autosave = options.autosave !== false;
		const runId = buildRunId();
		const generatedAt = nowIso();

		const scan = this.scanRepository(request);
		const contractSignals = this.collectContractSignals(contract);
		const baselineScore = this.estimateComplexityScore(request, scan.matchedFiles.length, scan.testFiles, contractSignals.length);
		const baselineComplexity = scoreToComplexity(baselineScore);
		const baselineBlastRadius = scoreToBlastRadius(baselineScore + (scan.matchedFiles.length >= 5 ? 1 : 0));

		const recommendation = this.buildRecommendation({
			request,
			baselineComplexity,
			testFiles: scan.testFiles,
			matchedFiles: scan.matchedFiles.length,
		});

		const suggestedFiles = defaultSuggestedFiles(scan.matchedFiles);
		const optionsList = this.buildOptions({
			request,
			baselineComplexity,
			baselineBlastRadius,
			suggestedFiles,
			contractSignals,
		});

		const result: SingularAnalysisResult = {
			runId,
			request,
			generatedAt,
			scannedFiles: scan.scannedFiles,
			sourceFiles: scan.sourceFiles,
			testFiles: scan.testFiles,
			matchedFiles: scan.matchedFiles,
			baselineComplexity,
			baselineBlastRadius,
			recommendation: recommendation.value,
			recommendationReason: recommendation.reason,
			contractSignals,
			options: optionsList,
		};

		if (autosave) {
			this.saveRunArtifacts(result);
		}

		return result;
	}

	saveAnalysis(result: SingularAnalysisResult): void {
		this.saveRunArtifacts(result);
	}

	private saveRunArtifacts(result: SingularAnalysisResult): void {
		const runDir = join(this.getAnalysesRoot(), result.runId);
		mkdirSync(runDir, { recursive: true });

		const analysisPath = join(runDir, "analysis.json");
		const metaPath = join(runDir, "meta.json");

		writeFileSync(analysisPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
		writeFileSync(
			metaPath,
			`${JSON.stringify(
				{
					runId: result.runId,
					generatedAt: result.generatedAt,
					request: result.request,
					recommendation: result.recommendation,
					stageFit: result.stageFit,
					baselineComplexity: result.baselineComplexity,
					baselineBlastRadius: result.baselineBlastRadius,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	}

	private scanRepository(request: string): {
		scannedFiles: number;
		sourceFiles: number;
		testFiles: number;
		matchedFiles: string[];
	} {
		const files = this.walkFiles();
		const tokens = normalizeRequestTokens(request);
		const scored = files
			.map((absolutePath) => {
				const relativePath = toPosixPath(relative(this.cwd, absolutePath));
				const normalizedPath = relativePath.toLowerCase();
				const fileName = basename(relativePath).toLowerCase();

				let score = 0;
				for (const token of tokens) {
					if (normalizedPath.includes(token)) score += 1;
					if (fileName.includes(token)) score += 2;
				}

				if (/auth|account|profile|cabinet|dashboard|billing|payment/i.test(request) && /auth|user|account|profile|billing|payment|dashboard/i.test(normalizedPath)) {
					score += 1;
				}

				return { relativePath, score };
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

		const matchedFiles = scored.slice(0, 10).map((item) => item.relativePath);
		const sourceFiles = files.filter((absolutePath) => {
			const rel = toPosixPath(relative(this.cwd, absolutePath));
			return rel.startsWith("src/") || rel.startsWith("app/") || rel.startsWith("packages/");
		}).length;
		const testFiles = files.filter((absolutePath) => {
			const rel = toPosixPath(relative(this.cwd, absolutePath)).toLowerCase();
			return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.test\./.test(rel) || /\.spec\./.test(rel);
		}).length;

		return {
			scannedFiles: files.length,
			sourceFiles,
			testFiles,
			matchedFiles,
		};
	}

	private walkFiles(): string[] {
		const maxFiles = 12_000;
		const stack = [this.cwd];
		const files: string[] = [];

		while (stack.length > 0 && files.length < maxFiles) {
			const dir = stack.pop();
			if (!dir) break;

			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				const absolutePath = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
					stack.push(absolutePath);
					continue;
				}
				if (!entry.isFile()) continue;
				if (!SCAN_TEXT_EXTENSIONS.has(getExtension(entry.name))) continue;
				try {
					if (statSync(absolutePath).size > 800_000) continue;
				} catch {
					continue;
				}
				files.push(absolutePath);
				if (files.length >= maxFiles) break;
			}
		}

		return files.sort((a, b) => a.localeCompare(b));
	}

	private collectContractSignals(contract: EngineeringContract): string[] {
		const signals: string[] = [];
		if (contract.goal) signals.push(`goal=${contract.goal}`);
		if ((contract.constraints ?? []).length > 0) signals.push(`constraints=${contract.constraints?.length ?? 0}`);
		if ((contract.quality_gates ?? []).length > 0) signals.push(`quality_gates=${contract.quality_gates?.length ?? 0}`);
		if ((contract.definition_of_done ?? []).length > 0) {
			signals.push(`definition_of_done=${contract.definition_of_done?.length ?? 0}`);
		}
		if ((contract.non_goals ?? []).length > 0) signals.push(`non_goals=${contract.non_goals?.length ?? 0}`);
		if ((contract.risks ?? []).length > 0) signals.push(`risks=${contract.risks?.length ?? 0}`);
		return signals.slice(0, 8);
	}

	private estimateComplexityScore(
		request: string,
		matchedFiles: number,
		testFiles: number,
		contractSignalCount: number,
	): number {
		let score = 1;
		const normalized = request.toLowerCase();

		if (request.length > 70) score += 1;
		if (matchedFiles >= 5) score += 1;
		if (matchedFiles >= 8) score += 1;
		if (testFiles === 0) score += 1;
		if (contractSignalCount >= 3) score += 1;

		if (
			/(migration|refactor|rewrite|billing|payment|security|permission|rbac|role|distributed|event|queue|microservice|oauth|sso|регресс|миграц|рефактор|безопасност|права|роли)/.test(
				normalized,
			)
		) {
			score += 1;
		}

		if (/(asap|urgent|критично|срочно|немедленно)/.test(normalized)) {
			score += 1;
		}

		return Math.min(6, score);
	}

	private buildRecommendation(payload: {
		request: string;
		baselineComplexity: SingularComplexity;
		testFiles: number;
		matchedFiles: number;
	}): { value: SingularRecommendation; reason: string } {
		const normalized = payload.request.toLowerCase();
		const urgent = /(asap|urgent|критично|срочно|немедленно)/.test(normalized);

		if (payload.baselineComplexity === "high" && payload.testFiles === 0) {
			return {
				value: "defer",
				reason: "High complexity with no tests in place. Build a safety net and design first.",
			};
		}
		if (payload.baselineComplexity === "high" || payload.matchedFiles >= 7) {
			return {
				value: "implement_incrementally",
				reason: "The change touches multiple areas. Prefer incremental rollout via an MVP slice.",
			};
		}
		if (urgent) {
			return {
				value: "implement_now",
				reason: "The request is urgent and risk appears manageable. Implement now with a constrained scope.",
			};
		}
		return {
			value: "implement_now",
			reason: "Complexity is manageable. Implement now while enforcing quality gates.",
		};
	}

	private buildOptions(payload: {
		request: string;
		baselineComplexity: SingularComplexity;
		baselineBlastRadius: SingularBlastRadius;
		suggestedFiles: string[];
		contractSignals: string[];
	}): SingularOption[] {
		const compactFiles = payload.suggestedFiles.slice(0, 6);
		const broadFiles = payload.suggestedFiles.length > 0 ? payload.suggestedFiles : ["src/**/*", "test/**/*"];
		const contractGateStep =
			payload.contractSignals.length > 0
				? "Validate contract constraints and quality gates before merge."
				: "Define explicit quality gates and Definition of Done before rollout.";

		return [
			{
				id: "1",
				title: "Incremental MVP",
				summary: "Deliver a minimal usable feature slice quickly with measurable outcomes.",
				complexity: payload.baselineComplexity === "high" ? "medium" : payload.baselineComplexity,
				blast_radius: payload.baselineBlastRadius === "high" ? "medium" : payload.baselineBlastRadius,
				suggested_files: compactFiles,
				plan: [
					"Lock the minimum scope and explicitly exclude non-goals.",
					"Implement in 1-2 target areas without cascading refactors.",
					"Add smoke/regression tests for the new flow.",
					contractGateStep,
				],
				pros: ["Fast time-to-value", "Controlled risk", "Easy rollback"],
				cons: ["Some UX/infrastructure remains for the next phase"],
				when_to_choose: "Choose when you need delivery this sprint with controlled blast radius.",
			},
			{
				id: "2",
				title: "Comprehensive implementation",
				summary: "Ship the full feature with infrastructure, edge cases, and API expansion.",
				complexity: "high",
				blast_radius: "high",
				suggested_files: broadFiles,
				plan: [
					"Design architecture and module boundaries before coding.",
					"Implement domain logic, API/UI layers, and persistence.",
					"Cover behavior with integration and contract tests.",
					"Roll out in stages with feature flags and metrics.",
				],
				pros: ["Delivers the full capability", "Lower technical debt after release"],
				cons: ["Higher cost and regression risk", "Requires longer review and test cycle"],
				when_to_choose: "Choose when this is a strategic milestone and you can afford larger scope.",
			},
			{
				id: "3",
				title: "Defer implementation",
				summary: "Do not code now; prepare design, risk map, and migration plan first.",
				complexity: "low",
				blast_radius: "low",
				suggested_files: [],
				plan: [
					"Prepare technical design and impacted-area map.",
					"Define readiness criteria and implementation risks.",
					"Resume implementation after dependencies are cleared.",
				],
				pros: ["Minimal immediate risk", "Clear plan before coding"],
				cons: ["Feature is not delivered in current release window"],
				when_to_choose: "Choose when prerequisites are missing or risk is too high this cycle.",
			},
		];
	}
}
