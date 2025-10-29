const result = { answer: 42 };

setTimeout(() => {
  const message = 'ready';
  globalThis.__debugMessage = message;
}, 10);

setTimeout(() => {}, 50);
