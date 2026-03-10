import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import type { ToolPermissionRequest } from "./tools/permissions.js";

export type HookEventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
export type HookAction = "allow" | "block" | "warn" | "append";

export interface HookRule {
	id?: string;
	event: HookEventName;
	action: HookAction;
	toolNames?: string[];
	match?: string;
	regex?: RegExp;
	caseSensitive: boolean;
	message?: string;
	append?: string;
	sourcePath: string;
}

export interface LoadedHooksConfig {
	userPromptSubmit: HookRule[];
	preToolUse: HookRule[];
	postToolUse: HookRule[];
	stop: HookRule[];
	sources: string[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadHooksOptions {
	cwd: string;
	agentDir: string;
	homeDir?: string;
	organizationDir?: string;
}

export interface UserPromptHooksResult {
	text: string;
	blocked: boolean;
	message?: string;
	notices: string[];
}

export interface PreToolHooksResult {
	allowed: boolean;
	message?: string;
	notices: string[];
}

export interface PostToolHooksInput {
	toolName: string;
	outputText?: string;
	isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}
	if (Array.isArray(value)) {
		const result: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") continue;
			const trimmed = item.trim();
			if (trimmed.length > 0) result.push(trimmed);
		}
		return result;
	}
	return [];
}

function normalizeAction(value: unknown, fallback: HookAction): HookAction {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "allow":
		case "block":
		case "warn":
		case "append":
			return normalized;
		default:
			return fallback;
	}
}

function eventKeyCandidates(event: HookEventName): string[] {
	switch (event) {
		case "UserPromptSubmit":
			return ["UserPromptSubmit", "userPromptSubmit", "user_prompt_submit"];
		case "PreToolUse":
			return ["PreToolUse", "preToolUse", "pre_tool_use"];
		case "PostToolUse":
			return ["PostToolUse", "postToolUse", "post_tool_use"];
		case "Stop":
			return ["Stop", "stop"];
	}
}

function defaultAction(event: HookEventName): HookAction {
	switch (event) {
		case "UserPromptSubmit":
		case "PreToolUse":
			return "block";
		case "PostToolUse":
		case "Stop":
			return "warn";
	}
}

function readEventRules(object: Record<string, unknown>, event: HookEventName): unknown[] {
	for (const key of eventKeyCandidates(event)) {
		const value = object[key];
		if (Array.isArray(value)) {
			return value;
		}
	}
	return [];
}

function parseRule(
	event: HookEventName,
	raw: unknown,
	sourcePath: string,
	diagnostics: ResourceDiagnostic[],
	index: number,
): HookRule | undefined {
	const fallbackAction = defaultAction(event);
	if (typeof raw === "string") {
		const match = raw.trim();
		if (match.length === 0) return undefined;
		return {
			event,
			action: fallbackAction,
			match,
			caseSensitive: false,
			sourcePath,
			id: `${event}-${index + 1}`,
		};
	}

	if (!isRecord(raw)) {
		diagnostics.push({
			type: "warning",
			path: sourcePath,
			message: `${event}: rule ${index + 1} must be an object or string`,
		});
		return undefined;
	}

	if (raw.enabled === false) {
		return undefined;
	}

	const ruleId = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : `${event}-${index + 1}`;
	const action = normalizeAction(raw.action, fallbackAction);
	const caseSensitive = raw.caseSensitive === true;
	const message = typeof raw.message === "string" && raw.message.trim().length > 0 ? raw.message.trim() : undefined;
	const append = typeof raw.append === "string" && raw.append.trim().length > 0 ? raw.append.trim() : undefined;
	const matchCandidate =
		(typeof raw.match === "string" && raw.match) || (typeof raw.contains === "string" && raw.contains);
	const match = typeof matchCandidate === "string" && matchCandidate.trim().length > 0 ? matchCandidate.trim() : undefined;

	let regex: RegExp | undefined;
	if (typeof raw.regex === "string" && raw.regex.trim().length > 0) {
		try {
			regex = new RegExp(raw.regex, caseSensitive ? undefined : "i");
		} catch (error) {
			diagnostics.push({
				type: "warning",
				path: sourcePath,
				message: `${event}: invalid regex in rule "${ruleId}": ${error instanceof Error ? error.message : String(error)}`,
			});
			return undefined;
		}
	}

	const toolNames = [
		...toStringArray(raw.tool),
		...toStringArray(raw.tools),
	]
		.map((name) => name.toLowerCase())
		.filter((name, idx, arr) => arr.indexOf(name) === idx);

	return {
		id: ruleId,
		event,
		action,
		toolNames: toolNames.length > 0 ? toolNames : undefined,
		match,
		regex,
		caseSensitive,
		message,
		append,
		sourcePath,
	};
}

