import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getIosmGuidePath } from "./paths.js";

const IOSM_CONTEXT_INTRO =
	"The following is the IOSM operational guide for this project. Read it carefully before each engineering action.";

export function buildIosmContextBlock(content: string): string {
	return ["<iosm-context>", IOSM_CONTEXT_INTRO, "", content.trimEnd(), "</iosm-context>"].join("\n");
}

export function loadIosmContextFromPath(guidePath: string): string | undefined {
	if (!existsSync(guidePath)) {
		return undefined;
	}

	let content: string;
	try {
		content = readFileSync(guidePath, "utf8");
	} catch {
		return undefined;
	}

	return buildIosmContextBlock(content);
}

export function findIosmGuidePath(startDir: string = process.cwd()): string | undefined {
	let currentDir = resolve(startDir);
	const rootDir = resolve("/");

	while (true) {
		const guidePath = getIosmGuidePath(currentDir);
		if (existsSync(guidePath)) {
			return guidePath;
		}

		if (currentDir === rootDir) {
			return undefined;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

/**
 * Load the nearest IOSM.md from the given working directory (walking up
 * ancestor directories) and return it wrapped in a structured context block
 * suitable for injection into the agent system prompt.
 *
 * Returns `undefined` if no IOSM.md file exists in `cwd` or its parents.
 */
export function loadIosmContext(cwd: string): string | undefined {
	const guidePath = findIosmGuidePath(cwd);
	return guidePath ? loadIosmContextFromPath(guidePath) : undefined;
}
