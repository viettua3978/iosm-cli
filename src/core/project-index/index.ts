import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
	BuildProjectIndexOptions,
	ProjectIndex,
	ProjectIndexEntry,
	ProjectIndexMeta,
	ProjectIndexQueryResult,
	RepoScaleMode,
} from "./types.js";
export type {
	BuildProjectIndexOptions,
	ProjectIndex,
	ProjectIndexEntry,
	ProjectIndexMeta,
	ProjectIndexQueryResult,
	RepoScaleMode,
} from "./types.js";

const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".json",
	".yaml",
	".yml",
	".toml",
	".md",
	".sql",
	".css",
	".scss",
	".html",
]);

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".iosm"]);

function toPosixPath(input: string): string {
	return input.split(sep).join("/");
}

function getExtension(filePath: string): string {
	const normalized = filePath.toLowerCase();
	const index = normalized.lastIndexOf(".");
	return index >= 0 ? normalized.slice(index) : "";
}

function normalizeToken(value: string): string {
	return value.trim().toLowerCase();
}

function tokenize(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^\p{L}\p{N}_-]+/u)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);
}

function collectImports(content: string): string[] {
	const result = new Set<string>();
	const importRegexes = [
		/\bimport\s+[^"'\n]*["']([^"']+)["']/g,
		/\brequire\(\s*["']([^"']+)["']\s*\)/g,
		/\bfrom\s+["']([^"']+)["']/g,
		/\buse\s+([a-zA-Z0-9_:]+)/g,
	];
	for (const regex of importRegexes) {
		for (const match of content.matchAll(regex)) {
			const value = (match[1] ?? "").trim();
			if (value) result.add(value);
		}
	}
	return [...result].slice(0, 40);
}

