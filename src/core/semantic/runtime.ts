import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { globSync } from "glob";
import type { AuthStorage } from "../auth-storage.js";
import {
	getSemanticConfigPath,
	loadMergedSemanticConfig,
} from "./config.js";
import { chunkTextForSemantic, type SemanticChunkDraft } from "./chunking.js";
import {
	getSemanticIndexDir,
	getSemanticProjectHash,
	loadSemanticIndex,
	writeSemanticIndex,
} from "./index-store.js";
import { createSemanticEmbeddingProvider } from "./providers.js";
import type {
	SemanticIndexConfig,
	SemanticIndexMeta,
	SemanticIndexOperationResult,
	SemanticIndexedChunk,
	SemanticIndexedVector,
	SemanticQueryHit,
	SemanticQueryResult,
	SemanticSearchConfig,
	SemanticStatusResult,
	SemanticStaleReason,
	SemanticToolResult,
} from "./types.js";
import {
	SemanticConfigMissingError,
	SemanticRebuildRequiredError,
} from "./types.js";

interface SemanticRuntimeOptions {
	cwd: string;
	agentDir: string;
	authStorage?: AuthStorage;
}

interface ScannedSemanticFile {
	absPath: string;
	relPath: string;
	size: number;
	mtimeMs: number;
	hash: string;
	text: string;
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function fileHashFromContent(content: string): string {
	return sha256(content);
}

function chunkId(path: string, draft: SemanticChunkDraft, index: number): string {
	return sha256(`${path}:${draft.hash}:${draft.lineStart}:${draft.lineEnd}:${index}`).slice(0, 24);
}

function normalizeIndexPath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return toPosixPath(rel);
}

function cosineSimilarity(a: number[], b: number[], normA: number, normB: number): number {
	if (normA <= 0 || normB <= 0 || a.length !== b.length) return 0;
	let dot = 0;
	for (let index = 0; index < a.length; index++) {
		dot += a[index]! * b[index]!;
	}
	return dot / (normA * normB);
}

function vectorNorm(vector: number[]): number {
	let sum = 0;
	for (const value of vector) {
		sum += value * value;
	}
	return Math.sqrt(sum);
}

function ageSecondsFromIso(iso: string): number | undefined {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return undefined;
	const ageMs = Date.now() - ms;
	if (ageMs < 0) return 0;
	return Math.floor(ageMs / 1000);
}

function clampTopK(value: number | undefined): number {
	if (!Number.isFinite(value)) return 8;
	const normalized = Math.floor(value as number);
	if (normalized < 1) return 1;
	if (normalized > 20) return 20;
	return normalized;
}

export class SemanticSearchRuntime {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly authStorage?: AuthStorage;

	constructor(options: SemanticRuntimeOptions) {
		this.cwd = resolve(options.cwd);
		this.agentDir = options.agentDir;
		this.authStorage = options.authStorage;
	}

	async execute(action: "status"): Promise<SemanticStatusResult>;
	async execute(action: "index"): Promise<SemanticIndexOperationResult>;
	async execute(action: "rebuild"): Promise<SemanticIndexOperationResult>;
	async execute(action: "query", query: string, topK?: number): Promise<SemanticQueryResult>;
	async execute(action: "status" | "index" | "rebuild" | "query", query?: string, topK?: number): Promise<SemanticToolResult> {
		if (action === "status") {
			return this.status();
		}
		if (action === "index") {
			return this.index();
		}
		if (action === "rebuild") {
			return this.rebuild();
		}
		return this.query(query ?? "", topK);
	}

	async status(): Promise<SemanticStatusResult> {
		const userConfigPath = getSemanticConfigPath("user", this.cwd, this.agentDir);
		const projectConfigPath = getSemanticConfigPath("project", this.cwd, this.agentDir);
		const indexPath = getSemanticIndexDir(this.cwd, this.agentDir);
		const merged = loadMergedSemanticConfig(this.cwd, this.agentDir);
		const config = merged.config;

		if (!config) {
			return {
				action: "status",
				configured: false,
				enabled: false,
				indexed: false,
				stale: true,
				staleReason: "missing_index",
				files: 0,
				chunks: 0,
				indexPath,
				configPathUser: userConfigPath,
				configPathProject: projectConfigPath,
			};
		}

		const loaded = loadSemanticIndex(indexPath);
		const stale = this.detectStaleness(config, loaded.meta);
		const files = loaded.meta ? Object.keys(loaded.meta.fileMap).length : 0;
		const chunks = loaded.chunks.length;

		return {
			action: "status",
			configured: true,
			enabled: config.enabled,
			indexed: loaded.exists && !!loaded.meta,
			stale: stale.stale,
			staleReason: stale.reason,
			provider: config.provider.type,
			model: config.provider.model,
			files,
			chunks,
			dimension: loaded.meta?.dimension,
			ageSeconds: loaded.meta ? ageSecondsFromIso(loaded.meta.builtAt) : undefined,
			indexPath,
			configPathUser: userConfigPath,
			configPathProject: projectConfigPath,
		};
	}

