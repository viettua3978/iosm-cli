import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SemanticIndexMeta, SemanticIndexedChunk, SemanticIndexedVector } from "./types.js";

export interface SemanticIndexFiles {
	metaPath: string;
	chunksPath: string;
	vectorsPath: string;
}

export interface LoadedSemanticIndex {
	exists: boolean;
	meta?: SemanticIndexMeta;
	chunks: SemanticIndexedChunk[];
	vectors: SemanticIndexedVector[];
}

export function getSemanticRootDir(agentDir: string): string {
	return join(agentDir, "semantic");
}

export function getSemanticIndexesDir(agentDir: string): string {
	return join(getSemanticRootDir(agentDir), "indexes");
}

export function getSemanticProjectHash(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 20);
}

export function getSemanticIndexDir(cwd: string, agentDir: string): string {
	return join(getSemanticIndexesDir(agentDir), getSemanticProjectHash(cwd));
}

export function getSemanticIndexFiles(indexDir: string): SemanticIndexFiles {
	return {
		metaPath: join(indexDir, "meta.json"),
		chunksPath: join(indexDir, "chunks.jsonl"),
		vectorsPath: join(indexDir, "vectors.jsonl"),
	};
}

function parseJsonLines<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	if (!raw.trim()) return [];
	const rows: T[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		rows.push(JSON.parse(trimmed) as T);
	}
	return rows;
}

function stringifyJsonLines(values: unknown[]): string {
	if (values.length === 0) return "";
	return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

export function loadSemanticIndex(indexDir: string): LoadedSemanticIndex {
	const files = getSemanticIndexFiles(indexDir);
	if (!existsSync(files.metaPath)) {
		return { exists: false, chunks: [], vectors: [] };
	}

	const meta = JSON.parse(readFileSync(files.metaPath, "utf8")) as SemanticIndexMeta;
	const chunks = parseJsonLines<SemanticIndexedChunk>(files.chunksPath);
	const vectors = parseJsonLines<SemanticIndexedVector>(files.vectorsPath);
	return {
		exists: true,
		meta,
		chunks,
		vectors,
	};
}

export function writeSemanticIndex(
	indexDir: string,
	meta: SemanticIndexMeta,
	chunks: SemanticIndexedChunk[],
	vectors: SemanticIndexedVector[],
): SemanticIndexFiles {
	if (!existsSync(indexDir)) {
		mkdirSync(indexDir, { recursive: true });
	}
	const files = getSemanticIndexFiles(indexDir);
	writeFileSync(files.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	writeFileSync(files.chunksPath, stringifyJsonLines(chunks), "utf8");
	writeFileSync(files.vectorsPath, stringifyJsonLines(vectors), "utf8");
	return files;
}

export function clearSemanticIndex(indexDir: string): void {
	if (!existsSync(indexDir)) return;
	rmSync(indexDir, { recursive: true, force: true });
}
