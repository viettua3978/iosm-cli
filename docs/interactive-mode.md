# Interactive Mode

Interactive mode is the default experience when running `iosm` without `-p` or `--mode` flags. It provides a rich multi-turn terminal session with persistent history, model switching, and keyboard-driven controls.

## Starting Interactive Mode

```bash
# Default
iosm

# With specific model
iosm --model sonnet:high

# With profile
iosm --profile plan

# Continue previous session
iosm --continue
```

## Core UX

- Multi-turn conversation with persistent session history
- Keyboard-driven controls for model, profile, and queue management
- Live tool execution rendering with expandable output
- Pending message queue for follow-up prompts
- Task plan visualization and progress tracking
- Streaming responses with interrupt/steer capability

---

## Slash Commands

### Session Lifecycle

| Command | Description | Example |
|---------|-------------|---------|
| `/new` | Start a new session | `/new` |
| `/clear` | Alias for `/new` | `/clear` |
| `/resume` | Open session picker | `/resume` |
| `/fork` | Branch from a previous message | `/fork` |
| `/tree` | Navigate the session tree | `/tree` |
| `/checkpoint` | Save a rollback checkpoint (`/checkpoint list`) | `/checkpoint before-refactor` |
| `/rollback` | Roll back to latest/named/indexed checkpoint | `/rollback 2` |
| `/name` | Set session display name | `/name refactoring-auth` |
| `/session` | Session info | `/session` |
| `/quit` | Exit the application | `/quit` |

### Model & Runtime

| Command | Description | Example |
|---------|-------------|---------|
| `/model` | Open provider-first model selector (`provider -> model`) | `/model` |
| `/scoped-models` | Manage model rotation | `/scoped-models` |
| `/mcp` | Open MCP manager UI and run MCP subcommands | `/mcp` |
| `/memory` | Interactive memory manager (`add/edit/remove/scope/path`) | `/memory` |
| `/settings` | View/modify settings | `/settings` |
| `/hotkeys` | View keyboard shortcuts | `/hotkeys` |
| `/changelog` | View recent changes | `/changelog` |

### IOSM & Planning

| Command | Description | Example |
|---------|-------------|---------|
| `/init` | Bootstrap IOSM workspace | `/init` |
| `/iosm` | Run full IOSM cycle | `/iosm 0.95 --max-iterations 5` |
| `/cycle-plan` | Plan a new cycle | `/cycle-plan reduce latency` |
| `/cycle-status` | Check cycle progress | `/cycle-status` |
| `/cycle-report` | View cycle report | `/cycle-report` |
| `/cycle-list` | List all cycles | `/cycle-list` |

### Orchestration & Agents

| Command | Description | Example |
|---------|-------------|---------|
| `/orchestrate` | Launch subagent orchestration | See below |
| `/agents` | Inspect custom/system agents | `/agents` |
| `/subagent-runs` | List subagent run history | `/subagent-runs` |
| `/subagent-resume` | Resume a subagent run | `/subagent-resume run-123` |
| `/team-runs` | List team orchestration runs | `/team-runs` |
| `/team-status` | Check team run status | `/team-status team-456` |

### System Actions

| Command | Description | Example |
|---------|-------------|---------|
| `/export` | Export session to HTML | `/export` |
| `/share` | Share via GitHub Gist | `/share` |
| `/copy` | Copy last response to clipboard | `/copy` |
| `/doctor` | Run diagnostics for model/auth/MCP/hooks/resources | `/doctor` |
| `/compact` | Compact conversation context | `/compact` |
| `/reload` | Reload extensions and resources | `/reload` |
| `/permissions` | View/set tool permissions | `/permissions` |
| `/yolo` | Toggle auto-approve mode | `/yolo on` |
| `/login` | Authenticate with provider (OAuth incl. Qwen + OpenRouter API key) | `/login` |
| `/auth` | Alias for `/login` | `/auth` |
| `/logout` | Clear saved provider credentials | `/logout` |

`/mcp add` without flags starts a guided wizard in the terminal UI.
`/memory` opens an interactive manager. `/memory <text>` saves a note to `memory.md` and reloads session context. Use `/memory edit <index> <text>` for direct updates.

---

## Keyboard Shortcuts

### Application Controls

