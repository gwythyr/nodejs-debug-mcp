import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CDP, { type Client } from 'chrome-remote-interface';

import type { DebugScriptArguments, DebugScriptResponse } from './types.js';

const PORT_REGEX = /--inspect-brk=(\d+)/;
const CONNECT_RETRY_DELAY_MS = 100;
const MAX_CONNECT_WAIT_MS = 5000;
const PROCESS_EXIT_ERROR = 'Process exited before breakpoint was hit';

export async function debugScript(args: DebugScriptArguments): Promise<DebugScriptResponse> {
  const port = extractPort(args.command);

  const child = spawn(args.command, {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    stdio: 'ignore',
  });

  let processExited = false;
  const exitMarker = () => {
    processExited = true;
  };
  child.on('exit', exitMarker);

  let client: Client | undefined;

  try {
    client = await connectToInspector(port, args.timeout, () => processExited);
  } catch (error) {
    if (processExited || (error instanceof Error && error.message === PROCESS_EXIT_ERROR)) {
      return { error: PROCESS_EXIT_ERROR };
    }
    throw error;
  }

  try {
    return await runDebugSession(args, child, client);
  } finally {
    child.off('exit', exitMarker);
    await cleanup(child, client);
  }
}

function extractPort(command: string): number {
  const match = command.match(PORT_REGEX);
  if (!match) {
    return 9229;
  }
  return Number.parseInt(match[1], 10);
}

async function connectToInspector(
  port: number,
  timeout: number,
  hasProcessExited: () => boolean,
): Promise<Client> {
  const maxWait = Math.min(timeout, MAX_CONNECT_WAIT_MS);
  const start = Date.now();

  for (;;) {
    if (hasProcessExited()) {
      throw new Error(PROCESS_EXIT_ERROR);
    }

    try {
      return await CDP({ host: '127.0.0.1', port });
    } catch (error) {
      if (Date.now() - start >= maxWait) {
        throw error;
      }
      await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
}

async function runDebugSession(
  args: DebugScriptArguments,
  child: ChildProcess,
  client: Client,
): Promise<DebugScriptResponse> {
  const { Debugger, Runtime } = client;

  await Debugger.enable();
  await Runtime.enable();

  const absolutePath = resolve(args.breakpoint.file);
  const fileUrl = pathToFileURL(absolutePath).href;

  await Debugger.setBreakpointByUrl({
    url: fileUrl,
    lineNumber: Math.max(0, args.breakpoint.line - 1),
    columnNumber: 0,
  });

  return waitForBreakpointAndEvaluate(args, child, client);
}

function waitForBreakpointAndEvaluate(
  args: DebugScriptArguments,
  child: ChildProcess,
  client: Client,
): Promise<DebugScriptResponse> {
  const { Debugger, Runtime } = client;

  return new Promise<DebugScriptResponse>((resolve) => {
    let settled = false;

    const settle = (result: DebugScriptResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      child.off('exit', handleExit);
      Debugger.removeListener('paused', handlePaused);
      resolve(result);
    };

    const handleExit = () => {
      settle({ error: PROCESS_EXIT_ERROR });
    };

    const timeoutId = setTimeout(() => {
      settle({ error: `Timeout waiting for breakpoint after ${args.timeout}ms` });
    }, args.timeout);

    const handlePaused = async (event: { callFrames: Array<{ callFrameId: string }> }) => {
      try {
        const callFrameId = event.callFrames[0]?.callFrameId;
        if (!callFrameId) {
          settle({ error: PROCESS_EXIT_ERROR });
          return;
        }

        Debugger.removeListener('paused', handlePaused);

        const evaluation = await evaluateExpression(Debugger, callFrameId, args.expression);
        settle({ result: evaluation });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settle({ error: message });
      }
    };

    Debugger.on('paused', handlePaused);
    child.on('exit', handleExit);

    if (child.exitCode !== null || child.signalCode !== null) {
      settle({ error: PROCESS_EXIT_ERROR });
      return;
    }

    Runtime.runIfWaitingForDebugger().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      settle({ error: message });
    });
  });
}

async function evaluateExpression(
  Debugger: Client['Debugger'],
  callFrameId: string,
  expression: string,
): Promise<{ type: string; value: unknown }> {
  const wrappedExpression = `JSON.stringify(${expression})`;

  const stringifyResult = await Debugger.evaluateOnCallFrame({
    callFrameId,
    expression: wrappedExpression,
    returnByValue: true,
    silent: true,
  });

  let value: unknown = undefined;

  if (!stringifyResult.exceptionDetails && stringifyResult.result.value !== undefined) {
    const serialized = stringifyResult.result.value;
    if (typeof serialized === 'string') {
      try {
        value = JSON.parse(serialized);
      } catch {
        value = serialized;
      }
    } else {
      value = serialized;
    }
  }

  const rawResult = await Debugger.evaluateOnCallFrame({
    callFrameId,
    expression,
    returnByValue: true,
    silent: true,
  });

  let type = rawResult.result.type ?? typeof value;

  if (!rawResult.exceptionDetails) {
    if (rawResult.result.subtype === 'null') {
      type = 'null';
    } else if (rawResult.result.subtype === 'array') {
      type = 'array';
    }

    if (value === undefined) {
      if (rawResult.result.value !== undefined) {
        value = rawResult.result.value;
      } else if (rawResult.result.description !== undefined) {
        value = rawResult.result.description;
      }
    }
  } else {
    type = typeof value;
  }

  return { type, value };
}

async function cleanup(child: ChildProcess, client?: Client) {
  if (!child.killed) {
    child.kill('SIGKILL');
  }

  if (client) {
    try {
      await client.close();
    } catch {
      // No cleanup action required on close failure.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
