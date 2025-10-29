import type { ChildProcess } from 'node:child_process';
import type { Client } from 'chrome-remote-interface';

import type {
  DebugScriptArguments,
  DebugScriptResponse,
  EvaluationResult,
  ToolContent,
} from './types.js';

export const PROCESS_EXIT_ERROR = 'Process exited before breakpoint was hit';

export function createContent(message?: string): ToolContent[] {
  if (!message) {
    return [];
  }
  return [{ type: 'text', text: message }];
}

type SessionState = 'waiting-for-runtime' | 'runtime-ready' | 'completed' | 'errored';

interface SessionOptions {
  breakpointId: string;
  targetUrl: string;
  targetLineNumber: number;
}

export class BreakpointEvaluationSession {
  private readonly args: DebugScriptArguments;
  private readonly child: ChildProcess;
  private readonly Debugger: Client['Debugger'];
  private readonly Runtime: Client['Runtime'];
  private readonly options: SessionOptions;
  private readonly evaluations: EvaluationResult[] = [];
  private readonly emitter: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };

  private state: SessionState = 'waiting-for-runtime';
  private timeoutId: NodeJS.Timeout | null = null;
  private removePausedListener: (() => void) | null = null;
  private resolvePromise!: (value: DebugScriptResponse) => void;

  constructor(args: DebugScriptArguments, child: ChildProcess, client: Client, options: SessionOptions) {
    this.args = args;
    this.child = child;
    this.Debugger = client.Debugger;
    this.Runtime = client.Runtime;
    this.options = options;
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

      void this.Runtime.runIfWaitingForDebugger()
        .then(this.handleRuntimeReady)
        .catch(this.handleRuntimeError);
    });
  }

  private readonly handleProcessTermination = () => {
    this.finishOnProcessTermination();
  };

  private readonly handleExecutionContextDestroyed = () => {
    if (this.isSettled()) {
      return;
    }

    if (this.state === 'waiting-for-runtime') {
      this.settleWithProcessExitError();
      return;
    }

    this.finishOnProcessTermination();
  };

  private readonly handleRuntimeReady = () => {
    if (this.isSettled()) {
      return;
    }

    if (this.state === 'waiting-for-runtime') {
      this.state = 'runtime-ready';
    }

    if (this.childExited()) {
      this.settleWithProcessExitError();
    }
  };

  private readonly handleRuntimeError = (error: unknown) => {
    if (this.isSettled()) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.settleWithError(message);
  };

  private readonly handlePaused = async (
    event: { callFrames: Array<{ callFrameId: string; url?: string }>; hitBreakpoints?: string[] },
  ) => {
    if (this.isSettled()) {
      return;
    }

    if (this.options.breakpointId && !event.hitBreakpoints?.includes(this.options.breakpointId)) {
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

    if (frameUrl && frameUrl !== this.options.targetUrl) {
      await this.Debugger.resume();
      return;
    }

    if (location && location.lineNumber !== this.options.targetLineNumber) {
      await this.Debugger.resume();
      return;
    }

    const callFrameId = topFrame?.callFrameId;
    if (!callFrameId) {
      this.settleWithProcessExitError();
      return;
    }

    try {
      const evaluation = await evaluateExpression(this.Debugger, callFrameId, this.args.expression);
      this.evaluations.push(evaluation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settleWithError(message);
      return;
    }

    if (this.isSettled()) {
      return;
    }

    try {
      await this.Debugger.resume();
    } catch (resumeError) {
      if (this.evaluations.length > 0) {
        this.finishOnProcessTermination();
        return;
      }
      const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
      this.settleWithError(message);
    }
  };

  private attachListeners(): void {
    this.removePausedListener = this.Debugger.on('paused', this.handlePaused);
    this.child.on('exit', this.handleProcessTermination);
    this.child.on('close', this.handleProcessTermination);
    this.emitter.on('disconnect', this.handleProcessTermination);
    this.emitter.on('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
  }

  private detachListeners(): void {
    this.child.off('exit', this.handleProcessTermination);
    this.child.off('close', this.handleProcessTermination);
    this.emitter.removeListener('disconnect', this.handleProcessTermination);
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

  private finishOnProcessTermination(): void {
    if (this.isSettled()) {
      return;
    }

    if (this.evaluations.length === 0) {
      this.settleWithProcessExitError();
      return;
    }

    this.settle(
      {
        content: createContent(),
        structuredContent: { results: this.evaluations },
      },
      'completed',
    );
  }

  private settleWithProcessExitError(): void {
    this.settle(
      {
        content: createContent(PROCESS_EXIT_ERROR),
        structuredContent: { error: PROCESS_EXIT_ERROR },
        isError: true,
      },
      'errored',
    );
  }

  private settleWithError(message: string): void {
    this.settle(
      {
        content: createContent(message),
        structuredContent: { error: message },
        isError: true,
      },
      'errored',
    );
  }

  private settle(result: DebugScriptResponse, nextState: Extract<SessionState, 'completed' | 'errored'>): void {
    if (this.isSettled()) {
      return;
    }

    this.state = nextState;
    this.clearTimeout();
    this.detachListeners();
    this.resolvePromise(result);
  }

  private isSettled(): boolean {
    return this.state === 'completed' || this.state === 'errored';
  }

  private childExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }
}

async function evaluateExpression(
  Debugger: Client['Debugger'],
  callFrameId: string,
  expression: string,
): Promise<EvaluationResult> {
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
