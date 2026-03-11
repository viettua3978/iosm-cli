export type RepoScaleMode = "small" | "medium" | "large";

export interface ProjectIndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
	ownerZone: string;
	imports: string[];
	symbols: string[];
	changeFreq: number;
}

export interface ProjectIndexMeta {
	version: 1;
	cwd: string;
	builtAt: string;
	updatedAt: string;
	totalFiles: number;
	sourceFiles: number;
	testFiles: number;
	repoScaleMode: RepoScaleMode;
}

export interface ProjectIndex {
	meta: ProjectIndexMeta;
	entries: ProjectIndexEntry[];
}

export interface BuildProjectIndexOptions {
	maxFiles?: number;
	incrementalFrom?: ProjectIndex;
	changedFiles?: string[];
}

export interface ProjectIndexQueryResult {
	matches: ProjectIndexEntry[];
	tokens: string[];
}
