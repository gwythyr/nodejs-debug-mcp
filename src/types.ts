import { z } from 'zod';

export const breakpointLocationSchema = z.object({
  file: z.string(),
  line: z.number(),
});

export type BreakpointLocation = z.infer<typeof breakpointLocationSchema>;

export const debugScriptInputSchema = z.object({
  command: z.string(),
  breakpoint: breakpointLocationSchema,
  expression: z.string(),
  timeout: z.number(),
  includeStack: z.boolean().optional(),
});

export type DebugScriptArguments = z.infer<typeof debugScriptInputSchema>;

export interface EvaluationResult {
  type: string;
  value: unknown;
  stack?: StackFrame[];
}

export interface StackFrame {
  function?: string;
  file?: string;
  line?: number;
  column?: number;
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
