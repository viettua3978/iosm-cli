import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
	const resolvedPackageName = packageName || PACKAGE_NAME;
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return REPOSITORY_URL
				? `Download from: ${REPOSITORY_URL}/releases/latest`
				: `Run: npm install -g ${resolvedPackageName}`;
		case "pnpm":
			return `Run: pnpm install -g ${resolvedPackageName}`;
		case "yarn":
			return `Run: yarn global add ${resolvedPackageName}`;
		case "bun":
			return `Run: bun install -g ${resolvedPackageName}`;
		case "npm":
			return `Run: npm install -g ${resolvedPackageName}`;
		default:
			return `Run: npm install -g ${resolvedPackageName}`;
	}
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.IOSM_PACKAGE_DIR || process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// App Config (from package.json iosmConfig)
// =============================================================================

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));

function normalizeRepositoryUrl(repository: unknown): string | undefined {
	let url: string | undefined;
	if (typeof repository === "string") {
		url = repository;
	} else if (repository && typeof repository === "object" && "url" in repository) {
		const repoUrl = (repository as { url?: unknown }).url;
		if (typeof repoUrl === "string") {
			url = repoUrl;
		}
	}

	if (!url) return undefined;
	const normalized = url.replace(/^git\+/, "").replace(/\.git$/, "");
	if (normalized.startsWith("github:")) {
		return `https://github.com/${normalized.slice("github:".length)}`;
	}
	return normalized;
}

export const APP_NAME: string = pkg.iosmConfig?.name || pkg.piConfig?.name || "iosm";
export const PACKAGE_NAME: string = pkg.name || APP_NAME;
export const CONFIG_DIR_NAME: string = pkg.iosmConfig?.configDir || pkg.piConfig?.configDir || ".iosm";
export const VERSION: string = pkg.version;
export const REPOSITORY_URL: string | undefined = normalizeRepositoryUrl(pkg.repository);
export const CHANGELOG_URL: string | undefined = REPOSITORY_URL ? `${REPOSITORY_URL}/blob/main/CHANGELOG.md` : undefined;
const APP_ENV_PREFIX = APP_NAME.toUpperCase();

// Primary app-specific env vars (legacy aliases are still supported)
export const ENV_AGENT_DIR = `${APP_ENV_PREFIX}_CODING_AGENT_DIR`;
export const ENV_PACKAGE_DIR = `${APP_ENV_PREFIX}_PACKAGE_DIR`;
export const ENV_OFFLINE = `${APP_ENV_PREFIX}_OFFLINE`;
export const ENV_SKIP_VERSION_CHECK = `${APP_ENV_PREFIX}_SKIP_VERSION_CHECK`;
export const ENV_SHARE_VIEWER_URL = `${APP_ENV_PREFIX}_SHARE_VIEWER_URL`;
export const ENV_CLEAR_ON_SHRINK = `${APP_ENV_PREFIX}_CLEAR_ON_SHRINK`;
export const ENV_HARDWARE_CURSOR = `${APP_ENV_PREFIX}_HARDWARE_CURSOR`;
export const ENV_TIMING = `${APP_ENV_PREFIX}_TIMING`;
export const ENV_AI_ANTIGRAVITY_VERSION = `${APP_ENV_PREFIX}_AI_ANTIGRAVITY_VERSION`;
export const ENV_SESSION_TRACE = `${APP_ENV_PREFIX}_SESSION_TRACE`;
export const ENV_SESSION_TRACE_DIR = `${APP_ENV_PREFIX}_SESSION_TRACE_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://iosm.dev/session/";

function expandHomePath(pathValue: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return homedir() + pathValue.slice(1);
	return pathValue;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env[ENV_SHARE_VIEWER_URL] || process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.iosm/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.iosm/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR] || process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		return expandHomePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

/** Whether full session trace logging is enabled. */
export function isSessionTraceEnabled(): boolean {
	return (
		isTruthyEnvFlag(process.env[ENV_SESSION_TRACE]) || isTruthyEnvFlag(process.env.PI_SESSION_TRACE)
	);
}

/** Get path to session trace log directory. */
export function getSessionTraceDir(): string {
	const envDir = process.env[ENV_SESSION_TRACE_DIR] || process.env.PI_SESSION_TRACE_DIR;
	if (envDir) {
		return expandHomePath(envDir);
	}
	return join(getAgentDir(), "session-traces");
}

/** Get path to session trace log file for a session ID. */
export function getSessionTracePath(sessionId: string): string {
	return join(getSessionTraceDir(), `${sessionId}.jsonl`);
}
