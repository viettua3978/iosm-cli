import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MemoryScope = "project" | "user";

export interface MemoryEntry {
	text: string;
	timestamp?: string;
}

export interface MemoryListResult {
	entries: MemoryEntry[];
	hasManagedBlock: boolean;
}

export interface MemoryAddResult {
	entry: MemoryEntry;
	count: number;
}

export interface MemoryRemoveResult {
	entry: MemoryEntry;
	count: number;
}

export interface MemoryUpdateResult {
	entry: MemoryEntry;
	count: number;
}

const MEMORY_BLOCK_START = "<!-- iosm-memory:start -->";
const MEMORY_BLOCK_END = "<!-- iosm-memory:end -->";

interface ParsedMemoryContent {
	lines: string[];
	hasManagedBlock: boolean;
	startIndex: number;
	endIndex: number;
	managedLines: string[];
}

function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n/g, "\n");
}

function parseMemoryContent(rawContent: string, filePath: string): ParsedMemoryContent {
	const lines = normalizeLineEndings(rawContent).split("\n");
	let startIndex = -1;
	let endIndex = -1;

	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index]?.trim();
		if (trimmed === MEMORY_BLOCK_START && startIndex < 0) {
			startIndex = index;
			continue;
		}
		if (trimmed === MEMORY_BLOCK_END && startIndex >= 0) {
			endIndex = index;
			break;
		}
	}

	if (
		(startIndex >= 0 && endIndex < 0) ||
		(startIndex < 0 && endIndex >= 0) ||
		(startIndex >= 0 && endIndex <= startIndex)
	) {
		throw new Error(`Malformed memory block in ${filePath}. Fix markers ${MEMORY_BLOCK_START} and ${MEMORY_BLOCK_END}.`);
	}

	if (startIndex >= 0) {
		return {
			lines,
			hasManagedBlock: true,
			startIndex,
			endIndex,
			managedLines: lines.slice(startIndex + 1, endIndex),
		};
	}

	return {
		lines,
		hasManagedBlock: false,
		startIndex: -1,
		endIndex: -1,
		managedLines: [],
	};
}

function parseMemoryEntryLine(line: string): MemoryEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;

	const timestampedMatch = trimmed.match(/^-\s*\[([^\]]+)\]\s+(.+)$/);
	if (timestampedMatch) {
		return {
			timestamp: timestampedMatch[1]?.trim() || undefined,
			text: timestampedMatch[2]?.trim() ?? "",
		};
	}

	const bulletMatch = trimmed.match(/^-\s+(.+)$/);
	if (bulletMatch) {
		return {
			text: bulletMatch[1]?.trim() ?? "",
		};
	}

	return {
		text: trimmed,
	};
}

function serializeMemoryContent(existingContent: string, parsed: ParsedMemoryContent, managedLines: string[]): string {
	if (parsed.hasManagedBlock) {
		const nextLines = [
			...parsed.lines.slice(0, parsed.startIndex + 1),
			...managedLines,
			...parsed.lines.slice(parsed.endIndex),
		];
		return `${nextLines.join("\n").trimEnd()}\n`;
	}

	const base = normalizeLineEndings(existingContent).trimEnd();
	const block = [MEMORY_BLOCK_START, ...managedLines, MEMORY_BLOCK_END].join("\n");
	const next = base.length > 0 ? `${base}\n\n${block}` : block;
	return `${next.trimEnd()}\n`;
}

function normalizeMemoryText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function formatMemoryEntryLine(text: string, now: Date): string {
	return `- [${now.toISOString()}] ${text}`;
}

function listEntriesFromLines(lines: string[]): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	for (const line of lines) {
		const parsed = parseMemoryEntryLine(line);
		if (!parsed) continue;
		if (!parsed.text) continue;
		entries.push(parsed);
	}
	return entries;
}

function getIndexedEntries(lines: string[]): Array<{ lineIndex: number; entry: MemoryEntry }> {
	const indexedEntries: Array<{ lineIndex: number; entry: MemoryEntry }> = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const entry = parseMemoryEntryLine(lines[lineIndex] ?? "");
		if (!entry || !entry.text) continue;
		indexedEntries.push({ lineIndex, entry });
	}
	return indexedEntries;
}

