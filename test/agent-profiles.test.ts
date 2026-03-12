import { describe, expect, it } from "vitest";
import {
	AGENT_PROFILES,
	getAgentProfile,
	getMainProfileNames,
	isValidProfileName,
} from "../src/core/agent-profiles.js";

describe("agent profiles", () => {
	it("keeps full as default fallback profile", () => {
		expect(getAgentProfile(undefined).name).toBe("full");
		expect(getAgentProfile("unknown-profile").name).toBe("full");
	});

	it("registers meta profile with full-capability parity", () => {
		expect(isValidProfileName("meta")).toBe(true);
		expect(AGENT_PROFILES.meta.tools).toEqual(AGENT_PROFILES.full.tools);
		expect(AGENT_PROFILES.meta.thinkingLevel).toBe(AGENT_PROFILES.full.thinkingLevel);
		expect(AGENT_PROFILES.meta.mainMode).toBe(true);
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("bounded read-only recon");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("do not make direct write/edit changes in the main agent before launching the first task call");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain(
			"If the user requested a specific number of parallel agents or delegates",
		);
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("multiple top-level task calls");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("primary optimization target is safe parallel execution");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("single-agent execution is the exception");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain(
			"For conversational or non-repository requests",
		);
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("Do not output internal reasoning");
	});

	it("includes meta in main profile cycling order", () => {
		expect(getMainProfileNames()).toEqual(["plan", "iosm", "meta", "full"]);
	});
});
