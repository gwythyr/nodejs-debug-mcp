export interface BreakpointLocation {
  file: string;
  line: number;
}

export interface DebugScriptArguments {
  command: string;
  breakpoint: BreakpointLocation;
  expression: string;
  timeout: number;
}

export interface DebugScriptSuccess {
  result: {
    type: string;
    value: unknown;
  };
}

export interface DebugScriptError {
  error: string;
}

export type DebugScriptResponse = DebugScriptSuccess | DebugScriptError;
