---
title: "Organon: Specification and Generation"
date: "2026-03-17T00:00:00.000Z"
slug: "organon-specification-and-generation"
description: "Assembling the Organon agent harness by combining all structural guardrail patterns into a specification-driven code generation pipeline."
draft: true
---

# Organon: Specification and Generation

> Part 6 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

The typical agent tool-use harness is a bag of strings and hope.

Conversation history is `Array<any>`. Tool dispatch is a `switch` on a string name, with `default: throw new Error("unknown tool")`. Error handling is `catch(() => "something went wrong")`. The LLM produces subtly malformed tool calls and they silently corrupt state. Debugging means reading conversation logs and guessing where things went sideways.

This series has been building an alternative. This post assembles the pieces into a specification and generates an implementation against it — showing concretely that structural constraints reduce the review surface to a narrow band.

## The Specification

Over five posts, we've defined every component of Organon's behavioral contract. Each definition is an authoritative source of truth from which downstream artifacts are derived:

| Component | Constraint Source | Key Definition |
|-----------|-----------------|----------------|
| Parse boundaries | Post 1 | Effect Schemas for config, LLM responses, tool results |
| Error model | Post 2 | Tagged error union with recovery semantics |
| Conversation protocol | Post 3 | Typestate accumulator (`Conversation<S>`) |
| Agent lifecycle | Post 4 | XState machine with bounded loops |
| Tool capabilities | Post 5 | Narrow interfaces via Layers |

Together, these definitions form a specification. Each component's type signature, capability interface, and error channel are already defined. What remains is implementation — and the specification constrains it tightly.

### Test Invariants

Properties that must hold across all executions:

- The conversation never contains a tool call without a corresponding tool result before the next LLM call.
- Budget limits are never exceeded by more than one operation (the operation that crosses the threshold completes, then the harness stops).
- Every error variant reaches a defined recovery or terminal state.
- Tool execution never occurs outside the `executing` state.
- A function with `never` in its requirements position never triggers an effect.
- Every tool call's arguments are validated against the tool's input schema before execution.

## The Mold

The spec is so constraining that implementation is nearly determined. Consider the tool dispatcher. Here is the type signature the LLM receives:

```ts
function dispatchTool(
  call: ToolCallRequest,
  tools: ToolRegistry,
): Effect<
  ToolSuccess,
  ToolNotFound | ToolSchemaViolation | ToolTimeout | ToolExecutionError,
  ToolExecution
> {
  // ...
}
```

Every constraint is visible in this signature:

- **Input:** `ToolCallRequest` — already parsed from the LLM response schema (Post 1). The tool name and arguments are typed, not `string` and `unknown`.
- **Tool lookup:** `ToolRegistry` — the capability set narrowed by Layer assembly (Post 5). Only tools provided at startup exist. No ambient imports.
- **Argument validation:** Each tool's input schema (Post 1) must be satisfied before execution. The dispatcher decodes `call.arguments` against the specific tool's `InputSchema`.
- **Execution:** Via the capability interface (Post 5), not via direct imports. The dispatcher calls `tool.execute(validatedArgs)`.
- **Result decoding:** The tool's output is decoded against its `OutputSchema` (Post 1). Malformed output is caught at the boundary.
- **Error channel:** Exactly four tagged errors (Post 2). The caller must handle each. No generic `catch`, no `Error` base class.
- **Effect:** `ToolExecution` (Post 5). The dispatcher can dispatch tools and nothing else. No LLM calls, no filesystem access, no network I/O beyond what the tool's own capability provides.
- **State guard:** The dispatcher can only run when the machine is in `executing.executeTool` (Post 4).

The implementation space is narrow. Most of the decisions have been made by the specification. The LLM is filling in a mold, not designing from scratch.

## Generation in Practice

Let's see this concretely. We'll generate the tool dispatcher — the component with the most constraint surfaces — and watch what happens.

### The Prompt

The LLM receives the type signature above, plus:

