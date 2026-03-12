import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSharedMemoryPath,
	readSharedMemory,
	type SharedMemoryContext,
	writeSharedMemory,
} from "../src/core/shared-memory.js";

describe("shared memory runtime", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "iosm-shared-memory-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const context = (taskId?: string): SharedMemoryContext => ({
		rootCwd: cwd,
		runId: "run_mesh",
		taskId,
	});

	it("supports concurrent run-scoped writes and cross-task reads", async () => {
		await Promise.all(
			Array.from({ length: 5 }, (_unused, index) =>
				writeSharedMemory(context(`task_${index + 1}`), {
					scope: "run",
					key: "mesh/log",
					value: `[task_${index + 1}]`,
					mode: "append",
				}),
			),
		);

		const readByTask = await readSharedMemory(context("task_5"), {
			scope: "run",
			key: "mesh/log",
			includeValues: true,
		});
		const value = readByTask.items[0]?.value ?? "";
		for (let index = 1; index <= 5; index += 1) {
			expect(value).toContain(`[task_${index}]`);
		}
		expect(readByTask.totalMatched).toBe(1);
	});

	it("enforces CAS mismatch checks and supports valid CAS updates", async () => {
		const first = await writeSharedMemory(context("task_1"), {
			scope: "run",
			key: "state/checkpoint",
			value: "v1",
			mode: "set",
		});
		expect(first.version).toBe(1);

		const second = await writeSharedMemory(context("task_2"), {
			scope: "run",
			key: "state/checkpoint",
			value: "v2",
			mode: "set",
			ifVersion: first.version,
		});
		expect(second.version).toBe(2);
		expect(second.value).toBe("v2");

		await expect(
			writeSharedMemory(context("task_3"), {
				scope: "run",
				key: "state/checkpoint",
				value: "v3",
				mode: "set",
				ifVersion: first.version,
			}),
		).rejects.toThrow(/CAS mismatch/i);
	});

	it("isolates task scope from other tasks while keeping run scope shared", async () => {
		await writeSharedMemory(context("task_1"), {
			scope: "task",
			key: "notes/private",
			value: "task1-secret",
			mode: "set",
		});
		await writeSharedMemory(context("task_1"), {
			scope: "run",
			key: "notes/public",
			value: "shared-note",
			mode: "set",
		});

		const task1Local = await readSharedMemory(context("task_1"), {
			scope: "task",
			prefix: "notes/",
			includeValues: true,
		});
		expect(task1Local.items).toHaveLength(1);
		expect(task1Local.items[0]?.key).toBe("notes/private");
		expect(task1Local.items[0]?.value).toBe("task1-secret");

		const task2Local = await readSharedMemory(context("task_2"), {
			scope: "task",
			prefix: "notes/",
			includeValues: true,
		});
		expect(task2Local.items).toHaveLength(0);

		const task2Run = await readSharedMemory(context("task_2"), {
			scope: "run",
			key: "notes/public",
			includeValues: true,
		});
		expect(task2Run.items).toHaveLength(1);
		expect(task2Run.items[0]?.value).toBe("shared-note");
	});

	it("serves snapshot reads even when write lock is held", async () => {
		await writeSharedMemory(context("task_1"), {
			scope: "run",
			key: "snapshot/key",
			value: "snapshot-value",
			mode: "set",
		});
		const filePath = getSharedMemoryPath(cwd, "run_mesh");
		const release = await lockfile.lock(filePath, { realpath: false });
		try {
			const startedAt = Date.now();
			const result = await readSharedMemory(context("task_2"), {
				scope: "run",
				key: "snapshot/key",
				includeValues: true,
			});
			const elapsedMs = Date.now() - startedAt;
			expect(elapsedMs).toBeLessThan(120);
			expect(result.items[0]?.value).toBe("snapshot-value");
		} finally {
			await release();
		}
	});

	it("aborts lock-retrying writes when signal is cancelled", async () => {
		await writeSharedMemory(context("task_1"), {
			scope: "run",
			key: "abort/key",
			value: "seed",
			mode: "set",
		});
		const filePath = getSharedMemoryPath(cwd, "run_mesh");
		const release = await lockfile.lock(filePath, { realpath: false });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 25);
		try {
			await expect(
				writeSharedMemory(
					context("task_2"),
					{
						scope: "run",
						key: "abort/key",
						value: "blocked-write",
						mode: "append",
					},
					controller.signal,
				),
			).rejects.toThrow(/aborted/i);
		} finally {
			await release();
		}
	});
});
