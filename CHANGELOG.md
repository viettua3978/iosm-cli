# Changelog

All notable changes to `iosm-cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

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
