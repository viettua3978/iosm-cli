import { spawn, spawnSync } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

const externalCliSchema = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Arguments passed directly to the command (no shell interpolation)",
		}),
	),
	path: Type.Optional(Type.String({ description: "Working directory for the command (default: current directory)" })),
	stdin: Type.Optional(Type.String({ description: "Optional text piped to the command stdin" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
});

export type ExternalCliToolInput = Static<typeof externalCliSchema>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 512 * 1024;

interface RunCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	captureTruncated: boolean;
}

export interface ExternalCliToolDetails {
	command: string;
	args: string[];
	cwd: string;
	exitCode: number;
	truncation?: TruncationResult;
	captureTruncated?: boolean;
}

export interface ExternalCliToolOptions {
	name: string;
	label?: string;
	description: string;
	commandCandidates: string[];
	ensureManagedTool?: "fd" | "rg";
	allowExitCodes?: number[];
	emptyOutputMessage?: string;
	missingInstallHint?: string;
	forbiddenArgs?: string[];
	forbiddenArgPrefixes?: string[];
}

function commandExists(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "pipe" });
		const err = result.error as NodeJS.ErrnoException | undefined;
		return !err || err.code !== "ENOENT";
	} catch {
		return false;
	}
}

function includesForbiddenArg(args: string[], exact: Set<string>, prefixes: string[]): string | undefined {
	for (const arg of args) {
		if (exact.has(arg)) {
			return arg;
		}
		for (const prefix of prefixes) {
			if (arg === prefix || arg.startsWith(prefix)) {
				return arg;
			}
		}
	}
	return undefined;
}

async function resolveCommand(options: ExternalCliToolOptions): Promise<string | undefined> {
	if (options.ensureManagedTool) {
		const managed = await ensureTool(options.ensureManagedTool, true);
		if (managed) {
			return managed;
		}
	}

	for (const candidate of options.commandCandidates) {
		if (commandExists(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	stdin: string | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RunCommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const child = spawn(command, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdoutChunks: Buffer[] = [];
		let stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let captureTruncated = false;
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		const captureChunk = (
			chunk: Buffer,
			chunks: Buffer[],
			currentBytes: number,
		): { nextBytes: number; truncated: boolean } => {
			if (currentBytes >= MAX_CAPTURE_BYTES) {
				return { nextBytes: currentBytes, truncated: true };
			}
			const remaining = MAX_CAPTURE_BYTES - currentBytes;
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				return { nextBytes: currentBytes + chunk.length, truncated: false };
			}
			chunks.push(chunk.subarray(0, remaining));
			return { nextBytes: MAX_CAPTURE_BYTES, truncated: true };
		};

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, Math.max(1_000, timeoutMs));

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			const captured = captureChunk(chunk, stdoutChunks, stdoutBytes);
			stdoutBytes = captured.nextBytes;
			captureTruncated = captureTruncated || captured.truncated;
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const captured = captureChunk(chunk, stderrChunks, stderrBytes);
			stderrBytes = captured.nextBytes;
			captureTruncated = captureTruncated || captured.truncated;
		});

		if (stdin !== undefined) {
			child.stdin.write(stdin);
		}
		child.stdin.end();

		child.on("error", (error) => {
			cleanup();
			settle(() => reject(new Error(`Failed to run ${command}: ${error.message}`)));
		});

		child.on("close", (code) => {
			cleanup();

			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}

			if (timedOut) {
				settle(() => reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`)));
				return;
			}

			settle(() =>
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? -1,
					captureTruncated,
				}),
			);
		});
	});
}

export function createExternalCliTool(cwd: string, options: ExternalCliToolOptions): AgentTool<typeof externalCliSchema> {
	const allowExitCodes = new Set(options.allowExitCodes ?? [0]);
	const forbiddenArgs = new Set(options.forbiddenArgs ?? []);
	const forbiddenPrefixes = options.forbiddenArgPrefixes ?? [];

	return {
		name: options.name,
		label: options.label ?? options.name,
		description: options.description,
		parameters: externalCliSchema,
		execute: async (
			_toolCallId: string,
			{ args, path, stdin, timeout }: { args?: string[]; path?: string; stdin?: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			const normalizedArgs = (args ?? []).map((arg) => String(arg));
			const blockedArg = includesForbiddenArg(normalizedArgs, forbiddenArgs, forbiddenPrefixes);
			if (blockedArg) {
				throw new Error(`Argument "${blockedArg}" is not allowed for ${options.name}.`);
			}

			const command = await resolveCommand(options);
			if (!command) {
				const hint = options.missingInstallHint ? ` ${options.missingInstallHint}` : "";
				throw new Error(`${options.name} command is not available.${hint}`);
			}

			const executionCwd = resolveToCwd(path || ".", cwd);
			const timeoutMs = Math.round((timeout ?? 30) * 1000);
			const result = await runCommand(command, normalizedArgs, executionCwd, stdin, timeoutMs, signal);

			if (!allowExitCodes.has(result.exitCode)) {
				const errorText = result.stderr.trim() || result.stdout.trim() || `${options.name} exited with code ${result.exitCode}`;
				throw new Error(errorText);
			}

			let output = result.stdout.trimEnd();
			if (!output && result.stderr.trim().length > 0) {
				output = result.stderr.trimEnd();
			}
			if (!output) {
				output = options.emptyOutputMessage ?? "No output";
			}

			const truncation = truncateHead(output);
			let finalOutput = truncation.content;
			const details: ExternalCliToolDetails = {
				command,
				args: normalizedArgs,
				cwd: executionCwd,
				exitCode: result.exitCode,
			};
			const notices: string[] = [];

			if (truncation.truncated) {
				details.truncation = truncation;
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`);
			}
			if (result.captureTruncated) {
				details.captureTruncated = true;
				notices.push(`capture limit reached (${formatSize(MAX_CAPTURE_BYTES)})`);
			}
			if (notices.length > 0) {
				finalOutput += `\n\n[${notices.join(". ")} · showing up to ${DEFAULT_MAX_LINES} lines]`;
			}

			return {
				content: [{ type: "text", text: finalOutput }],
				details,
			};
		},
	};
}

export { externalCliSchema };
