import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import type { TruncationResult } from "./truncate.js";
import {
	type PackageManager,
	detectPackageManager,
	ensureCommandOrThrow,
	formatVerificationOutput,
	readPackageJson,
	resolvePackageManagerExecInvocation,
	resolvePackageManagerRunInvocation,
	runVerificationCommand,
} from "./verification-runner.js";

const lintRunSchema = Type.Object({
	runner: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("npm"),
				Type.Literal("pnpm"),
				Type.Literal("yarn"),
				Type.Literal("bun"),
				Type.Literal("eslint"),
				Type.Literal("prettier"),
				Type.Literal("stylelint"),
			],
			{
				description: "Linter runner: auto | npm | pnpm | yarn | bun | eslint | prettier | stylelint",
			},
		),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("check"), Type.Literal("fix")], {
			description: "Lint mode: check | fix (default: check).",
		}),
	),
	script: Type.Optional(
		Type.String({
			description: "Package script for npm/pnpm/yarn/bun runners (default: lint or lint:fix by mode).",
		}),
	),
	targets: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional explicit lint targets (paths/globs).",
		}),
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional CLI args forwarded to the selected linter runner.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Working directory for lint execution (default: current directory)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)." })),
});

export type LintRunToolInput = Static<typeof lintRunSchema>;
export type LintRunRunner = "auto" | "npm" | "pnpm" | "yarn" | "bun" | "eslint" | "prettier" | "stylelint";
export type LintRunMode = "check" | "fix";
export type LintRunStatus = "passed" | "failed" | "no_tests" | "error";

type ResolvedLintRunner = Exclude<LintRunRunner, "auto">;

interface ResolvedLintCommand {
	resolvedRunner: ResolvedLintRunner;
	command: string;
	args: string[];
}

export interface LintRunToolDetails {
	resolvedRunner: ResolvedLintRunner;
	resolvedCommand: string;
	resolvedArgs: string[];
	cwd: string;
	mode: LintRunMode;
	exitCode: number;
	status: LintRunStatus;
	durationMs: number;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

export const DEFAULT_LINT_RUN_TIMEOUT_SECONDS = 300;

function normalizeTimeoutSeconds(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_LINT_RUN_TIMEOUT_SECONDS;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("timeout must be a positive number.");
	}
	return value;
}

function normalizeStringArray(raw: string[] | undefined): string[] {
	return (raw ?? []).map((item) => String(item));
}

function normalizeScriptName(raw: string | undefined, mode: LintRunMode): string {
	const fallback = mode === "fix" ? "lint:fix" : "lint";
	const script = (raw ?? fallback).trim();
	if (script.length === 0) {
		throw new Error("script must not be empty.");
	}
	return script;
}

function hasAnyFile(cwd: string, fileNames: string[]): boolean {
	return fileNames.some((name) => existsSync(join(cwd, name)));
}

function hasEslintConfig(cwd: string, packageJsonEslintConfig: unknown): boolean {
	if (packageJsonEslintConfig && typeof packageJsonEslintConfig === "object") {
		return true;
	}
	return hasAnyFile(cwd, [
		"eslint.config.js",
		"eslint.config.cjs",
		"eslint.config.mjs",
		"eslint.config.ts",
		"eslint.config.mts",
		"eslint.config.cts",
		".eslintrc",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.mjs",
		".eslintrc.yaml",
		".eslintrc.yml",
		".eslintrc.json",
	]);
}

function hasStylelintConfig(cwd: string, packageJsonStylelint: unknown): boolean {
	if (packageJsonStylelint && typeof packageJsonStylelint === "object") {
		return true;
	}
	return hasAnyFile(cwd, [
		"stylelint.config.js",
		"stylelint.config.cjs",
		"stylelint.config.mjs",
		"stylelint.config.ts",
		"stylelint.config.mts",
		"stylelint.config.cts",
		".stylelintrc",
		".stylelintrc.js",
		".stylelintrc.cjs",
		".stylelintrc.mjs",
		".stylelintrc.yaml",
		".stylelintrc.yml",
		".stylelintrc.json",
	]);
}

