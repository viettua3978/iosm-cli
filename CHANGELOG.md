# Changelog

All notable changes to `iosm-cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
