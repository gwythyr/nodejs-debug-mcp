import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { createContent, PROCESS_EXIT_ERROR } from './breakpoint-session.js';
import type {
  DebugScriptArguments,
  DebugScriptResponse,
  EvaluationResult,
  StackFrame,
} from './types.js';

const DEFAULT_DEBUGPY_HOST = '127.0.0.1';
const DEFAULT_DEBUGPY_PORT = 5678;
const LISTEN_REGEX = /--listen(?:=|\s+)([^\s]+)/;
const CONNECT_RETRY_DELAY_MS = 100;
const MAX_CONNECT_WAIT_MS = 5000;
const STACK_FRAME_LIMIT = 20;

interface DebugpyAddress {
  host: string;
  port: number;
}

export async function debugPythonScript(args: DebugScriptArguments): Promise<DebugScriptResponse> {
  const address = extractDebugpyAddress(args.command);

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

  let client: DebugClient | undefined;
  let socket: net.Socket | undefined;

  try {
    ({ client, socket } = await connectToDebugpy(address, args.timeout, () => processExited));
  } catch (error) {
    child.off('exit', exitMarker);
    await cleanupPython(child, client);

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
    const session = new PythonBreakpointEvaluationSession(args, child, client, socket, address);
    return await session.start();
  } finally {
    child.off('exit', exitMarker);
    await cleanupPython(child, client);
  }
}

class PythonBreakpointEvaluationSession {
  private readonly child: ChildProcess;
  private readonly client: DebugClient;
  private readonly socket: net.Socket;
  private readonly args: DebugScriptArguments;
  private readonly address: DebugpyAddress;
  private readonly targetPath: string;
  private readonly targetLine: number;
  private readonly evaluations: EvaluationResult[] = [];
  private timeoutId: NodeJS.Timeout | null = null;
  private resolvePromise: ((value: DebugScriptResponse) => void) | null = null;
  private state: 'initializing' | 'running' | 'completed' | 'errored' = 'initializing';
  private listenersAttached = false;
  private supportsConfigurationDone = false;

  constructor(
    args: DebugScriptArguments,
    child: ChildProcess,
    client: DebugClient,
    socket: net.Socket,
    address: DebugpyAddress,
  ) {
    this.args = args;
    this.child = child;
    this.client = client;
    this.socket = socket;
    this.address = address;
    this.targetPath = resolve(args.breakpoint.file);
    this.targetLine = Math.max(1, args.breakpoint.line);
  }

  start(): Promise<DebugScriptResponse> {
    return new Promise<DebugScriptResponse>((resolve) => {
      this.resolvePromise = resolve;
      this.attachListeners();
      this.startTimeout();
      void this.runDebugger().catch((error) => {
        this.settleWithError(error);
      });
    });
  }

  private attachListeners(): void {
    if (this.listenersAttached) {
      return;
    }

    this.child.on('exit', this.handleProcessTermination);
    this.child.on('close', this.handleProcessTermination);
    this.client.on('terminated', this.handleProcessTermination);
    this.client.on('exited', this.handleProcessTermination);
    this.client.on('stopped', this.handleStoppedEvent);
    this.socket.on('close', this.handleProcessTermination);
    this.socket.on('error', this.handleSocketError);

    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached) {
      return;
    }

    this.child.off('exit', this.handleProcessTermination);
    this.child.off('close', this.handleProcessTermination);
    this.client.off('terminated', this.handleProcessTermination);
    this.client.off('exited', this.handleProcessTermination);
    this.client.off('stopped', this.handleStoppedEvent);
    this.socket.off('close', this.handleProcessTermination);
    this.socket.off('error', this.handleSocketError);

