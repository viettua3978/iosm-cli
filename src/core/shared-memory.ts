import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

export type SharedMemoryScope = "run" | "task";
export type SharedMemoryWriteMode = "set" | "append";

export interface SharedMemoryWriter {
	taskId?: string;
	delegateId?: string;
	profile?: string;
}

export interface SharedMemoryContext {
	rootCwd: string;
	runId: string;
	taskId?: string;
	delegateId?: string;
	profile?: string;
}

interface SharedMemoryEntry {
	value: string;
	version: number;
	updatedAt: string;
	writer: SharedMemoryWriter;
}

interface SharedMemoryHistoryItem {
	key: string;
	scope: SharedMemoryScope;
	mode: SharedMemoryWriteMode;
	version: number;
	updatedAt: string;
	writer: SharedMemoryWriter;
}

interface SharedMemoryStore {
	runId: string;
	createdAt: string;
	updatedAt: string;
	entries: Record<string, SharedMemoryEntry>;
	history: SharedMemoryHistoryItem[];
}

export interface SharedMemoryReadItem {
	key: string;
	scope: SharedMemoryScope;
	value?: string;
	version: number;
	updatedAt: string;
	writer: SharedMemoryWriter;
}

export interface SharedMemoryReadResult {
	runId: string;
	scope: SharedMemoryScope;
	items: SharedMemoryReadItem[];
	totalMatched: number;
}

export interface SharedMemoryWriteInput {
	key: string;
	value: string;
	scope: SharedMemoryScope;
	mode: SharedMemoryWriteMode;
	ifVersion?: number;
}

export interface SharedMemoryReadInput {
	scope: SharedMemoryScope;
	key?: string;
	prefix?: string;
	limit?: number;
	includeValues?: boolean;
}

const maxEntryCharsDefault = 4000;
const maxKeysDefault = 500;
const historySizeDefault = 1000;
const lockRetryAttempts = 12;
const lockRetryDelayMs = 20;

const maxEntryChars = readBoundedInt(process.env.IOSM_SUBAGENT_SHARED_MEMORY_MAX_ENTRY_CHARS, maxEntryCharsDefault, 64, 20_000);
const maxKeys = readBoundedInt(process.env.IOSM_SUBAGENT_SHARED_MEMORY_MAX_KEYS, maxKeysDefault, 10, 20_000);
const historySize = readBoundedInt(process.env.IOSM_SUBAGENT_SHARED_MEMORY_HISTORY_SIZE, historySizeDefault, 10, 50_000);

function readBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = raw ? Number.parseInt(raw, 10) : fallback;
	if (!Number.isInteger(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRunId(runId: string): string {
	const trimmed = runId.trim();
	if (!trimmed) throw new Error("shared memory requires non-empty run_id context");
	return trimmed;
}

function normalizeKey(key: string): string {
	const normalized = key.trim().replace(/\s+/g, " ");
	if (!normalized) throw new Error("shared memory key must be non-empty");
	if (normalized.length > 240) {
		throw new Error("shared memory key too long (max 240 chars)");
	}
	return normalized;
}

function resolveScopedKey(context: SharedMemoryContext, scope: SharedMemoryScope, key: string): string {
	const normalizedKey = normalizeKey(key);
	if (scope === "task") {
		if (!context.taskId || !context.taskId.trim()) {
			throw new Error("task-scoped shared memory requires task_id context");
		}
		return `task:${context.taskId.trim()}:${normalizedKey}`;
	}
	return `run:${normalizedKey}`;
}

function parseScopedKey(scopedKey: string): { scope: SharedMemoryScope; key: string; taskId?: string } {
	if (scopedKey.startsWith("task:")) {
		const rest = scopedKey.slice("task:".length);
		const split = rest.indexOf(":");
		if (split <= 0) {
			return { scope: "task", key: rest };
		}
		return {
			scope: "task",
			taskId: rest.slice(0, split),
			key: rest.slice(split + 1),
		};
	}
	if (scopedKey.startsWith("run:")) {
		return { scope: "run", key: scopedKey.slice("run:".length) };
	}
	return { scope: "run", key: scopedKey };
}

function getSharedMemoryDir(rootCwd: string): string {
	return join(rootCwd, ".iosm", "subagents", "shared-memory");
}

export function getSharedMemoryPath(rootCwd: string, runId: string): string {
	return join(getSharedMemoryDir(rootCwd), `${normalizeRunId(runId)}.json`);
}

function createInitialStore(runId: string): SharedMemoryStore {
	const now = new Date().toISOString();
	return {
		runId,
		createdAt: now,
		updatedAt: now,
		entries: {},
		history: [],
	};
}

function readStore(filePath: string, runId: string): SharedMemoryStore {
	if (!existsSync(filePath)) {
		return createInitialStore(runId);
	}
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as SharedMemoryStore;
		if (!parsed || typeof parsed !== "object") return createInitialStore(runId);
		if (parsed.runId !== runId) return createInitialStore(runId);
		if (!parsed.entries || typeof parsed.entries !== "object") parsed.entries = {};
		if (!Array.isArray(parsed.history)) parsed.history = [];
		if (!parsed.createdAt || typeof parsed.createdAt !== "string") parsed.createdAt = new Date().toISOString();
		if (!parsed.updatedAt || typeof parsed.updatedAt !== "string") parsed.updatedAt = parsed.createdAt;
		return parsed;
	} catch {
		return createInitialStore(runId);
	}
}

function writeStore(filePath: string, store: SharedMemoryStore): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
	for (let attempt = 1; attempt <= lockRetryAttempts; attempt += 1) {
		try {
			return await lockfile.lock(filePath, { realpath: false });
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
			if (code !== "ELOCKED" || attempt >= lockRetryAttempts) {
				throw error;
			}
			await delay(lockRetryDelayMs * attempt);
		}
	}
	throw new Error("failed to acquire shared memory lock");
}

