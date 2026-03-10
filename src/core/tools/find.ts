import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { createInterface } from "node:readline";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { ensureTool } from "../../utils/tools-manager.js";
import { createPathIgnoreFilter } from "./ignore-filter.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	glob: (_pattern, _searchCwd, _options) => {
		// This is a placeholder - actual fd execution happens in execute
		return [];
	},
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem + fd */
	operations?: FindOperations;
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	const customOps = options?.operations;

	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: findSchema,
		execute: async (
			_toolCallId: string,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const earlyAbortHandler = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", earlyAbortHandler, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						if (!(await ops.exists(searchPath))) {
							reject(new Error(`Path not found: ${searchPath}`));
							return;
						}

						// If custom operations provided with glob, use that
						if (customOps?.glob) {
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});

							signal?.removeEventListener("abort", earlyAbortHandler);

							if (results.length === 0) {
								resolve({
									content: [{ type: "text", text: "No files found matching pattern" }],
									details: undefined,
								});
								return;
							}

							// Relativize paths
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) {
									return p.slice(searchPath.length + 1);
								}
								return path.relative(searchPath, p);
							});

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];

							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}

							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}

							resolve({
								content: [{ type: "text", text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							});
							return;
						}

						// Default: use fd
						const fdPath = await ensureTool("fd", true);
						if (!fdPath) {
							reject(new Error("fd is not available and could not be downloaded"));
							return;
						}
						const ignoreFilter = createPathIgnoreFilter(searchPath);

						// Build fd arguments. Keep hidden files visible, but still exclude
						// high-noise implementation directories that are almost never useful.
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--exclude",
							".git",
							"--exclude",
							"node_modules",
						];

						args.push(pattern, searchPath);
						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let aborted = false;
						let killedDueToLimit = false;
						let resultLimitReached = false;
						const relativized: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", childAbortHandler);
						};

						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};

						const childAbortHandler = () => {
							aborted = true;
							stopChild();
						};

						signal?.removeEventListener("abort", earlyAbortHandler);
						signal?.addEventListener("abort", childAbortHandler, { once: true });

						rl.on("line", (rawLine) => {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) {
								return;
							}

							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1);
							} else {
								relativePath = path.relative(searchPath, line);
							}

							if (hadTrailingSlash && !relativePath.endsWith("/")) {
								relativePath += "/";
							}

							const absolutePath = line.startsWith(searchPath) ? line : path.resolve(searchPath, relativePath);
							if (ignoreFilter.ignores(absolutePath)) {
								return;
							}

							relativized.push(relativePath);
							if (relativized.length >= effectiveLimit) {
								resultLimitReached = true;
								stopChild(true);
							}
						});

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						child.on("error", (error) => {
							cleanup();
							reject(new Error(`Failed to run fd: ${error.message}`));
						});

						child.on("close", (code) => {
							cleanup();

							if (aborted) {
								reject(new Error("Operation aborted"));
								return;
							}

							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								reject(new Error(errorMsg));
								return;
							}

							if (relativized.length === 0) {
								resolve({
									content: [{ type: "text", text: "No files found matching pattern" }],
									details: undefined,
								});
								return;
							}

							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];

							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}

							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}

							resolve({
								content: [{ type: "text", text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							});
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", earlyAbortHandler);
						reject(e);
					}
				})();
			});
		},
	};
}

/** Default find tool using process.cwd() - for backwards compatibility */
export const findTool = createFindTool(process.cwd());
