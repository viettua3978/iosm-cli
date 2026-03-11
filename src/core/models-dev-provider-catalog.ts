import { MODELS_DEV_PROVIDERS, type ModelsDevProviderInfo } from "./models-dev-providers.js";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_TIMEOUT_MS = 2500;

export interface ModelsDevProviderModelInfo {
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers: Record<string, string>;
	api?: string;
	npm?: string;
}

export interface ModelsDevProviderCatalogInfo extends ModelsDevProviderInfo {
	api?: string;
	npm?: string;
	models: readonly ModelsDevProviderModelInfo[];
}

interface RawModelsDevModel {
	id?: unknown;
	name?: unknown;
	reasoning?: unknown;
	modalities?: unknown;
	cost?: unknown;
	limit?: unknown;
	headers?: unknown;
	provider?: unknown;
}

interface RawModelsDevProvider {
	id?: unknown;
	name?: unknown;
	env?: unknown;
	api?: unknown;
	npm?: unknown;
	models?: unknown;
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toHeaderMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string") headers[key] = raw;
	}
	return headers;
}

function toNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeModel(rawModelId: string, raw: RawModelsDevModel, provider: RawModelsDevProvider): ModelsDevProviderModelInfo {
	const modelProvider = raw.provider && typeof raw.provider === "object" ? (raw.provider as Record<string, unknown>) : {};
	const modalities = raw.modalities && typeof raw.modalities === "object" ? (raw.modalities as Record<string, unknown>) : {};
	const inputModalities = toStringArray(modalities.input);
	const cost = raw.cost && typeof raw.cost === "object" ? (raw.cost as Record<string, unknown>) : {};
	const limit = raw.limit && typeof raw.limit === "object" ? (raw.limit as Record<string, unknown>) : {};

	return {
		id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : rawModelId,
		name: typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name : rawModelId,
		reasoning: Boolean(raw.reasoning),
		input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: toNumber(cost.input, 0),
			output: toNumber(cost.output, 0),
			cacheRead: toNumber(cost.cache_read, 0),
			cacheWrite: toNumber(cost.cache_write, 0),
		},
		contextWindow: toNumber(limit.context, 128000),
		maxTokens: toNumber(limit.output, 16384),
		headers: toHeaderMap(raw.headers),
		api: typeof modelProvider.api === "string" ? modelProvider.api : typeof provider.api === "string" ? provider.api : undefined,
		npm: typeof modelProvider.npm === "string" ? modelProvider.npm : typeof provider.npm === "string" ? provider.npm : undefined,
	};
}

function normalizeCatalog(payload: unknown): Map<string, ModelsDevProviderCatalogInfo> {
	if (!payload || typeof payload !== "object") return new Map();

	const catalog = new Map<string, ModelsDevProviderCatalogInfo>();
	for (const [providerId, value] of Object.entries(payload as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const candidate = value as RawModelsDevProvider;
		const id =
			typeof candidate.id === "string" && candidate.id.trim().length > 0 ? candidate.id : providerId;
		const name = typeof candidate.name === "string" && candidate.name.trim().length > 0 ? candidate.name : id;
		const env = toStringArray(candidate.env);

		const rawModels =
			candidate.models && typeof candidate.models === "object"
				? (candidate.models as Record<string, RawModelsDevModel>)
				: {};
		const models = Object.entries(rawModels)
			.map(([modelId, model]) => normalizeModel(modelId, model ?? {}, candidate))
			.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));

		catalog.set(id, {
			id,
			name,
			env,
			api: typeof candidate.api === "string" ? candidate.api : undefined,
			npm: typeof candidate.npm === "string" ? candidate.npm : undefined,
			models,
		});
	}

	return catalog;
}

function fallbackCatalog(): Map<string, ModelsDevProviderCatalogInfo> {
	return new Map(
		MODELS_DEV_PROVIDERS.map((provider) => [
			provider.id,
			{
				...provider,
				models: [],
			} satisfies ModelsDevProviderCatalogInfo,
		]),
	);
}

async function fetchModelsDevPayload(timeoutMs: number): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(MODELS_DEV_API_URL, {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		return (await response.json()) as unknown;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export async function loadModelsDevProviderCatalog(
	options?: { timeoutMs?: number },
): Promise<ReadonlyMap<string, ModelsDevProviderCatalogInfo>> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const payload = await fetchModelsDevPayload(timeoutMs);
	if (!payload) return fallbackCatalog();

	const catalog = normalizeCatalog(payload);
	return catalog.size > 0 ? catalog : fallbackCatalog();
}

export async function loadModelsDevProviders(
	options?: { timeoutMs?: number },
): Promise<readonly ModelsDevProviderInfo[]> {
	const catalog = await loadModelsDevProviderCatalog(options);
	return Array.from(catalog.values())
		.map((provider) => ({
			id: provider.id,
			name: provider.name,
			env: provider.env,
		}))
		.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
}
