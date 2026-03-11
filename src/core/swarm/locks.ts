function normalizeTouch(value: string): string {
	const trimmed = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!trimmed) return "";
	return trimmed.replace(/\/+/g, "/").replace(/\/$/, "");
}

function normalizePrefix(value: string): string {
	const normalized = normalizeTouch(value);
	if (!normalized) return "";
	if (normalized.endsWith("/**") || normalized.endsWith("/*")) {
		return normalized.replace(/\/\*\*?$/, "");
	}
	return normalized;
}

function overlaps(a: string, b: string): boolean {
	if (!a || !b) return false;
	const na = normalizePrefix(a);
	const nb = normalizePrefix(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	if (na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)) return true;
	return false;
}

export interface LockConflict {
	taskId: string;
	conflictsWithTaskId: string;
	touch: string;
	conflictingTouch: string;
}

export class HierarchicalLockManager {
	private readonly locksByTask = new Map<string, string[]>();

	canAcquire(taskId: string, touches: string[]): { ok: boolean; conflicts: LockConflict[] } {
		const normalizedTouches = touches.map((touch) => normalizeTouch(touch)).filter((touch) => touch.length > 0);
		const conflicts: LockConflict[] = [];
		for (const [existingTaskId, existingTouches] of this.locksByTask.entries()) {
			if (existingTaskId === taskId) continue;
			for (const touch of normalizedTouches) {
				for (const existingTouch of existingTouches) {
					if (!overlaps(touch, existingTouch)) continue;
					conflicts.push({
						taskId,
						conflictsWithTaskId: existingTaskId,
						touch,
						conflictingTouch: existingTouch,
					});
				}
			}
		}
		return { ok: conflicts.length === 0, conflicts };
	}

	acquire(taskId: string, touches: string[]): void {
		const normalized = touches.map((touch) => normalizeTouch(touch)).filter((touch) => touch.length > 0);
		this.locksByTask.set(taskId, normalized);
	}

	release(taskId: string): void {
		this.locksByTask.delete(taskId);
	}

	downgrade(taskId: string, touches: string[]): void {
		if (!this.locksByTask.has(taskId)) return;
		this.acquire(taskId, touches);
	}

	has(taskId: string): boolean {
		return this.locksByTask.has(taskId);
	}

	snapshot(): Record<string, string[]> {
		const result: Record<string, string[]> = {};
		for (const [taskId, touches] of this.locksByTask.entries()) {
			result[taskId] = [...touches];
		}
		return result;
	}
}

export function isTouchInScope(touch: string, scope: string): boolean {
	const normalizedTouch = normalizePrefix(touch);
	const normalizedScope = normalizePrefix(scope);
	if (!normalizedTouch || !normalizedScope) return false;
	return normalizedTouch === normalizedScope || normalizedTouch.startsWith(`${normalizedScope}/`);
}

export function touchesConflict(a: string[], b: string[]): boolean {
	for (const ta of a) {
		for (const tb of b) {
			if (overlaps(ta, tb)) return true;
		}
	}
	return false;
}
