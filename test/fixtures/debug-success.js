const result = { answer: 42 };
globalThis.__debugResult = result;

setTimeout(() => {
  const message = 'ready';
  globalThis.__debugMessage = message;
  void 0;
}, 10);

setTimeout(() => {}, 50);
