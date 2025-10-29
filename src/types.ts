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

export interface EvaluationResult {
  type: string;
  value: unknown;
}

export interface ToolContent {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface DebugScriptStructuredSuccess {
  results: EvaluationResult[];
  [key: string]: unknown;
}

export interface DebugScriptStructuredError {
  error: string;
  [key: string]: unknown;
}

export interface DebugScriptSuccess {
  content: ToolContent[];
  structuredContent: DebugScriptStructuredSuccess;
  isError?: false;
  [key: string]: unknown;
}

export interface DebugScriptError {
  content: ToolContent[];
  structuredContent: DebugScriptStructuredError;
  isError: true;
  [key: string]: unknown;
}

export type DebugScriptResponse = DebugScriptSuccess | DebugScriptError;
