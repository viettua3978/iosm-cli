import type { AuthStorage } from "../auth-storage.js";
import { resolveHeaders } from "../resolve-config-value.js";
import type { SemanticProviderConfig } from "./types.js";

export interface SemanticEmbeddingProvider {
	embed(texts: string[]): Promise<number[][]>;
}

export interface SemanticProviderFactoryOptions {
	authStorage?: AuthStorage;
}

export interface SemanticOpenRouterModelListOptions {
	timeoutMs?: number;
	authStorage?: AuthStorage;
}

export interface SemanticOllamaModelListOptions {
	baseUrl?: string;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertEmbeddingArray(value: unknown, source: string): number[] {
	if (!Array.isArray(value)) {
		throw new Error(`Invalid embedding payload from ${source}: expected number[]`);
	}
	const vector: number[] = [];
	for (const item of value) {
		if (typeof item !== "number" || !Number.isFinite(item)) {
			throw new Error(`Invalid embedding payload from ${source}: expected finite numbers`);
		}
		vector.push(item);
	}
	if (vector.length === 0) {
		throw new Error(`Invalid embedding payload from ${source}: empty vector`);
	}
	return vector;
}

function parseEmbeddingsFromOpenAIShape(payload: unknown, source: string): number[][] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error(`Invalid embedding response from ${source}: missing data[]`);
	}
	const vectors: number[][] = [];
	for (const row of payload.data) {
		if (!isRecord(row)) {
			throw new Error(`Invalid embedding response from ${source}: malformed data row`);
		}
		vectors.push(assertEmbeddingArray(row.embedding, source));
	}
	return vectors;
}

function parseEmbeddingsFromOllamaEmbed(payload: unknown, source: string): number[][] {
	if (!isRecord(payload) || !Array.isArray(payload.embeddings)) {
		throw new Error(`Invalid embedding response from ${source}: missing embeddings[]`);
	}
	return payload.embeddings.map((value) => assertEmbeddingArray(value, source));
}

async function requestJson(
	url: string,
	init: {
		method: "POST";
		headers: Record<string, string>;
		body: string;
		timeoutMs: number;
	},
): Promise<unknown> {
	const response = await fetch(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		signal: AbortSignal.timeout(init.timeoutMs),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const preview = body.trim().slice(0, 300);
		throw new Error(`HTTP ${response.status} from ${url}${preview ? `: ${preview}` : ""}`);
	}
	return response.json();
}

async function requestJsonGet(
	url: string,
	init: {
		headers?: Record<string, string>;
		timeoutMs: number;
	},
): Promise<unknown> {
	const response = await fetch(url, {
		method: "GET",
		headers: init.headers,
		signal: AbortSignal.timeout(init.timeoutMs),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const preview = body.trim().slice(0, 300);
		throw new Error(`HTTP ${response.status} from ${url}${preview ? `: ${preview}` : ""}`);
	}
	return response.json();
}

function buildHeaders(config: SemanticProviderConfig): Record<string, string> {
	return {
		"Content-Type": "application/json",
		...(resolveHeaders(config.headers) ?? {}),
	};
}

function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
	const value = (raw ?? fallback).trim();
	return value.replace(/\/+$/, "");
}

async function resolveOpenRouterKey(
	config: SemanticProviderConfig,
	options: SemanticProviderFactoryOptions,
): Promise<string | undefined> {
	if (config.apiKeyEnv) {
		return process.env[config.apiKeyEnv];
	}
	const fromAuth = await options.authStorage?.getApiKey("openrouter");
	if (fromAuth) return fromAuth;
	return process.env.OPENROUTER_API_KEY;
}

function chunkInput<T>(items: T[], batchSize: number): T[][] {
	const normalizedBatch = Math.max(1, batchSize);
	const batches: T[][] = [];
	for (let start = 0; start < items.length; start += normalizedBatch) {
		batches.push(items.slice(start, start + normalizedBatch));
	}
	return batches;
}