	async index(): Promise<SemanticIndexOperationResult> {
		return this.buildIndex(false);
	}

	async rebuild(): Promise<SemanticIndexOperationResult> {
		return this.buildIndex(true);
	}

	async query(rawQuery: string, topK?: number): Promise<SemanticQueryResult> {
		const query = rawQuery.trim();
		if (!query) {
			throw new Error("semantic query cannot be empty");
		}

		const config = this.loadConfiguredSemanticConfig();
		if (!config.enabled) {
			throw new Error("semantic search is disabled in semantic.json");
		}

		const status = await this.status();
		let autoRefreshed = false;
		if (!status.indexed || status.stale) {
			const requiresRebuild =
				!status.indexed ||
				status.staleReason === "provider_changed" ||
				status.staleReason === "chunking_changed" ||
				status.staleReason === "index_filters_changed" ||
				status.staleReason === "dimension_mismatch";
			await this.buildIndex(requiresRebuild);
			autoRefreshed = true;
		}

		const indexPath = getSemanticIndexDir(this.cwd, this.agentDir);
		const loaded = loadSemanticIndex(indexPath);
		const meta = loaded.meta;
		if (!meta || loaded.vectors.length === 0 || loaded.chunks.length === 0) {
			return {
				action: "query",
				query,
				topK: clampTopK(topK),
				autoRefreshed,
				hits: [],
			};
		}

		const provider = await createSemanticEmbeddingProvider(config.provider, {
			authStorage: this.authStorage,
		});
		const queryVector = (await provider.embed([query]))[0];
		if (!queryVector) {
			throw new Error("provider returned no embedding for query");
		}

		if (queryVector.length !== meta.dimension) {
			throw new SemanticRebuildRequiredError(
				`Embedding dimension changed (${queryVector.length} != ${meta.dimension}). Run /semantic rebuild.`,
			);
		}

		const chunkById = new Map<string, SemanticIndexedChunk>();
		for (const chunk of loaded.chunks) {
			chunkById.set(chunk.id, chunk);
		}
		const queryNorm = vectorNorm(queryVector);
		const ranked: SemanticQueryHit[] = [];
		for (const vector of loaded.vectors) {
			const chunk = chunkById.get(vector.id);
			if (!chunk) continue;
			const score = cosineSimilarity(queryVector, vector.vector, queryNorm, vector.norm);
			if (!Number.isFinite(score)) continue;
			ranked.push({
				score,
				path: chunk.path,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				snippet: chunk.preview,
			});
		}

		ranked.sort((a, b) => b.score - a.score);
		const effectiveTopK = clampTopK(topK);
		return {
			action: "query",
			query,
			topK: effectiveTopK,
			autoRefreshed,
			hits: ranked.slice(0, effectiveTopK),
		};
	}

	private loadConfiguredSemanticConfig(): SemanticSearchConfig {
		const merged = loadMergedSemanticConfig(this.cwd, this.agentDir);
		if (!merged.config) {
			throw new SemanticConfigMissingError(
				getSemanticConfigPath("user", this.cwd, this.agentDir),
				getSemanticConfigPath("project", this.cwd, this.agentDir),
			);
		}
		if (merged.errors.length > 0) {
			throw new Error(`semantic config warnings: ${merged.errors.join(" | ")}`);
		}
		return merged.config;
	}

	private detectStaleness(
		config: SemanticSearchConfig,
		meta: SemanticIndexMeta | undefined,
	): { stale: boolean; reason?: SemanticStaleReason } {
		if (!meta) {
			return { stale: true, reason: "missing_index" };
		}
		if (meta.dimension <= 0) {
			return { stale: true, reason: "dimension_mismatch" };
		}
		if (meta.providerFingerprint !== this.providerFingerprint(config)) {
			return { stale: true, reason: "provider_changed" };
		}
		if (meta.chunkConfigFingerprint !== this.chunkConfigFingerprint(config.index)) {
			return { stale: true, reason: "chunking_changed" };
		}
		if (meta.indexFilterFingerprint !== this.indexFilterFingerprint(config.index)) {
			return { stale: true, reason: "index_filters_changed" };
		}

		const statusFileMap = this.collectProjectFileStats(config.index);
		const indexedPaths = Object.keys(meta.fileMap);
		if (indexedPaths.length !== statusFileMap.size) {
			return { stale: true, reason: "files_changed" };
		}
		for (const [path, current] of statusFileMap.entries()) {
			const previous = meta.fileMap[path];
			if (!previous) {
				return { stale: true, reason: "files_changed" };
			}
			if (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
				return { stale: true, reason: "files_changed" };
			}
		}

		return { stale: false };
	}

