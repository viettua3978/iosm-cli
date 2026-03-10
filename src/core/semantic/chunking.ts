import { createHash } from "node:crypto";
import type { SemanticIndexConfig } from "./types.js";

export interface SemanticChunkDraft {
	text: string;
	hash: string;
	lineStart: number;
	lineEnd: number;
	preview: string;
}

function buildLineOffsets(text: string): number[] {
	const offsets = [0];
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") {
			offsets.push(index + 1);
		}
	}
	return offsets;
}

function lineFromOffset(lineOffsets: number[], offset: number): number {
	let low = 0;
	let high = lineOffsets.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const value = lineOffsets[mid] ?? 0;
		if (value <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return Math.max(0, high);
}

function normalizePreview(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= 180) return compact;
	return `${compact.slice(0, 177)}...`;
}

function hashChunk(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function chooseChunkEnd(text: string, start: number, maxChars: number): number {
	const requestedEnd = Math.min(text.length, start + maxChars);
	if (requestedEnd >= text.length) {
		return requestedEnd;
	}
	const minBoundary = start + Math.floor(maxChars * 0.55);
	const newlineBoundary = text.lastIndexOf("\n", requestedEnd);
	if (newlineBoundary >= minBoundary) {
		return newlineBoundary + 1;
	}
	return requestedEnd;
}

export function chunkTextForSemantic(textRaw: string, indexConfig: SemanticIndexConfig): SemanticChunkDraft[] {
	const text = textRaw.replace(/\r\n/g, "\n");
	const trimmed = text.trim();
	if (!trimmed) return [];

	const maxChars = Math.max(200, indexConfig.chunkMaxChars);
	const overlap = Math.max(0, Math.min(indexConfig.chunkOverlapChars, Math.floor(maxChars * 0.8)));
	const lineOffsets = buildLineOffsets(text);

	const drafts: SemanticChunkDraft[] = [];
	let start = 0;

	while (start < text.length) {
		const end = chooseChunkEnd(text, start, maxChars);
		if (end <= start) {
			break;
		}

		const chunkText = text.slice(start, end).trim();
		if (chunkText.length > 0) {
			const startLine = lineFromOffset(lineOffsets, start) + 1;
			const endLine = lineFromOffset(lineOffsets, Math.max(start, end - 1)) + 1;
			drafts.push({
				text: chunkText,
				hash: hashChunk(chunkText),
				lineStart: startLine,
				lineEnd: Math.max(startLine, endLine),
				preview: normalizePreview(chunkText),
			});
		}

		if (end >= text.length) {
			break;
		}

		const nextStart = overlap > 0 ? end - overlap : end;
		start = Math.max(start + 1, nextStart);
	}

	return drafts;
}
