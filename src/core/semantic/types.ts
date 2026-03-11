export type SemanticScope = "user" | "project";
export type SemanticProviderType = "openrouter" | "ollama" | "custom_openai";
export type SemanticAction = "status" | "index" | "rebuild" | "query";
export type SemanticStaleReason =
	| "missing_index"
	| "provider_changed"
	| "chunking_changed"
	| "index_filters_changed"
	| "files_changed"
	| "dimension_mismatch";

export interface SemanticProviderConfig {
	type: SemanticProviderType;
	model: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	batchSize: number;
	timeoutMs: number;
}

export interface SemanticIndexConfig {
	includeGlobs: string[];
	excludeGlobs: string[];
	chunkMaxChars: number;
	chunkOverlapChars: number;
	maxFileBytes: number;
	maxFiles: number;
}

export interface SemanticSearchConfig {
	enabled: boolean;
	autoIndex: boolean;
	provider: SemanticProviderConfig;
	index: SemanticIndexConfig;
}

export interface SemanticConfigFile {
	semanticSearch?: Partial<{
		enabled: boolean;
		autoIndex: boolean;
		provider: Partial<{
			type: SemanticProviderType;
			model: string;
			baseUrl: string;
			apiKeyEnv: string;
			headers: Record<string, string>;
			batchSize: number;
			timeoutMs: number;
		}>;
		index: Partial<{
			includeGlobs: string[];
			excludeGlobs: string[];
			chunkMaxChars: number;
			chunkOverlapChars: number;
			maxFileBytes: number;
			maxFiles: number;
		}>;
	}>;
}

export interface SemanticScopedLoadResult {
	scope: SemanticScope;
	path: string;
	file: SemanticConfigFile;
	error?: Error;
}

export interface SemanticMergedConfig {
	config?: SemanticSearchConfig;
	errors: string[];
	scoped: SemanticScopedLoadResult[];
}

export interface SemanticFileFingerprint {
	path: string;
	size: number;
	mtimeMs: number;
	hash: string;
	chunks: string[];
}

export interface SemanticIndexMeta {
	version: 1;
	cwd: string;
	projectHash: string;
	providerFingerprint: string;
	providerType: SemanticProviderType;
	model: string;
	dimension: number;
	builtAt: string;
	chunkConfigFingerprint: string;
	indexFilterFingerprint: string;
	fileMap: Record<string, SemanticFileFingerprint>;
}

export interface SemanticIndexedChunk {
	id: string;
	path: string;
	lineStart: number;
	lineEnd: number;
	preview: string;
	hash: string;
}

export interface SemanticIndexedVector {
	id: string;
	vector: number[];
	norm: number;
}

export interface SemanticChunkForEmbedding extends SemanticIndexedChunk {
	text: string;
}

export interface SemanticIndexOperationResult {
	action: "index" | "rebuild";
	indexPath: string;
	durationMs: number;
	processedFiles: number;
	newFiles: number;
	changedFiles: number;
	removedFiles: number;
	reusedFiles: number;
	chunks: number;
	dimension: number;
	builtAt: string;
}

export interface SemanticStatusResult {
	action: "status";
	configured: boolean;
	enabled: boolean;
	autoIndex: boolean;
	indexed: boolean;
	stale: boolean;
	staleReason?: SemanticStaleReason;
	provider?: SemanticProviderType;
	model?: string;
	files: number;
	chunks: number;
	dimension?: number;
	ageSeconds?: number;
	indexPath: string;
	configPathUser: string;
	configPathProject: string;
}

export interface SemanticQueryHit {
	score: number;
	path: string;
	lineStart: number;
	lineEnd: number;
	snippet: string;
}

export interface SemanticQueryResult {
	action: "query";
	query: string;
	topK: number;
	autoRefreshed: boolean;
	hits: SemanticQueryHit[];
}

export type SemanticToolResult =
	| SemanticStatusResult
	| SemanticIndexOperationResult
	| SemanticQueryResult;

export class SemanticConfigError extends Error {}

export class SemanticConfigMissingError extends Error {
	readonly userConfigPath: string;
	readonly projectConfigPath: string;

	constructor(userConfigPath: string, projectConfigPath: string) {
		super(
			`Semantic search config not found. Create one with /semantic setup or write ${userConfigPath} (user) or ${projectConfigPath} (project).`,
		);
		this.name = "SemanticConfigMissingError";
		this.userConfigPath = userConfigPath;
		this.projectConfigPath = projectConfigPath;
	}
}

export class SemanticRebuildRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SemanticRebuildRequiredError";
	}
}

export class SemanticIndexRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SemanticIndexRequiredError";
	}
}