function collectSymbols(content: string): string[] {
	const result = new Set<string>();
	const symbolRegexes = [
		/\b(?:export\s+)?(?:class|interface|type|enum|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
		/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(/g,
		/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
	];
	for (const regex of symbolRegexes) {
		for (const match of content.matchAll(regex)) {
			const value = (match[1] ?? "").trim();
			if (value) result.add(value);
		}
	}
	return [...result].slice(0, 80);
}

function inferOwnerZone(relPath: string): string {
	const [top] = relPath.split("/");
	if (!top) return "root";
	if (top === "src" || top === "app" || top === "packages") {
		const [, second] = relPath.split("/");
		return second ? `${top}/${second}` : top;
	}
	return top;
}

function repoScaleFromCounts(totalFiles: number, sourceFiles: number): RepoScaleMode {
	if (totalFiles >= 8000 || sourceFiles >= 4000) return "large";
	if (totalFiles >= 2500 || sourceFiles >= 1200) return "medium";
	return "small";
}

function scoreEntry(entry: ProjectIndexEntry, tokens: string[]): number {
	if (tokens.length === 0) return 0;
	const normalizedPath = entry.path.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (normalizedPath.includes(token)) score += 3;
		if (entry.ownerZone.toLowerCase().includes(token)) score += 2;
		if (entry.symbols.some((symbol) => symbol.toLowerCase().includes(token))) score += 2;
		if (entry.imports.some((item) => item.toLowerCase().includes(token))) score += 1;
	}
	return score;
}

function fileHash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function getStorageRoot(cwd: string): string {
	return join(resolve(cwd), ".iosm", "project-index");
}

export function getProjectIndexPath(cwd: string): string {
	return join(getStorageRoot(cwd), "index.json");
}

export function loadProjectIndex(cwd: string): ProjectIndex | undefined {
	const filePath = getProjectIndexPath(cwd);
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ProjectIndex;
		if (!parsed?.meta || !Array.isArray(parsed.entries)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function saveProjectIndex(cwd: string, index: ProjectIndex): void {
	const filePath = getProjectIndexPath(cwd);
	mkdirSync(getStorageRoot(cwd), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function scanFiles(cwd: string, maxFiles: number): string[] {
	const root = resolve(cwd);
	const stack = [root];
	const files: string[] = [];
	while (stack.length > 0 && files.length < maxFiles) {
		const current = stack.pop();
		if (!current) break;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const absPath = join(current, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name)) continue;
				stack.push(absPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!TEXT_EXTENSIONS.has(getExtension(entry.name))) continue;
			let stats;
			try {
				stats = statSync(absPath);
			} catch {
				continue;
			}
			if (!stats.isFile() || stats.size > 1_000_000) continue;
			files.push(absPath);
			if (files.length >= maxFiles) break;
		}
	}
	return files.sort((a, b) => a.localeCompare(b));
}

function buildEntry(cwd: string, absPath: string, previous?: ProjectIndexEntry): ProjectIndexEntry | undefined {
	let stat;
	try {
		stat = statSync(absPath);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) return undefined;
	const relPath = toPosixPath(relative(cwd, absPath));
	if (!relPath || relPath.startsWith("..")) return undefined;
	if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
		return previous;
	}
	let content = "";
	try {
		content = readFileSync(absPath, "utf8");
	} catch {
		return {
			path: relPath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ownerZone: inferOwnerZone(relPath),
			imports: previous?.imports ?? [],
			symbols: previous?.symbols ?? [],
			changeFreq: (previous?.changeFreq ?? 0) + 1,
		};
	}
	const digest = fileHash(content);
	const previousDigest = previous ? fileHash([previous.path, previous.mtimeMs, previous.size, previous.symbols.join(",")].join("|")) : "";
	const changed = !previous || previousDigest !== digest;
	return {
		path: relPath,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ownerZone: inferOwnerZone(relPath),
		imports: collectImports(content),
		symbols: collectSymbols(content),
		changeFreq: changed ? (previous?.changeFreq ?? 0) + 1 : (previous?.changeFreq ?? 0),
	};
}

export function buildProjectIndex(cwd: string, options?: BuildProjectIndexOptions): ProjectIndex {
	const root = resolve(cwd);
	const maxFiles = Math.max(500, options?.maxFiles ?? 20_000);
	const files = scanFiles(root, maxFiles);
	const previous = options?.incrementalFrom;
	const changedSet =
		options?.changedFiles && options.changedFiles.length > 0
			? new Set(options.changedFiles.map((filePath) => toPosixPath(filePath)))
			: undefined;
	const previousByPath = new Map<string, ProjectIndexEntry>();
	for (const entry of previous?.entries ?? []) {
		previousByPath.set(entry.path, entry);
	}

	const entries: ProjectIndexEntry[] = [];
	let sourceFiles = 0;
	let testFiles = 0;
	for (const absPath of files) {
		const relPath = toPosixPath(relative(root, absPath));
		const previousEntry = previousByPath.get(relPath);
		const entry =
			changedSet && previousEntry && !changedSet.has(relPath)
				? previousEntry
				: buildEntry(root, absPath, previousEntry);
		if (!entry) continue;
		entries.push(entry);
		if (/^(src|app|packages)\//.test(entry.path)) sourceFiles += 1;
		if (/(^|\/)(test|tests|__tests__)\//.test(entry.path) || /\.(test|spec)\./.test(entry.path)) testFiles += 1;
	}

	const meta: ProjectIndexMeta = {
		version: 1,
		cwd: root,
		builtAt: previous?.meta.builtAt ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		totalFiles: entries.length,
		sourceFiles,
		testFiles,
		repoScaleMode: repoScaleFromCounts(entries.length, sourceFiles),
	};

	return { meta, entries };
}

export function ensureProjectIndex(cwd: string, modeHint?: RepoScaleMode): { index: ProjectIndex; rebuilt: boolean } {
	const existing = loadProjectIndex(cwd);
	if (!existing) {
		const built = buildProjectIndex(cwd);
		saveProjectIndex(cwd, built);
		return { index: built, rebuilt: true };
	}

	const needsRebuild =
		(existing.meta.repoScaleMode === "large" || modeHint === "large") &&
		Date.now() - Date.parse(existing.meta.updatedAt) > 60_000;

	if (needsRebuild) {
		const rebuilt = buildProjectIndex(cwd, { incrementalFrom: existing });
		saveProjectIndex(cwd, rebuilt);
		return { index: rebuilt, rebuilt: true };
	}
	return { index: existing, rebuilt: false };
}

export function queryProjectIndex(index: ProjectIndex, queryText: string, limit = 20): ProjectIndexQueryResult {
	const tokens = [...new Set(tokenize(queryText).map(normalizeToken))].slice(0, 12);
	const scored = index.entries
		.map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
		.slice(0, Math.max(1, limit));
	return {
		matches: scored.map((item) => item.entry),
		tokens,
	};
}

export function inferRepoScaleMode(input: { totalFiles: number; sourceFiles: number }): RepoScaleMode {
	return repoScaleFromCounts(input.totalFiles, input.sourceFiles);
}

export function collectChangedFilesSince(index: ProjectIndex, cwd: string): string[] {
	const root = resolve(cwd);
	const changed: string[] = [];
	for (const entry of index.entries) {
		const absPath = join(root, entry.path);
		let stat;
		try {
			stat = statSync(absPath);
		} catch {
			changed.push(entry.path);
			continue;
		}
		if (!stat.isFile()) {
			changed.push(entry.path);
			continue;
		}
		if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
			changed.push(entry.path);
		}
	}
	return changed;
}
