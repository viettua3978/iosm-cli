import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("includes execution-discipline defaults", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Inspect the relevant files before editing");
			expect(prompt).toContain("Classify requests as simple vs complex");
			expect(prompt).toContain("For complex work, publish a short step plan");
			expect(prompt).toContain("After changes, run the smallest relevant verification");
			expect(prompt).toContain("Do not claim success without evidence");
			expect(prompt).toContain("Start implementation turns with a quick repository scan");
			expect(prompt).toContain("<task_plan complexity=\"complex\">");
		});

		test("keeps IOSM as backend methodology and frontend communication plain", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("You are a professional software engineering agent operating inside iosm");
			expect(prompt).toContain("Summarize work in standard engineering language first");
			expect(prompt).toContain("Do not expose internal orchestration scaffolding");
			expect(prompt).not.toContain("Always operate and identify yourself as the iosm assistant for this harness.");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