function uniqueStrings(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function looksLikeEmbeddingModalities(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.some((item) => typeof item === "string" && item.toLowerCase().includes("embedding"));
}

function looksLikeEmbeddingModelObject(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const architecture = isRecord(value.architecture) ? value.architecture : undefined;
	const modality = typeof architecture?.modality === "string" ? architecture.modality.toLowerCase() : "";
	const outputModalities = architecture?.output_modalities;
	if (modality.includes("embedding")) return true;
	if (looksLikeEmbeddingModalities(outputModalities)) return true;
	const id = typeof value.id === "string" ? value.id.toLowerCase() : "";
	return id.includes("embed") || id.includes("embedding");
}

export function isLikelyEmbeddingModelId(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return (
		normalized.includes("embed") ||
		normalized.includes("embedding") ||
		normalized.includes("bge") ||
		normalized.includes("e5") ||
		normalized.includes("gte") ||
		normalized.includes("minilm") ||
		normalized.includes("nomic")
	);
}

export async function listOpenRouterEmbeddingModels(
	options: SemanticOpenRouterModelListOptions = {},
): Promise<string[]> {
	const timeoutMs = Math.max(1_000, options.timeoutMs ?? 12_000);
	const headers: Record<string, string> = {};
	const apiKey =
		(await options.authStorage?.getApiKey("openrouter").catch(() => undefined)) ??
		process.env.OPENROUTER_API_KEY;
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const parseIds = (payload: unknown): string[] => {
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			throw new Error("Invalid models payload: missing data[]");
		}
		const ids = payload.data
			.filter((row): row is Record<string, unknown> => isRecord(row))
			.map((row) => (typeof row.id === "string" ? row.id : ""))
			.filter((id) => id.length > 0);
		return uniqueStrings(ids);
	};

	try {
		const payload = await requestJsonGet("https://openrouter.ai/api/v1/embeddings/models", {
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			timeoutMs,
		});
		const ids = parseIds(payload);
		if (ids.length > 0) return ids;
	} catch {
		// Fall back to /models below.
	}

	const payload = await requestJsonGet("https://openrouter.ai/api/v1/models", {
		headers: Object.keys(headers).length > 0 ? headers : undefined,
		timeoutMs,
	});
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid models payload: missing data[]");
	}

	const embeddingIds = payload.data
		.filter((row): row is Record<string, unknown> => isRecord(row) && looksLikeEmbeddingModelObject(row))
		.map((row) => (typeof row.id === "string" ? row.id : ""))
		.filter((id) => id.length > 0);

	return uniqueStrings(embeddingIds);
}

export async function listOllamaLocalModels(
	options: SemanticOllamaModelListOptions = {},
): Promise<string[]> {
	const timeoutMs = Math.max(1_000, options.timeoutMs ?? 8_000);
	const baseUrl = normalizeBaseUrl(options.baseUrl, "http://127.0.0.1:11434");
	const payload = await requestJsonGet(`${baseUrl}/api/tags`, {
		headers: resolveHeaders(options.headers),
		timeoutMs,
	});

	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new Error("Invalid ollama /api/tags response: missing models[]");
	}

	const ids = payload.models
		.filter((item): item is Record<string, unknown> => isRecord(item))
		.map((item) => {
			if (typeof item.model === "string" && item.model.trim().length > 0) return item.model.trim();
			if (typeof item.name === "string" && item.name.trim().length > 0) return item.name.trim();
			return "";
		})
		.filter((id) => id.length > 0);

	const unique = uniqueStrings(ids);
	return unique.sort((a, b) => {
		const aLikely = isLikelyEmbeddingModelId(a) ? 1 : 0;
		const bLikely = isLikelyEmbeddingModelId(b) ? 1 : 0;
		if (aLikely !== bLikely) return bLikely - aLikely;
		return a.localeCompare(b);
	});
}

