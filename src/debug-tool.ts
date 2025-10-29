import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CDP, { type Client } from 'chrome-remote-interface';

import type {
  DebugScriptArguments,
  DebugScriptResponse,
  EvaluationResult,
  ToolContent,
} from './types.js';

const PORT_REGEX = /--inspect-brk=(\d+)/;
const CONNECT_RETRY_DELAY_MS = 100;
const MAX_CONNECT_WAIT_MS = 5000;
const PROCESS_EXIT_ERROR = 'Process exited before breakpoint was hit';

function createContent(message?: string): ToolContent[] {
  if (!message) {
    return [];
  }
  return [{ type: 'text', text: message }];
}

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

  return waitForBreakpointAndEvaluate(
    args,
    child,
    client,
    breakpointId,
    fileUrl,
    expectedLineNumber,
  );
}

function waitForBreakpointAndEvaluate(
  args: DebugScriptArguments,
  child: ChildProcess,
  client: Client,
  breakpointId: string,
  targetUrl: string,
  targetLineNumber: number,
): Promise<DebugScriptResponse> {
  const { Debugger, Runtime } = client;
  const emitter = client as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };

  return new Promise<DebugScriptResponse>((resolve) => {
    let settled = false;
    const evaluations: EvaluationResult[] = [];

    let removePausedListener: (() => void) | null = null;
    let hasResumed = false;
    let executionContextDestroyedBeforeResume = false;
    let contextDestroyedAfterResume = false;
    const handleDisconnect = () => {
      finishSession();
    };
    const handleClose = () => {
      finishSession();
    };

    const settle = (result: DebugScriptResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      child.off('exit', handleExit);
      child.off('close', handleClose);
      emitter.removeListener('disconnect', handleDisconnect);
      if (removePausedListener) {
        removePausedListener();
        removePausedListener = null;
      }
      emitter.removeListener('Runtime.executionContextDestroyed', handleExecutionContextDestroyed);
      resolve(result);
    };

    const finishSession = () => {
      if (settled) {
        return;
      }
      if (evaluations.length === 0) {
        settle({
          content: createContent(PROCESS_EXIT_ERROR),
          structuredContent: { error: PROCESS_EXIT_ERROR },
          isError: true,
        });
      } else {
        settle({
          content: createContent(),
          structuredContent: { results: evaluations },
        });
      }
    };

    const handleExit = () => {
      finishSession();
    };

    const handleExecutionContextDestroyed = () => {
      if (!hasResumed) {
        executionContextDestroyedBeforeResume = true;
        return;
      }
      contextDestroyedAfterResume = true;
      finishSession();
    };

    const timeoutId = setTimeout(() => {
      settle({
        content: createContent(`Timeout waiting for breakpoint after ${args.timeout}ms`),
        structuredContent: { error: `Timeout waiting for breakpoint after ${args.timeout}ms` },
        isError: true,
      });
    }, args.timeout);

    const handlePaused = async (
      event: { callFrames: Array<{ callFrameId: string; url?: string }> ; hitBreakpoints?: string[] },
    ) => {
      try {
        if (breakpointId && !event.hitBreakpoints?.includes(breakpointId)) {
          await Debugger.resume();
          return;
        }

        const topFrame = event.callFrames[0] as {
          callFrameId: string;
          url?: string;
          location?: { scriptId: string; lineNumber: number; columnNumber: number };
        } | undefined;

        const frameUrl = topFrame?.url;
        const location = topFrame?.location;

        if (frameUrl && frameUrl !== targetUrl) {
          await Debugger.resume();
          return;
        }

        if (location && location.lineNumber !== targetLineNumber) {
          await Debugger.resume();
          return;
        }

        const callFrameId = topFrame?.callFrameId;
        if (!callFrameId) {
          settle({
            content: createContent(PROCESS_EXIT_ERROR),
            structuredContent: { error: PROCESS_EXIT_ERROR },
            isError: true,
          });
          return;
        }

        const evaluation = await evaluateExpression(Debugger, callFrameId, args.expression);
        evaluations.push(evaluation);

        if (settled) {
          return;
        }

        try {
          await Debugger.resume();
        } catch (resumeError) {
          if (evaluations.length > 0) {
            finishSession();
            return;
          }
          const message =
            resumeError instanceof Error ? resumeError.message : String(resumeError);
          settle({
            content: createContent(message),
            structuredContent: { error: message },
            isError: true,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settle({
          content: createContent(message),
          structuredContent: { error: message },
          isError: true,
        });
      }
    };

    removePausedListener = Debugger.on('paused', handlePaused);
    child.on('exit', handleExit);
    child.on('close', handleClose);
    emitter.on('disconnect', handleDisconnect);
    emitter.on('Runtime.executionContextDestroyed', handleExecutionContextDestroyed);

    if (child.exitCode !== null || child.signalCode !== null) {
      settle({
        content: createContent(PROCESS_EXIT_ERROR),
        structuredContent: { error: PROCESS_EXIT_ERROR },
        isError: true,
      });
      return;
    }

    Runtime.runIfWaitingForDebugger()
      .then(() => {
        hasResumed = true;
        if (executionContextDestroyedBeforeResume) {
          settle({
            content: createContent(PROCESS_EXIT_ERROR),
            structuredContent: { error: PROCESS_EXIT_ERROR },
            isError: true,
          });
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          settle({
            content: createContent(PROCESS_EXIT_ERROR),
            structuredContent: { error: PROCESS_EXIT_ERROR },
            isError: true,
          });
        } else if (contextDestroyedAfterResume && !settled) {
          finishSession();
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        settle({
          content: createContent(message),
          structuredContent: { error: message },
          isError: true,
        });
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