export function getMemoryFilePath(scope: MemoryScope, cwd: string, agentDir: string): string {
	return scope === "project" ? join(cwd, ".iosm", "memory.md") : join(agentDir, "memory.md");
}

export function readMemoryEntries(filePath: string): MemoryListResult {
	if (!existsSync(filePath)) {
		return { entries: [], hasManagedBlock: false };
	}
	const raw = readFileSync(filePath, "utf8");
	const parsed = parseMemoryContent(raw, filePath);
	return {
		entries: listEntriesFromLines(parsed.managedLines),
		hasManagedBlock: parsed.hasManagedBlock,
	};
}

export function addMemoryEntry(filePath: string, rawText: string, now: Date = new Date()): MemoryAddResult {
	const text = normalizeMemoryText(rawText);
	if (!text) {
		throw new Error("Memory text cannot be empty.");
	}

	const existingContent = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
	const parsed = parseMemoryContent(existingContent, filePath);
	const nextManagedLines = [...parsed.managedLines, formatMemoryEntryLine(text, now)];
	const nextContent = serializeMemoryContent(existingContent, parsed, nextManagedLines);

	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, nextContent, "utf8");

	const entries = listEntriesFromLines(nextManagedLines);
	const entry = entries[entries.length - 1];
	if (!entry) {
		throw new Error("Failed to save memory entry.");
	}
	return {
		entry,
		count: entries.length,
	};
}

export function removeMemoryEntry(filePath: string, index: number): MemoryRemoveResult {
	if (!Number.isInteger(index) || index < 1) {
		throw new Error("Memory index must be a positive integer.");
	}
	if (!existsSync(filePath)) {
		throw new Error("Memory file not found.");
	}

	const existingContent = readFileSync(filePath, "utf8");
	const parsed = parseMemoryContent(existingContent, filePath);
	if (!parsed.hasManagedBlock) {
		throw new Error("No managed memory entries found.");
	}

	const indexedEntries = getIndexedEntries(parsed.managedLines);

	const target = indexedEntries[index - 1];
	if (!target) {
		throw new Error(`Memory entry #${index} not found.`);
	}

	const nextManagedLines = parsed.managedLines.filter((_line, lineIndex) => lineIndex !== target.lineIndex);
	const nextContent = serializeMemoryContent(existingContent, parsed, nextManagedLines);
	writeFileSync(filePath, nextContent, "utf8");

	return {
		entry: target.entry,
		count: listEntriesFromLines(nextManagedLines).length,
	};
}

export function updateMemoryEntry(filePath: string, index: number, rawText: string, now: Date = new Date()): MemoryUpdateResult {
	if (!Number.isInteger(index) || index < 1) {
		throw new Error("Memory index must be a positive integer.");
	}
	const text = normalizeMemoryText(rawText);
	if (!text) {
		throw new Error("Memory text cannot be empty.");
	}
	if (!existsSync(filePath)) {
		throw new Error("Memory file not found.");
	}

	const existingContent = readFileSync(filePath, "utf8");
	const parsed = parseMemoryContent(existingContent, filePath);
	if (!parsed.hasManagedBlock) {
		throw new Error("No managed memory entries found.");
	}

	const indexedEntries = getIndexedEntries(parsed.managedLines);
	const target = indexedEntries[index - 1];
	if (!target) {
		throw new Error(`Memory entry #${index} not found.`);
	}

	const nextManagedLines = [...parsed.managedLines];
	nextManagedLines[target.lineIndex] = formatMemoryEntryLine(text, now);
	const nextContent = serializeMemoryContent(existingContent, parsed, nextManagedLines);
	writeFileSync(filePath, nextContent, "utf8");

	const nextEntries = listEntriesFromLines(nextManagedLines);
	const entry = nextEntries[index - 1];
	if (!entry) {
		throw new Error(`Failed to update memory entry #${index}.`);
	}
	return {
		entry,
		count: nextEntries.length,
	};
}
