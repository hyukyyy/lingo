# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-04-02

### Added

- External MCP server delegation — skills detect and use already-connected GitHub/Notion MCP servers
  - `learn` skill: GitHub MCP → `prData` 전달 → env var fallback → skip(warning)
  - `bootstrap` skill: GitHub MCP PR 일괄 스캔 + Notion MCP 데이터베이스 연동
  - `setup` skill: 외부 MCP 감지 시 토큰 설정 선택사항으로 변경
- `learn_from_pr` tool: `prData` parameter for pre-fetched PR data (from external MCP)
- Environment variable support: `GITHUB_TOKEN`, `NOTION_API_TOKEN` read at server startup
- Explicit error when adapter requested but token missing (replaces silent fallback)
- `npx @hyukyyy/lingo-mcp-server` execution support (`isDirectExecution` fix)
- `.mcp.dev.json` for local development (`.mcp.json` is now npx-based for distribution)
- `.npmignore` to exclude dev-only files from npm package
- AskUserQuestion enforced in all skills

### Changed

- `.mcp.json`: `node dist/server.js` with hardcoded cwd → `npx @hyukyyy/lingo-mcp-server`
- `bootstrap` tool: glossary written to `<rootDir>/.lingo/glossary.json` when rootDir specified
- `bootstrap` orchestrator: throws error instead of silent fallback when adapter not found
- README: plugin install command corrected to `claude plugin marketplace add` + `claude plugin install`

## [0.1.1] - 2026-04-01

### Added

- Local document scanning (Feature 6.2) — extract domain terms from markdown files
  - `DocsParser` implementing `LanguageParser` for `.md` and `.txt` files
  - New `CodeConceptKind` values: `section`, `term`, `definition`
  - `markdown` added to `SupportedLanguage`
  - Fenced code block stripping to avoid false positives
- SCM adapter registry (Feature 6.4) — pluggable source control adapters
  - `SCMAdapterRegistry` mirroring PM `AdapterRegistry` API
  - GitHub SCM adapter factory registration
  - `learnFromPR` accepts optional `scmAdapter` parameter
- Dynamic setup adapter selection (Feature 6.5)
  - `list_adapters` MCP tool returning unified PM + SCM adapter list
  - Setup skill rewritten for dynamic adapter discovery
- Prompt learning hook (Feature 6.3)
  - `prompt-learning-hook.sh` PostToolUse hook for glossary term detection
  - Stdout advisory pattern for `record_signal` invocation
- npm package prep: LICENSE, CI/CD workflows, typedoc, example configs

### Changed

- `isTermWorthy` handles doc-sourced kinds (`section`, `term`, `definition`)
- `computeStats` includes `markdown` language and doc concept kinds
- `RegisterToolsOptions` accepts `scmAdapterRegistry`
- `server.ts` initializes both PM and SCM adapter registries
- Bootstrap test timeout increased for CI stability

## [0.1.0] - 2025-03-31

### Added

- Initial release of `@hyukyyy/lingo-mcp-server`
- MCP server providing organizational context layer for AI development tools
- Terminology mapping from planning language to code locations
- Support for Model Context Protocol SDK integration
- TypeScript build with type declarations
- CLI binary (`lingo`) for running the MCP server
- Example configurations and skill definitions
- Vitest test suite

[Unreleased]: https://github.com/hyukyyy/lingo/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/hyukyyy/lingo/compare/v0.1.1...v0.1.4
[0.1.1]: https://github.com/hyukyyy/lingo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hyukyyy/lingo/releases/tag/v0.1.0