	private collectCandidatePaths(indexConfig: SemanticIndexConfig): string[] {
		const results = new Set<string>();
		for (const pattern of indexConfig.includeGlobs) {
			for (const filePath of globSync(pattern, {
				cwd: this.cwd,
				absolute: true,
				nodir: true,
				dot: true,
				ignore: indexConfig.excludeGlobs,
				follow: false,
			})) {
				results.add(resolve(filePath));
			}
		}

		return [...results].sort().slice(0, indexConfig.maxFiles);
	}

	private collectProjectFileStats(indexConfig: SemanticIndexConfig): Map<string, { size: number; mtimeMs: number }> {
		const map = new Map<string, { size: number; mtimeMs: number }>();
		for (const absPath of this.collectCandidatePaths(indexConfig)) {
			let stat;
			try {
				stat = statSync(absPath);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			if (stat.size > indexConfig.maxFileBytes) continue;
			const relPath = normalizeIndexPath(this.cwd, absPath);
			map.set(relPath, { size: stat.size, mtimeMs: stat.mtimeMs });
		}
		return map;
	}

	private collectProjectFiles(indexConfig: SemanticIndexConfig): ScannedSemanticFile[] {
		const files: ScannedSemanticFile[] = [];
		for (const absPath of this.collectCandidatePaths(indexConfig)) {
			let stat;
			try {
				stat = statSync(absPath);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			if (stat.size > indexConfig.maxFileBytes) continue;

			let buffer: Buffer;
			try {
				buffer = readFileSync(absPath);
			} catch {
				continue;
			}
			if (buffer.includes(0)) continue;

			const text = buffer.toString("utf8");
			const trimmed = text.trim();
			if (!trimmed) continue;

			const relPath = normalizeIndexPath(this.cwd, absPath);
			files.push({
				absPath,
				relPath,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				hash: fileHashFromContent(text.replace(/\r\n/g, "\n")),
				text: text.replace(/\r\n/g, "\n"),
			});
		}
		return files;
	}

	private providerFingerprint(config: SemanticSearchConfig): string {
		const stableHeaders = config.provider.headers
			? Object.entries(config.provider.headers).sort(([a], [b]) => a.localeCompare(b))
			: [];
		return sha256(
			JSON.stringify({
				type: config.provider.type,
				model: config.provider.model,
				baseUrl: config.provider.baseUrl ?? "",
				headers: stableHeaders,
				apiKeyEnv: config.provider.apiKeyEnv ?? "",
			}),
		);
	}

	private chunkConfigFingerprint(indexConfig: SemanticIndexConfig): string {
		return sha256(
			JSON.stringify({
				chunkMaxChars: indexConfig.chunkMaxChars,
				chunkOverlapChars: indexConfig.chunkOverlapChars,
			}),
		);
	}

	private indexFilterFingerprint(indexConfig: SemanticIndexConfig): string {
		return sha256(
			JSON.stringify({
				includeGlobs: [...indexConfig.includeGlobs].sort(),
				excludeGlobs: [...indexConfig.excludeGlobs].sort(),
				maxFileBytes: indexConfig.maxFileBytes,
				maxFiles: indexConfig.maxFiles,
			}),
		);
	}

	private async buildIndex(forceRebuild: boolean): Promise<SemanticIndexOperationResult> {
		const startedAt = Date.now();
		const config = this.loadConfiguredSemanticConfig();
		if (!config.enabled) {
			throw new Error("semantic search is disabled in semantic.json");
		}

		const indexDir = getSemanticIndexDir(this.cwd, this.agentDir);
		const existing = loadSemanticIndex(indexDir);
		const existingMeta = existing.meta;
		const providerFingerprint = this.providerFingerprint(config);
		const chunkFingerprint = this.chunkConfigFingerprint(config.index);
		const filterFingerprint = this.indexFilterFingerprint(config.index);

		if (
			!forceRebuild &&
			existingMeta &&
			(existingMeta.providerFingerprint !== providerFingerprint ||
				existingMeta.chunkConfigFingerprint !== chunkFingerprint ||
				existingMeta.indexFilterFingerprint !== filterFingerprint)
		) {
			throw new SemanticRebuildRequiredError(
				"Semantic index settings changed. Run /semantic rebuild (or iosm semantic rebuild).",
			);
		}

		const provider = await createSemanticEmbeddingProvider(config.provider, {
			authStorage: this.authStorage,
		});
		const files = this.collectProjectFiles(config.index);
		const existingChunkById = new Map(existing.chunks.map((chunk) => [chunk.id, chunk]));
		const existingVectorById = new Map(existing.vectors.map((vector) => [vector.id, vector]));

		const nextChunks: SemanticIndexedChunk[] = [];
		const nextVectors: SemanticIndexedVector[] = [];
		const nextFileMap: SemanticIndexMeta["fileMap"] = {};

		let changedFiles = 0;
		let newFiles = 0;
		let reusedFiles = 0;
		let removedFiles = 0;
		// Full rebuild must not inherit previous dimension. Otherwise provider/model
		// dimension changes can keep throwing mismatch even after rebuild.
		let dimension = forceRebuild ? undefined : existingMeta?.dimension;

		const currentPaths = new Set(files.map((file) => file.relPath));
		if (existingMeta) {
			for (const path of Object.keys(existingMeta.fileMap)) {
				if (!currentPaths.has(path)) {
					removedFiles += 1;
				}
			}
		}

		for (const file of files) {
			const prev = !forceRebuild ? existingMeta?.fileMap[file.relPath] : undefined;
			const canReuse =
				!!prev &&
				prev.hash === file.hash &&
				prev.chunks.length > 0 &&
				prev.chunks.every((id) => existingChunkById.has(id) && existingVectorById.has(id));

			if (canReuse && prev) {
				reusedFiles += 1;
				for (const chunkId of prev.chunks) {
					const chunk = existingChunkById.get(chunkId);
					const vector = existingVectorById.get(chunkId);
					if (!chunk || !vector) continue;
					nextChunks.push(chunk);
					nextVectors.push(vector);
				}
				nextFileMap[file.relPath] = {
					path: file.relPath,
					size: file.size,
					mtimeMs: file.mtimeMs,
					hash: file.hash,
					chunks: [...prev.chunks],
				};
				continue;
			}

			if (prev) changedFiles += 1;
			else newFiles += 1;

			const drafts = chunkTextForSemantic(file.text, config.index);
			const chunkRecords = drafts.map((draft, index) => {
				const id = chunkId(file.relPath, draft, index);
				return {
					id,
					path: file.relPath,
					lineStart: draft.lineStart,
					lineEnd: draft.lineEnd,
					preview: draft.preview,
					hash: draft.hash,
					text: draft.text,
				};
			});
			const chunkIds = chunkRecords.map((chunk) => chunk.id);
			nextFileMap[file.relPath] = {
				path: file.relPath,
				size: file.size,
				mtimeMs: file.mtimeMs,
				hash: file.hash,
				chunks: chunkIds,
			};

			if (chunkRecords.length === 0) continue;
			const embeddings = await provider.embed(chunkRecords.map((chunk) => chunk.text));
			if (embeddings.length !== chunkRecords.length) {
				throw new Error(`Embedding provider returned ${embeddings.length} vectors for ${chunkRecords.length} chunks.`);
			}

			for (let index = 0; index < chunkRecords.length; index++) {
				const chunk = chunkRecords[index]!;
				const vector = embeddings[index]!;
				if (!Array.isArray(vector) || vector.length === 0) {
					throw new Error("Embedding provider returned an empty vector.");
				}
				if (dimension === undefined || dimension <= 0) {
					dimension = vector.length;
				} else if (dimension !== vector.length) {
					throw new SemanticRebuildRequiredError(
						`Embedding dimension mismatch (${vector.length} != ${dimension}). Run /semantic rebuild.`,
					);
				}

				nextChunks.push({
					id: chunk.id,
					path: chunk.path,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					preview: chunk.preview,
					hash: chunk.hash,
				});
				nextVectors.push({
					id: chunk.id,
					vector,
					norm: vectorNorm(vector),
				});
			}
		}

		const builtAt = new Date().toISOString();
		const meta: SemanticIndexMeta = {
			version: 1,
			cwd: this.cwd,
			projectHash: getSemanticProjectHash(this.cwd),
			providerFingerprint,
			providerType: config.provider.type,
			model: config.provider.model,
			dimension: dimension ?? 0,
			builtAt,
			chunkConfigFingerprint: chunkFingerprint,
			indexFilterFingerprint: filterFingerprint,
			fileMap: nextFileMap,
		};
		writeSemanticIndex(indexDir, meta, nextChunks, nextVectors);

		return {
			action: forceRebuild ? "rebuild" : "index",
			indexPath: indexDir,
			durationMs: Date.now() - startedAt,
			processedFiles: files.length,
			newFiles,
			changedFiles,
			removedFiles,
			reusedFiles,
			chunks: nextChunks.length,
			dimension: meta.dimension,
			builtAt,
		};
	}
}
