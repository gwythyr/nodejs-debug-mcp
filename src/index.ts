#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createContent } from './breakpoint-session.js';
import { debugScript } from './debug-tool.js';
import type { DebugScriptArguments } from './types.js';

const TOOL_DESCRIPTION =
  'Execute a single-threaded Node.js command (with --inspect-brk) in debug mode, pause at a breakpoint, evaluate an expression, and return the values for each breakpoint hit.';

const server = new McpServer({
  name: 'nodejs-debug-mcp',
  version: '0.1.0',
});

const debugScriptInputSchema = {
  command: z.string(),
  breakpoint: z.object({
    file: z.string(),
    line: z.number(),
  }),
  expression: z.string(),
  timeout: z.number(),
};

server.registerTool(
  'debug-script',
  {
    title: 'debug-script',
    description: TOOL_DESCRIPTION,
    inputSchema: debugScriptInputSchema,
  },
  async (args) => {
    const debugArgs: DebugScriptArguments = {
      command: args.command,
      breakpoint: {
        file: args.breakpoint.file,
        line: args.breakpoint.line,
      },
      expression: args.expression,
      timeout: args.timeout,
    };

    try {
      return await debugScript(debugArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: createContent(message),
        structuredContent: { error: message },
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to start MCP server:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

void main();
