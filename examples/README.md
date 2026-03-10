# Examples

Complete example library for `iosm-cli` SDK and extension development. These examples demonstrate how to use `iosm-cli` programmatically and extend it with custom functionality.

## Quick Start

```bash
# Run any example with tsx
npx tsx examples/sdk/01-minimal.ts
npx tsx examples/extensions/hello.ts

# Or load an extension directly
iosm -e examples/extensions/permission-gate.ts
```

---

## 📁 Directory Structure

### [sdk/](sdk/)

**12 progressive examples** showing how to use `iosm-cli` as a library via `createAgentSession()`.

| # | Example | What You Learn |
|---|---------|---------------|
| 01 | [Minimal](sdk/01-minimal.ts) | Simplest usage — auto-discovers everything |
| 02 | [Custom Model](sdk/02-custom-model.ts) | Select provider, model, and thinking level |
| 03 | [Custom Prompt](sdk/03-custom-prompt.ts) | Replace or append to the system prompt |
| 04 | [Skills](sdk/04-skills.ts) | Discover, filter, and inject custom skills |
| 05 | [Tools](sdk/05-tools.ts) | Built-in tools, read-only mode, custom cwd |
| 06 | [Extensions](sdk/06-extensions.ts) | Inline extensions, lifecycle hooks, custom tools |
| 07 | [Context Files](sdk/07-context-files.ts) | AGENTS.md project-specific instructions |
| 08 | [Prompt Templates](sdk/08-prompt-templates.ts) | File-based reusable prompts as slash commands |
| 09 | [API Keys & OAuth](sdk/09-api-keys-and-oauth.ts) | Auth storage, model registry, runtime key override |
| 10 | [Settings](sdk/10-settings.ts) | Override compaction, retry, terminal settings |
| 11 | [Sessions](sdk/11-sessions.ts) | In-memory, persistent, continue, list, open sessions |
| 12 | [Full Control](sdk/12-full-control.ts) | Zero discovery — explicit configuration for everything |

→ Full SDK guide at [sdk/README.md](sdk/README.md)

---

### [extensions/](extensions/)

**66 extension examples** organized by category, demonstrating the full extension API.

| Category | Count | Highlights |
|----------|-------|-----------|
| **Safety & Lifecycle** | 5 | Permission gates, protected paths, destructive action confirmation |
| **Custom Tools** | 12 | Todo list, hello world, SSH delegation, image gen, subagents |
| **Commands & UI** | 22 | Presets, overlays, editors, footers, headers, notifications, games |
| **Git Integration** | 2 | Checkpoint stashing, auto-commit on exit |
| **System Prompt** | 4 | Dynamic prompt modification, custom compaction |
| **System Integration** | 1 | macOS theme sync |
| **Custom Providers** | 3 | Anthropic, GitLab Duo, Qwen CLI |
| **Session & Messages** | 4 | Named sessions, bookmarks, event bus, message rendering |
| **Resources** | 1 | Dynamic skill/prompt/theme loading |
| **Dependencies** | 2 | Extension with own package.json, file watcher |

→ Full extension guide at [extensions/README.md](extensions/README.md)

---

### [rpc-extension-ui.ts](rpc-extension-ui.ts)

Standalone RPC client that exercises all extension UI methods over the RPC protocol. Demonstrates how to use `confirm`, `select`, `notify`, and custom UI from an external process.

---

## Key Concepts

### Extension Pattern

```typescript
import type { ExtensionAPI } from "iosm-cli";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, hooks, UI
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

### SDK Pattern

```typescript
import { createAgentSession } from "iosm-cli";

const { session } = await createAgentSession({ /* options */ });
session.subscribe((event) => { /* handle events */ });
await session.prompt("Your message");
```

### State Persistence

Store extension state in tool result `details` for proper session branching:

```typescript
return {
  content: [{ type: "text", text: "Done" }],
  details: { myState: [...data] },  // Persisted with session
};

// Reconstruct on fork/resume
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    // Rebuild state from details
  }
});
```

---

## Documentation

- [SDK Reference](sdk/README.md) — Complete SDK guide with all options
- [Extension Guide](extensions/README.md) — Full extension API documentation
- [Extension API Docs](../docs/extensions-packages-themes.md) — Official extension reference
- [SDK Integration Docs](../docs/rpc-json-sdk.md) — JSON/RPC/SDK integration guide
