import type { Agent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { EventStream, validateToolArguments } from "@mariozechner/pi-ai";

type ToolCallContent = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

type ToolResultMessageLike = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details: unknown;
	isError: boolean;
	timestamp: number;
};

/**
 * Parallel policy: run tool calls concurrently only when all calls are `task`.
 * This preserves deterministic behavior for mutating filesystem tools.
 */
export function shouldExecuteTaskCallsInParallel(toolCalls: ToolCallContent[]): boolean {
	return toolCalls.length > 1 && toolCalls.every((toolCall) => toolCall.name === "task");
}

function createAgentStream(): EventStream<any, any> {
	return new EventStream(
		(event) => event.type === "agent_end",
		(event) => (event.type === "agent_end" ? event.messages : []),
	);
}

function toToolResultError(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, never>;
} {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: {},
	};
}

const STEERING_SKIP_TEXT = "Skipped due to queued user message.";
const STEERING_POLL_INTERVAL_MS = 40;

function createSteeringSkipResult(): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, never>;
} {
	return {
		content: [{ type: "text", text: STEERING_SKIP_TEXT }],
		details: {},
	};
}

function createLinkedAbortController(
	primary: AbortSignal,
	secondary: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const cleanup = () => {
		primary.removeEventListener("abort", onAbort);
		secondary.removeEventListener("abort", onAbort);
	};
	const onAbort = () => {
		cleanup();
		controller.abort();
	};
	if (primary.aborted || secondary.aborted) {
		controller.abort();
		return { signal: controller.signal, cleanup };
	}
	primary.addEventListener("abort", onAbort, { once: true });
	secondary.addEventListener("abort", onAbort, { once: true });
	return { signal: controller.signal, cleanup };
}

function waitForSteeringPoll(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, STEERING_POLL_INTERVAL_MS);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.toLowerCase().includes("aborted");
}

function skipToolCall(toolCall: ToolCallContent, stream: EventStream<any, any>): ToolResultMessageLike {
	const result = createSteeringSkipResult();
	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});
	const toolResultMessage: ToolResultMessageLike = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};
	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}

async function executeToolCallsSequential(
	tools: AgentTool<any>[] | undefined,
	toolCalls: ToolCallContent[],
	signal: AbortSignal,
	stream: EventStream<any, any>,
	getSteeringMessages?: () => Promise<AgentMessage[]>,
): Promise<{ toolResults: ToolResultMessageLike[]; steeringMessages?: AgentMessage[] }> {
	const results: ToolResultMessageLike[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		const tool = tools?.find((item) => item.name === toolCall.name);
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: any;
		let isError = false;
		try {
			if (!tool) {
				throw new Error(`Tool ${toolCall.name} not found`);
			}
			const validatedArgs = validateToolArguments(tool, toolCall as any);
			result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					partialResult,
				});
			});
		} catch (error) {
			result = toToolResultError(error);
			isError = true;
		}

		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});
		const toolResultMessage: ToolResultMessageLike = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};
		results.push(toolResultMessage);
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });

		if (getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages };
}

