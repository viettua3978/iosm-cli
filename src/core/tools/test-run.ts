import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import type { TruncationResult } from "./truncate.js";
import {
	type PackageManager,
	commandExists,
	detectPackageManager,
	ensureCommandOrThrow,
	formatVerificationOutput,
	readPackageJson,
	resolvePackageManagerExecInvocation,
	resolvePackageManagerRunInvocation,
	runVerificationCommand,
} from "./verification-runner.js";

const testRunSchema = Type.Object({
	runner: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("npm"),
				Type.Literal("pnpm"),
				Type.Literal("yarn"),
				Type.Literal("bun"),
				Type.Literal("vitest"),
				Type.Literal("jest"),
				Type.Literal("pytest"),
			],
			{
				description: "Test runner: auto | npm | pnpm | yarn | bun | vitest | jest | pytest",
			},
		),
	),
	script: Type.Optional(
		Type.String({
			description: "Package script for npm/pnpm/yarn/bun runners (default: test).",
		}),
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional arguments forwarded to the selected runner.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Working directory for running tests (default: current directory)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 900)." })),
});

export type TestRunToolInput = Static<typeof testRunSchema>;
export type TestRunRunner = "auto" | "npm" | "pnpm" | "yarn" | "bun" | "vitest" | "jest" | "pytest";
export type TestRunStatus = "passed" | "failed" | "no_tests" | "error";

type ResolvedTestRunner = Exclude<TestRunRunner, "auto">;

interface ResolvedTestCommand {
	resolvedRunner: ResolvedTestRunner;
	command: string;
	args: string[];
}

export interface TestRunToolDetails {
	resolvedRunner: ResolvedTestRunner;
	resolvedCommand: string;
	resolvedArgs: string[];
	cwd: string;
	exitCode: number;
	status: TestRunStatus;
	durationMs: number;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

export const DEFAULT_TEST_RUN_TIMEOUT_SECONDS = 900;

function normalizeTimeoutSeconds(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_TEST_RUN_TIMEOUT_SECONDS;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("timeout must be a positive number.");
	}
	return value;
}

function normalizeStringArray(raw: string[] | undefined): string[] {
	return (raw ?? []).map((item) => String(item));
}

function normalizeScriptName(raw: string | undefined, fallback: string): string {
	const script = (raw ?? fallback).trim();
	if (script.length === 0) {
		throw new Error("script must not be empty.");
	}
	return script;
}

function hasAnyFile(cwd: string, fileNames: string[]): boolean {
	return fileNames.some((name) => existsSync(join(cwd, name)));
}

function hasVitestConfig(cwd: string): boolean {
	return hasAnyFile(cwd, [
		"vitest.config.ts",
		"vitest.config.js",
		"vitest.config.mjs",
		"vitest.config.cjs",
		"vitest.config.mts",
		"vitest.config.cts",
	]);
}

function hasJestConfig(cwd: string, packageJsonJest: unknown): boolean {
	if (packageJsonJest && typeof packageJsonJest === "object") {
		return true;
	}
	return hasAnyFile(cwd, [
		"jest.config.ts",
		"jest.config.js",
		"jest.config.mjs",
		"jest.config.cjs",
		"jest.config.json",
		"jest.config.mts",
		"jest.config.cts",
	]);
}

function hasPythonMarkers(cwd: string): boolean {
	return hasAnyFile(cwd, [
		"pyproject.toml",
		"pytest.ini",
		"tox.ini",
		"setup.cfg",
		"requirements.txt",
		"requirements-dev.txt",
	]);
}

function assertPackageManagerAvailable(packageManager: PackageManager): void {
	if (packageManager === "bun") {
		ensureCommandOrThrow("bun", 'Command "bun" is required for bun-based test execution.');
		return;
	}
	ensureCommandOrThrow(packageManager, `Command "${packageManager}" is required for test execution.`);
}

function resolveScriptBasedCommand(
	packageManager: PackageManager,
	script: string,
	args: string[],
): ResolvedTestCommand {
	assertPackageManagerAvailable(packageManager);
	const invocation = resolvePackageManagerRunInvocation(packageManager, script, args);
	return {
		resolvedRunner: packageManager,
		command: invocation.command,
		args: invocation.args,
	};
}

