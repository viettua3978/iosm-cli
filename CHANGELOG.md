# Changelog

All notable changes to `iosm-cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

## [0.2.4] - 2026-03-12

### Added

- **META profile onboarding UX** — switching to `meta` now shows an explicit runtime hint describing orchestration-first usage and when to switch back to `full`
- **META interruption fallback hint** — when a run ends without any assistant message in `meta`, the UI now emits a recovery warning with concrete prompt guidance
- **Task host-profile runtime getter** — task tool integration now supports dynamic host profile reads (`getHostProfileName`) so orchestration pressure follows live profile changes during a session

### Changed

- **META directive policy (chat-safe classification)** — meta orchestration directive now explicitly classifies non-repository prompts as direct chat responses and limits orchestration rules to actionable repository work
- **META profile system prompt alignment** — profile-level prompt now mirrors the chat-safe classification behavior to avoid conflicting orchestration instructions
- **Internal orchestration metadata aliasing** — hidden orchestration UI metadata now always persists display aliases (including streaming paths) for safer prompt display substitution

### Fixed

- **Profile switch propagation into task orchestration** — runtime profile changes now propagate through session config-change events and task-tool host-profile resolution
- **Invisible assistant responses in meta chat prompts** — assistant prose suppression no longer triggers for `META_ORCHESTRATION_DIRECTIVE` metadata (suppression remains for legacy `ORCHESTRATION_DIRECTIVE` blocks only)
- **Meta interruption messaging consistency** — differentiated interruption guidance now appears for both assistant-level abort/error and run-level early termination scenarios

### Documentation

- Updated README version markers and added a dedicated **Modes At A Glance** block
- Added explicit **META model requirements** guidance (modern models, large context windows, high output limits) in README, CLI reference, interactive mode docs, and configuration docs

## [0.2.3] - 2026-03-11

### Fixed

- **Startup model restore after restart** — `createAgentSession()` now hydrates missing saved provider/model definitions from `models.dev` before resolving default model, so previously selected providers such as coding-plan providers are restored automatically on relaunch
- **Stale startup warning suppression** — interactive startup no longer shows stale `No models available...` warning when model restore succeeds during session initialization
- **Restart UX consistency** — startup header and active session state now align with restored saved `provider/model` selection without requiring manual `/model` re-selection

## [0.2.2] - 2026-03-11

### Added

- **Models.dev provider+model catalog runtime** — added full catalog parsing (providers + models metadata) with timeout/fallback behavior for interactive auth/model flows
- **Automatic provider model hydration after `/login`** — when a provider has credentials but no built-in model definitions, `iosm-cli` now registers models from `models.dev` so `/model` is immediately usable (including coding-plan providers such as `zai-coding-plan`)
- **Startup/on-demand auth model hydration** — `/model` now attempts to hydrate missing models for saved authenticated providers before rendering provider/model choices

### Changed

- **Provider/model visibility in status line** — footer and model-switch status now display `provider/model` to make cross-provider switches explicit even when model IDs are identical
- **Auth UX feedback** — login flow now reports a clear warning when credentials are stored but no models can be loaded yet

### Fixed

- **API-key login crash** — fixed unbound registry method usage that caused `TypeError: Cannot read properties of undefined (reading 'models')` in interactive login flows
- **Empty model selector after provider login** — fixed cases where `/model` stayed empty after successful API-key auth for providers not shipped in the built-in registry

### Documentation

- Updated README and docs (`getting-started`, `interactive-mode`, `configuration`) to reflect full models.dev-backed provider/model availability via `/login` and `/model`

## [0.2.1] - 2026-03-11

### Added

- **Run/task shared memory runtime** — introduced `.iosm/subagents/shared-memory/*.json` state with versioned entries and history for cross-task coordination
- **Shared memory tools** — added `shared_memory_write` and `shared_memory_read` tools for subagent orchestration (`run` and `task` scopes, CAS support, append/set modes)
- **Canonical `/swarm` command surface** — added dedicated runtime commands: `/swarm run`, `/swarm from-singular`, `/swarm watch`, `/swarm retry`, `/swarm resume` (with bounded parallelism and budget controls)
- **Swarm scheduler reliability modules** — added dedicated scheduler/locks/gates/state-store/spawn/retry components for stable multi-task dispatch under contention
- **Swarm lock + gate execution model** — introduced hierarchical touch locks and contract-aware task/run gates for `Scopes -> Touches -> Locks -> Gates -> Done`
- **Swarm runtime artifacts** — added persisted run state in `.iosm/orchestrate/<run-id>/` (`run.json`, `dag.json`, `state.json`, `events.jsonl`, checkpoints, reports)
- **Swarm watch telemetry** — added runtime visibility for ready/running/blocked/done distribution, budget usage, lock snapshot, ETA/throughput, critical path, and theoretical speedup
- **Swarm spawn policy controls** — added high-risk spawn candidate classification with confirmation-gated fan-out behavior
- **Project index subsystem** — introduced repository indexing (`.iosm/project-index/index.json`) for scale-aware planning and targeted file selection
- **Failure retrospective engine** — added failure-cause classification and retry directive generation for smarter follow-up attempts

### Changed

- **Swarm-first orchestration flow** — `/singular` execution handoff now supports `Start with Swarm (Recommended)` and routes selected options to `/swarm from-singular ...`
- **Command separation** — `/orchestrate --swarm` removed; `/swarm` is now the canonical gated runtime while `/orchestrate` remains manual legacy team splitting
- **Task orchestration contract** — `task` tool/runtime now carries richer run/task metadata and improved scheduling context for delegated execution
- **Interactive swarm observability** — expanded interactive mode status/watch output with deeper swarm runtime diagnostics and task progress details

### Fixed

- **Swarm retry stability** — improved retry bucket handling (`permission`, `dependency/import`, `test`, `timeout`, `unknown`) to reduce noisy re-runs
- **Lock/contention handling** — improved execution behavior for conflicting touches and blocked tasks in DAG scheduling scenarios

### Documentation

- Expanded README, CLI reference, interactive mode, and orchestration docs for swarm runtime semantics, shared-memory collaboration, and reliability controls

## [0.2.0] - 2026-03-11

### Added

- **Interactive engineering contract manager (`/contract`)** — field-by-field contract editing with immediate save-on-enter and automatic JSON generation for project scope
- **Layered contract model** — explicit `project`, `session`, and `effective` contract layers with copy/delete flows and merged runtime enforcement
- **Singular feasibility mode (`/singular`)** — command-first feasibility analysis that combines repository baseline scan with a standard agent pass and returns exactly three implementation options
- **Option-driven execution handoff** — `/singular` now produces concrete file targets, step plans, trade-offs, and decision guidance before implementation starts
- **Regression coverage for large paste UX** — multiline unbracketed paste now covered by dedicated tests to ensure one submission flow and compact marker rendering

### Changed

- **Feasibility workflow naming** — `/blast` replaced by `/singular` for feature feasibility decisions
- **Profile cleanup** — `/shadow` workflow removed to avoid duplication with plan-oriented analysis
- **Contract interaction model** — removed extra save step in field editor; entering value immediately persists to selected scope

### Fixed

- **TUI width safety** — startup resources block now truncates long lines to terminal width, preventing render crashes on narrow terminals
- **Paste queue behavior** — large pasted multiline input is treated as a single paste event instead of fragmented queued submissions

### Documentation

- Expanded README with dedicated decision workflow section (`/contract` vs `/singular`), command migration notes, and clearer contract layer distinctions
- Extended interactive mode docs with explicit `effective/session/project` explanations and migration guidance from removed commands
- Updated CLI reference with interactive feasibility/contract command behavior and migration notes

## [0.1.3] - 2026-03-10

### Added

- **Semantic search runtime** — Added built-in `semantic_search` tool (`index`, `query`, `status`, `rebuild`), interactive `/semantic` manager, and top-level `iosm semantic` command
- **Semantic setup UX upgrades** — Added provider model discovery (OpenRouter/Ollama) and setup-flow guidance for optional fields
- **Search/analysis toolchain expansion** — Added separate built-in tools: `rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`
- **Doctor CLI diagnostics for tools** — `/doctor` now reports external CLI toolchain availability (`rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`) in text and JSON output
- **CLI entry point** — Standalone `iosm` binary with full argument parsing
- **Interactive mode** — Multi-turn terminal agent with keyboard-driven controls
- **Print mode** — One-shot `iosm -p` for scripting and CI
- **JSON stream mode** — Machine-readable `--mode json` event output
- **RPC mode** — stdio JSON-RPC server for IDE integrations
- **Built-in tools** — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`
- **Multi-provider support** — Anthropic, OpenAI, Gemini, Groq, Cerebras, xAI, OpenRouter, Mistral, AWS Bedrock, Azure OpenAI, and more
- **Model cycling** — `--models` flag and `Ctrl+P` for model rotation
- **Thinking levels** — `--thinking off|minimal|low|medium|high|xhigh`
- **Agent profiles** — `full`, `plan`, `iosm` + advanced profiles (`explore`, `iosm_analyst`, `iosm_verifier`, `cycle_planner`)
- **IOSM workspace** — `iosm init` bootstraps `iosm.yaml`, `IOSM.md`, `.iosm/` artifacts
- **IOSM cycles** — `iosm cycle plan|report|status|list` for systematic improvement
- **IOSM metrics** — Six canonical metrics (semantic, logic, performance, simplicity, modularity, flow) with IOSM-Index
- **Subagent orchestration** — Parallel/sequential delegation with `/orchestrate`
- **Custom agents** — Markdown agent definitions in `.iosm/agents/`
- **Extension system** — TypeScript extensions with tools, commands, hooks, and UI
- **Skills** — Markdown workflow modules
- **Prompt templates** — Reusable prompt snippets as slash commands
- **Themes** — JSON TUI theme customization
- **Package manager** — `iosm install|remove|update|list` from npm/git/local
- **Session persistence** — Automatic session saving and recovery
- **Session branching** — `/tree`, `/fork` for conversation tree navigation
- **HTML export** — `/export` with themed, self-contained HTML output
- **Session sharing** — `/share` via GitHub Gists
- **Session trace** — `--session-trace` for full JSONL audit logging
- **Context compaction** — Automatic context summarization when approaching limits
- **File attachments** — `@file` syntax for including files in prompts
- **Programmatic SDK** — `createAgentSession()` for embedding in custom apps
- **Keybinding customization** — `~/.iosm/agent/keybindings.json`
- **OAuth support** — `/login` for provider authentication
- **Permission controls** — `/permissions` and `/yolo` for tool approval management

### Changed

- Switched from monorepo `tsgo` scripts to standalone `tsc`-based build system
- Promoted CLI source, docs, examples, and tests to repository root

### Documentation

- Comprehensive README with feature showcase, provider reference, and examples
- 10 detailed documentation files covering all features
- CONTRIBUTING.md with development setup and PR guidelines
- 66 extension examples with categorized README
- 12 SDK examples with quick reference guide