async function executeToolCallsParallelTasksOnly(
	tools: AgentTool<any>[] | undefined,
	toolCalls: ToolCallContent[],
	signal: AbortSignal,
	stream: EventStream<any, any>,
	getSteeringMessages?: () => Promise<AgentMessage[]>,
): Promise<{ toolResults: ToolResultMessageLike[]; steeringMessages?: AgentMessage[] }> {
	const steeringAbortController = new AbortController();
	const linkedAbort = createLinkedAbortController(signal, steeringAbortController.signal);
	const executionSignal = linkedAbort.signal;
	let completedCount = 0;
	let steeringMessages: AgentMessage[] | undefined;

	const steeringWatcher = getSteeringMessages
		? (async () => {
				while (completedCount < toolCalls.length && !executionSignal.aborted) {
					const steering = await getSteeringMessages();
					if (steering.length > 0) {
						steeringMessages = steering;
						if (!signal.aborted && !steeringAbortController.signal.aborted) {
							steeringAbortController.abort();
						}
						return;
					}
					if (completedCount >= toolCalls.length || executionSignal.aborted) {
						return;
					}
					await waitForSteeringPoll(executionSignal);
				}
			})()
		: undefined;

	const executions = toolCalls.map(async (toolCall, index) => {
		const tool = tools?.find((item) => item.name === toolCall.name);
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: any;
		let isError = false;
		try {
			if (!tool) {
				throw new Error(`Tool ${toolCall.name} not found`);
			}
			const validatedArgs = validateToolArguments(tool, toolCall as any);
			result = await tool.execute(toolCall.id, validatedArgs, executionSignal, (partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					partialResult,
				});
			});
		} catch (error) {
			const interruptedBySteering = steeringAbortController.signal.aborted && !signal.aborted;
			result = interruptedBySteering && isAbortError(error) ? createSteeringSkipResult() : toToolResultError(error);
			isError = true;
		} finally {
			completedCount += 1;
		}

		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessageLike = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
		return { index, toolResultMessage };
	});

	try {
		const completed = await Promise.all(executions);
		if (steeringWatcher) {
			await steeringWatcher;
		}
		const orderedResults = completed
			.slice()
			.sort((left, right) => left.index - right.index)
			.map((item) => item.toolResultMessage);

		if (!steeringMessages && getSteeringMessages) {
			const trailingSteering = await getSteeringMessages();
			if (trailingSteering.length > 0) {
				steeringMessages = trailingSteering;
			}
		}
		return {
			toolResults: orderedResults,
			steeringMessages: steeringMessages && steeringMessages.length > 0 ? steeringMessages : undefined,
		};
	} finally {
		linkedAbort.cleanup();
	}
}

async function executeToolCallsWithPolicy(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: any,
	signal: AbortSignal,
	stream: EventStream<any, any>,
	getSteeringMessages?: () => Promise<AgentMessage[]>,
): Promise<{ toolResults: ToolResultMessageLike[]; steeringMessages?: AgentMessage[] }> {
	const toolCalls = assistantMessage.content.filter((content: any) => content.type === "toolCall") as ToolCallContent[];
	if (shouldExecuteTaskCallsInParallel(toolCalls)) {
		return executeToolCallsParallelTasksOnly(tools, toolCalls, signal, stream, getSteeringMessages);
	}
	return executeToolCallsSequential(tools, toolCalls, signal, stream, getSteeringMessages);
}

export const __parallelTaskAgentTestUtils = {
	executeToolCallsWithPolicy,
};

async function streamAssistantResponse(
	context: any,
	config: any,
	signal: AbortSignal,
	stream: EventStream<any, any>,
	streamFn: (...args: any[]) => any,
): Promise<any> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}
	const llmMessages = await config.convertToLlm(messages);
	const llmContext = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
	const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const response = await streamFn(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage = null;
	let addedPartial = false;
	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;
			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}
	return await response.result();
}

async function runLoopWithPolicy(
	currentContext: any,
	newMessages: AgentMessage[],
	config: any,
	signal: AbortSignal,
	stream: EventStream<any, any>,
	streamFn: (...args: any[]) => any,
): Promise<void> {
	let firstTurn = true;
	let pendingMessages = (await config.getSteeringMessages?.()) || [];

	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "turn_end", message, toolResults: [] });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			const toolCalls = message.content.filter((content: any) => content.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;
			const toolResults: ToolResultMessageLike[] = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCallsWithPolicy(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;
				for (const result of toolResults) {
					currentContext.messages.push(result as any);
					newMessages.push(result as any);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}
		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

function agentLoopWithPolicy(
	prompts: AgentMessage[],
	context: any,
	config: any,
	signal: AbortSignal,
	streamFn: (...args: any[]) => any,
): EventStream<any, any> {
	const stream = createAgentStream();
	void (async () => {
		const newMessages = [...prompts];
		const currentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};
		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}
		await runLoopWithPolicy(currentContext, newMessages, config, signal, stream, streamFn);
	})();
	return stream;
}