function resolveFrameworkCommand(
	packageManager: PackageManager,
	runner: "vitest" | "jest",
	args: string[],
): ResolvedTestCommand {
	assertPackageManagerAvailable(packageManager);
	const invocation = resolvePackageManagerExecInvocation(packageManager, runner, args);
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

function resolvePytestCommand(args: string[]): ResolvedTestCommand {
	if (commandExists("python3")) {
		return {
			resolvedRunner: "pytest",
			command: "python3",
			args: ["-m", "pytest", ...args],
		};
	}
	if (commandExists("pytest")) {
		return {
			resolvedRunner: "pytest",
			command: "pytest",
			args,
		};
	}
	throw new Error('No pytest runtime found. Install python3 + pytest or expose "pytest" in PATH.');
}

function resolveAutoRunner(cwd: string, script: string): ResolvedTestRunner {
	const packageJson = readPackageJson(cwd);
	if (packageJson?.scripts[script]) {
		return detectPackageManager(cwd);
	}
	if (hasVitestConfig(cwd)) return "vitest";
	if (hasJestConfig(cwd, packageJson?.raw?.jest)) return "jest";
	if (hasPythonMarkers(cwd)) return "pytest";
	throw new Error(
		'Unable to auto-detect test runner. Expected package.json script, vitest/jest config, or python pytest markers.',
	);
}

function resolveTestCommand(input: {
	cwd: string;
	runner: TestRunRunner;
	script: string;
	args: string[];
}): ResolvedTestCommand {
	const packageJson = readPackageJson(input.cwd);
	const detectedPackageManager = detectPackageManager(input.cwd);
	let resolvedRunner: ResolvedTestRunner;

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

	if (resolvedRunner === "vitest" || resolvedRunner === "jest") {
		return resolveFrameworkCommand(detectedPackageManager, resolvedRunner, input.args);
	}

	return resolvePytestCommand(input.args);
}

function mapTestStatus(resolvedRunner: ResolvedTestRunner, exitCode: number): TestRunStatus {
	if (exitCode === 0) return "passed";
	if (resolvedRunner === "pytest" && exitCode === 5) return "no_tests";
	if (exitCode === 1) return "failed";
	return "error";
}

function indicatesPytestModuleMissing(output: string): boolean {
	return /No module named pytest|ModuleNotFoundError:\s*No module named ['"]pytest['"]/i.test(output);
}

function renderSummary(details: TestRunToolDetails, output: string): string {
	const argsText = details.resolvedArgs.length > 0 ? ` ${details.resolvedArgs.join(" ")}` : "";
	return [
		`test_run status: ${details.status}`,
		`runner: ${details.resolvedRunner}`,
		`command: ${details.resolvedCommand}${argsText}`,
		`cwd: ${details.cwd}`,
		`exit_code: ${details.exitCode}`,
		`duration_ms: ${details.durationMs}`,
		"",
		output,
	].join("\n");
}

export function createTestRunTool(cwd: string): AgentTool<typeof testRunSchema> {
	return {
		name: "test_run",
		label: "test_run",
		description:
			"Structured test runner with auto detection across npm/pnpm/yarn/bun, vitest, jest, and pytest. Returns normalized status without throwing on ordinary test failures.",
		parameters: testRunSchema,
		execute: async (_toolCallId: string, input: TestRunToolInput, signal?: AbortSignal) => {
			const executionCwd = resolveToCwd(input.path || ".", cwd);
			const timeoutSeconds = normalizeTimeoutSeconds(input.timeout);
			const normalizedArgs = normalizeStringArray(input.args);
			const script = normalizeScriptName(input.script, "test");
			const runner = input.runner ?? "auto";

			let command = resolveTestCommand({
				cwd: executionCwd,
				runner,
				script,
				args: normalizedArgs,
			});

			let result = await runVerificationCommand({
				command: command.command,
				args: command.args,
				cwd: executionCwd,
				timeoutMs: timeoutSeconds * 1000,
				signal,
			});

			// python3 -m pytest fallback to bare pytest when pytest module is unavailable
			if (
				command.resolvedRunner === "pytest" &&
				command.command === "python3" &&
				result.exitCode !== 0 &&
				indicatesPytestModuleMissing(`${result.stdout}\n${result.stderr}`) &&
				commandExists("pytest")
			) {
				const fallback = await runVerificationCommand({
					command: "pytest",
					args: normalizedArgs,
					cwd: executionCwd,
					timeoutMs: timeoutSeconds * 1000,
					signal,
				});
				command = { resolvedRunner: "pytest", command: "pytest", args: normalizedArgs };
				result = {
					...fallback,
					durationMs: result.durationMs + fallback.durationMs,
				};
			}

			const status = mapTestStatus(command.resolvedRunner, result.exitCode);
			const formatted = formatVerificationOutput(
				result.stdout,
				result.stderr,
				result.captureTruncated,
				"No test output",
			);

			const details: TestRunToolDetails = {
				resolvedRunner: command.resolvedRunner,
				resolvedCommand: command.command,
				resolvedArgs: command.args,
				cwd: executionCwd,
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

export const testRunTool = createTestRunTool(process.cwd());

