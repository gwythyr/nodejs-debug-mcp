import { z } from 'zod';

export const breakpointLocationSchema = z.object({
  file: z.string().describe('Use relative path from working directory for token efficiency'),
  line: z.number(),
});

export type BreakpointLocation = z.infer<typeof breakpointLocationSchema>;

export const runtimeSchema = z.enum(['node', 'python']);
export type Runtime = z.infer<typeof runtimeSchema>;

export const debugScriptInputSchema = z.object({
  command: z.string().describe(
    'Node.js: "node --inspect-brk=<port> script.js". ' +
    'Python: "python3 -m debugpy --listen 127.0.0.1:<port> --wait-for-client script.py". '
  ),
  breakpoint: breakpointLocationSchema.describe(
    'Breakpoint pauses BEFORE executing the line. To inspect a variable, set breakpoint AFTER its assignment.'
  ),
  expression: z.string(),
  timeout: z.number(),
  includeStack: z.boolean().optional(),
  runtime: runtimeSchema.optional().default('node'),
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
