const result = { answer: 42 };

setTimeout(() => {
  const message = 'ready';
  globalThis.__debugMessage = message;
  console.log(result, message);
}, 10);

setTimeout(() => {}, 5000);