async function withLockedStore<T>(
	context: SharedMemoryContext,
	fn: (store: SharedMemoryStore, filePath: string) => T,
): Promise<T> {
	const runId = normalizeRunId(context.runId);
	const filePath = getSharedMemoryPath(context.rootCwd, runId);
	mkdirSync(dirname(filePath), { recursive: true });
	if (!existsSync(filePath)) {
		writeStore(filePath, createInitialStore(runId));
	}
	const release = await acquireFileLock(filePath);
	try {
		const store = readStore(filePath, runId);
		const value = fn(store, filePath);
		writeStore(filePath, store);
		return value;
	} finally {
		await release();
	}
}

function trimHistory(store: SharedMemoryStore): void {
	if (store.history.length <= historySize) return;
	store.history = store.history.slice(store.history.length - historySize);
}

function writerFromContext(context: SharedMemoryContext): SharedMemoryWriter {
	return {
		taskId: context.taskId?.trim() || undefined,
		delegateId: context.delegateId?.trim() || undefined,
		profile: context.profile?.trim() || undefined,
	};
}

export async function writeSharedMemory(
	context: SharedMemoryContext,
	input: SharedMemoryWriteInput,
): Promise<SharedMemoryReadItem> {
	const normalizedValue = input.value;
	if (normalizedValue.length > maxEntryChars) {
		throw new Error(`shared memory value exceeds ${maxEntryChars} chars`);
	}
	const scopedKey = resolveScopedKey(context, input.scope, input.key);

	return withLockedStore(context, (store) => {
		const now = new Date().toISOString();
		const entriesCount = Object.keys(store.entries).length;
		const previous = store.entries[scopedKey];
		if (!previous && entriesCount >= maxKeys) {
			throw new Error(`shared memory key limit reached (${maxKeys})`);
		}
		if (input.ifVersion !== undefined && previous && previous.version !== input.ifVersion) {
			throw new Error(`shared memory CAS mismatch for key "${input.key}" (expected ${input.ifVersion}, got ${previous.version})`);
		}
		if (input.ifVersion !== undefined && !previous) {
			throw new Error(`shared memory CAS mismatch for key "${input.key}" (expected ${input.ifVersion}, got 0)`);
		}

		const nextValue = input.mode === "append" ? `${previous?.value ?? ""}${normalizedValue}` : normalizedValue;
		if (nextValue.length > maxEntryChars) {
			throw new Error(`shared memory value exceeds ${maxEntryChars} chars after ${input.mode}`);
		}
		const nextVersion = (previous?.version ?? 0) + 1;
		const writer = writerFromContext(context);
		store.entries[scopedKey] = {
			value: nextValue,
			version: nextVersion,
			updatedAt: now,
			writer,
		};
		store.updatedAt = now;
		store.history.push({
			key: normalizeKey(input.key),
			scope: input.scope,
			mode: input.mode,
			version: nextVersion,
			updatedAt: now,
			writer,
		});
		trimHistory(store);

		return {
			key: normalizeKey(input.key),
			scope: input.scope,
			value: nextValue,
			version: nextVersion,
			updatedAt: now,
			writer,
		};
	});
}

function matchesScopeAndPrefix(
	context: SharedMemoryContext,
	scopedKey: string,
	scope: SharedMemoryScope,
	key: string | undefined,
	prefix: string | undefined,
): { matched: boolean; parsed: ReturnType<typeof parseScopedKey> } {
	const parsed = parseScopedKey(scopedKey);
	if (parsed.scope !== scope) return { matched: false, parsed };
	if (scope === "task") {
		const taskId = context.taskId?.trim();
		if (!taskId) return { matched: false, parsed };
		if (parsed.taskId !== taskId) return { matched: false, parsed };
	}
	if (key) {
		return { matched: parsed.key === key, parsed };
	}
	if (prefix) {
		return { matched: parsed.key.startsWith(prefix), parsed };
	}
	return { matched: true, parsed };
}

export async function readSharedMemory(
	context: SharedMemoryContext,
	input: SharedMemoryReadInput,
): Promise<SharedMemoryReadResult> {
	const normalizedKey = input.key ? normalizeKey(input.key) : undefined;
	const normalizedPrefix = input.prefix ? normalizeKey(input.prefix) : undefined;
	const limit = Math.max(1, Math.min(100, input.limit ?? 20));
	const includeValues = input.includeValues !== false;

	return withLockedStore(context, (store) => {
		const matchedItems: SharedMemoryReadItem[] = [];
		for (const [scopedKey, entry] of Object.entries(store.entries)) {
			const matched = matchesScopeAndPrefix(context, scopedKey, input.scope, normalizedKey, normalizedPrefix);
			if (!matched.matched) continue;
			matchedItems.push({
				key: matched.parsed.key,
				scope: input.scope,
				value: includeValues ? entry.value : undefined,
				version: entry.version,
				updatedAt: entry.updatedAt,
				writer: entry.writer ?? {},
			});
		}

		matchedItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const sliced = matchedItems.slice(0, limit);
		return {
			runId: store.runId,
			scope: input.scope,
			items: sliced,
			totalMatched: matchedItems.length,
		};
	});
}