| Key | Action |
|-----|--------|
| `Esc` | Interrupt current agent run |
| `Ctrl+C` | Clear input or app-level clear |
| `Ctrl+D` | Exit the application |
| `Ctrl+Z` | Suspend process |

### Model & Profile

| Key | Action |
|-----|--------|
| `Shift+Tab` | Cycle profile (full → plan → iosm) |
| `Shift+Ctrl+T` | Cycle thinking level |
| `Ctrl+P` | Next model in rotation |
| `Shift+Ctrl+P` | Previous model in rotation |
| `Ctrl+L` | Open model selector |

### UI Controls

| Key | Action |
|-----|--------|
| `Ctrl+O` | Expand/collapse tool output details |
| `Ctrl+T` | Toggle thinking panel |
| `Ctrl+G` | Open external editor for input |

### Input & Queue

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Steer while streaming (macOS: `Ctrl+\\`) |
| `Alt+Enter` | Queue follow-up message |
| `Alt+Up` | Dequeue/edit queued draft |
| `Ctrl+V` | Paste image (Windows: `Alt+V`) |

### Customization

Override keybindings by creating `~/.iosm/agent/keybindings.json`:

```json
{
  "Ctrl+P": "nextModel",
  "Ctrl+Shift+P": "previousModel",
  "Ctrl+L": "openModelSelector"
}
```

---

## Profiles

Profiles change the agent's behavior, available tools, and system prompt:

### Main Profiles (switchable via `Shift+Tab`)

| Profile | Tools | Use Case |
|---------|-------|----------|
| `full` | All built-ins (read, bash, edit, write, grep, find, ls, rg, fd, ast_grep, comby, jq, yq, semgrep, sed) | Default development work |
| `plan` | Read-only (read, grep, find, ls) | Architecture planning, code review |
| `iosm` | All + IOSM context | IOSM cycle execution with artifact sync |

### Advanced Profiles (via `--profile` or orchestration)

| Profile | Use Case |
|---------|----------|
| `explore` | Exploratory codebase analysis |
| `iosm_analyst` | Deep metric analysis and reporting |
| `iosm_verifier` | Verify cycle results and quality gates |
| `cycle_planner` | Plan and structure IOSM cycles |

### Example: Planning Workflow

```bash
# Start in plan mode for analysis
iosm --profile plan

# In the session:
# "Analyze the authentication module and propose a migration plan to OAuth 2.0"

# Switch to full mode for implementation (Shift+Tab)
# "Implement phase 1 of the OAuth migration"
```

---

## Streaming Input Modes

While a response is streaming, you can interact with it:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Steer** | `Ctrl+Enter` | Interrupt and redirect immediately |
| **Follow-up** | `Alt+Enter` | Queue message for after completion |
| **Meta** | Adaptive | Soft update at boundary checkpoints |

### Example: Steering

```
Agent: [streaming a long analysis of the codebase...]

You: (Ctrl+Enter) Focus specifically on the database layer
# Agent immediately redirects to database analysis
```

### Example: Follow-up Queue

```
Agent: [streaming response...]

You: (Alt+Enter) Also check for N+1 query issues
You: (Alt+Enter) And suggest indexing improvements
# Both messages will be processed after the current response
```

---

## Workflow Examples

### Code Review Session

```bash
iosm --profile plan --tools read,grep,find,ls

# "Review src/core/ for code quality issues, focusing on error handling"
# "Check for any security vulnerabilities in the auth module"
# "Generate a summary of findings sorted by severity"
```

### Debugging Session

```bash
iosm --model sonnet:high

# "The checkout API returns 500 errors intermittently. Help me debug."
# Agent will use bash, read, grep to investigate
# "Run the failing test with verbose output"
# "Apply the fix and verify all tests pass"
```

### IOSM Improvement Cycle

```bash
iosm --profile iosm

# "/init" (first time)
# "/cycle-plan reduce API response time"
# "Analyze the current baseline and create hypothesis cards"
# "Execute the Improve phase focusing on query optimization"
# "/cycle-status"
```

### Multi-Agent Orchestration

```bash
iosm

# "Launch 3 parallel agents to:
#  1. Audit auth module security
#  2. Review database query performance  
#  3. Check API contract compliance"

# Or via slash command:
/orchestrate --parallel --agents 3 \
  --profiles explore,explore,iosm_verifier \
  Audit security, performance, and contracts
```