function agentLoopContinueWithPolicy(
	context: any,
	config: any,
	signal: AbortSignal,
	streamFn: (...args: any[]) => any,
): EventStream<any, any> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
	const stream = createAgentStream();
	void (async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext = { ...context };
		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		await runLoopWithPolicy(currentContext, newMessages, config, signal, stream, streamFn);
	})();
	return stream;
}

/**
 * Patch a pi-agent-core Agent instance so multiple `task` tool calls in one assistant turn
 * execute concurrently.
 */
export function patchAgentForParallelTaskExecution(agent: Agent): void {
	const runtime: any = agent;
	if (runtime.__iosmParallelTaskPatched) {
		return;
	}
	runtime.__iosmParallelTaskPatched = true;

	runtime._runLoop = async function patchedRunLoop(
		messages?: AgentMessage[],
		options?: { skipInitialSteeringPoll?: boolean },
	) {
		const self: any = this;
		const model = self._state.model;
		if (!model) throw new Error("No model configured");

		self.runningPrompt = new Promise<void>((resolve) => {
			self.resolveRunningPrompt = resolve;
		});
		self.abortController = new AbortController();
		self._state.isStreaming = true;
		self._state.streamMessage = null;
		self._state.error = undefined;

		const reasoning = self._state.thinkingLevel === "off" ? undefined : self._state.thinkingLevel;
		const context = {
			systemPrompt: self._state.systemPrompt,
			messages: self._state.messages.slice(),
			tools: self._state.tools,
		};

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;
		const config = {
			model,
			reasoning,
			sessionId: self._sessionId,
			transport: self._transport,
			thinkingBudgets: self._thinkingBudgets,
			maxRetryDelayMs: self._maxRetryDelayMs,
			convertToLlm: self.convertToLlm,
			transformContext: self.transformContext,
			getApiKey: self.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return self.dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => self.dequeueFollowUpMessages(),
		};

		let partial: AgentMessage | null = null;
		try {
			const stream = messages
				? agentLoopWithPolicy(messages, context, config, self.abortController.signal, self.streamFn)
				: agentLoopContinueWithPolicy(context, config, self.abortController.signal, self.streamFn);

			for await (const event of stream) {
				switch (event.type) {
					case "message_start":
						partial = event.message;
						self._state.streamMessage = event.message;
						break;
					case "message_update":
						partial = event.message;
						self._state.streamMessage = event.message;
						break;
					case "message_end":
						partial = null;
						self._state.streamMessage = null;
						self.appendMessage(event.message);
						break;
					case "tool_execution_start": {
						const pending = new Set(self._state.pendingToolCalls);
						pending.add(event.toolCallId);
						self._state.pendingToolCalls = pending;
						break;
					}
					case "tool_execution_end": {
						const pending = new Set(self._state.pendingToolCalls);
						pending.delete(event.toolCallId);
						self._state.pendingToolCalls = pending;
						break;
					}
					case "turn_end":
						if (event.message.role === "assistant" && event.message.errorMessage) {
							self._state.error = event.message.errorMessage;
						}
						break;
					case "agent_end":
						self._state.isStreaming = false;
						self._state.streamMessage = null;
						break;
				}
				self.emit(event);
			}

			if (partial && partial.role === "assistant" && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					(content: any) =>
						(content.type === "thinking" && content.thinking.trim().length > 0) ||
						(content.type === "text" && content.text.trim().length > 0) ||
						(content.type === "toolCall" && content.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					self.appendMessage(partial);
				} else if (self.abortController?.signal.aborted) {
					throw new Error("Request was aborted");
				}
			}
		} catch (error: any) {
			const errorMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: self.abortController?.signal.aborted ? "aborted" : "error",
				errorMessage: error?.message || String(error),
				timestamp: Date.now(),
			};
			self.appendMessage(errorMessage as any);
			self._state.error = error?.message || String(error);
			self.emit({ type: "agent_end", messages: [errorMessage] });
		} finally {
			self._state.isStreaming = false;
			self._state.streamMessage = null;
			self._state.pendingToolCalls = new Set();
			self.abortController = undefined;
			self.resolveRunningPrompt?.();
			self.runningPrompt = undefined;
			self.resolveRunningPrompt = undefined;
		}
	};
}
