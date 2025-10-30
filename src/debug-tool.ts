import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CDP, { type Client } from 'chrome-remote-interface';

import { BreakpointEvaluationSession, PROCESS_EXIT_ERROR, createContent } from './breakpoint-session.js';
import type { DebugScriptArguments, DebugScriptResponse } from './types.js';

const PORT_REGEX = /--inspect-brk=(\d+)/;
const CONNECT_RETRY_DELAY_MS = 100;
const MAX_CONNECT_WAIT_MS = 5000;

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
      return {
        content: createContent(PROCESS_EXIT_ERROR),
        structuredContent: { error: PROCESS_EXIT_ERROR },
        isError: true,
      };
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
  const expectedLineNumber = Math.max(0, args.breakpoint.line);

  const setBreakpointResult = await Debugger.setBreakpointByUrl({
    url: fileUrl,
    lineNumber: expectedLineNumber,
    columnNumber: 0,
  });

  const breakpointId = setBreakpointResult?.breakpointId ?? '';
  const targetScriptId = (
    setBreakpointResult as { locations?: Array<{ scriptId?: string }> } | undefined
  )?.locations?.[0]?.scriptId;

  return waitForBreakpointAndEvaluate(
    args,
    child,
    client,
    breakpointId,
    fileUrl,
    expectedLineNumber,
    targetScriptId,
  );
}

function waitForBreakpointAndEvaluate(
  args: DebugScriptArguments,
  child: ChildProcess,
  client: Client,
  breakpointId: string,
  targetUrl: string,
  targetLineNumber: number,
  targetScriptId?: string,
): Promise<DebugScriptResponse> {
  const session = new BreakpointEvaluationSession(args, child, client, {
    breakpointId,
    targetUrl,
    targetLineNumber,
    targetScriptId,
  });
  return session.start();
}


async function cleanup(child: ChildProcess, client?: Client) {
  console.error('cleanup invoked', child.exitCode, child.signalCode);
  if (
    !child.killed &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
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