```ts
// The tool registry type
type ToolRegistry = ReadonlyMap<string, {
  readonly inputSchema: Schema.Schema<unknown>;
  readonly outputSchema: Schema.Schema<unknown>;
  readonly execute: (args: unknown) => Effect<unknown, ToolExecutionError, ToolExecution>;
}>;

// The tagged error types it must use
class ToolNotFound extends Data.TaggedError("ToolNotFound")<{
  readonly requestedTool: string;
  readonly available: ReadonlyArray<string>;
}> {}

class ToolSchemaViolation extends Data.TaggedError("ToolSchemaViolation")<{
  readonly tool: string;
  readonly violations: ReadonlyArray<string>;
}> {}

class ToolTimeout extends Data.TaggedError("ToolTimeout")<{
  readonly tool: string;
  readonly elapsed: number;
}> {}

class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly tool: string;
  readonly message: string;
}> {}

// The success type
class ToolSuccess extends Data.TaggedClass("ToolSuccess")<{
  readonly tool: string;
  readonly result: unknown;
}> {}
```

The instruction: "Implement `dispatchTool` with this signature. Look up the tool, validate arguments against the tool's input schema, execute via the capability interface, decode the result against the output schema. Use Effect's pipe and generator syntax."

### First Attempt

The LLM generates:

```ts
function dispatchTool(
  call: ToolCallRequest,
  tools: ToolRegistry,
): Effect<
  ToolSuccess,
  ToolNotFound | ToolSchemaViolation | ToolTimeout | ToolExecutionError,
  ToolExecution
> {
  return Effect.gen(function* () {
    // Look up the tool
    const tool = tools.get(call.name);
    if (!tool) {
      return yield* new ToolNotFound({
        requestedTool: call.name,
        available: Array.from(tools.keys()),
      });
    }

    // Validate arguments
    const decoded = yield* Schema.decodeUnknown(tool.inputSchema)(call.arguments).pipe(
      Effect.mapError((parseError) =>
        new ToolSchemaViolation({
          tool: call.name,
          violations: [parseError.message],
        })
      ),
    );

    // Execute
    const rawResult = yield* tool.execute(decoded).pipe(
      Effect.timeoutFail({
        duration: "30 seconds",
        onTimeout: () => new ToolTimeout({ tool: call.name, elapsed: 30000 }),
      }),
    );

    // Decode result
    const result = yield* Schema.decodeUnknown(tool.outputSchema)(rawResult).pipe(
      Effect.mapError((parseError) =>
        new ToolSchemaViolation({
          tool: call.name,
          violations: [parseError.message],
        })
      ),
    );

    return new ToolSuccess({ tool: call.name, result });
  });
}
```

This is a reasonable first attempt. The structure is right — lookup, validate, execute, decode. But the constraints catch problems the LLM didn't anticipate.

### What the Compiler Caught

**Error type mismatch on `Schema.decodeUnknown`.** The `mapError` maps `ParseError` to `ToolSchemaViolation`, but `parseError.message` doesn't exist on Effect's `ParseError`. The actual API is `TreeFormatter.formatError(parseError)` or accessing `parseError.issue`. The compiler flags this: `Property 'message' does not exist on type 'ParseError'`.

**`Effect.timeoutFail` signature.** The `duration` parameter is `Duration.DurationInput`, not a string. The correct form is `Duration.seconds(30)` or `"30 seconds"` is valid — but `onTimeout` must return the error type, and the generated code returns it in a context where the error channel doesn't unify correctly. The compiler catches the union mismatch.

**Return type of `yield*` on an error.** `yield* new ToolNotFound(...)` doesn't work as a return — `yield*` with a `TaggedError` produces `never` (it short-circuits), so the `return` is unreachable. The compiler warns about unreachable code. The fix: drop the `return`.

Three compiler errors. Each traces to a specific constraint:
1. The `ParseError` API — enforced by Effect's type definitions
2. The `Duration` type — enforced by Effect's `timeoutFail` signature
3. The error channel flow — enforced by `Effect.gen`'s yield semantics

### What the Tests Caught

After fixing the compiler errors, the property tests run. Two failures:

**Property: "for all tool calls with valid arguments, dispatch succeeds or produces a tagged error."** Counterexample: a tool whose `execute` throws a raw `Error("ECONNRESET")` instead of returning a `ToolExecutionError`. The property test generates a tool implementation that throws, and the dispatcher doesn't catch it. The raw `Error` escapes as an *untagged defect* — it's not in the error channel.

The fix: wrap the `tool.execute` call in `Effect.catchAllDefect`:

```ts
const rawResult = yield* tool.execute(decoded).pipe(
  Effect.catchAllDefect((defect) =>
    Effect.fail(new ToolExecutionError({
      tool: call.name,
      message: defect instanceof Error ? defect.message : String(defect),
    }))
  ),
  Effect.timeoutFail({
    duration: Duration.seconds(30),
    onTimeout: () => new ToolTimeout({ tool: call.name, elapsed: 30000 }),
  }),
);
```

**Property: "for all tool calls to nonexistent tools, ToolNotFound.available lists exactly the registered tools."** Counterexample: an empty registry. `Array.from(tools.keys())` returns `[]`, which is correct — but the test asserts that `available` is a `ReadonlyArray<string>`, and the generated code produces `string[]`. This is a variance issue that the property test catches but the compiler doesn't (arrays are covariant in TypeScript). The fix is cosmetic but the test enforces the contract.

Two test failures. Each traces to a specific invariant:
1. "Every execution error is wrapped in a tagged type" — the error model from Post 2
2. "Error context matches the actual state" — the recovery semantics from Post 2

### What's Left to Review

After the compiler and tests pass, the review surface is small:

1. **Timeout configuration.** The dispatcher hardcodes `30 seconds`. Should this come from the tool's config? The spec doesn't specify — this is a genuine design decision.

2. **Schema violation formatting.** The dispatcher maps `ParseError` to a single string in `violations`. Should it produce structured violation paths instead? The tagged error type allows `ReadonlyArray<string>` — the formatting choice is unconstrained.

3. **Execution order.** The dispatcher validates arguments before checking the timeout. Should the timeout wrap the entire operation including validation? The spec doesn't constrain this — it's a latency tradeoff.

Three review items. Each is a genuine design decision that the spec intentionally left open. Everything else — the lookup, the error types, the capability boundary, the effect signature, the parse boundaries — was forced by the specification.

This is the series' core claim made concrete: **structural constraints reduce code review from "is this correct?" to "are these three design choices appropriate?"** The compiler eliminated structural bugs. The tests eliminated behavioral bugs. What remains is the narrow surface where human judgment actually matters.

## Scaling

Here's Organon configured for web research:

```ts
const researchConfig = {
  tools: { webFetcher: { timeout: 10000, allowedDomains: ["*.gov", "*.edu"] }, textExtractor: { model: "..." }, calculator: {} },
  llm: { model: "...", maxTokens: 4096 },
  budget: { maxTokens: 100000, maxCalls: 50, maxTime: 300000 },
};
```

Here it is configured for local file processing:

```ts
const fileProcessingConfig = {
  tools: { fileWriter: { basePath: "./output", maxSize: 1048576 }, calculator: {} },
  llm: { model: "...", maxTokens: 2048 },
  budget: { maxTokens: 50000, maxCalls: 20, maxTime: 120000 },
};
```

Same machine. Same error model. Same typestate protocol. Same conversation accumulator. Same budget tracker. Different tools, different schemas, different capabilities. Nothing about the harness moved.

### XState Inspector

[Interactive statechart — second appearance]

The full Organon machine: lifecycle, execution sub-machine, parallel budget tracker. Richer than the Post 4 version — the reader now understands every component. Walk through a complete agent run: idle → planning → executing → tool loop → evaluating → complete. Trigger interrupts. Watch error recovery. The machine is the spec, and the inspector is the spec made interactive.

---

*Next: [Organon: Verification](/organon-verification) — property-based testing, model-based testing, and fault injection — each targeting a different architectural layer, each derived from the same definitions.*
