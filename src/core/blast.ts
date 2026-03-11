import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { EngineeringContract } from "./contract.js";

export type BlastProfile = "quick" | "full";
export type BlastSeverity = "low" | "medium" | "high";

export interface BlastFinding {
	id: string;
	title: string;
	severity: BlastSeverity;
	category: string;
	detail: string;
	path?: string;
	line?: number;
	recommendation?: string;
}

export interface BlastRunOptions {
	profile: BlastProfile;
	autosave?: boolean;
	contract?: EngineeringContract;
}

export interface BlastRunResult {
	runId: string;
	profile: BlastProfile;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	scannedFiles: number;
	scannedLines: number;
	findings: BlastFinding[];
	summary: string;
	nextSteps: string[];
	reportMarkdown: string;
	contract: EngineeringContract;
	autosaved: boolean;
	reportPath?: string;
	findingsPath?: string;
}

export interface BlastLastRun {
	runId: string;
	reportPath: string;
	findingsPath: string;
	metaPath?: string;
	summary?: string;
	profile?: BlastProfile;
	completedAt?: string;
	findings?: number;
}

type BlastScanCounters = {
	files: number;
	lines: number;
	todoCount: number;
	debugCount: number;
	unsafeEvalCount: number;
	anyTypeCount: number;
	tsIgnoreCount: number;
	testFiles: number;
	largeFiles: number;
};

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
	".env",
	".sql",
	".html",
	".css",
]);

const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", "dist", "build", ".iosm", ".next", "coverage"]);

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

function getExtension(filePath: string): string {
	const normalized = filePath.toLowerCase();
	const index = normalized.lastIndexOf(".");
	return index >= 0 ? normalized.slice(index) : "";
}

