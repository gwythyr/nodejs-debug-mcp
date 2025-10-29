# MCP Server for Script Debugging - Technical Specification

## Objective

Create a lightweight, standalone software package that functions as a simple MCP server. The server will communicate via stdio (standard input/output) and its primary purpose is to provide a single tool for on-demand script debugging and expression evaluation.

## Core Component: The debug-script Tool

The server will expose a single tool named `debug-script`. This tool is designed to perform a complete debug-and-evaluate cycle within a single, atomic request-response operation.

## Workflow

The `debug-script` tool will execute the following sequence of actions upon receiving a request:

1. **Launch Process**: Start the target script or process using the provided command, ensuring it is launched in debug mode
2. **Set Breakpoint**: Set a single breakpoint at the specified file and line number
3. **Run and Monitor**: Resume execution and listen for every pause triggered by the configured breakpoint
4. **Evaluate Expression**: On each pause, evaluate the provided expression within the current execution context and store the typed result
5. **Resume Execution**: Resume the target process after each evaluation and continue monitoring until the process exits or the timeout elapses
6. **Return Results**: Send the collected list of evaluation results back to the client via stdout once execution has completed

## API Specification

### Communication

The server operates exclusively over stdio. It implements the MCP (Model Context Protocol) for message formatting and tool invocation.

### Request Parameters

The `debug-script` tool accepts a request with the following four parameters:

```json
{
  "command": "node --inspect-brk=9229 test.js",
  "breakpoint": {
    "file": "src/file.js",
    "line": 42
  },
  "expression": "myVariable",
  "timeout": 30000
}
```

#### Parameters:

1. **command** (string, required): The full command-line instruction to execute the target Node.js process. The command MUST include the `--inspect-brk=<port>` flag to enable debugging and MUST launch a single-threaded Node.js execution (no worker threads, clustered processes, or additional inspectors).
   - Example: `node --inspect-brk=9229 ./test.js`
   - The port number will be extracted using regex: `--inspect-brk=(\d+)`

2. **breakpoint** (object, required): Defines where execution should pause
   - **file** (string): Path to the source file (relative or absolute). Relative paths will be resolved to absolute using `path.resolve()`
   - **line** (number): Line number within the file to set the breakpoint

3. **expression** (string, required): The code expression to evaluate when the breakpoint is hit
   - Will be wrapped in `JSON.stringify()` to capture full object data
   - Falls back to raw expression if JSON.stringify fails

4. **timeout** (number, required): Maximum time in milliseconds to wait for the breakpoint to be hit
   - Measured in milliseconds for precision
   - Example: `30000` for 30 seconds

### Response Format

#### Success Response

```json
{
  "content": [],
  "structuredContent": {
    "results": [
      {
        "type": "number",
        "value": 42
      },
      {
        "type": "number",
        "value": 43
      }
    ]
  }
}
```

- `content` (array): Optional list of MCP content blocks conveying human-readable context. Successful evaluations omit additional text by default.
- `structuredContent` (object): Structured output defined by the tool schema.
  - `results` (array): Each evaluation result includes:
    - **type** (string): JavaScript type of the evaluated expression at the breakpoint hit.
    - **value** (any): Actual value, parsed from JSON when possible.

#### Error Response

```json
{
  "content": [
    {
      "type": "text",
      "text": "Process exited before breakpoint was hit"
    }
  ],
  "structuredContent": {
    "error": "Process exited before breakpoint was hit"
  },
  "isError": true
}
```

- `content` provides human-readable context about the failure.
- `structuredContent.error` holds the machine-readable error message.
- `isError` (boolean) MUST be set to `true` for tool-level errors surfaced via `structuredContent`.

#### Error Cases

Only two error scenarios are handled:
1. **Timeout exceeded**: Breakpoint was not hit within the specified timeout period
2. **Process exit**: The Node process terminated before the breakpoint was hit

## Technical Implementation

### Technology Stack

- **Language**: TypeScript/Node.js
- **MCP Protocol**: `@modelcontextprotocol/sdk/server`
- **Debug Protocol**: Chrome DevTools Protocol (Inspector)
- **Debug Client**: `chrome-remote-interface`

### Target Runtime

This implementation specifically targets **Node.js** debugging only. The Chrome DevTools Protocol (Inspector) is used to communicate with Node.js processes launched with the `--inspect-brk` flag.

### Implementation Flow

1. **Parse Command**: Extract the debug port from the command string using regex `--inspect-brk=(\d+)`, default to `9229` if not found

2. **Spawn Process**:
   - Execute the command using Node's `spawn()`
   - Inherit current working directory (`process.cwd()`)
   - Inherit all environment variables (`process.env`)

