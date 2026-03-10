import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeScopedSemanticConfig } from "../src/core/semantic/index.js";
import { createSemanticSearchTool } from "../src/core/tools/semantic-search.js";

function vectorFromText(text: string): number[] {
	const normalized = text.toLowerCase();
	let sum = 0;
	for (const ch of normalized) sum += ch.charCodeAt(0);
	return [normalized.length, sum % 911, normalized.includes("cache") ? 1 : 0];
}

describe("semantic_search tool", () => {
	let tempDir: string;
	let projectDir: string;
	let agentDir: string;
	let originalFetch: typeof globalThis.fetch;
	let originalApiKey: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-semantic-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		writeFileSync(
			join(projectDir, "src", "cache.ts"),
			"export const cacheKey = (id: string) => `cache-${id}`;\n",
			"utf8",
		);

		writeScopedSemanticConfig(
			"user",
			{
				semanticSearch: {
					enabled: true,
					provider: {
						type: "custom_openai",
						model: "test-tool-embed",
						baseUrl: "http://127.0.0.1:18081/v1",
						apiKeyEnv: "SEMANTIC_TOOL_API_KEY",
					},
				},
			},
			projectDir,
			agentDir,
		);

		originalApiKey = process.env.SEMANTIC_TOOL_API_KEY;
		process.env.SEMANTIC_TOOL_API_KEY = "semantic-tool-key";

		originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const bodyRaw = typeof init?.body === "string" ? init.body : "";
			const payload = JSON.parse(bodyRaw) as { input?: string[] };
			const input = Array.isArray(payload.input) ? payload.input : [];
			return new Response(
				JSON.stringify({
					data: input.map((text, index) => ({ index, embedding: vectorFromText(text) })),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalApiKey === undefined) {
			delete process.env.SEMANTIC_TOOL_API_KEY;
		} else {
			process.env.SEMANTIC_TOOL_API_KEY = originalApiKey;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("supports status/index/query actions", async () => {
		const tool = createSemanticSearchTool(projectDir, { agentDir });

		const statusResult = await tool.execute("semantic-status", { action: "status" });
		const statusText = statusResult.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(statusText).toContain("configured: yes");

		const indexResult = await tool.execute("semantic-index", { action: "index" });
		const indexText = indexResult.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(indexText).toContain("action: index");

		const queryResult = await tool.execute("semantic-query", {
			action: "query",
			query: "cache key builder",
			top_k: 5,
		});
		const queryText = queryResult.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(queryText).toContain("hits:");
		expect(queryText).toContain("cache.ts");
	});
});