function hasPrettierConfig(cwd: string, packageJsonPrettier: unknown): boolean {
	if (typeof packageJsonPrettier === "string" || (packageJsonPrettier && typeof packageJsonPrettier === "object")) {
		return true;
	}
	return hasAnyFile(cwd, [
		".prettierrc",
		".prettierrc.js",
		".prettierrc.cjs",
		".prettierrc.mjs",
		".prettierrc.json",
		".prettierrc.yaml",
		".prettierrc.yml",
		".prettierrc.toml",
		"prettier.config.js",
		"prettier.config.cjs",
		"prettier.config.mjs",
	]);
}

function assertPackageManagerAvailable(packageManager: PackageManager): void {
	if (packageManager === "bun") {
		ensureCommandOrThrow("bun", 'Command "bun" is required for bun-based lint execution.');
		return;
	}
	ensureCommandOrThrow(packageManager, `Command "${packageManager}" is required for lint execution.`);
}

function resolveScriptBasedCommand(packageManager: PackageManager, script: string, args: string[]): ResolvedLintCommand {
	assertPackageManagerAvailable(packageManager);
	const invocation = resolvePackageManagerRunInvocation(packageManager, script, args);
	return {
		resolvedRunner: packageManager,
		command: invocation.command,
		args: invocation.args,
	};
}

function buildDirectLintArgs(
	runner: "eslint" | "prettier" | "stylelint",
	mode: LintRunMode,
	targets: string[],
	args: string[],
): string[] {
	const effectiveTargets =
		targets.length > 0 ? targets : runner === "stylelint" ? ["**/*.{css,scss,sass,less}"] : ["."];

	if (runner === "eslint") {
		const modeArgs = mode === "fix" ? ["--fix"] : [];
		return [...modeArgs, ...args, ...effectiveTargets];
	}
	if (runner === "prettier") {
		const modeArgs = mode === "fix" ? ["--write"] : ["--check"];
		return [...modeArgs, ...args, ...effectiveTargets];
	}
	const modeArgs = mode === "fix" ? ["--fix"] : [];
	return [...modeArgs, ...args, ...effectiveTargets];
}

function resolveDirectLintCommand(
	packageManager: PackageManager,
	runner: "eslint" | "prettier" | "stylelint",
	mode: LintRunMode,
	targets: string[],
	args: string[],
): ResolvedLintCommand {
	assertPackageManagerAvailable(packageManager);
	const directArgs = buildDirectLintArgs(runner, mode, targets, args);
	const invocation = resolvePackageManagerExecInvocation(packageManager, runner, directArgs);
	ensureCommandOrThrow(
		invocation.command,
		`Command "${invocation.command}" is required to run ${runner}. Install ${packageManager} tooling first.`,
	);
	return {
		resolvedRunner: runner,
		command: invocation.command,
		args: invocation.args,
	};
}

function resolveAutoRunner(cwd: string, script: string): ResolvedLintRunner {
	const packageJson = readPackageJson(cwd);
	if (packageJson?.scripts[script]) {
		return detectPackageManager(cwd);
	}
	if (hasEslintConfig(cwd, packageJson?.raw?.eslintConfig)) return "eslint";
	if (hasStylelintConfig(cwd, packageJson?.raw?.stylelint)) return "stylelint";
	if (hasPrettierConfig(cwd, packageJson?.raw?.prettier)) return "prettier";
	throw new Error(
		'Unable to auto-detect lint runner. Expected package.json lint script or eslint/stylelint/prettier config.',
	);
}

function hasCheckModeConflictArgs(args: string[]): string | undefined {
	for (const arg of args) {
		if (arg === "--fix" || arg.startsWith("--fix=") || arg === "--write" || arg.startsWith("--write=")) {
			return arg;
		}
	}
	return undefined;
}

