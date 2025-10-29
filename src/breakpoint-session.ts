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

function successResponse(evaluations: EvaluationResult[]): DebugScriptResponse {
  return {
    content: createContent(),
    structuredContent: { results: evaluations },
  };
}

function processExitResponse(): DebugScriptResponse {
  return {
    content: createContent(PROCESS_EXIT_ERROR),
    structuredContent: { error: PROCESS_EXIT_ERROR },
    isError: true,
  };
}

function errorResponse(message: string): DebugScriptResponse {
  return {
    content: createContent(message),
    structuredContent: { error: message },
    isError: true,
  };
}

export function startBreakpointEvaluationSession(
  args: DebugScriptArguments,
  child: ChildProcess,
  client: Client,
  options: SessionOptions,
): Promise<DebugScriptResponse> {
  const { Debugger, Runtime } = client;
  const evaluations: EvaluationResult[] = [];
  let resolved = false;
  let runtimeReady = false;
  let timeoutId: NodeJS.Timeout | null = null;
  let resolveResponse: (value: DebugScriptResponse) => void = () => {};

  const cleanupCallbacks: Array<() => void> = [];

  const clearTimeoutIfNeeded = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const cleanupListeners = () => {
    while (cleanupCallbacks.length > 0) {
      const cleanup = cleanupCallbacks.pop();
      try {
        cleanup?.();
      } catch {
        // Listener removal errors should not surface to consumers.
      }
    }
  };

  const settle = (response: DebugScriptResponse) => {
    if (resolved) {
      return;
    }

    resolved = true;
    clearTimeoutIfNeeded();
    cleanupListeners();
    resolveResponse(response);
  };

  const settleWithProcessExitError = () => settle(processExitResponse());
  const settleWithError = (message: string) => settle(errorResponse(message));
  const settleWithSuccess = () => settle(successResponse(evaluations));

  const finishOnProcessTermination = () => {
    if (resolved) {
      return;
    }

    if (evaluations.length === 0) {
      settleWithProcessExitError();
      return;
    }

    settleWithSuccess();
  };

  const childExited = () => child.exitCode !== null || child.signalCode !== null;

  const onProcessTermination = () => {
    finishOnProcessTermination();
  };

  const onExecutionContextDestroyed = () => {
    if (resolved) {
      return;
    }

    if (!runtimeReady) {
      settleWithProcessExitError();
      return;
    }

    finishOnProcessTermination();
  };

  const onPaused = async (event: DebuggerPausedEvent) => {
    if (resolved) {
      return;
    }

    if (options.breakpointId && !event.hitBreakpoints?.includes(options.breakpointId)) {
      await Debugger.resume();
      return;
    }

    const topFrame = event.callFrames[0];
    const frameUrl = topFrame?.url;
    const location = topFrame?.location;

    if (frameUrl && frameUrl !== options.targetUrl) {
      await Debugger.resume();
      return;
    }

    if (location && location.lineNumber !== options.targetLineNumber) {
      await Debugger.resume();
      return;
    }

    const callFrameId = topFrame?.callFrameId;
    if (!callFrameId) {
      settleWithProcessExitError();
      return;
    }

    try {
      const evaluation = await evaluateExpression(Debugger, callFrameId, args.expression);
      if (!resolved) {
        evaluations.push(evaluation);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settleWithError(message);
      return;
    }

    if (resolved) {
      return;
    }

    try {
      await Debugger.resume();
    } catch (resumeError) {
      if (evaluations.length > 0) {
        finishOnProcessTermination();
        return;
      }

      const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
      settleWithError(message);
    }
  };

  const attachListeners = () => {
    const removePausedListener = Debugger.on('paused', onPaused);
    cleanupCallbacks.push(() => {
      if (typeof removePausedListener === 'function') {
        removePausedListener();
      }
    });

    child.on('exit', onProcessTermination);
    cleanupCallbacks.push(() => child.off('exit', onProcessTermination));

    child.on('close', onProcessTermination);
    cleanupCallbacks.push(() => child.off('close', onProcessTermination));

    client.on('disconnect', onProcessTermination);
    cleanupCallbacks.push(() => client.removeListener('disconnect', onProcessTermination));

    client.on('Runtime.executionContextDestroyed', onExecutionContextDestroyed);
    cleanupCallbacks.push(() =>
      client.removeListener('Runtime.executionContextDestroyed', onExecutionContextDestroyed),
    );
  };

  const startTimeout = () => {
    clearTimeoutIfNeeded();
    timeoutId = setTimeout(() => {
      settleWithError(`Timeout waiting for breakpoint after ${args.timeout}ms`);
    }, args.timeout);
  };

  return new Promise<DebugScriptResponse>((resolve) => {
    resolveResponse = resolve;
    startTimeout();
    attachListeners();

    if (childExited()) {
      settleWithProcessExitError();
      return;
    }

    void Runtime.runIfWaitingForDebugger()
      .then(() => {
        if (resolved) {
          return;
        }

        runtimeReady = true;

        if (childExited()) {
          settleWithProcessExitError();
        }
      })
      .catch((error) => {
        if (resolved) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        settleWithError(message);
      });
  });
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