    this.listenersAttached = false;
  }

  private async runDebugger(): Promise<void> {
    const initializedPromise = this.waitForClientEvent('initialized');

    const initializeResponse = await this.client.initializeRequest({
      adapterID: 'nodejs-debug-mcp-python',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
    });
    this.supportsConfigurationDone = initializeResponse.body?.supportsConfigurationDoneRequest === true;

    const attachArgs = { __restart: null } as unknown as DebugProtocol.AttachRequestArguments;
    const attachPromise = this.client.attachRequest(attachArgs);

    await initializedPromise;
    await this.client.setBreakpointsRequest({
      source: { path: this.targetPath },
      breakpoints: [{ line: this.targetLine }],
    });
    await this.sendConfigurationDone();
    await attachPromise;

    this.state = 'running';
  }

  private sendConfigurationDone(): Promise<DebugProtocol.ConfigurationDoneResponse | DebugProtocol.SetExceptionBreakpointsResponse> {
    if (this.supportsConfigurationDone) {
      return this.client.configurationDoneRequest();
    }
    return this.client.setExceptionBreakpointsRequest({ filters: ['all'] });
  }

  private waitForClientEvent<T>(eventName: string): Promise<T> {
    return new Promise((resolve) => {
      const handler = (event: T) => {
        this.client.off(eventName, handler as never);
        resolve(event);
      };
      this.client.on(eventName, handler as never);
    });
  }

  private startTimeout(): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      this.settleWithError(new Error(`Timeout waiting for breakpoint after ${this.args.timeout}ms`));
    }, this.args.timeout);
  }

  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private readonly handleSocketError = () => {
    this.finishOnProcessTermination();
  };

  private readonly handleProcessTermination = () => {
    this.finishOnProcessTermination();
  };

  private readonly handleStoppedEvent = (event: DebugProtocol.StoppedEvent) => {
    if (this.state !== 'running') {
      return;
    }

    const threadId = event.body?.threadId;
    if (typeof threadId !== 'number') {
      return;
    }

    void this.processStoppedThread(threadId).catch((error) => {
      this.settleWithError(error);
    });
  };

  private async processStoppedThread(threadId: number): Promise<void> {
    let stackFrames: DebugProtocol.StackFrame[] = [];
    try {
      const response = await this.client.stackTraceRequest({
        threadId,
        startFrame: 0,
        levels: this.args.includeStack ? STACK_FRAME_LIMIT : 1,
      });
      stackFrames = response.body?.stackFrames ?? [];
    } catch (error) {
      this.settleWithError(error);
      return;
    }

    const targetFrame = stackFrames.find((frame) => this.isTargetFrame(frame));
    if (!targetFrame) {
      await this.resumeThread(threadId);
      return;
    }

    try {
      const evaluation = await this.evaluateOnFrame(targetFrame.id);
      const stack = this.args.includeStack ? this.createStack(stackFrames) : undefined;
      this.recordEvaluation(stack ? { ...evaluation, stack } : evaluation);
    } catch (error) {
      this.settleWithError(error);
      return;
    }

    if (this.state !== 'running') {
      return;
    }

    await this.resumeThread(threadId);
  }

  private async resumeThread(threadId: number): Promise<void> {
    try {
      await this.client.continueRequest({ threadId });
    } catch (error) {
      if (this.evaluations.length > 0) {
        this.finishOnProcessTermination();
        return;
      }
      this.settleWithError(error);
    }
  }

  private isTargetFrame(frame: DebugProtocol.StackFrame): boolean {
    if (!frame || !frame.source?.path) {
      return false;
    }
    const framePath = resolve(frame.source.path);
    return framePath === this.targetPath && frame.line === this.targetLine;
  }

  private createStack(frames: DebugProtocol.StackFrame[]): StackFrame[] {
    return frames.map((frame) => ({
      function: frame.name ?? '',
      file: frame.source?.path ? resolve(frame.source.path) : undefined,
      line: frame.line,
      column: frame.column,
    }));
  }

  private async evaluateOnFrame(frameId: number): Promise<EvaluationResult> {
    const serializationExpression = `__import__(\"json\").dumps(${this.args.expression})`;

    const serialized = await this.tryEvaluate(frameId, serializationExpression);
    if (serialized?.body?.result) {
      const parsed = parseJsonResult(serialized.body.result);
      if (parsed.parsed) {
        return {
          type: determinePythonType(parsed.value),
          value: parsed.value,
        };
      }
    }

    const fallback = await this.tryEvaluate(frameId, this.args.expression);
    if (!fallback?.body) {
      throw new Error('Failed to evaluate expression');
    }

    return {
      type: fallback.body.type ?? (fallback.body.result ? typeof fallback.body.result : 'string'),
      value: fallback.body.result,
    };
  }

  private async tryEvaluate(
    frameId: number,
    expression: string,
  ): Promise<DebugProtocol.EvaluateResponse | null> {
    try {
      return await this.client.evaluateRequest({
        expression,
        frameId,
        context: 'watch',
      });
    } catch {
      return null;
    }
  }

  private recordEvaluation(evaluation: EvaluationResult): void {
    if (this.state === 'running') {
      this.evaluations.push(evaluation);
    }
  }

  private finishOnProcessTermination(): void {
    if (this.isSettled()) {
      return;
    }

    if (this.evaluations.length === 0) {
      this.settleWithError(new Error(PROCESS_EXIT_ERROR));
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

  private settleWithError(error: unknown): void {
    if (this.isSettled()) {
      return;
    }

    const message = describeError(error);
    const isProcessExit = message === PROCESS_EXIT_ERROR;
    this.settle(
      {
        content: createContent(message),
        structuredContent: { error: message },
        isError: true,
      },
      'errored',
    );

    if (!isProcessExit) {
      this.child.kill('SIGKILL');
    }
  }

  private settle(result: DebugScriptResponse, nextState: 'completed' | 'errored'): void {
    if (this.isSettled()) {
      return;
    }

    this.state = nextState;
    this.clearTimeout();
    this.detachListeners();

    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    if (resolve) {
      resolve(result);
    }
  }

  private isSettled(): boolean {
    return this.state === 'completed' || this.state === 'errored';
  }
}

function parseJsonResult(result: string): { parsed: true; value: unknown } | { parsed: false } {
  const normalized = stripPythonStringLiteral(result);
  try {
    return { parsed: true, value: JSON.parse(normalized) };
  } catch {
    return { parsed: false };
  }
}

function stripPythonStringLiteral(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first !== "'" && first !== '"') || last !== first) {
    return value;
  }

  const inner = value.slice(1, -1);
  const escapePattern = new RegExp(`\\\\${first}`, 'g');
  return inner.replace(escapePattern, first);
}

function determinePythonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function describeError(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === undefined || error === null) {
    return '';
  }
  return String(error);
}

function extractDebugpyAddress(command: string): DebugpyAddress {
  const match = command.match(LISTEN_REGEX);
  if (!match) {
    return { host: DEFAULT_DEBUGPY_HOST, port: DEFAULT_DEBUGPY_PORT };
  }

  const raw = stripQuotes(match[1]);
  if (!raw) {
    return { host: DEFAULT_DEBUGPY_HOST, port: DEFAULT_DEBUGPY_PORT };
  }

  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']');
    const host = closing >= 0 ? raw.slice(1, closing) : raw;
    const portValue = raw.slice(closing + 1).replace(/^:/, '');
    const port = parsePort(portValue);
    return { host: host || DEFAULT_DEBUGPY_HOST, port };
  }

  const parts = raw.split(':');
  if (parts.length === 1) {
    const value = parts[0];
    if (/^\d+$/.test(value)) {
      return { host: DEFAULT_DEBUGPY_HOST, port: Number.parseInt(value, 10) };
    }
    return { host: value || DEFAULT_DEBUGPY_HOST, port: DEFAULT_DEBUGPY_PORT };
  }

  const port = parsePort(parts.pop() ?? '');
  const host = parts.join(':') || DEFAULT_DEBUGPY_HOST;
  return { host, port };
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_DEBUGPY_PORT;
  }
  return parsed;
}

function createConnectionTimeoutError(
  address: DebugpyAddress,
  waitMs: number,
  cause?: unknown,
): Error {
  const details = describeError(cause);
  const suffix = details ? ` (${details})` : '';
  return new Error(
    `Unable to connect to debugpy at ${address.host}:${address.port} after ${waitMs}ms${suffix}`,
  );
}

async function connectToDebugpy(
  address: DebugpyAddress,
  timeout: number,
  hasProcessExited: () => boolean,
): Promise<{ client: DebugClient; socket: net.Socket }> {
  const maxWait = Math.min(timeout, MAX_CONNECT_WAIT_MS);
  const start = Date.now();
  let lastError: unknown;

  for (;;) {
    if (hasProcessExited()) {
      throw new Error(PROCESS_EXIT_ERROR);
    }

    try {
      const socket = await createSocket(address);
      const client = new DebugClient('node', '', 'python');
      const connector = client as unknown as {
        connect(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream): void;
        _socket?: net.Socket;
      };
      connector.connect(socket, socket);
      connector._socket = socket;
      return { client, socket };
    } catch (error) {
      lastError = error;
      if (Date.now() - start >= maxWait) {
        if (hasProcessExited()) {
          throw new Error(PROCESS_EXIT_ERROR);
        }
        throw createConnectionTimeoutError(address, maxWait, lastError);
      }
      await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
}

function createSocket(address: DebugpyAddress): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address.host, port: address.port });

    const handleError = (error: Error) => {
      socket.removeListener('connect', handleConnect);
      socket.destroy();
      reject(error);
    };

    const handleConnect = () => {
      socket.removeListener('error', handleError);
      resolve(socket);
    };

    socket.once('error', handleError);
    socket.once('connect', handleConnect);
  });
}

async function cleanupPython(child: ChildProcess, client?: DebugClient): Promise<void> {
  if (!child.killed && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }

  if (client) {
    try {
      await client.stop();
    } catch {
      // No action required if disconnect fails.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
