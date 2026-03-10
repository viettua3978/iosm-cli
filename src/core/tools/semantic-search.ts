import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getAgentDir } from "../../config.js";
import type { AuthStorage } from "../auth-storage.js";
import { SemanticSearchRuntime } from "../semantic/runtime.js";
import type {
	SemanticIndexOperationResult,
	SemanticQueryResult,
	SemanticStatusResult,
	SemanticToolResult,
} from "../semantic/types.js";

const semanticSearchSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("index"),
			Type.Literal("rebuild"),
			Type.Literal("query"),
		],
		{ description: "Semantic action: status | index | rebuild | query" },
	),
	query: Type.Optional(
		Type.String({
			description: "Query text (required when action=query)",
		}),
	),
	top_k: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Maximum number of query hits to return (default: 8, max: 20)",
		}),
	),
});

export type SemanticSearchToolInput = Static<typeof semanticSearchSchema>;

export interface SemanticSearchToolOptions {
	agentDir?: string;
	authStorage?: AuthStorage;
}

function formatSemanticStatus(result: SemanticStatusResult): string {
	const lines = [
		`configured: ${result.configured ? "yes" : "no"}`,
		`enabled: ${result.enabled ? "yes" : "no"}`,
		`indexed: ${result.indexed ? "yes" : "no"}`,
		`stale: ${result.stale ? `yes${result.staleReason ? ` (${result.staleReason})` : ""}` : "no"}`,
	];
	if (result.provider) lines.push(`provider: ${result.provider}`);
	if (result.model) lines.push(`model: ${result.model}`);
	lines.push(`files: ${result.files}`);
	lines.push(`chunks: ${result.chunks}`);
	if (result.dimension !== undefined) lines.push(`dimension: ${result.dimension}`);
	if (result.ageSeconds !== undefined) lines.push(`age_seconds: ${result.ageSeconds}`);
	lines.push(`index_path: ${result.indexPath}`);
	lines.push(`config_user: ${result.configPathUser}`);
	lines.push(`config_project: ${result.configPathProject}`);
	if (!result.configured) {
		lines.push("hint: run /semantic setup, then /semantic index");
	}
	return lines.join("\n");
}

function formatSemanticIndexResult(result: SemanticIndexOperationResult): string {
	return [
		`action: ${result.action}`,
		`processed_files: ${result.processedFiles}`,
		`reused_files: ${result.reusedFiles}`,
		`new_files: ${result.newFiles}`,
		`changed_files: ${result.changedFiles}`,
		`removed_files: ${result.removedFiles}`,
		`chunks: ${result.chunks}`,
		`dimension: ${result.dimension}`,
		`duration_ms: ${result.durationMs}`,
		`built_at: ${result.builtAt}`,
		`index_path: ${result.indexPath}`,
	].join("\n");
}

function formatSemanticQueryResult(result: SemanticQueryResult): string {
	const lines = [
		`query: ${result.query}`,
		`top_k: ${result.topK}`,
		`auto_refreshed: ${result.autoRefreshed ? "yes" : "no"}`,
	];

	if (result.hits.length === 0) {
		lines.push("hits: none");
		return lines.join("\n");
	}

	lines.push("hits:");
	for (let index = 0; index < result.hits.length; index++) {
		const hit = result.hits[index]!;
		lines.push(
			`${index + 1}. score=${hit.score.toFixed(4)} ${hit.path}:${hit.lineStart}-${hit.lineEnd} | ${hit.snippet}`,
		);
	}
	return lines.join("\n");
}

function formatSemanticToolResult(result: SemanticToolResult): string {
	if (result.action === "status") return formatSemanticStatus(result);
	if (result.action === "query") return formatSemanticQueryResult(result);
	return formatSemanticIndexResult(result);
}

export function createSemanticSearchTool(
	cwd: string,
	options?: SemanticSearchToolOptions,
): AgentTool<typeof semanticSearchSchema> {
	return {
		name: "semantic_search",
		label: "semantic_search",
		description:
			"Semantic code search with embeddings. Actions: status/index/rebuild/query. Query supports top_k (default 8, max 20).",
		parameters: semanticSearchSchema,
		execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal) => {
			const input = params as SemanticSearchToolInput;
			const runtime = new SemanticSearchRuntime({
				cwd,
				agentDir: options?.agentDir ?? getAgentDir(),
				authStorage: options?.authStorage,
			});

			let result: SemanticToolResult;
			if (input.action === "status") {
				result = await runtime.status();
			} else if (input.action === "index") {
				result = await runtime.index();
			} else if (input.action === "rebuild") {
				result = await runtime.rebuild();
			} else {
				const query = (input.query ?? "").trim();
				if (!query) {
					throw new Error("semantic_search query action requires a non-empty query");
				}
				result = await runtime.query(query, input.top_k);
			}

			return {
				content: [{ type: "text" as const, text: formatSemanticToolResult(result) }],
				details: result,
			};
		},
	};
}

export const semanticSearchTool = createSemanticSearchTool(process.cwd());
