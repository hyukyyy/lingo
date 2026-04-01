# Lingo MCP Server — Client Setup Guides

Configure your AI development tool to connect to the Lingo MCP server.

## Quick Start

### Claude Code (CLI)

```bash
# Automatic setup (recommended)
claude mcp add lingo -- npx @hyukyyy/lingo-mcp-server

# With custom glossary path
claude mcp add lingo -e LINGO_GLOSSARY_PATH=.lingo/glossary.json -e LINGO_ORG=my-org -- npx @hyukyyy/lingo-mcp-server

# Verify it's registered
claude mcp list
```

### Claude Code (Manual)

Create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "lingo": {
      "command": "npx",
      "args": ["@hyukyyy/lingo-mcp-server"],
      "env": {
        "LINGO_GLOSSARY_PATH": ".lingo/glossary.json",
        "LINGO_ORG": "my-org"
      }
    }
  }
}
```

Or add globally in `~/.claude/mcp.json` to have Lingo available across all projects.

### Cursor

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "lingo": {
      "command": "npx",
      "args": ["@hyukyyy/lingo-mcp-server"],
      "env": {
        "LINGO_GLOSSARY_PATH": ".lingo/glossary.json",
        "LINGO_ORG": "my-org"
      }
    }
  }
}
```

Or use **Cursor Settings > MCP Servers > Add Server** and enter:
- **Name:** `lingo`
- **Command:** `npx`
- **Args:** `@hyukyyy/lingo-mcp-server`

### Claude Desktop

Add to your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lingo": {
      "command": "npx",
      "args": ["@hyukyyy/lingo-mcp-server"],
      "env": {
        "LINGO_GLOSSARY_PATH": ".lingo/glossary.json",
        "LINGO_ORG": "my-org"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LINGO_GLOSSARY_PATH` | `.lingo/glossary.json` | Path to the glossary JSON file (relative or absolute) |
| `LINGO_ORG` | `default` | Organization name for new glossary stores |
| `LINGO_LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |

## Configuration Files

| File | Use Case |
|------|----------|
| [`claude-code.json`](./claude-code.json) | Claude Code project or global config |
| [`cursor.json`](./cursor.json) | Cursor project config |
| [`claude-desktop.json`](./claude-desktop.json) | Claude Desktop app config |
| [`local-dev.json`](./local-dev.json) | Development with tsx hot-reload |
| [`node-direct.json`](./node-direct.json) | Direct Node.js invocation (no npx) |

## Connection Methods

### Via npx (recommended for end users)

```json
{ "command": "npx", "args": ["@hyukyyy/lingo-mcp-server"] }
```

Best for: Published package usage. npx resolves the latest installed version.

### Via tsx (development)

```json
{ "command": "npx", "args": ["tsx", "src/server.ts"] }
```

Best for: Developing on the lingo server itself. Runs TypeScript directly.

### Via node (built output)

```json
{ "command": "node", "args": ["dist/server.js"] }
```

Best for: Running the compiled JavaScript directly without npx overhead.

### Via global install

```bash
npm install -g @hyukyyy/lingo-mcp-server
```

```json
{ "command": "lingo" }
```

Best for: System-wide availability without per-project installation.

## Verifying the Connection

Once configured, verify the server is reachable:

1. **Claude Code:** Run `claude mcp list` — lingo should appear with status "connected"
2. **Cursor:** Check MCP Servers in Settings — lingo should show a green status
3. **Claude Desktop:** Restart the app — lingo tools should appear in the tool list

Then test with a simple query:
- Ask your AI tool: *"Use the lingo bootstrap tool to discover terms in this codebase"*
- Or: *"Use lingo to list all glossary terms"*

## Troubleshooting

**Server not starting?**
- Ensure Node.js >= 18 is installed: `node --version`
- Ensure the package is available: `npx @hyukyyy/lingo-mcp-server --help`
- Check stderr logs: `LINGO_LOG_LEVEL=debug npx @hyukyyy/lingo-mcp-server`

**No tools showing up?**
- Verify the server name is `lingo` in your config (case-sensitive)
- Restart your AI tool after config changes
- Check that `mcp.json` / `.mcp.json` is valid JSON (no trailing commas)

**Glossary file not found?**
- The server creates `.lingo/glossary.json` automatically on first write
- Ensure the `LINGO_GLOSSARY_PATH` is relative to where the AI tool opens the project