3. **Connect to Inspector**:
   - Connect to Chrome DevTools Protocol on the extracted port
   - Wait for the WebSocket connection to establish

4. **Set Breakpoint**:
   - Normalize the breakpoint file path to absolute using `path.resolve()`
   - Call `Debugger.setBreakpointByUrl()` with the file path and line number

5. **Start Execution**:
   - Call `Runtime.runIfWaitingForDebugger()` to continue from the initial break
   - Begin a timeout timer that covers the entire debug session

6. **Wait for Events**:
   - Listen for `Debugger.paused` events (breakpoint hits)
   - Listen for process exit events and inspector disconnects

7. **Evaluate Expression**:
   - Try: `Runtime.evaluate({ expression: "JSON.stringify(${expression})" })`
   - If that fails, fallback to: `Runtime.evaluate({ expression })`
   - Parse the result to extract type and value
   - Append the typed result to an in-memory array
   - Call `Debugger.resume()` to continue execution

8. **Session Completion**:
   - Stop when the target process exits or the timeout elapses
   - Close the Inspector connection
   - Return the collected results

### Expression Evaluation Strategy

To handle JavaScript objects properly, expressions are wrapped in `JSON.stringify()`:

```typescript
// First attempt: Get full object structure
const wrappedExpr = `JSON.stringify(${expression})`;
let result = await Runtime.evaluate({ expression: wrappedExpr });

// Fallback: If stringify fails (circular refs, functions, etc.)
if (result.exceptionDetails) {
  result = await Runtime.evaluate({ expression });
}
```

This approach:
- Captures full object data for serializable objects
- Falls back gracefully for non-serializable values
- Works with primitives, arrays, and nested objects

## Scope and Constraints

### Minimalism is Key

The implementation should be as simple as possible. Avoid any complexity that is not essential to the described workflow.

### Happy Path Focus

The implementation focuses on the successful execution path. The following are explicitly OUT OF SCOPE:

- Complex error handling beyond the two specified error cases
- Interactive debugging features (step-over, step-in, continue)
- Multiple breakpoints
- Conditional breakpoints
- Watch expressions
- Call stack inspection
- Variable modification
- Support for languages other than Node.js
- Configuration files or complex setup
- Logging or verbose output
- Retry logic
- Connection pooling or reuse

### What IS in Scope

- Detecting timeout
- Detecting process exit before breakpoint
- Basic expression evaluation with object serialization
- Simple, atomic request-response cycle
- Clean process termination

## Project Structure

```
nodejs-debug-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # MCP server setup
│   ├── debug-tool.ts      # Main debug-script tool implementation
│   └── types.ts           # TypeScript interfaces
└── SPECIFICATION.md       # This document
```

## Dependencies

### Required npm packages:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "chrome-remote-interface": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  }
}
```

## Usage Example

### Starting the MCP Server

```bash
node dist/index.js
```

The server reads from stdin and writes to stdout, following the MCP protocol.

### Request Example

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "debug-script",
    "arguments": {
      "command": "node --inspect-brk=9229 ./dist/test.js",
      "breakpoint": {
        "file": "src/test.ts",
        "line": 15
      },
      "expression": "myLocalVariable",
      "timeout": 30000
    }
  }
}
```

### Success Response Example

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [],
    "structuredContent": {
      "results": [
        {
          "type": "object",
          "value": {
            "name": "John",
            "age": 30
          }
        },
        {
          "type": "string",
          "value": "done"
        }
      ]
    }
  }
}
```

### Error Response Example

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Timeout waiting for breakpoint after 30000ms"
      }
    ],
    "structuredContent": {
      "error": "Timeout waiting for breakpoint after 30000ms"
    },
    "isError": true
  }
}
```

## Implementation Notes

### Path Resolution

Both relative and absolute paths are accepted for the breakpoint file. Relative paths are resolved relative to the server's current working directory.

### Port Extraction

The debug port is extracted from the command string. If no port is specified or extraction fails, the default port `9229` is used.

### Process Lifecycle

The spawned Node process is allowed to exit naturally. The implementation only sends a termination signal if cleanup occurs while the process is still running.

### Environment Inheritance

The spawned process inherits all environment variables from the MCP server process. This ensures that tests have access to necessary configuration (NODE_ENV, PATH, etc.).

## Success Criteria

The implementation is considered complete when:

1. The MCP server correctly implements the stdio protocol
2. The `debug-script` tool is registered and callable
3. Node.js processes can be spawned with debug flags
4. Breakpoints can be set and hit successfully
5. Expressions are evaluated on each breakpoint hit and returned with type information in order
6. Processes are allowed to finish execution unless cleanup requires termination
7. Timeout and process-exit errors are detected and reported
8. The codebase is minimal and focused on the happy path
