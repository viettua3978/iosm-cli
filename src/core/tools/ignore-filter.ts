import { existsSync, readFileSync } from "node:fs";
import ignore from "ignore";
import { dirname, join, relative, resolve, sep } from "node:path";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

interface IgnoreState {
	matcher: IgnoreMatcher;
	patterns: string[];
}

export interface PathIgnoreFilter {
	ignores(absolutePath: string): boolean;
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function loadIgnorePatterns(dir: string, rootDir: string): string[] {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	const patterns: string[] = [];

	for (const fileName of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, fileName);
		if (!existsSync(ignorePath)) {
			continue;
		}

		try {
			const content = readFileSync(ignorePath, "utf-8");
			patterns.push(
				...content
					.split(/\r?\n/)
					.map((line) => prefixIgnorePattern(line, prefix))
					.filter((line): line is string => Boolean(line)),
			);
		} catch {
			// Ignore unreadable ignore files and continue with the best available rules.
		}
	}

	return patterns;
}

export function createPathIgnoreFilter(rootDir: string): PathIgnoreFilter {
	const normalizedRoot = resolve(rootDir);
	const stateCache = new Map<string, IgnoreState>();

	const buildState = (dir: string): IgnoreState => {
		const normalizedDir = resolve(dir);
		const cached = stateCache.get(normalizedDir);
		if (cached) {
			return cached;
		}

		if (normalizedDir === normalizedRoot) {
			const patterns = loadIgnorePatterns(normalizedDir, normalizedRoot);
			const matcher = ignore();
			if (patterns.length > 0) {
				matcher.add(patterns);
			}
			const state = { matcher, patterns };
			stateCache.set(normalizedDir, state);
			return state;
		}

		const parentState = buildState(dirname(normalizedDir));
		const relativeDir = toPosixPath(relative(normalizedRoot, normalizedDir));
		if (relativeDir && parentState.matcher.ignores(`${relativeDir}/`)) {
			stateCache.set(normalizedDir, parentState);
			return parentState;
		}

		const patterns = parentState.patterns.slice();
		patterns.push(...loadIgnorePatterns(normalizedDir, normalizedRoot));

		const matcher = ignore();
		if (patterns.length > 0) {
			matcher.add(patterns);
		}

		const state = { matcher, patterns };
		stateCache.set(normalizedDir, state);
		return state;
	};

	return {
		ignores(absolutePath: string): boolean {
			const normalizedPath = resolve(absolutePath);
			const relativePath = relative(normalizedRoot, normalizedPath);

			if (!relativePath || relativePath.startsWith("..")) {
				return false;
			}

			return buildState(dirname(normalizedPath)).matcher.ignores(toPosixPath(relativePath));
		},
	};
}
