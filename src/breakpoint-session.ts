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

class SessionResultSerializer {
  static success(evaluations: EvaluationResult[]): DebugScriptResponse {
    return {
      content: createContent(),
      structuredContent: { results: evaluations },
    };
  }

  static processExitError(): DebugScriptResponse {
    return {
      content: createContent(PROCESS_EXIT_ERROR),
      structuredContent: { error: PROCESS_EXIT_ERROR },
      isError: true,
    };
  }

  static error(message: string): DebugScriptResponse {
    return {
      content: createContent(message),
      structuredContent: { error: message },
      isError: true,
    };
  }
}

class SessionStateMachine {
  private state: SessionState = 'waiting-for-runtime';
  private readonly evaluations: EvaluationResult[] = [];
  private timeoutId: NodeJS.Timeout | null = null;
  private resolvePromise: ((value: DebugScriptResponse) => void) | null = null;

  constructor(
    private readonly args: DebugScriptArguments,
    private readonly onSettle: () => void,
  ) {}

  begin(resolve: (value: DebugScriptResponse) => void): void {
    this.resolvePromise = resolve;
    this.startTimeout();
  }

  isSettled(): boolean {
    return this.state === 'completed' || this.state === 'errored';
  }

  isWaitingForRuntime(): boolean {
    return this.state === 'waiting-for-runtime';
  }

  markRuntimeReady(): void {
    if (this.state === 'waiting-for-runtime') {
      this.state = 'runtime-ready';
    }
  }

  recordEvaluation(evaluation: EvaluationResult): void {
    if (!this.isSettled()) {
      this.evaluations.push(evaluation);
    }
  }

  hasEvaluations(): boolean {
    return this.evaluations.length > 0;
  }

  finishOnProcessTermination(): void {
    if (this.isSettled()) {
      return;
    }

    if (!this.hasEvaluations()) {
      this.settleWithProcessExitError();
      return;
    }

    this.settle(SessionResultSerializer.success(this.evaluations), 'completed');
  }

  settleWithProcessExitError(): void {
    this.settle(SessionResultSerializer.processExitError(), 'errored');
  }

  settleWithError(message: string): void {
    this.settle(SessionResultSerializer.error(message), 'errored');
  }

  private settle(result: DebugScriptResponse, nextState: Extract<SessionState, 'completed' | 'errored'>): void {
    if (this.isSettled()) {
      return;
    }

    this.state = nextState;
    this.clearTimeout();

    try {
      this.onSettle();
    } finally {
      const resolve = this.resolvePromise;
      this.resolvePromise = null;
      if (resolve) {
        resolve(result);
      }
    }
  }

  private startTimeout(): void {
    this.clearTimeout();
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
}

class SessionListenerManager {
  private listenersAttached = false;
  private removePausedListener: (() => void) | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly client: Client,
    private readonly Debugger: Client['Debugger'],
    private readonly onProcessTermination: () => void,
    private readonly onExecutionContextDestroyed: () => void,
    private readonly onPaused: (event: DebuggerPausedEvent) => void | Promise<void>,
  ) {}

  attach(): void {
    if (this.listenersAttached) {
      return;
    }

    this.removePausedListener = this.Debugger.on('paused', this.onPaused);
    this.child.on('exit', this.onProcessTermination);
    this.child.on('close', this.onProcessTermination);
    this.client.on('disconnect', this.onProcessTermination);
    this.client.on('Runtime.executionContextDestroyed', this.onExecutionContextDestroyed);

    this.listenersAttached = true;
  }

  detach(): void {
    if (!this.listenersAttached) {
      return;
    }

    this.child.off('exit', this.onProcessTermination);
    this.child.off('close', this.onProcessTermination);
    this.client.removeListener('disconnect', this.onProcessTermination);
    this.client.removeListener('Runtime.executionContextDestroyed', this.onExecutionContextDestroyed);

    if (this.removePausedListener) {
      this.removePausedListener();
      this.removePausedListener = null;
    }

    this.listenersAttached = false;
  }
}

export class BreakpointEvaluationSession {
  private readonly Debugger: Client['Debugger'];
  private readonly Runtime: Client['Runtime'];
  private readonly child: ChildProcess;
  private readonly client: Client;
  private readonly args: DebugScriptArguments;
  private readonly options: SessionOptions;
  private readonly stateMachine: SessionStateMachine;
  private readonly listeners: SessionListenerManager;

  constructor(args: DebugScriptArguments, child: ChildProcess, client: Client, options: SessionOptions) {
    this.child = child;
    this.args = args;
    this.options = options;
    this.client = client;
    this.Debugger = client.Debugger;
    this.Runtime = client.Runtime;
    this.listeners = new SessionListenerManager(
      this.child,
      this.client,
      this.Debugger,
      this.handleProcessTermination,
      this.handleExecutionContextDestroyed,
      this.handlePaused,
    );
    this.stateMachine = new SessionStateMachine(this.args, () => {
      this.listeners.detach();
    });
  }

  start(): Promise<DebugScriptResponse> {
    return new Promise<DebugScriptResponse>((resolve) => {
      this.stateMachine.begin(resolve);
      this.listeners.attach();

      if (this.childExited()) {
        this.stateMachine.settleWithProcessExitError();
        return;
      }

      void this.Runtime.runIfWaitingForDebugger()
        .then(this.handleRuntimeReady)
        .catch(this.handleRuntimeError);
    });
  }

  private childExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private readonly handleProcessTermination = () => {
    this.stateMachine.finishOnProcessTermination();
  };

  private readonly handleExecutionContextDestroyed = () => {
    if (this.stateMachine.isSettled()) {
      return;
    }

    if (this.stateMachine.isWaitingForRuntime()) {
      this.stateMachine.settleWithProcessExitError();
      return;
    }

    this.stateMachine.finishOnProcessTermination();
  };

  private readonly handleRuntimeReady = () => {
    if (this.stateMachine.isSettled()) {
      return;
    }

    this.stateMachine.markRuntimeReady();

    if (this.childExited()) {
      this.stateMachine.settleWithProcessExitError();
    }
  };

  private readonly handleRuntimeError = (error: unknown) => {
    if (this.stateMachine.isSettled()) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.stateMachine.settleWithError(message);
  };

  private readonly handlePaused = async (event: DebuggerPausedEvent) => {
    if (this.stateMachine.isSettled()) {
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
      this.stateMachine.settleWithProcessExitError();
      return;
    }

    try {
      const evaluation = await evaluateExpression(this.Debugger, callFrameId, this.args.expression);
      this.stateMachine.recordEvaluation(evaluation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stateMachine.settleWithError(message);
      return;
    }

    if (this.stateMachine.isSettled()) {
      return;
    }

    try {
      await this.Debugger.resume();
    } catch (resumeError) {
      if (this.stateMachine.hasEvaluations()) {
        this.stateMachine.finishOnProcessTermination();
        return;
      }
      const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
      this.stateMachine.settleWithError(message);
    }
  };
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
