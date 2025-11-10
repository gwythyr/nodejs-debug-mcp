# mcp-debug-unit

MCP server that gives coding agents the ability to debug Node.js **and** Python scripts without modifying source code.

Published on npm as `mcp-debug-unit` (formerly `nodejs-debug-mcp`). The legacy CLI alias remains available for backwards compatibility.

## Why install this

Your coding agent (Claude, Cursor, etc.) can inspect runtime values without modifying your code. Instead of asking the agent to add `console.log` statements, it can call `debug-script` to see what's happening at any line during execution.

Particularly useful for debugging unit tests and helping agents write tests by understanding what values are actually present at runtime.

## How it works

The agent specifies:
- A Node.js command to run
- A breakpoint location (file and line)
- An expression to evaluate

The tool runs the script, pauses at that line each time it executes, evaluates the expression, and returns all values when the script finishes.

## Parameters

- **command:** Debuggable command to run. For Node.js pass `--inspect-brk`, for Python run under `debugpy` with `--listen` + `--wait-for-client`.
- **breakpoint:** `{ file: string, line: number }`
- **expression:** Expression to evaluate when the breakpoint is hit. Works for both runtimes.
- **timeout:** Maximum execution time in milliseconds
- **includeStack:** (optional) Include call stack frames in the result
- **runtime:** (optional) `'node'` (default) or `'python'`

## Setup

### Claude Code

```bash
claude mcp add --scope user --transport stdio mcp-debug-unit -- npx -y mcp-debug-unit
```

### Codex CLI

```bash
codex mcp add mcp-debug-unit -- npx -y mcp-debug-unit
```

### Cursor

Add to your MCP settings config file:
```json
{
  "mcpServers": {
    "mcp-debug-unit": {
      "command": "npx",
      "args": ["-y", "mcp-debug-unit"]
    }
  }
}
```

## Development

```bash
npx tsc                        # Build
node --test test/e2e.test.js  # Test
```

### Python runtime requirements

- Install `debugpy` (e.g. `python3 -m pip install debugpy`)
- The MCP server bootstraps `debugpy` automatically into your user cache (e.g. `~/.cache/mcp-debug-unit/debugpy/<hash>` or `%LOCALAPPDATA%\mcp-debug-unit\cache\debugpy\<hash>`) if the interpreter referenced in your command cannot import it. Override the storage location via `MCP_DEBUG_UNIT_DEBUGPY_DIR` (or the legacy `NODEJS_DEBUG_MCP_DEBUGPY_DIR`).
- Launch your script via `python3 -m debugpy --listen 127.0.0.1:5678 --wait-for-client ./script.py`
- Call `debug-script` with `runtime: "python"` and the same `listen` host:port in the `command`
- Use absolute or relative paths for the `breakpoint.file` (they will be resolved automatically)

See `SPECIFICATION.md` for implementation details.

## Release

To publish a new version to npm:

```bash
# Patch version (0.1.2 → 0.1.3)
npm version patch && git push --follow-tags

# Minor version (0.1.2 → 0.2.0)
npm version minor && git push --follow-tags

# Major version (0.1.2 → 1.0.0)
npm version major && git push --follow-tags
```

This automatically:
- Updates package.json version
- Creates a git commit and tag
- Pushes to GitHub
- Triggers the publish workflow

## License

MIT
