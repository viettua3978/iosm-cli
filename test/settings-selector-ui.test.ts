import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { SettingsSelectorComponent, type SettingsCallbacks, type SettingsConfig } from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createConfig(): SettingsConfig {
	return {
		autoCompact: true,
		showImages: true,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		transport: "auto",
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
		currentTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		collapseChangelog: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		autocompleteMaxVisible: 10,
		quietStartup: false,
		clearOnShrink: false,
	};
}

function createCallbacks(): SettingsCallbacks {
	const noop = () => {};
	return {
		onAutoCompactChange: noop,
		onShowImagesChange: noop,
		onAutoResizeImagesChange: noop,
		onBlockImagesChange: noop,
		onEnableSkillCommandsChange: noop,
		onSteeringModeChange: noop,
		onFollowUpModeChange: noop,
		onTransportChange: noop,
		onThinkingLevelChange: noop,
		onThemeChange: noop,
		onThemePreview: noop,
		onHideThinkingBlockChange: noop,
		onCollapseChangelogChange: noop,
		onDoubleEscapeActionChange: noop,
		onTreeFilterModeChange: noop,
		onShowHardwareCursorChange: noop,
		onEditorPaddingXChange: noop,
		onAutocompleteMaxVisibleChange: noop,
		onQuietStartupChange: noop,
		onClearOnShrinkChange: noop,
		onCancel: noop,
	};
}

describe("SettingsSelectorComponent UI", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows title and quick usage summary", () => {
		const component = new SettingsSelectorComponent(createConfig(), createCallbacks());
		const output = stripAnsi(component.render(120).join("\n"));

		expect(output).toContain("Settings");
		expect(output).toContain("search enabled");
		expect(output).toContain("Enter to edit");
		expect(output).toContain("Esc to close");
	});
});