function containsAny(text: string, terms: string[]): boolean {
	const normalized = text.toLowerCase();
	return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function countSeverity(findings: BlastFinding[], severity: BlastSeverity): number {
	return findings.filter((item) => item.severity === severity).length;
}

function clampFindings(findings: BlastFinding[], max: number): BlastFinding[] {
	if (findings.length <= max) return findings;
	return findings.slice(0, max);
}

function serializeFinding(finding: BlastFinding): string {
	const location = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : "";
	return `- [${finding.severity.toUpperCase()}] ${finding.title}${location}\n  ${finding.detail}${finding.recommendation ? `\n  fix: ${finding.recommendation}` : ""}`;
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

export interface BlastServiceOptions {
	cwd: string;
}

export class BlastService {
	private readonly cwd: string;

	constructor(options: BlastServiceOptions) {
		this.cwd = options.cwd;
	}

	getAuditsRoot(): string {
		return join(this.cwd, ".iosm", "audits");
	}

	getLastRun(): BlastLastRun | undefined {
		const root = this.getAuditsRoot();
		if (!existsSync(root)) return undefined;
		const candidates = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
		const runId = candidates[candidates.length - 1];
		if (!runId) return undefined;

		const runDir = join(root, runId);
		const reportPath = join(runDir, "report.md");
		const findingsPath = join(runDir, "findings.json");
		if (!existsSync(reportPath) || !existsSync(findingsPath)) {
			return undefined;
		}

		const metaPath = join(runDir, "meta.json");
		let summary: string | undefined;
		let profile: BlastProfile | undefined;
		let completedAt: string | undefined;
		let findingsCount: number | undefined;
		if (existsSync(metaPath)) {
			try {
				const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
				summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
				profile =
					parsed.profile === "quick" || parsed.profile === "full" ? (parsed.profile as BlastProfile) : undefined;
				completedAt = typeof parsed.completedAt === "string" ? parsed.completedAt : undefined;
				findingsCount = typeof parsed.findings === "number" ? parsed.findings : undefined;
			} catch {
				// Keep metadata optional.
			}
		}

		return {
			runId,
			reportPath,
			findingsPath,
			metaPath: existsSync(metaPath) ? metaPath : undefined,
			summary,
			profile,
			completedAt,
			findings: findingsCount,
		};
	}

	async run(options: BlastRunOptions): Promise<BlastRunResult> {
		const startedAt = nowIso();
		const started = Date.now();
		const profile = options.profile;
		const runId = buildRunId(new Date());
		const autosave = options.autosave !== false;
		const contract = options.contract ? { ...options.contract } : {};

		const { files, findings, counters } = this.scanRepository(profile, contract);
		const findingsLimited = clampFindings(findings, profile === "full" ? 150 : 80);
		const summary = this.buildSummary(counters, findingsLimited);
		const nextSteps = this.buildNextSteps(findingsLimited, contract);
		const completedAt = nowIso();
		const durationMs = Date.now() - started;
		const reportMarkdown = this.buildReportMarkdown({
			runId,
			profile,
			startedAt,
			completedAt,
			durationMs,
			counters,
			findings: findingsLimited,
			summary,
			nextSteps,
			contract,
		});

		const result: BlastRunResult = {
			runId,
			profile,
			startedAt,
			completedAt,
			durationMs,
			scannedFiles: counters.files,
			scannedLines: counters.lines,
			findings: findingsLimited,
			summary,
			nextSteps,
			reportMarkdown,
			contract,
			autosaved: false,
		};

		if (autosave) {
			const saved = this.saveRunArtifacts(result);
			result.autosaved = true;
			result.reportPath = saved.reportPath;
			result.findingsPath = saved.findingsPath;
		}

		return result;
	}

	private saveRunArtifacts(result: BlastRunResult): { reportPath: string; findingsPath: string } {
		const runDir = join(this.getAuditsRoot(), result.runId);
		mkdirSync(runDir, { recursive: true });

		const reportPath = join(runDir, "report.md");
		const findingsPath = join(runDir, "findings.json");
		const metaPath = join(runDir, "meta.json");

		writeFileSync(reportPath, `${result.reportMarkdown}\n`, "utf8");
		writeFileSync(findingsPath, `${JSON.stringify(result.findings, null, 2)}\n`, "utf8");
		writeFileSync(
			metaPath,
			`${JSON.stringify(
				{
					runId: result.runId,
					profile: result.profile,
					summary: result.summary,
					startedAt: result.startedAt,
					completedAt: result.completedAt,
					durationMs: result.durationMs,
					files: result.scannedFiles,
					lines: result.scannedLines,
					findings: result.findings.length,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		return { reportPath, findingsPath };
	}

	private scanRepository(
		profile: BlastProfile,
		contract: EngineeringContract,
	): { files: string[]; findings: BlastFinding[]; counters: BlastScanCounters } {
		const counters: BlastScanCounters = {
			files: 0,
			lines: 0,
			todoCount: 0,
			debugCount: 0,
			unsafeEvalCount: 0,
			anyTypeCount: 0,
			tsIgnoreCount: 0,
			testFiles: 0,
			largeFiles: 0,
		};

		const findings: BlastFinding[] = [];
		const files = this.walkFiles(profile);
		const maxFileBytes = profile === "full" ? 512_000 : 256_000;

		for (const absolutePath of files) {
			const relativePath = toPosixPath(relative(this.cwd, absolutePath));
			const stat = statSync(absolutePath);
			if (stat.size > maxFileBytes) {
				counters.largeFiles += 1;
				findings.push({
					id: `large-file:${relativePath}`,
					title: "Large file in scan scope",
					severity: "medium",
					category: "maintainability",
					detail: `File size ${stat.size} bytes exceeds ${maxFileBytes} bytes threshold for ${profile} profile.`,
					path: relativePath,
					recommendation: "Split file into smaller modules or exclude it from scope if generated.",
				});
				continue;
			}

			let content: string;
			try {
				content = readFileSync(absolutePath, "utf8");
			} catch {
				continue;
			}
			if (content.includes("\u0000")) continue;

			const lines = content.split(/\r?\n/);
			counters.files += 1;
			counters.lines += lines.length;
			if (/(^|\/)(test|tests|__tests__)\//i.test(relativePath) || /\.test\./i.test(relativePath)) {
				counters.testFiles += 1;
			}

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? "";
				const lineNumber = i + 1;

				if (/(TODO|FIXME|HACK)\b/i.test(line)) {
					counters.todoCount += 1;
					if (findings.length < 220) {
						findings.push({
							id: `todo:${relativePath}:${lineNumber}`,
							title: "Outstanding TODO/FIXME marker",
							severity: "low",
							category: "maintainability",
							detail: line.trim(),
							path: relativePath,
							line: lineNumber,
							recommendation: "Convert to tracked issue or resolve before release.",
						});
					}
				}

				if (/\bconsole\.log\(|\bdebugger\b/.test(line)) {
					counters.debugCount += 1;
					if (findings.length < 220) {
						findings.push({
							id: `debug:${relativePath}:${lineNumber}`,
							title: "Debug artifact in code path",
							severity: "medium",
							category: "quality",
							detail: line.trim(),
							path: relativePath,
							line: lineNumber,
							recommendation: "Remove debug call or guard behind explicit debug flag.",
						});
					}
				}

				if (/\beval\s*\(|\bnew Function\s*\(|child_process\.(exec|execSync)\s*\(/.test(line)) {
					counters.unsafeEvalCount += 1;
					if (findings.length < 220) {
						findings.push({
							id: `unsafe:${relativePath}:${lineNumber}`,
							title: "Potentially unsafe dynamic execution",
							severity: "high",
							category: "security",
							detail: line.trim(),
							path: relativePath,
							line: lineNumber,
							recommendation: "Replace with safer static alternatives or strictly sanitize inputs.",
						});
					}
				}

				if (/:\s*any\b|<any>/.test(line)) {
					counters.anyTypeCount += 1;
				}

				if (/@ts-ignore\b/.test(line)) {
					counters.tsIgnoreCount += 1;
				}
			}
		}

		if (counters.anyTypeCount > 15) {
			findings.push({
				id: "types:any-overuse",
				title: "High usage of `any` type",
				severity: "medium",
				category: "type-safety",
				detail: `Detected ${counters.anyTypeCount} occurrences of explicit any type usage.`,
				recommendation: "Replace broad any usage with domain types or unknown + narrowing.",
			});
		}
		if (counters.tsIgnoreCount > 5) {
			findings.push({
				id: "types:ts-ignore-overuse",
				title: "Excessive @ts-ignore usage",
				severity: "medium",
				category: "type-safety",
				detail: `Detected ${counters.tsIgnoreCount} @ts-ignore directives.`,
				recommendation: "Audit and remove ignored type errors; keep only documented exceptions.",
			});
		}

		const gates = contract.quality_gates ?? [];
		if (containsAny(gates.join(" "), ["test", "coverage"]) && counters.testFiles === 0) {
			findings.push({
				id: "contract:tests-missing",
				title: "Contract gate mismatch: tests expected",
				severity: "high",
				category: "contract",
				detail: "Quality gates mention tests/coverage but no test files were detected in scan scope.",
				recommendation: "Add coverage-aligned tests or adjust contract gates before implementation.",
			});
		}
		if (containsAny(gates.join(" "), ["no todo", "todo=0", "todo:0"]) && counters.todoCount > 0) {
			findings.push({
				id: "contract:todo-mismatch",
				title: "Contract gate mismatch: TODO markers present",
				severity: "medium",
				category: "contract",
				detail: `Contract requires TODO cleanup but ${counters.todoCount} markers were found.`,
				recommendation: "Resolve TODO/FIXME markers or relax gate for current cycle.",
			});
		}

		return { files, findings, counters };
	}

	private walkFiles(profile: BlastProfile): string[] {
		const maxFiles = profile === "full" ? 18_000 : 6_000;
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
				files.push(absolutePath);
				if (files.length >= maxFiles) break;
			}
		}

		return files.sort((a, b) => a.localeCompare(b));
	}

	private buildSummary(counters: BlastScanCounters, findings: BlastFinding[]): string {
		const high = countSeverity(findings, "high");
		const medium = countSeverity(findings, "medium");
		const low = countSeverity(findings, "low");
		const highestRisk = findings.find((item) => item.severity === "high") ?? findings[0];

		const highestLine = highestRisk
			? ` Highest risk: ${highestRisk.title}${highestRisk.path ? ` (${highestRisk.path})` : ""}.`
			: "";
		return `Scanned ${counters.files} files (${counters.lines} lines). Findings: ${high} high, ${medium} medium, ${low} low.${highestLine}`;
	}

	private buildNextSteps(findings: BlastFinding[], contract: EngineeringContract): string[] {
		const steps: string[] = [];
		const high = findings.filter((item) => item.severity === "high");
		const medium = findings.filter((item) => item.severity === "medium");

		if (high.length > 0) {
			steps.push("Address all HIGH findings first and add regression checks before refactors.");
		}
		if (medium.length > 0) {
			steps.push("Batch MEDIUM findings by module and apply low-blast-radius fixes incrementally.");
		}
		if ((contract.quality_gates ?? []).length > 0) {
			steps.push("Re-run /blast after changes to verify contract quality gates.");
		}
		if (steps.length === 0) {
			steps.push("No major risks detected; proceed with planned changes and keep /blast as pre-merge audit.");
		}
		return steps.slice(0, 3);
	}

	private buildReportMarkdown(payload: {
		runId: string;
		profile: BlastProfile;
		startedAt: string;
		completedAt: string;
		durationMs: number;
		counters: BlastScanCounters;
		findings: BlastFinding[];
		summary: string;
		nextSteps: string[];
		contract: EngineeringContract;
	}): string {
		const high = countSeverity(payload.findings, "high");
		const medium = countSeverity(payload.findings, "medium");
		const low = countSeverity(payload.findings, "low");
		const topFindings = payload.findings
			.sort((a, b) => {
				const score = (severity: BlastSeverity): number => (severity === "high" ? 3 : severity === "medium" ? 2 : 1);
				return score(b.severity) - score(a.severity);
			})
			.slice(0, 20);

		const contractLines: string[] = [];
		if (payload.contract.goal) contractLines.push(`- goal: ${payload.contract.goal}`);
		if (payload.contract.quality_gates && payload.contract.quality_gates.length > 0) {
			contractLines.push(`- quality_gates: ${payload.contract.quality_gates.join("; ")}`);
		}
		if (payload.contract.constraints && payload.contract.constraints.length > 0) {
			contractLines.push(`- constraints: ${payload.contract.constraints.join("; ")}`);
		}
		const contractSection = contractLines.length > 0 ? contractLines.join("\n") : "- none";

		return [
			`# Blast Audit Report`,
			``,
			`- run_id: ${payload.runId}`,
			`- profile: ${payload.profile}`,
			`- started_at: ${payload.startedAt}`,
			`- completed_at: ${payload.completedAt}`,
			`- duration_ms: ${payload.durationMs}`,
			``,
			`## Executive Summary`,
			`${payload.summary}`,
			``,
			`## Scan Metrics`,
			`- files_scanned: ${payload.counters.files}`,
			`- lines_scanned: ${payload.counters.lines}`,
			`- test_files: ${payload.counters.testFiles}`,
			`- TODO/FIXME markers: ${payload.counters.todoCount}`,
			`- debug artifacts: ${payload.counters.debugCount}`,
			`- unsafe dynamic execution markers: ${payload.counters.unsafeEvalCount}`,
			`- large files skipped: ${payload.counters.largeFiles}`,
			``,
			`## Findings Overview`,
			`- high: ${high}`,
			`- medium: ${medium}`,
			`- low: ${low}`,
			``,
			`## Contract Context`,
			`${contractSection}`,
			``,
			`## Top Findings`,
			topFindings.length > 0 ? topFindings.map(serializeFinding).join("\n") : "- none",
			``,
			`## Recommended Next Steps`,
			payload.nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
		].join("\n");
	}
}
