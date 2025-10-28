import { debugScript } from './debug-tool.js';
import type { DebugScriptArguments, DebugScriptResponse } from './types.js';

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
  'Execute a Node.js command in debug mode, pause at a breakpoint, evaluate an expression, and return the value.';

const TOOL_INFO = {
  name: 'debug-script',
  description: TOOL_DESCRIPTION,
  input_schema: TOOL_INPUT_SCHEMA,
};

process.stdin.setEncoding('utf8');

let buffer = '';

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
        sendResponse(message.id ?? null, { result });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        sendResponse(message.id ?? null, { error: messageText });
      }
      break;
    }
    default: {
      sendError(message.id ?? null, -32601, `Method not found: ${message.method}`);
    }
  }
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

function sendResponse(id: JsonRpcId, result: Record<string, unknown>) {
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
