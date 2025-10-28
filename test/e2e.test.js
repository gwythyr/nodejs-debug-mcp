import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const distEntry = resolve(projectRoot, 'dist', 'index.js');
const fixturesDir = join(__dirname, 'fixtures');

function createServer() {
  const child = spawn('node', [distEntry], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let nextId = 1;
  const pending = new Map();

  const rl = createInterface({ input: child.stdout });

  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        child.off('exit', entry.onExit);
        entry.resolve(message);
      }
    }
  });

  const send = (method, params) => {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise((resolveRequest, rejectRequest) => {
      const onExit = (code, signal) => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectRequest(
            new Error(`Server exited unexpectedly (code=${code}, signal=${signal ?? 'null'})`),
          );
        }
      };

      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, onExit });
      child.once('exit', onExit);

      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  };

  const callDebug = (args) =>
    send('tools/call', {
      name: 'debug-script',
      arguments: args,
    }).then((message) => message.result);

  const listTools = () => send('tools/list').then((message) => message.result.tools);

  const close = async () => {
    for (const entry of pending.values()) {
      child.off('exit', entry.onExit);
      entry.reject(new Error('Server closed'));
    }
    pending.clear();

    child.kill('SIGTERM');
    child.stdin.end();
    rl.close();
    await once(child, 'exit');
  };

  return { callDebug, listTools, close };
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        const { port } = address;
        server.close(() => resolvePort(port));
      } else {
        server.close(() => rejectPort(new Error('Unable to determine port')));
      }
    });
  });
}

function fixturePath(name) {
  return join(fixturesDir, name);
}

test('tools/list returns debug-script tool', async (t) => {
  const server = createServer();
  t.after(() => server.close());

  const tools = await server.listTools();
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], {
    name: 'debug-script',
    description:
      'Execute a Node.js command in debug mode, pause at a breakpoint, evaluate an expression, and return the value.',
    input_schema: {
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
    },
  });
});

test('debug-script evaluates expression at breakpoint', async (t) => {
  const server = createServer();
  t.after(() => server.close());

  const script = fixturePath('debug-success.js');
  const port = await getFreePort();

  const response = await server.callDebug({
    command: `node --inspect-brk=${port} ${JSON.stringify(script)}`,
    breakpoint: { file: script, line: 4 },
    expression: 'result.answer',
    timeout: 5000,
  });

  console.log('success response', response);

  assert.deepEqual(response, {
    result: {
      type: 'number',
      value: 42,
    },
  });
});

test('debug-script reports timeout when breakpoint not reached', async (t) => {
  const server = createServer();
  t.after(() => server.close());

  const script = fixturePath('debug-timeout.js');
  const port = await getFreePort();

  const response = await server.callDebug({
    command: `node --inspect-brk=${port} ${JSON.stringify(script)}`,
    breakpoint: { file: script, line: 3 },
    expression: 'globalThis.reached',
    timeout: 500,
  });

  assert.deepEqual(response, {
    error: 'Timeout waiting for breakpoint after 500ms',
  });
});

test('debug-script reports process exit before breakpoint', async (t) => {
  const server = createServer();
  t.after(() => server.close());

  const script = fixturePath('debug-exit.js');
  const port = await getFreePort();

  const response = await server.callDebug({
    command: `node --inspect-brk=${port} ${JSON.stringify(script)}`,
    breakpoint: { file: script, line: 1 },
    expression: 'true',
    timeout: 1000,
  });

  assert.deepEqual(response, {
    error: 'Process exited before breakpoint was hit',
  });
});
