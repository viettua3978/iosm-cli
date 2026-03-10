import type { TUI } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";

/** Dense character set for the coding-strip animation */
const CIPHER_CHARS = Array.from("!@#$%^&*<>{}[]|~=+?/\\▓▒░01");
const STREAM_LENGTH = 96;
const WINDOW_LENGTH = 34;
const SWEEP_WIDTH = 7;
const TICK_MS = 70;

function hashSeed(input: string): number {
	let hash = 2166136261;
	for (const ch of input) {
		hash ^= ch.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function createSeededRandom(seed: number): () => number {
	let state = seed || 1;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Loader component with a seamless coding-strip animation.
 *
 * The visual intentionally never reveals the status text itself. The message is
 * only used as a seed so different tasks get slightly different symbol streams.
 */
export class DecryptLoader extends Text {
	private targetMessage: string;
	private tick = 0;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private ui: TUI | null = null;
	private stream = "";

	constructor(
		ui: TUI,
		private readonly spinnerColorFn: (str: string) => string,
		private readonly messageColorFn: (str: string) => string,
		message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.targetMessage = message;
		this.rebuildStream();
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.stop();
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.tick++;
			this.updateDisplay();
		}, TICK_MS);
	}

	stop(): void {
		if (this.intervalId !== null) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string): void {
		if (message !== this.targetMessage) {
			this.targetMessage = message;
			this.tick = 0;
			this.rebuildStream();
			this.updateDisplay();
		}
	}

	private rebuildStream(): void {
		const seed = hashSeed(this.targetMessage || "iosm");
		const random = createSeededRandom(seed);
		const chars: string[] = [];

		for (let index = 0; index < STREAM_LENGTH; index++) {
			let next = CIPHER_CHARS[Math.floor(random() * CIPHER_CHARS.length)] ?? "▓";
			if (chars.length > 0 && chars[chars.length - 1] === next) {
				next = CIPHER_CHARS[(CIPHER_CHARS.indexOf(next) + 3) % CIPHER_CHARS.length] ?? next;
			}
			chars.push(next);
		}

		this.stream = chars.join("");
	}

	private updateDisplay(): void {
		if (!this.stream) {
			this.rebuildStream();
		}

		const doubledStream = this.stream + this.stream;
		const offset = (this.tick * 2) % this.stream.length;
		const slice = doubledStream.slice(offset, offset + WINDOW_LENGTH);
		const sweepStart = (this.tick * 3) % WINDOW_LENGTH;

		let display = "";
		for (let index = 0; index < slice.length; index++) {
			const ch = slice[index] ?? " ";
			const relative = (index - sweepStart + WINDOW_LENGTH) % WINDOW_LENGTH;
			const inSweep = relative < SWEEP_WIDTH;
			display += inSweep ? this.spinnerColorFn(ch) : this.messageColorFn(ch);
		}

		this.setText(display);
		this.ui?.requestRender();
	}
}
