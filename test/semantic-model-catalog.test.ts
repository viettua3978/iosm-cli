import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isLikelyEmbeddingModelId,
	listOllamaLocalModels,
	listOpenRouterEmbeddingModels,
} from "../src/core/semantic/index.js";

describe("semantic model catalogs", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("loads OpenRouter embedding models from the embeddings catalog endpoint", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [{ id: "nvidia/llama-nemotron-embed-vl-1b-v2:free" }, { id: "openai/text-embedding-3-small" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const models = await listOpenRouterEmbeddingModels({ timeoutMs: 2000 });
		expect(models).toEqual(["nvidia/llama-nemotron-embed-vl-1b-v2:free", "openai/text-embedding-3-small"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("/api/v1/embeddings/models");
	});

	it("falls back to /models and filters embedding-like entries", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/v1/embeddings/models")) {
				return new Response("not found", { status: 404 });
			}
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "openai/text-embedding-3-small",
							architecture: { modality: "text->embeddings", output_modalities: ["embeddings"] },
						},
						{
							id: "openai/gpt-5.4",
							architecture: { modality: "text->text", output_modalities: ["text"] },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const models = await listOpenRouterEmbeddingModels({ timeoutMs: 2000 });
		expect(models).toEqual(["openai/text-embedding-3-small"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("lists local Ollama models and prioritizes embedding-like names", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					models: [
						{ model: "llama3.2:latest" },
						{ model: "nomic-embed-text:latest" },
						{ model: "mxbai-embed-large:latest" },
						{ model: "deepseek-r1:latest" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const models = await listOllamaLocalModels({ baseUrl: "http://127.0.0.1:11434", timeoutMs: 2000 });
		expect(models).toEqual([
			"mxbai-embed-large:latest",
			"nomic-embed-text:latest",
			"deepseek-r1:latest",
			"llama3.2:latest",
		]);
		expect(isLikelyEmbeddingModelId(models[0]!)).toBe(true);
		expect(isLikelyEmbeddingModelId(models[1]!)).toBe(true);
		expect(isLikelyEmbeddingModelId(models[2]!)).toBe(false);
	});
});
