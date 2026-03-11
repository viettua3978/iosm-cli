import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SemanticSearchRuntime, writeScopedSemanticConfig } from "../src/core/semantic/index.js";

function vectorFromText(text: string, dimension: number = 4): number[] {
	const normalized = text.toLowerCase();
	const words = normalized.split(/\s+/).filter(Boolean);
	let charSum = 0;
	for (const ch of normalized) {
		charSum += ch.charCodeAt(0);
	}
	const base = [
		normalized.length,
		words.length,
		charSum % 997,
		normalized.includes("auth") ? 1 : 0,
	];
	const vector: number[] = [];
	for (let i = 0; i < dimension; i++) {
		vector.push(base[i % base.length]! + i * 0.0001);
	}
	return vector;
}

describe("semantic runtime", () => {
	let tempDir: string;
	let projectDir: string;
	let agentDir: string;
	let originalFetch: typeof globalThis.fetch;
	let originalApiKey: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-semantic-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		writeFileSync(
			join(projectDir, "src", "auth.ts"),
			[
				"export function validateAuthToken(token: string): boolean {",
				"  return token.length > 10;",
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(projectDir, "src", "session.ts"),
			[
				"export function createSessionCookie(userId: string): string {",
				"  return `session-${userId}`;",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		writeScopedSemanticConfig(
			"user",
			{
				semanticSearch: {
					enabled: true,
					autoIndex: false,
					provider: {
						type: "custom_openai",
						model: "test-embedding-small",
						baseUrl: "http://127.0.0.1:18080/v1",
						apiKeyEnv: "SEMANTIC_TEST_API_KEY",
						batchSize: 16,
						timeoutMs: 30000,
					},
					index: {
						includeGlobs: ["src/**/*.{ts,js,md,json,yaml,yml}"],
						excludeGlobs: ["**/node_modules/**", "**/.git/**", "**/.iosm/**"],
						chunkMaxChars: 700,
						chunkOverlapChars: 120,
						maxFileBytes: 262144,
						maxFiles: 5000,
					},
				},
			},
			projectDir,
			agentDir,
		);

		originalApiKey = process.env.SEMANTIC_TEST_API_KEY;
		process.env.SEMANTIC_TEST_API_KEY = "semantic-test-key";

		originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const bodyRaw = typeof init?.body === "string" ? init.body : "";
			const payload = JSON.parse(bodyRaw) as { input?: string[]; model?: string };
			const input = Array.isArray(payload.input) ? payload.input : [];
			const dimension = String(payload.model ?? "").includes("dim6") ? 6 : 4;
			const data = input.map((text, index) => ({ index, embedding: vectorFromText(text, dimension) }));
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalApiKey === undefined) {
			delete process.env.SEMANTIC_TEST_API_KEY;
		} else {
			process.env.SEMANTIC_TEST_API_KEY = originalApiKey;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("indexes and queries with optional incremental refresh", async () => {
		const runtime = new SemanticSearchRuntime({
			cwd: projectDir,
			agentDir,
		});

		const statusBefore = await runtime.status();
		expect(statusBefore.configured).toBe(true);
		expect(statusBefore.autoIndex).toBe(false);
		expect(statusBefore.indexed).toBe(false);

		const indexResult = await runtime.index();
		expect(indexResult.processedFiles).toBeGreaterThan(0);
		expect(indexResult.chunks).toBeGreaterThan(0);
		expect(indexResult.dimension).toBe(4);

		const queryResult = await runtime.query("validate authentication token", 5);
		expect(queryResult.autoRefreshed).toBe(false);
		expect(queryResult.hits.length).toBeGreaterThan(0);
		expect(queryResult.hits.some((hit) => hit.path.endsWith("src/auth.ts"))).toBe(true);

		writeFileSync(
			join(projectDir, "src", "auth.ts"),
			[
				"export function validateAuthToken(token: string): boolean {",
				"  if (token.startsWith('tmp_')) return false;",
				"  return token.length > 10;",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const staleStatus = await runtime.status();
		expect(staleStatus.stale).toBe(true);

		await expect(runtime.query("temporary auth token rule", 5)).rejects.toThrow(
			"auto-indexing is disabled",
		);

		writeScopedSemanticConfig(
			"user",
			{
				semanticSearch: {
					enabled: true,
					autoIndex: true,
					provider: {
						type: "custom_openai",
						model: "test-embedding-small",
						baseUrl: "http://127.0.0.1:18080/v1",
						apiKeyEnv: "SEMANTIC_TEST_API_KEY",
						batchSize: 16,
						timeoutMs: 30000,
					},
					index: {
						includeGlobs: ["src/**/*.{ts,js,md,json,yaml,yml}"],
						excludeGlobs: ["**/node_modules/**", "**/.git/**", "**/.iosm/**"],
						chunkMaxChars: 700,
						chunkOverlapChars: 120,
						maxFileBytes: 262144,
						maxFiles: 5000,
					},
				},
			},
			projectDir,
			agentDir,
		);

		const refreshedQuery = await runtime.query("temporary auth token rule", 5);
		expect(refreshedQuery.autoRefreshed).toBe(true);
		expect(refreshedQuery.hits.length).toBeGreaterThan(0);
	});

	it("rebuild resets dimension when embedding model changes", async () => {
		const runtime = new SemanticSearchRuntime({
			cwd: projectDir,
			agentDir,
		});

		const initial = await runtime.rebuild();
		expect(initial.dimension).toBe(4);

		writeScopedSemanticConfig(
			"user",
			{
				semanticSearch: {
					enabled: true,
					autoIndex: false,
					provider: {
						type: "custom_openai",
						model: "test-embedding-dim6",
						baseUrl: "http://127.0.0.1:18080/v1",
						apiKeyEnv: "SEMANTIC_TEST_API_KEY",
						batchSize: 16,
						timeoutMs: 30000,
					},
					index: {
						includeGlobs: ["src/**/*.{ts,js,md,json,yaml,yml}"],
						excludeGlobs: ["**/node_modules/**", "**/.git/**", "**/.iosm/**"],
						chunkMaxChars: 700,
						chunkOverlapChars: 120,
						maxFileBytes: 262144,
						maxFiles: 5000,
					},
				},
			},
			projectDir,
			agentDir,
		);

		const changedRuntime = new SemanticSearchRuntime({
			cwd: projectDir,
			agentDir,
		});
		const staleStatus = await changedRuntime.status();
		expect(staleStatus.stale).toBe(true);

		const rebuilt = await changedRuntime.rebuild();
		expect(rebuilt.dimension).toBe(6);

		const statusAfter = await changedRuntime.status();
		expect(statusAfter.stale).toBe(false);
		expect(statusAfter.dimension).toBe(6);
	});
});