function resolveLintCommand(input: {
	cwd: string;
	runner: LintRunRunner;
	mode: LintRunMode;
	script: string;
	args: string[];
	targets: string[];
}): ResolvedLintCommand {
	const packageJson = readPackageJson(input.cwd);
	let resolvedRunner: ResolvedLintRunner;

	if (input.runner === "auto") {
		resolvedRunner = resolveAutoRunner(input.cwd, input.script);
	} else {
		resolvedRunner = input.runner;
	}

	if (resolvedRunner === "npm" || resolvedRunner === "pnpm" || resolvedRunner === "yarn" || resolvedRunner === "bun") {
		if (!packageJson) {
			throw new Error(`package.json is required to run ${resolvedRunner} scripts.`);
		}
		if (!packageJson.scripts[input.script]) {
			throw new Error(`Script "${input.script}" is not defined in package.json.`);
		}
		return resolveScriptBasedCommand(resolvedRunner, input.script, input.args);
	}

	const packageManager = detectPackageManager(input.cwd);
	return resolveDirectLintCommand(packageManager, resolvedRunner, input.mode, input.targets, input.args);
}

function mapLintStatus(exitCode: number): LintRunStatus {
	if (exitCode === 0) return "passed";
	if (exitCode === 1) return "failed";
	return "error";
}

function renderSummary(details: LintRunToolDetails, output: string): string {
	const argsText = details.resolvedArgs.length > 0 ? ` ${details.resolvedArgs.join(" ")}` : "";
	return [
		`lint_run status: ${details.status}`,
		`runner: ${details.resolvedRunner}`,
		`mode: ${details.mode}`,
		`command: ${details.resolvedCommand}${argsText}`,
		`cwd: ${details.cwd}`,
		`exit_code: ${details.exitCode}`,
		`duration_ms: ${details.durationMs}`,
		"",
		output,
	].join("\n");
}

export function createLintRunTool(cwd: string): AgentTool<typeof lintRunSchema> {
	return {
		name: "lint_run",
		label: "lint_run",
		description:
			"Structured lint runner with auto detection across npm/pnpm/yarn/bun scripts and eslint/prettier/stylelint direct execution. Returns normalized status without throwing on ordinary lint failures.",
		parameters: lintRunSchema,
		execute: async (_toolCallId: string, input: LintRunToolInput, signal?: AbortSignal) => {
			const executionCwd = resolveToCwd(input.path || ".", cwd);
			const timeoutSeconds = normalizeTimeoutSeconds(input.timeout);
			const args = normalizeStringArray(input.args);
			const targets = normalizeStringArray(input.targets);
			const mode: LintRunMode = input.mode ?? "check";
			const script = normalizeScriptName(input.script, mode);
			const runner: LintRunRunner = input.runner ?? "auto";

			if (mode === "check") {
				const conflictArg = hasCheckModeConflictArgs(args);
				if (conflictArg) {
					throw new Error(`Argument "${conflictArg}" is incompatible with mode=check.`);
				}
			}

			const command = resolveLintCommand({
				cwd: executionCwd,
				runner,
				mode,
				script,
				args,
				targets,
			});

			const result = await runVerificationCommand({
				command: command.command,
				args: command.args,
				cwd: executionCwd,
				timeoutMs: timeoutSeconds * 1000,
				signal,
			});

			const status = mapLintStatus(result.exitCode);
			const formatted = formatVerificationOutput(
				result.stdout,
				result.stderr,
				result.captureTruncated,
				"No lint output",
			);

			const details: LintRunToolDetails = {
				resolvedRunner: command.resolvedRunner,
				resolvedCommand: command.command,
				resolvedArgs: command.args,
				cwd: executionCwd,
				mode,
				exitCode: result.exitCode,
				status,
				durationMs: result.durationMs,
				captureTruncated: result.captureTruncated || undefined,
				truncation: formatted.truncation,
			};

			return {
				content: [{ type: "text", text: renderSummary(details, formatted.text) }],
				details,
			};
		},
	};
}

export const lintRunTool = createLintRunTool(process.cwd());

