# nodejs-debug-mcp

MCP server that gives coding agents the ability to debug Node.js scripts without modifying source code.

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

- **command:** Node.js command with `--inspect-brk` flag (enables debugging and pauses execution at start)
- **breakpoint:** `{ file: string, line: number }`
- **expression:** JavaScript expression to evaluate
- **timeout:** Maximum execution time in milliseconds

## Setup

### Claude Code

```bash
claude mcp add --scope user --transport stdio nodejs-debug-mcp -- npx -y nodejs-debug-mcp
```

### Codex CLI

```bash
codex mcp add npx -- -y nodejs-debug-mcp nodejs-debug-mcp
```

### Cursor

Settings → MCP → Add Command Server:
```bash
npx nodejs-debug-mcp
```

## Development

```bash
npx tsc                        # Build
node --test test/e2e.test.js  # Test
```

See `SPECIFICATION.md` for implementation details.

## License

MIT