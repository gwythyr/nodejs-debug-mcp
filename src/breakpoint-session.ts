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

type DebuggerPausedEvent = {
  callFrames: Array<{
    callFrameId: string;
    url?: string;
    location?: { scriptId: string; lineNumber: number; columnNumber: number };
  }>;
  hitBreakpoints?: string[];
};

type SessionEmitter = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

class SessionController {
  private readonly evaluations: EvaluationResult[] = [];
  private readonly child: ChildProcess;
  private readonly args: DebugScriptArguments;
  private state: SessionState = 'waiting-for-runtime';
  private timeoutId: NodeJS.Timeout | null = null;
  private cleanupListeners: (() => void) | null = null;
  private resolvePromise: ((value: DebugScriptResponse) => void) | null = null;

  constructor(args: DebugScriptArguments, child: ChildProcess) {
    this.args = args;
    this.child = child;
  }

  begin(resolve: (value: DebugScriptResponse) => void): void {
    this.resolvePromise = resolve;
  }

  registerCleanup(cleanup: () => void): void {
    this.cleanupListeners = cleanup;
  }

  startTimeout(): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      this.settleWithError(`Timeout waiting for breakpoint after ${this.args.timeout}ms`);
    }, this.args.timeout);
  }

  clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  isSettled(): boolean {
    return this.state === 'completed' || this.state === 'errored';
  }

  childExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  recordEvaluation(evaluation: EvaluationResult): void {
    if (!this.isSettled()) {
      this.evaluations.push(evaluation);
    }
  }

  hasEvaluations(): boolean {
    return this.evaluations.length > 0;
  }

  readonly handleProcessTermination = () => {
    this.finishOnProcessTermination();
  };

  readonly handleExecutionContextDestroyed = () => {
    if (this.isSettled()) {
      return;
    }

    if (this.state === 'waiting-for-runtime') {
      this.settleWithProcessExitError();
      return;
    }

    this.finishOnProcessTermination();
  };

  readonly handleRuntimeReady = () => {
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

  readonly handleRuntimeError = (error: unknown) => {
    if (this.isSettled()) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.settleWithError(message);
  };

  finishOnProcessTermination(): void {
    if (this.isSettled()) {
      return;
    }

    if (!this.hasEvaluations()) {
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

  settleWithProcessExitError(): void {
    this.settle(
      {
        content: createContent(PROCESS_EXIT_ERROR),
        structuredContent: { error: PROCESS_EXIT_ERROR },
        isError: true,
      },
      'errored',
    );
  }

  settleWithError(message: string): void {
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
    if (this.cleanupListeners) {
      this.cleanupListeners();
      this.cleanupListeners = null;
    }
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    if (resolve) {
      resolve(result);
    }
  }
}

class BreakpointPausedHandler {
  private readonly Debugger: Client['Debugger'];
  private readonly args: DebugScriptArguments;
  private readonly options: SessionOptions;
  private readonly session: SessionController;

  constructor(
    Debugger: Client['Debugger'],
    args: DebugScriptArguments,
    options: SessionOptions,
    session: SessionController,
  ) {
    this.Debugger = Debugger;
    this.args = args;
    this.options = options;
    this.session = session;
  }

  readonly handle = async (event: DebuggerPausedEvent) => {
    if (this.session.isSettled()) {
      return;
    }

    if (this.options.breakpointId && !event.hitBreakpoints?.includes(this.options.breakpointId)) {
      await this.Debugger.resume();
      return;
    }

    const topFrame = event.callFrames[0];
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
      this.session.settleWithProcessExitError();
      return;
    }

    try {
      const evaluation = await evaluateExpression(this.Debugger, callFrameId, this.args.expression);
      this.session.recordEvaluation(evaluation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.session.settleWithError(message);
      return;
    }

    if (this.session.isSettled()) {
      return;
    }

    try {
      await this.Debugger.resume();
    } catch (resumeError) {
      if (this.session.hasEvaluations()) {
        this.session.finishOnProcessTermination();
        return;
      }
      const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
      this.session.settleWithError(message);
    }
  };
}

class SessionListeners {
  private readonly child: ChildProcess;
  private readonly emitter: SessionEmitter;
  private readonly Debugger: Client['Debugger'];
  private readonly handlers: {
    onProcessTermination: (...args: unknown[]) => void;
    onExecutionContextDestroyed: (...args: unknown[]) => void;
    onPaused: (event: DebuggerPausedEvent) => void | Promise<void>;
  };
  private removePausedListener: (() => void) | null = null;
  private attached = false;

  constructor(
    child: ChildProcess,
    emitter: SessionEmitter,
    Debugger: Client['Debugger'],
    handlers: {
      onProcessTermination: (...args: unknown[]) => void;
      onExecutionContextDestroyed: (...args: unknown[]) => void;
      onPaused: (event: DebuggerPausedEvent) => void | Promise<void>;
    },
  ) {
    this.child = child;
    this.emitter = emitter;
    this.Debugger = Debugger;
    this.handlers = handlers;
  }

  attach(): void {
    if (this.attached) {
      return;
    }

    this.removePausedListener = this.Debugger.on('paused', this.handlers.onPaused);
    this.child.on('exit', this.handlers.onProcessTermination);
    this.child.on('close', this.handlers.onProcessTermination);
    this.emitter.on('disconnect', this.handlers.onProcessTermination);
    this.emitter.on('Runtime.executionContextDestroyed', this.handlers.onExecutionContextDestroyed);

    this.attached = true;
  }

  detach(): void {
    if (!this.attached) {
      return;
    }

    this.child.off('exit', this.handlers.onProcessTermination);
    this.child.off('close', this.handlers.onProcessTermination);
    this.emitter.removeListener('disconnect', this.handlers.onProcessTermination);
    this.emitter.removeListener('Runtime.executionContextDestroyed', this.handlers.onExecutionContextDestroyed);

    if (this.removePausedListener) {
      this.removePausedListener();
      this.removePausedListener = null;
    }

    this.attached = false;
  }
}

export class BreakpointEvaluationSession {
  private readonly Debugger: Client['Debugger'];
  private readonly Runtime: Client['Runtime'];
  private readonly controller: SessionController;
  private readonly listeners: SessionListeners;
  private readonly pausedHandler: BreakpointPausedHandler;

  constructor(args: DebugScriptArguments, child: ChildProcess, client: Client, options: SessionOptions) {
    this.Debugger = client.Debugger;
    this.Runtime = client.Runtime;

    const emitter = client as unknown as SessionEmitter;
    this.controller = new SessionController(args, child);
    this.pausedHandler = new BreakpointPausedHandler(this.Debugger, args, options, this.controller);
    this.listeners = new SessionListeners(child, emitter, this.Debugger, {
      onProcessTermination: this.controller.handleProcessTermination,
      onExecutionContextDestroyed: this.controller.handleExecutionContextDestroyed,
      onPaused: this.pausedHandler.handle,
    });
    this.controller.registerCleanup(() => this.listeners.detach());
  }

  start(): Promise<DebugScriptResponse> {
    return new Promise<DebugScriptResponse>((resolve) => {
      this.controller.begin(resolve);
      this.listeners.attach();
      this.controller.startTimeout();

      if (this.controller.childExited()) {
        this.controller.settleWithProcessExitError();
        return;
      }

      void this.Runtime.runIfWaitingForDebugger()
        .then(this.controller.handleRuntimeReady)
        .catch(this.controller.handleRuntimeError);
    });
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
