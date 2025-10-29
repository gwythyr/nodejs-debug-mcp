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
}

export interface DebugScriptStructuredSuccess {
  results: EvaluationResult[];
}

export interface DebugScriptStructuredError {
  error: string;
}

export interface DebugScriptSuccess {
  content: ToolContent[];
  structuredContent: DebugScriptStructuredSuccess;
  isError?: false;
}

export interface DebugScriptError {
  content: ToolContent[];
  structuredContent: DebugScriptStructuredError;
  isError: true;
}

export type DebugScriptResponse = DebugScriptSuccess | DebugScriptError;
