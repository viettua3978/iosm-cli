# Orchestration & Subagents

`iosm-cli` supports delegated execution through subagents — specialized AI agents that handle task delegation, parallel execution, and multi-agent workflows.

## Overview

Subagents allow you to:
- **Delegate tasks** to specialized agents with isolated context windows
- **Run agents in parallel** for independent analyses or implementations
- **Orchestrate teams** with dependency ordering and lock-based coordination
- **Track runs** with full transcripts and result aggregation

---

## User-Level Entry Points

### 1. Natural Language Delegation

Simply describe what you want delegated, and the agent handles orchestration:

```
You: Launch 3 agents to analyze security, performance, and code quality separately

Agent: I'll create 3 parallel subagents for each analysis area...
```

### 2. Slash Command Orchestration

Use `/orchestrate` for explicit control:

```bash
/orchestrate --parallel --agents 3 \
  --profiles explore,full,iosm_verifier \
  --cwd .,src,.iosm \
  Analyze security, optimize performance, verify IOSM compliance
```

### 3. Agent Mention

Reference a specific agent by name:

```
@security-auditor Review the authentication module for vulnerabilities
```

---

## `/orchestrate` Command

### Syntax

```bash
/orchestrate [flags] <task description>
```

### Execution Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--parallel` | Run agents concurrently | `--parallel` |
| `--sequential` | Run agents one after another | `--sequential` |
| `--agents <N>` | Number of agents to spawn | `--agents 3` |
| `--max-parallel <N>` | Concurrency limit for parallel runs | `--max-parallel 2` |

### Profile & Context Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--profile <name>` | Single profile for all agents | `--profile explore` |
| `--profiles p1,p2,...` | Per-agent profile assignment | `--profiles explore,full,iosm_verifier` |
| `--cwd path1,path2,...` | Per-agent working directories | `--cwd .,src,test` |

### Coordination Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--locks lock1,lock2,...` | Write serialization domains | `--locks db,config` |
| `--depends 2>1,3>2` | Dependency ordering | `--depends 2>1` (agent 2 waits for 1) |
| `--worktree` | Git worktree isolation | `--worktree` |

---

## Usage Examples

### Parallel Independent Analysis

Three agents analyze different aspects simultaneously:

```bash
/orchestrate --parallel --agents 3 \
  --profiles explore,explore,explore \
  --cwd src/auth,src/api,src/data \
  Analyze code quality and suggest improvements
```

### Sequential Pipeline

Agent 2 depends on Agent 1's output:

```bash
/orchestrate --sequential --agents 2 \
  --depends 2>1 \
  First: analyze the codebase architecture. \
  Second: propose a refactoring plan based on the analysis.
```

### Parallel with Write Isolation

For concurrent changes that might conflict:

```bash
/orchestrate --parallel --worktree --agents 2 \
  Agent 1: refactor auth module \
  Agent 2: refactor payment module
```

### Locked Write Coordination

Serialize writes to shared resources:

```bash
/orchestrate --parallel --agents 3 \
  --locks database-schema \
  All agents: optimize your assigned module's database queries
```

### Full Team Orchestration

```bash
/orchestrate --parallel --agents 4 \
  --profiles iosm_analyst,explore,iosm_verifier,full \
  --max-parallel 2 \
  1: Collect baseline metrics \
  2: Identify optimization opportunities \
  3: Verify current quality gate compliance \
  4: Implement the top-priority fix
```

---

## Visibility & Tracking

### View Subagent Runs

```bash
/subagent-runs
```

Lists all subagent runs with:
- Run ID, status (running/complete/failed)
- Agent profile and task description
- Timestamps and duration

### Resume a Subagent Run

```bash
/subagent-resume <run-id> [extra instructions]
```

Continue or refine a previous subagent's work:

```bash
/subagent-resume run-abc123 "Focus more on error handling"
```

### Team Run Status

```bash
/team-runs                     # List team orchestration runs
/team-status <team-run-id>     # Detailed status of a specific team run
```

### Artifacts

Subagent transcripts and team records are stored in:

```
.iosm/subagents/
├── runs/     # Individual subagent transcripts
└── teams/    # Team orchestration records
```

---

## Custom Agents

### Defining Custom Agents

Create markdown files in `.iosm/agents/`:

```markdown
---
name: security-auditor
description: Specialized security vulnerability analysis
---

You are a security auditor specializing in web application security.

Your responsibilities:
1. Review code for OWASP Top 10 vulnerabilities
2. Check authentication and authorization flows
3. Identify secrets exposure risks
4. Validate input sanitization
5. Check for SQL injection, XSS, CSRF vectors

Always provide:
- Severity rating (Critical/High/Medium/Low)
- Specific file and line references
- Recommended fixes with code examples
```

### Using Custom Agents

```bash
# Reference by name in chat
@security-auditor Review the login flow

# View all available agents
/agents

# Use in orchestration
/orchestrate --agents 1 --profile security-auditor \
  Audit the authentication module
```

### System Agents

Built-in system agents available by default include auditor, verifier, and executor roles. View them with `/agents`.

---

## Parallel Safety Model

### When to Use Locks

Use `lock_key` domains when multiple agents might write to the same files:

```bash
/orchestrate --parallel --agents 2 \
  --locks "config-files" \
  Both modify shared configuration
```

### When to Use Worktrees

Use `--worktree` for large-scale concurrent edits:

```bash
/orchestrate --parallel --worktree --agents 3 \
  Each refactor a major module independently
```

### When No Coordination Is Needed

Keep independent analyses lock-free:

```bash
/orchestrate --parallel --agents 3 \
  --profiles explore,explore,explore \
  Each analyze a different module (read-only)
```

---

## Best Practices

1. **Keep tasks independent** — Each agent works best with a well-defined, independent scope
2. **Narrow responsibilities** — One agent, one clear task
3. **Use appropriate profiles** — Read-only tasks don't need `full` profile
4. **Aggregate results** — The orchestrating agent synthesizes all subagent outputs
5. **Clarify constraints** — Specify boundaries and expected output format
6. **Monitor progress** — Use `/subagent-runs` and `/team-status` to track execution
7. **Start small** — Begin with 2-3 agents and scale up as needed
