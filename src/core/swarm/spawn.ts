import { createHash } from "node:crypto";
import type { SwarmSpawnCandidate } from "./types.js";

function normalize(input: string): string {
	return input.trim().toLowerCase().replace(/\s+/g, " ");
}

export function createSpawnFingerprint(candidate: Pick<SwarmSpawnCandidate, "description" | "path" | "changeType">): string {
	const payload = [normalize(candidate.description), normalize(candidate.path), normalize(candidate.changeType)].join("|");
	return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export class SwarmSpawnQueue {
	private readonly byFingerprint = new Map<string, SwarmSpawnCandidate>();
	private readonly order: string[] = [];

	enqueue(candidate: SwarmSpawnCandidate): { accepted: boolean; fingerprint: string } {
		const fingerprint = createSpawnFingerprint(candidate);
		if (this.byFingerprint.has(fingerprint)) {
			return { accepted: false, fingerprint };
		}
		this.byFingerprint.set(fingerprint, candidate);
		this.order.push(fingerprint);
		return { accepted: true, fingerprint };
	}

	drain(limit: number): Array<{ fingerprint: string; candidate: SwarmSpawnCandidate }> {
		const result: Array<{ fingerprint: string; candidate: SwarmSpawnCandidate }> = [];
		const max = Math.max(0, limit);
		while (this.order.length > 0 && result.length < max) {
			const fingerprint = this.order.shift();
			if (!fingerprint) break;
			const candidate = this.byFingerprint.get(fingerprint);
			if (!candidate) continue;
			this.byFingerprint.delete(fingerprint);
			result.push({ fingerprint, candidate });
		}
		return result;
	}

	size(): number {
		return this.byFingerprint.size;
	}
}
