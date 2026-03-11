import { describe, expect, it } from "vitest";
import { classifyFailureCause, isRetrospectiveRetryable } from "../src/core/failure-retrospective.js";

describe("failure retrospective classification", () => {
	it("maps abort messages to aborted and disables retrospective retry", () => {
		expect(classifyFailureCause("Operation aborted")).toBe("aborted");
		expect(classifyFailureCause("signal aborted while waiting")).toBe("aborted");
		expect(isRetrospectiveRetryable(classifyFailureCause("Operation aborted"))).toBe(false);
	});

	it("keeps existing token/logic/dependency mapping", () => {
		expect(classifyFailureCause("Context window exceeded token limit.")).toBe("token_limit");
		expect(classifyFailureCause("Invariant violated: logic mismatch")).toBe("logic_error");
		expect(classifyFailureCause("module not found: foo")).toBe("dependency_env");
	});
});