function mergeHooksFromFile(
	filePath: string,
	acc: LoadedHooksConfig,
): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (error) {
		acc.diagnostics.push({
			type: "warning",
			path: filePath,
			message: `Failed to parse hooks config: ${error instanceof Error ? error.message : String(error)}`,
		});
		return;
	}

	if (!isRecord(parsed)) {
		acc.diagnostics.push({
			type: "warning",
			path: filePath,
			message: "Hooks config must be a JSON object",
		});
		return;
	}

	const appendRules = (event: HookEventName, target: HookRule[]) => {
		const eventRules = readEventRules(parsed, event);
		for (let index = 0; index < eventRules.length; index++) {
			const rule = parseRule(event, eventRules[index], filePath, acc.diagnostics, index);
			if (rule) target.push(rule);
		}
	};

	appendRules("UserPromptSubmit", acc.userPromptSubmit);
	appendRules("PreToolUse", acc.preToolUse);
	appendRules("PostToolUse", acc.postToolUse);
	appendRules("Stop", acc.stop);
	acc.sources.push(filePath);
}

function collectHookConfigPaths(options: LoadHooksOptions): string[] {
	const resolvedCwd = resolve(options.cwd);
	const resolvedHome = resolve(options.homeDir ?? homedir());
	const candidates: string[] = [];
	const seen = new Set<string>();

	const pushCandidate = (pathValue: string) => {
		const resolvedPath = resolve(pathValue);
		if (seen.has(resolvedPath)) return;
		seen.add(resolvedPath);
		candidates.push(resolvedPath);
	};

	const organizationDir =
		options.organizationDir ??
		process.env.IOSM_ORG_DIR ??
		process.env.PI_ORG_DIR;
	if (organizationDir) {
		pushCandidate(join(resolve(organizationDir), CONFIG_DIR_NAME, "hooks.json"));
	}

	pushCandidate(join(resolvedHome, CONFIG_DIR_NAME, "hooks.json"));
	pushCandidate(join(resolve(options.agentDir), "hooks.json"));
	pushCandidate(join(resolve(options.agentDir), CONFIG_DIR_NAME, "hooks.json"));

	const ancestorCandidates: string[] = [];
	let current = resolvedCwd;
	while (true) {
		ancestorCandidates.push(join(current, CONFIG_DIR_NAME, "hooks.json"));
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	for (let index = ancestorCandidates.length - 1; index >= 0; index--) {
		pushCandidate(ancestorCandidates[index]);
	}

	return candidates.filter((pathValue) => existsSync(pathValue));
}

export function emptyHooksConfig(): LoadedHooksConfig {
	return {
		userPromptSubmit: [],
		preToolUse: [],
		postToolUse: [],
		stop: [],
		sources: [],
		diagnostics: [],
	};
}

export function loadHooksConfig(options: LoadHooksOptions): LoadedHooksConfig {
	const merged = emptyHooksConfig();
	for (const filePath of collectHookConfigPaths(options)) {
		mergeHooksFromFile(filePath, merged);
	}
	return merged;
}

function matchesRule(rule: HookRule, text: string, toolName?: string): boolean {
	if (rule.toolNames && rule.toolNames.length > 0) {
		if (!toolName) return false;
		const normalizedTool = toolName.toLowerCase();
		if (!rule.toolNames.includes("*") && !rule.toolNames.includes(normalizedTool)) {
			return false;
		}
	}

	if (rule.regex) {
		return rule.regex.test(text);
	}

	if (rule.match) {
		if (rule.caseSensitive) {
			return text.includes(rule.match);
		}
		return text.toLowerCase().includes(rule.match.toLowerCase());
	}

	return true;
}

function normalizeNotice(rule: HookRule, fallback: string): string {
	const prefix = rule.id ? `[${rule.id}] ` : "";
	return `${prefix}${rule.message ?? fallback}`;
}

export function applyUserPromptSubmitHooks(config: LoadedHooksConfig, text: string): UserPromptHooksResult {
	let currentText = text;
	const notices: string[] = [];
	const appendSnippets: string[] = [];

	for (let index = config.userPromptSubmit.length - 1; index >= 0; index--) {
		const rule = config.userPromptSubmit[index];
		if (!matchesRule(rule, currentText)) continue;

		if (rule.action === "allow") {
			return { text: currentText, blocked: false, notices };
		}
		if (rule.action === "append") {
			const appendText = rule.append ?? rule.message;
			if (appendText) appendSnippets.push(appendText);
			continue;
		}
		if (rule.action === "warn") {
			notices.push(normalizeNotice(rule, "Matched UserPromptSubmit warning rule."));
			continue;
		}
		if (rule.action === "block") {
			return {
				text: currentText,
				blocked: true,
				message: normalizeNotice(rule, "Prompt blocked by UserPromptSubmit hook."),
				notices,
			};
		}
	}

	if (appendSnippets.length > 0) {
		const joined = appendSnippets.reverse().join("\n\n").trim();
		if (joined.length > 0) {
			currentText = `${currentText}\n\n${joined}`;
		}
	}

	return { text: currentText, blocked: false, notices };
}

export function applyPreToolUseHooks(
	config: LoadedHooksConfig,
	request: ToolPermissionRequest,
): PreToolHooksResult {
	const serializedInput = JSON.stringify(request.input);
	const matchingText = `${request.summary}\n${serializedInput}`;
	const notices: string[] = [];

	for (let index = config.preToolUse.length - 1; index >= 0; index--) {
		const rule = config.preToolUse[index];
		if (!matchesRule(rule, matchingText, request.toolName)) continue;

		if (rule.action === "allow") {
			return { allowed: true, notices };
		}
		if (rule.action === "warn" || rule.action === "append") {
			notices.push(normalizeNotice(rule, "Matched PreToolUse warning rule."));
			continue;
		}
		if (rule.action === "block") {
			return {
				allowed: false,
				message: normalizeNotice(
					rule,
					`Tool "${request.toolName}" blocked by PreToolUse hook.`,
				),
				notices,
			};
		}
	}

	return { allowed: true, notices };
}

export function applyPostToolUseHooks(
	config: LoadedHooksConfig,
	input: PostToolHooksInput,
): string[] {
	const matchingText = `${input.toolName}\n${input.outputText ?? ""}\nerror:${input.isError ? "true" : "false"}`;
	const notices: string[] = [];

	for (let index = config.postToolUse.length - 1; index >= 0; index--) {
		const rule = config.postToolUse[index];
		if (!matchesRule(rule, matchingText, input.toolName)) continue;
		notices.push(
			normalizeNotice(
				rule,
				`PostToolUse hook matched for tool "${input.toolName}".`,
			),
		);
	}

	return notices;
}

export function applyStopHooks(config: LoadedHooksConfig, reason: string): string[] {
	const notices: string[] = [];
	for (let index = config.stop.length - 1; index >= 0; index--) {
		const rule = config.stop[index];
		if (!matchesRule(rule, reason)) continue;
		notices.push(
			normalizeNotice(rule, `Stop hook matched (reason: ${reason}).`),
		);
	}
	return notices;
}
