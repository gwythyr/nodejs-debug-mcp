declare module 'chrome-remote-interface' {
  export type ChromeDebugger = {
    enable(): Promise<void>;
    on(event: 'paused', handler: (event: any) => void | Promise<void>): () => void;
    setBreakpointByUrl(
      args: Record<string, unknown>,
    ): Promise<{ breakpointId: string; actualLocation?: Record<string, unknown> }>;
    resume(): Promise<void>;
    evaluateOnCallFrame(args: Record<string, unknown>): Promise<any>;
  };

  export type ChromeRuntime = {
    enable(): Promise<void>;
    runIfWaitingForDebugger(): Promise<void>;
  };

  type EventListener = (...args: unknown[]) => void;

  export type Client = {
    Debugger: ChromeDebugger;
    Runtime: ChromeRuntime;
    close(): Promise<void>;
    on(event: 'disconnect', listener: () => void): Client;
    on(event: 'Runtime.executionContextDestroyed', listener: (event: unknown) => void): Client;
    on(event: string, listener: EventListener): Client;
    removeListener(event: 'disconnect', listener: () => void): Client;
    removeListener(event: 'Runtime.executionContextDestroyed', listener: (event: unknown) => void): Client;
    removeListener(event: string, listener: EventListener): Client;
  };

  export type Options = {
    host?: string;
    port?: number;
  };

  export default function CDP(options?: Options): Promise<Client>;
}
