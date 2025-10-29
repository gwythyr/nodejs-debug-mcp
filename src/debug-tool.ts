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
  const session = new BreakpointEvaluationSession(
    args,
    child,
    client,
    breakpointId,
    targetUrl,
    targetLineNumber,
  );
  return session.start();
}

class BreakpointEvaluationSession {
  private readonly args: DebugScriptArguments;
  private readonly child: ChildProcess;
  private readonly Debugger: Client['Debugger'];
  private readonly Runtime: Client['Runtime'];
  private readonly breakpointId: string;
  private readonly targetUrl: string;
  private readonly targetLineNumber: number;
  private readonly evaluations: EvaluationResult[] = [];
  private readonly emitter: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };

  private settled = false;
  private timeoutId: NodeJS.Timeout | null = null;
  private removePausedListener: (() => void) | null = null;
  private hasResumed = false;
  private executionContextDestroyedBeforeResume = false;
  private contextDestroyedAfterResume = false;
  private resolvePromise!: (value: DebugScriptResponse) => void;

  constructor(
    args: DebugScriptArguments,
    child: ChildProcess,
    client: Client,
    breakpointId: string,
    targetUrl: string,
    targetLineNumber: number,
  ) {
    this.args = args;
    this.child = child;
    this.Debugger = client.Debugger;
    this.Runtime = client.Runtime;
    this.breakpointId = breakpointId;
    this.targetUrl = targetUrl;
    this.targetLineNumber = targetLineNumber;
    this.emitter = client as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): void;
      removeListener(event: string, listener: (...args: unknown[]) => void): void;
    };
  }

  start(): Promise<DebugScriptResponse> {
    return new Promise<DebugScriptResponse>((resolve) => {
      this.resolvePromise = resolve;
      this.attachListeners();
      this.startTimeout();

      if (this.childExited()) {
        this.settleWithProcessExitError();
        return;
      }

      this.Runtime.runIfWaitingForDebugger()
        .then(this.handleRuntimeReady)
        .catch(this.handleRuntimeError);
    });
  }

  private readonly handleExit = () => {
    this.finishSession();
  };

  private readonly handleClose = () => {
    this.finishSession();
  };

  private readonly handleDisconnect = () => {
    this.finishSession();
  };

  private readonly handleExecutionContextDestroyed = () => {
    if (!this.hasResumed) {
      this.executionContextDestroyedBeforeResume = true;
      return;
    }
    this.contextDestroyedAfterResume = true;
    this.finishSession();
  };

  private readonly handlePaused = async (
    event: { callFrames: Array<{ callFrameId: string; url?: string }>; hitBreakpoints?: string[] },
  ) => {
    try {
      if (this.breakpointId && !event.hitBreakpoints?.includes(this.breakpointId)) {
        await this.Debugger.resume();
        return;
      }

      const topFrame = event.callFrames[0] as {
        callFrameId: string;
        url?: string;
        location?: { scriptId: string; lineNumber: number; columnNumber: number };
      } | undefined;

      const frameUrl = topFrame?.url;
      const location = topFrame?.location;

      if (frameUrl && frameUrl !== this.targetUrl) {
        await this.Debugger.resume();
        return;
      }

      if (location && location.lineNumber !== this.targetLineNumber) {
        await this.Debugger.resume();
        return;
      }

      const callFrameId = topFrame?.callFrameId;
      if (!callFrameId) {
        this.settleWithProcessExitError();
        return;
      }

      const evaluation = await evaluateExpression(this.Debugger, callFrameId, this.args.expression);
      this.evaluations.push(evaluation);

      if (this.settled) {
        return;
      }

      try {
        await this.Debugger.resume();
      } catch (resumeError) {
        if (this.evaluations.length > 0) {
          this.finishSession();
          return;
        }
        const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
        this.settleWithError(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settleWithError(message);
    }
  };

  private readonly handleRuntimeReady = () => {
    this.hasResumed = true;
    if (this.executionContextDestroyedBeforeResume) {
      this.settleWithProcessExitError();
      return;
    }

    if (this.childExited()) {
      this.settleWithProcessExitError();
      return;
    }

    if (this.contextDestroyedAfterResume && !this.settled) {
      this.finishSession();
    }
  };

  private readonly handleRuntimeError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    this.settleWithError(message);
  };

  private attachListeners(): void {
    this.removePausedListener = this.Debugger.on('paused', this.handlePaused);
    this.child.on('exit', this.handleExit);
    this.child.on('close', this.handleClose);
    this.emitter.on('disconnect', this.handleDisconnect);
    this.emitter.on('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
  }

  private detachListeners(): void {
    this.child.off('exit', this.handleExit);
    this.child.off('close', this.handleClose);
    this.emitter.removeListener('disconnect', this.handleDisconnect);
    this.emitter.removeListener('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    if (this.removePausedListener) {
      this.removePausedListener();
      this.removePausedListener = null;
    }
  }

  private startTimeout(): void {
    this.timeoutId = setTimeout(() => {
      this.settleWithError(`Timeout waiting for breakpoint after ${this.args.timeout}ms`);
    }, this.args.timeout);
  }

  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private finishSession(): void {
    if (this.settled) {
      return;
    }

    if (this.evaluations.length === 0) {
      this.settleWithProcessExitError();
      return;
    }

    this.settle({
      content: createContent(),
      structuredContent: { results: this.evaluations },
    });
  }

  private settleWithProcessExitError(): void {
    this.settle({
      content: createContent(PROCESS_EXIT_ERROR),
      structuredContent: { error: PROCESS_EXIT_ERROR },
      isError: true,
    });
  }

  private settleWithError(message: string): void {
    this.settle({
      content: createContent(message),
      structuredContent: { error: message },
      isError: true,
    });
  }

  private settle(result: DebugScriptResponse): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.clearTimeout();
    this.detachListeners();
    this.resolvePromise(result);
  }

  private childExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }
}

async function evaluateExpression(
  Debugger: Client['Debugger'],
  callFrameId: string,
  expression: string,
): Promise<{ type: string; value: unknown }> {
  const rawResult = await Debugger.evaluateOnCallFrame({
    callFrameId,
    expression,
    returnByValue: true,
    silent: true,
  });

  let type = rawResult.result.type ?? 'undefined';
  let value: unknown = rawResult.result.value;

  const hasObjectId = rawResult.result.objectId !== undefined;

  if (!rawResult.exceptionDetails) {
    if (rawResult.result.subtype === 'null') {
      type = 'null';
      value ??= null;
    } else if (rawResult.result.subtype === 'array') {
      type = 'array';
    }

    if (value === undefined && rawResult.result.description !== undefined && !hasObjectId) {
      value = rawResult.result.description;
    }
  }

  const needsSerialization =
    rawResult.exceptionDetails !== undefined ||
    hasObjectId ||
    value === undefined ||
    type === 'object';

  if (needsSerialization) {
    const wrappedExpression = `(function () { try { return JSON.stringify(${expression}); } catch (error) { return undefined; } })()`;

    const stringifyResult = await Debugger.evaluateOnCallFrame({
      callFrameId,
      expression: wrappedExpression,
      returnByValue: true,
      silent: true,
    });

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
  }

  if (rawResult.exceptionDetails) {
    type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  } else if (value !== undefined) {
    if (Array.isArray(value)) {
      type = 'array';
    } else if (value === null) {
      type = 'null';
    } else if (typeof value !== 'object') {
      type = typeof value;
    }
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
