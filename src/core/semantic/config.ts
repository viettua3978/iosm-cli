import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	SemanticConfigFile,
	SemanticMergedConfig,
	SemanticScope,
	SemanticScopedLoadResult,
	SemanticSearchConfig,
	SemanticProviderType,
} from "./types.js";
import { SemanticConfigError } from "./types.js";

const DEFAULT_INCLUDE_GLOBS = ["**/*.{ts,tsx,js,jsx,py,go,rs,java,md,json,yaml,yml}"];
const DEFAULT_EXCLUDE_GLOBS = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/.iosm/**"];

const DEFAULT_CONFIG: SemanticSearchConfig = {
	enabled: true,
	provider: {
		type: "openrouter",
		model: "openai/text-embedding-3-small",
		batchSize: 32,
		timeoutMs: 30_000,
	},
	index: {
		includeGlobs: [...DEFAULT_INCLUDE_GLOBS],
		excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
		chunkMaxChars: 1200,
		chunkOverlapChars: 200,
		maxFileBytes: 262_144,
		maxFiles: 20_000,
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const normalized = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return normalized.length > 0 ? normalized : undefined;
}

function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		if (typeof rawValue !== "string") continue;
		const normalizedKey = key.trim();
		if (!normalizedKey) continue;
		result[normalizedKey] = rawValue;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeProviderType(value: unknown): SemanticProviderType | undefined {
	if (value === "openrouter" || value === "ollama" || value === "custom_openai") {
		return value;
	}
	return undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	const normalized = Math.floor(value);
	if (!Number.isFinite(normalized)) return fallback;
	if (normalized < min) return min;
	if (normalized > max) return max;
	return normalized;
}

function parseSemanticConfigFile(path: string): SemanticConfigFile {
	if (!existsSync(path)) {
		return {};
	}
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new SemanticConfigError(`Expected JSON object in ${path}`);
	}

	const result: SemanticConfigFile = {};
	const rawSemantic = parsed.semanticSearch;
	if (!isRecord(rawSemantic)) {
		return result;
	}

	const provider = isRecord(rawSemantic.provider)
		? {
				type: sanitizeProviderType(rawSemantic.provider.type),
				model: asString(rawSemantic.provider.model),
				baseUrl: asString(rawSemantic.provider.baseUrl),
				apiKeyEnv: asString(rawSemantic.provider.apiKeyEnv),
				headers: sanitizeStringRecord(rawSemantic.provider.headers),
				batchSize: asNumber(rawSemantic.provider.batchSize),
				timeoutMs: asNumber(rawSemantic.provider.timeoutMs),
			}
		: undefined;

	const index = isRecord(rawSemantic.index)
		? {
				includeGlobs: sanitizeStringArray(rawSemantic.index.includeGlobs),
				excludeGlobs: sanitizeStringArray(rawSemantic.index.excludeGlobs),
				chunkMaxChars: asNumber(rawSemantic.index.chunkMaxChars),
				chunkOverlapChars: asNumber(rawSemantic.index.chunkOverlapChars),
				maxFileBytes: asNumber(rawSemantic.index.maxFileBytes),
				maxFiles: asNumber(rawSemantic.index.maxFiles),
			}
		: undefined;

	result.semanticSearch = {
		enabled: asBoolean(rawSemantic.enabled),
		provider,
		index,
	};

	return result;
}

function mergeSemanticConfig(
	base: SemanticConfigFile["semanticSearch"] | undefined,
	override: SemanticConfigFile["semanticSearch"] | undefined,
): SemanticConfigFile["semanticSearch"] | undefined {
	if (!base && !override) return undefined;
	return {
		...(base ?? {}),
		...(override ?? {}),
		provider: {
			...(base?.provider ?? {}),
			...(override?.provider ?? {}),
		},
		index: {
			...(base?.index ?? {}),
			...(override?.index ?? {}),
		},
	};
}

function resolveSemanticSearchConfig(
	partial: SemanticConfigFile["semanticSearch"] | undefined,
): SemanticSearchConfig | undefined {
	if (!partial) return undefined;

	const providerType = partial.provider?.type ?? DEFAULT_CONFIG.provider.type;
	const model = (partial.provider?.model ?? DEFAULT_CONFIG.provider.model).trim();
	if (!model) {
		throw new SemanticConfigError(`semanticSearch.provider.model cannot be empty`);
	}

	return {
		enabled: partial.enabled ?? DEFAULT_CONFIG.enabled,
		provider: {
			type: providerType,
			model,
			baseUrl: partial.provider?.baseUrl?.trim() || undefined,
			apiKeyEnv: partial.provider?.apiKeyEnv?.trim() || undefined,
			headers: partial.provider?.headers && Object.keys(partial.provider.headers).length > 0 ? partial.provider.headers : undefined,
			batchSize: clampInt(partial.provider?.batchSize, DEFAULT_CONFIG.provider.batchSize, 1, 512),
			timeoutMs: clampInt(partial.provider?.timeoutMs, DEFAULT_CONFIG.provider.timeoutMs, 1_000, 300_000),
		},
		index: {
			includeGlobs: partial.index?.includeGlobs && partial.index.includeGlobs.length > 0 ? partial.index.includeGlobs : [...DEFAULT_CONFIG.index.includeGlobs],
			excludeGlobs: partial.index?.excludeGlobs && partial.index.excludeGlobs.length > 0 ? partial.index.excludeGlobs : [...DEFAULT_CONFIG.index.excludeGlobs],
			chunkMaxChars: clampInt(partial.index?.chunkMaxChars, DEFAULT_CONFIG.index.chunkMaxChars, 200, 20_000),
			chunkOverlapChars: clampInt(partial.index?.chunkOverlapChars, DEFAULT_CONFIG.index.chunkOverlapChars, 0, 5_000),
			maxFileBytes: clampInt(partial.index?.maxFileBytes, DEFAULT_CONFIG.index.maxFileBytes, 1_024, 16 * 1024 * 1024),
			maxFiles: clampInt(partial.index?.maxFiles, DEFAULT_CONFIG.index.maxFiles, 1, 1_000_000),
		},
	};
}

export function getSemanticConfigPath(scope: SemanticScope, cwd: string, agentDir: string): string {
	return scope === "project" ? join(cwd, ".iosm", "semantic.json") : join(agentDir, "semantic.json");
}

export function readScopedSemanticConfig(scope: SemanticScope, cwd: string, agentDir: string): SemanticScopedLoadResult {
	const path = getSemanticConfigPath(scope, cwd, agentDir);
	try {
		return {
			scope,
			path,
			file: parseSemanticConfigFile(path),
		};
	} catch (error) {
		return {
			scope,
			path,
			file: {},
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

export function loadMergedSemanticConfig(cwd: string, agentDir: string): SemanticMergedConfig {
	const scoped = [readScopedSemanticConfig("user", cwd, agentDir), readScopedSemanticConfig("project", cwd, agentDir)];
	const errors: string[] = [];

	for (const entry of scoped) {
		if (entry.error) {
			errors.push(`${entry.scope} config (${entry.path}): ${entry.error.message}`);
		}
	}

	const mergedPartial = mergeSemanticConfig(scoped[0]?.file.semanticSearch, scoped[1]?.file.semanticSearch);
	let config: SemanticSearchConfig | undefined;
	try {
		config = resolveSemanticSearchConfig(mergedPartial);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		errors.push(`semanticSearch: ${message}`);
		config = undefined;
	}

	return {
		config,
		errors,
		scoped,
	};
}

export function writeScopedSemanticConfig(
	scope: SemanticScope,
	file: SemanticConfigFile,
	cwd: string,
	agentDir: string,
): string {
	const path = getSemanticConfigPath(scope, cwd, agentDir);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	return path;
}

export function upsertScopedSemanticSearchConfig(
	scope: SemanticScope,
	config: SemanticSearchConfig,
	cwd: string,
	agentDir: string,
): string {
	const current = readScopedSemanticConfig(scope, cwd, agentDir);
	if (current.error) {
		throw new SemanticConfigError(`Cannot update ${scope} semantic config (${current.path}): ${current.error.message}`);
	}
	const nextFile: SemanticConfigFile = {
		...current.file,
		semanticSearch: {
			enabled: config.enabled,
			provider: {
				type: config.provider.type,
				model: config.provider.model,
				baseUrl: config.provider.baseUrl,
				apiKeyEnv: config.provider.apiKeyEnv,
				headers: config.provider.headers,
				batchSize: config.provider.batchSize,
				timeoutMs: config.provider.timeoutMs,
			},
			index: {
				includeGlobs: [...config.index.includeGlobs],
				excludeGlobs: [...config.index.excludeGlobs],
				chunkMaxChars: config.index.chunkMaxChars,
				chunkOverlapChars: config.index.chunkOverlapChars,
				maxFileBytes: config.index.maxFileBytes,
				maxFiles: config.index.maxFiles,
			},
		},
	};
	return writeScopedSemanticConfig(scope, nextFile, cwd, agentDir);
}

export function getDefaultSemanticSearchConfig(): SemanticSearchConfig {
	return {
		enabled: DEFAULT_CONFIG.enabled,
		provider: { ...DEFAULT_CONFIG.provider },
		index: {
			includeGlobs: [...DEFAULT_CONFIG.index.includeGlobs],
			excludeGlobs: [...DEFAULT_CONFIG.index.excludeGlobs],
			chunkMaxChars: DEFAULT_CONFIG.index.chunkMaxChars,
			chunkOverlapChars: DEFAULT_CONFIG.index.chunkOverlapChars,
			maxFileBytes: DEFAULT_CONFIG.index.maxFileBytes,
			maxFiles: DEFAULT_CONFIG.index.maxFiles,
		},
	};
}
