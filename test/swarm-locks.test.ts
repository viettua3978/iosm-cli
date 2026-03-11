import { describe, expect, it } from "vitest";
import { HierarchicalLockManager, isTouchInScope, touchesConflict } from "../src/core/swarm/locks.js";

describe("swarm hierarchical locks", () => {
	it("detects parent/child conflicts and supports downgrade", () => {
		const locks = new HierarchicalLockManager();
		expect(locks.canAcquire("task_a", ["src/auth/**"]).ok).toBe(true);
		locks.acquire("task_a", ["src/auth/**"]);

		expect(locks.canAcquire("task_b", ["src/auth/token.ts"]).ok).toBe(false);
		locks.downgrade("task_a", ["src/auth/session.ts"]);
		expect(locks.canAcquire("task_b", ["src/auth/token.ts"]).ok).toBe(true);
	});

	it("matches touches against scope and conflict helper", () => {
		expect(isTouchInScope("src/api/auth.ts", "src/api/**")).toBe(true);
		expect(isTouchInScope("docs/readme.md", "src/**")).toBe(false);
		expect(touchesConflict(["src/auth/**"], ["src/auth/token.ts"])).toBe(true);
		expect(touchesConflict(["src/auth/token.ts"], ["src/auth/session.ts"])).toBe(false);
	});
});
