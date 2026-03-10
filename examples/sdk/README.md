# SDK Examples

Programmatic usage of `iosm-cli` via `createAgentSession()`. These 12 progressive examples show how to customize every aspect of the agent.

## Running Examples

```bash
npx tsx examples/sdk/01-minimal.ts
```

> **Prerequisite**: Set at least one provider API key (e.g., `ANTHROPIC_API_KEY`).

---

## Examples Overview

### [01-minimal.ts](01-minimal.ts) — Minimal Usage

The simplest possible SDK usage. Auto-discovers skills, extensions, tools, context files from `cwd` and `~/.iosm/agent`. Model chosen from settings or first available.

```typescript
import { createAgentSession } from "iosm-cli";

const { session } = await createAgentSession();

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

---

### [02-custom-model.ts](02-custom-model.ts) — Custom Model Selection

Select a specific model and thinking level. Shows three ways to find models: by provider/id, via registry, or from available models.

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, createAgentSession, ModelRegistry } from "iosm-cli";

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

// Find a specific model
const model = getModel("anthropic", "claude-sonnet-4-20250514");

// Pick from available models (ones with valid API keys)
const available = await modelRegistry.getAvailable();

const { session } = await createAgentSession({
  model: available[0],
  thinkingLevel: "medium",  // off | low | medium | high
  authStorage,
  modelRegistry,
});
```

---

### [03-custom-prompt.ts](03-custom-prompt.ts) — Custom System Prompt

Replace or modify the default system prompt.

**Replace entirely:**
```typescript
const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a pirate assistant. Always say Arrr!",
  appendSystemPromptOverride: () => [],
});
```

**Append to existing:**
```typescript
const loader = new DefaultResourceLoader({
  appendSystemPromptOverride: (base) => [
    ...base,
    "## Rules\n- Always be concise\n- Use bullet points",
  ],
});
```

---

### [04-skills.ts](04-skills.ts) — Skills Configuration

Discover, filter, merge, or replace skills loaded into the system prompt.

```typescript
const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [
      ...current.skills.filter(s => s.name.includes("browser")),
      customSkill,
    ],
    diagnostics: current.diagnostics,
  }),
});
```

---

### [05-tools.ts](05-tools.ts) — Tools Configuration

Control which built-in tools are available.

```typescript
// Read-only mode
await createAgentSession({ tools: readOnlyTools });

// Custom tool selection
await createAgentSession({ tools: [readTool, bashTool, grepTool] });

// With custom cwd — MUST use factory functions!
const cwd = "/path/to/project";
await createAgentSession({
  cwd,
  tools: createCodingTools(cwd),
});
```

> **Important**: When using a custom `cwd`, use factory functions (`createCodingTools`, `createReadTool`, etc.) so tools resolve paths relative to your cwd, not `process.cwd()`.

---

### [06-extensions.ts](06-extensions.ts) — Extensions Configuration

Load file-based extensions and define inline extension factories.

```typescript
const resourceLoader = new DefaultResourceLoader({
  additionalExtensionPaths: ["./my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => console.log("Agent starting"));
    },
  ],
});
```

---

### [07-context-files.ts](07-context-files.ts) — Context Files (AGENTS.md)

Project-specific instructions loaded from `AGENTS.md` files.

```typescript
const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      {
        path: "/virtual/AGENTS.md",
        content: "# Rules\n- Use TypeScript strict mode\n- No any types",
      },
    ],
  }),
});
```

---

### [08-prompt-templates.ts](08-prompt-templates.ts) — Prompt Templates

Define reusable prompt templates invokable as `/templatename` commands.

```typescript
const deployTemplate: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "path",
  filePath: "/virtual/prompts/deploy.md",
  content: "# Deploy\n1. Build\n2. Test\n3. Deploy",
};
```

---

### [09-api-keys-and-oauth.ts](09-api-keys-and-oauth.ts) — API Keys & OAuth

Configure authentication and model registry.

```typescript
// Default auth
const authStorage = AuthStorage.create();

// Custom location
const customAuth = AuthStorage.create("/my/app/auth.json");

// Runtime override (not persisted)
authStorage.setRuntimeApiKey("anthropic", "sk-temp-key");

// Custom model registry
const modelRegistry = new ModelRegistry(authStorage, "/path/to/models.json");
```

---

### [10-settings.ts](10-settings.ts) — Settings Configuration

Override runtime settings for compaction, retry, terminal behavior.

```typescript
// Override specific settings
const settings = SettingsManager.create();
settings.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

// In-memory (for testing)
const inMemory = SettingsManager.inMemory({
  compaction: { enabled: false },
});
```

---

### [11-sessions.ts](11-sessions.ts) — Session Management

Control session persistence: in-memory, new file, continue, list, open.

```typescript
// In-memory (no persistence)
SessionManager.inMemory();

// New persistent session
SessionManager.create(process.cwd());

// Continue most recent
SessionManager.continueRecent(process.cwd());

// List all sessions
const sessions = await SessionManager.list(process.cwd());

// Open specific session
SessionManager.open(sessions[0].path);
```

---

### [12-full-control.ts](12-full-control.ts) — Full Control

Zero auto-discovery — explicit configuration for everything.

```typescript
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a minimal assistant.",
  getAppendSystemPrompt: () => [],
  getPathMetadata: () => new Map(),
  extendResources: () => {},
  reload: async () => {},
};

const { session } = await createAgentSession({
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  resourceLoader,
  tools: [createReadTool(cwd), createBashTool(cwd)],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
  authStorage,
  modelRegistry,
});
```

---

## Quick Reference

### `createAgentSession` Options

| Option | Default | Description |
|--------|---------|-------------|
| `authStorage` | `AuthStorage.create()` | Credential storage |
| `modelRegistry` | `new ModelRegistry(authStorage)` | Model registry with built-in + custom models |
| `cwd` | `process.cwd()` | Working directory for tool resolution |
| `agentDir` | `~/.iosm/agent` | User agent configuration directory |
| `model` | From settings / first available | Model to use |
| `thinkingLevel` | From settings / `"off"` | `off` · `low` · `medium` · `high` |
| `tools` | `codingTools` (all 7) | Built-in tool set (`readOnlyTools`, custom array) |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | `DefaultResourceLoader` | Loader for extensions, skills, prompts, themes |
| `sessionManager` | `SessionManager.create(cwd)` | Session persistence strategy |
| `settingsManager` | `SettingsManager.create(...)` | Runtime settings overrides |

### Event Types

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      // event.assistantMessageEvent.type: "text_delta" | "thinking_delta" | ...
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Done");
      break;
  }
});
```

### Built-in Tool Sets

| Constant | Tools Included |
|----------|---------------|
| `codingTools` | read, bash, edit, write, grep, find, ls |
| `readOnlyTools` | read, grep, find, ls |

### Factory Functions (for custom cwd)

| Function | Purpose |
|----------|---------|
| `createCodingTools(cwd)` | All 7 tools with custom cwd |
| `createReadOnlyTools(cwd)` | Read-only tools with custom cwd |
| `createReadTool(cwd)` | Individual tool with custom cwd |
| `createBashTool(cwd)` | Individual tool with custom cwd |
| `createEditTool(cwd)` | Individual tool with custom cwd |
| `createWriteTool(cwd)` | Individual tool with custom cwd |
| `createGrepTool(cwd)` | Individual tool with custom cwd |
| `createFindTool(cwd)` | Individual tool with custom cwd |
| `createLsTool(cwd)` | Individual tool with custom cwd |
