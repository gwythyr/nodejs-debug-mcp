import { debugScript } from './debug-tool.js';
import type { DebugScriptArguments, DebugScriptResponse, ToolContent } from './types.js';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    breakpoint: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
      },
      required: ['file', 'line'],
    },
    expression: { type: 'string' },
    timeout: { type: 'number' },
  },
  required: ['command', 'breakpoint', 'expression', 'timeout'],
};

const TOOL_DESCRIPTION =
  'Execute a single-threaded Node.js command (with --inspect-brk) in debug mode, pause at a breakpoint, evaluate an expression, and return the values for each breakpoint hit.';

const TOOL_INFO = {
  name: 'debug-script',
  description: TOOL_DESCRIPTION,
  inputSchema: TOOL_INPUT_SCHEMA,
};

const SERVER_INFO = {
  name: 'unit-debug-mcp',
  version: '0.1.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
};

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);

const PROTOCOL_VERSION = '2025-06-18';

process.stdin.setEncoding('utf8');

let buffer = '';

function createContent(message?: string): ToolContent[] {
  if (!message) {
    return [];
  }
  return [{ type: 'text', text: message }];
}

process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\n');

  while (newlineIndex !== -1) {
    const raw = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (raw.length > 0) {
      void handleMessage(raw);
    }

    newlineIndex = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  if (buffer.trim().length > 0) {
    void handleMessage(buffer.trim());
  }
});

async function handleMessage(raw: string) {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return;
  }

  if (message.jsonrpc !== '2.0') {
    return;
  }

  switch (message.method) {
    case 'initialize': {
      if (!validateInitializeParams(message.params)) {
        sendError(message.id ?? null, -32602, 'Invalid params for initialize');
        return;
      }

      const protocolVersion = negotiateProtocolVersion(message.params.protocolVersion);

      sendResponse(message.id ?? null, {
        protocolVersion,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
      break;
    }
    case 'ping': {
      sendResponse(message.id ?? null, {});
      break;
    }
    case 'tools/list': {
      sendResponse(message.id ?? null, { tools: [TOOL_INFO] });
      break;
    }
    case 'tools/call': {
      const args = extractArguments(message.params);
      if (!args) {
        sendError(message.id ?? null, -32602, 'Invalid params for debug-script');
        return;
      }

      try {
        const result = await debugScript(args);
        sendResponse(message.id ?? null, result);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        sendResponse(message.id ?? null, {
          content: createContent(messageText),
          structuredContent: { error: messageText },
          isError: true,
        });
      }
      break;
    }
    default: {
      if (message.id !== undefined) {
        sendError(message.id, -32601, `Method not found: ${message.method}`);
      }
    }
  }
}

function validateInitializeParams(params?: Record<string, unknown>): params is {
  protocolVersion: string;
} {
  if (!params || typeof params !== 'object') {
    return false;
  }

  return typeof params.protocolVersion === 'string';
}

function negotiateProtocolVersion(requested: string): string {
  return SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
}

function extractArguments(params?: Record<string, unknown>): DebugScriptArguments | null {
  const rawArgs = (params?.arguments ?? params) as Partial<DebugScriptArguments> | undefined;
  if (!rawArgs) {
    return null;
  }

  if (
    typeof rawArgs.command !== 'string' ||
    typeof rawArgs.expression !== 'string' ||
    typeof rawArgs.timeout !== 'number' ||
    typeof rawArgs.breakpoint !== 'object' ||
    rawArgs.breakpoint === null ||
    typeof rawArgs.breakpoint.file !== 'string' ||
    typeof rawArgs.breakpoint.line !== 'number'
  ) {
    return null;
  }

  return {
    command: rawArgs.command,
    expression: rawArgs.expression,
    timeout: rawArgs.timeout,
    breakpoint: {
      file: rawArgs.breakpoint.file,
      line: rawArgs.breakpoint.line,
    },
  };
}

function sendResponse(id: JsonRpcId, result: unknown) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  });

  process.stdout.write(`${payload}\n`);
}

function sendError(id: JsonRpcId, code: number, message: string) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });

  process.stdout.write(`${payload}\n`);
}
