export {
	getDefaultSemanticSearchConfig,
	getSemanticConfigPath,
	loadMergedSemanticConfig,
	readScopedSemanticConfig,
	upsertScopedSemanticSearchConfig,
	writeScopedSemanticConfig,
} from "./config.js";
export {
	getSemanticCommandHelp,
	parseSemanticCliCommand,
	type ParseSemanticCliResult,
	type SemanticCliCommand,
} from "./cli.js";
export {
	clearSemanticIndex,
	getSemanticIndexDir,
	getSemanticIndexFiles,
	getSemanticIndexesDir,
	getSemanticProjectHash,
	getSemanticRootDir,
	loadSemanticIndex,
	writeSemanticIndex,
} from "./index-store.js";
export {
	createSemanticEmbeddingProvider,
	isLikelyEmbeddingModelId,
	listOllamaLocalModels,
	listOpenRouterEmbeddingModels,
} from "./providers.js";
export { SemanticSearchRuntime } from "./runtime.js";
export type {
	SemanticAction,
	SemanticChunkForEmbedding,
	SemanticConfigFile,
	SemanticFileFingerprint,
	SemanticIndexConfig,
	SemanticIndexMeta,
	SemanticIndexOperationResult,
	SemanticIndexedChunk,
	SemanticIndexedVector,
	SemanticMergedConfig,
	SemanticProviderConfig,
	SemanticProviderType,
	SemanticQueryHit,
	SemanticQueryResult,
	SemanticScope,
	SemanticScopedLoadResult,
	SemanticSearchConfig,
	SemanticStatusResult,
	SemanticStaleReason,
	SemanticToolResult,
} from "./types.js";
export {
	SemanticConfigError,
	SemanticConfigMissingError,
	SemanticRebuildRequiredError,
} from "./types.js";
