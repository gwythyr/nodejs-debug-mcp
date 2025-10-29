# nodejs-debug-mcp

An MCP (Model Context Protocol) server that exposes a single `debug-script` tool. The tool launches a Node.js process in inspector mode, sets a breakpoint, evaluates an expression every time the breakpoint is hit, and streams the typed results back to the client in one request/response round trip.

The primary benefit is not to mimic a human-in-the-loop debugging session, but to let an LLM ingest the entire debug interaction in a single shot. That keeps the model's cognitive load low, minimizes churn on the surrounding context, and helps conserve tokens.

## Benefits

- One-shot ingestion means agents understand the whole debug trace without juggling incremental transcripts, reducing cognitive load and token usage.
- Works against unmodified Node.js source—no need to sprinkle `console.log` statements or remember to remove them later.
- Ideal for automated coding agents: explicitly ask them to call `debug-script` whenever they need runtime insight instead of editing the test suite with temporary logging.

## Quick Start

1. Configure your MCP-compatible host (Claude Code, Codex, Cursor, etc.) to launch `npx nodejs-debug-mcp`. The host will spawn the process on demand, so you never need to keep a background terminal open.

   ```bash
   npx nodejs-debug-mcp
   ```

2. From the host, call the `debug-script` tool with the Node.js command you want to run, the breakpoint location, and the expression to evaluate. Every time the breakpoint is hit, the server streams the evaluated value back in the same response.

### Usage tips

- Start with an assertion or loop that you want to inspect, set the breakpoint there, and ask the tool to evaluate whatever variable or expression you are tracking.
- When a debugging session fails, rerun with a different expression rather than reissuing multiple incremental calls—the entire trace arrives at once.
- Instruct human collaborators or coding agents to use this tool as their first resort for understanding failing tests instead of modifying source files with temporary logging.

## IDE & agent setup

### Claude Code

1. Open **Settings → Developer Tools → MCP Servers** in Claude Code.
2. Choose **Add Server → Command**, paste `npx nodejs-debug-mcp`, and save.
3. Trigger the `debug-script` tool from Claude Code when you need to inspect runtime state; Claude will launch the MCP command for you.

Need a single-shot CLI setup instead of using the GUI? Run:

```bash
claude mcp add --scope user --transport stdio nodejs-debug-mcp -- npx -y nodejs-debug-mcp
```

That registers the server at the user scope and points Claude Code at the published `nodejs-debug-mcp` binary via `npx`, so the CLI fetches the latest version and launches it over stdio whenever you call `debug-script`.

### Codex CLI

1. Add an MCP entry to your Codex configuration (for example, inside the CLI `mcpServers` list) with `"command": "npx nodejs-debug-mcp"` and a descriptive name.
2. Within the Codex CLI session, invoke the registered MCP tool; the CLI handles launching and shutting down the server automatically.

### Cursor

1. In Cursor, open **Settings → MCP**, click **Add Command Server**, and enter `npx nodejs-debug-mcp`.
2. Call `debug-script` from the Command Palette or chat to capture breakpoint evaluations inside the editor; Cursor will execute the command as needed.

## Development

```bash
# Compile TypeScript to dist/
npx tsc

# Run the end-to-end test suite
node --test test/e2e.test.js
```

The TypeScript build emits both JavaScript and declaration files in `dist/`. See `SPECIFICATION.md` for the full technical design that guided this implementation.

## Releasing

1. Bump the version in `package.json`.
2. Rebuild the distribution artifacts with `npx tsc`.
3. Pack and publish using your registry's standard workflow, ensuring `dist/` is included.

## License

Released under the terms of the [MIT license](./LICENSE).