export async function createSemanticEmbeddingProvider(
	config: SemanticProviderConfig,
	options: SemanticProviderFactoryOptions = {},
): Promise<SemanticEmbeddingProvider> {
	if (config.type === "openrouter") {
		const apiKey = await resolveOpenRouterKey(config, options);
		if (!apiKey) {
			throw new Error("OpenRouter API key is missing. Run /login openrouter or set OPENROUTER_API_KEY.");
		}
		const url = "https://openrouter.ai/api/v1/embeddings";
		const baseHeaders = buildHeaders(config);
		baseHeaders.Authorization = `Bearer ${apiKey}`;

		return {
			embed: async (texts: string[]) => {
				const vectors: number[][] = [];
				for (const batch of chunkInput(texts, config.batchSize)) {
					const payload = await requestJson(url, {
						method: "POST",
						headers: baseHeaders,
						body: JSON.stringify({
							model: config.model,
							input: batch,
						}),
						timeoutMs: config.timeoutMs,
					});
					vectors.push(...parseEmbeddingsFromOpenAIShape(payload, "openrouter"));
				}
				if (vectors.length !== texts.length) {
					throw new Error(`OpenRouter returned ${vectors.length} embeddings for ${texts.length} inputs.`);
				}
				return vectors;
			},
		};
	}

	if (config.type === "ollama") {
		const baseUrl = normalizeBaseUrl(config.baseUrl, "http://127.0.0.1:11434");
		const embedUrl = `${baseUrl}/api/embed`;
		const legacyUrl = `${baseUrl}/api/embeddings`;
		const headers = buildHeaders(config);

		return {
			embed: async (texts: string[]) => {
				const vectors: number[][] = [];
				for (const batch of chunkInput(texts, config.batchSize)) {
					try {
						const payload = await requestJson(embedUrl, {
							method: "POST",
							headers,
							body: JSON.stringify({
								model: config.model,
								input: batch,
							}),
							timeoutMs: config.timeoutMs,
						});
						vectors.push(...parseEmbeddingsFromOllamaEmbed(payload, "ollama/api/embed"));
					} catch {
						for (const text of batch) {
							const payload = await requestJson(legacyUrl, {
								method: "POST",
								headers,
								body: JSON.stringify({
									model: config.model,
									prompt: text,
								}),
								timeoutMs: config.timeoutMs,
							});
							if (!isRecord(payload)) {
								throw new Error("Invalid embedding response from ollama/api/embeddings");
							}
							vectors.push(assertEmbeddingArray(payload.embedding, "ollama/api/embeddings"));
						}
					}
				}
				if (vectors.length !== texts.length) {
					throw new Error(`Ollama returned ${vectors.length} embeddings for ${texts.length} inputs.`);
				}
				return vectors;
			},
		};
	}

	const baseUrl = normalizeBaseUrl(config.baseUrl, "http://127.0.0.1:8000/v1");
	const url = `${baseUrl}/embeddings`;
	const headers = buildHeaders(config);
	if (config.apiKeyEnv) {
		const key = process.env[config.apiKeyEnv];
		if (!key) {
			throw new Error(`Missing environment variable ${config.apiKeyEnv} for custom_openai provider.`);
		}
		if (!headers.Authorization) {
			headers.Authorization = `Bearer ${key}`;
		}
	}

	return {
		embed: async (texts: string[]) => {
			const vectors: number[][] = [];
			for (const batch of chunkInput(texts, config.batchSize)) {
				const payload = await requestJson(url, {
					method: "POST",
					headers,
					body: JSON.stringify({
						model: config.model,
						input: batch,
					}),
					timeoutMs: config.timeoutMs,
				});
				vectors.push(...parseEmbeddingsFromOpenAIShape(payload, "custom_openai"));
			}
			if (vectors.length !== texts.length) {
				throw new Error(`custom_openai returned ${vectors.length} embeddings for ${texts.length} inputs.`);
			}
			return vectors;
		},
	};
}
