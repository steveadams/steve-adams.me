---
title: "Making Illegal States Unrepresentable"
date: "2026-03-17T00:00:00.000Z"
slug: "making-illegal-states-unrepresentable"
description: "Using discriminated unions and exhaustive matching to eliminate entire categories of bugs at compile time."
draft: true
---

# Making Illegal States Unrepresentable

> Part 2 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

A tool executes and returns a result. What shape is that result? Here's a common approach:

```ts
type ToolResult = {
  ok: boolean;
  data?: string;
  error?: string;
  timedOut?: boolean;
};
```

Quick — which combinations are legal? Can `ok` be `true` with `error` set? Can `timedOut` be `true` with `data` present? Can all three optional fields be absent? The type permits every combination. The rules are implicit, encoded in `if/else` chains scattered through handlers:

```ts
function handleResult(result: ToolResult) {
  if (result.ok && result.data) {
    // success path
  } else if (result.timedOut) {
    // timeout path
  } else if (result.error) {
    // error path
  }
  // what if none of these match?
  // what if ok is true but data is missing?
  // silence.
}
```

An LLM writing a new handler generates something that looks like this. It covers the cases it can infer from context. It misses one — maybe the case where `ok` is `false` but `error` is also absent (a tool that failed without producing an error message). The code compiles. The missed case falls through silently. You find out in production.

Now scale this up. Organon's harness has multiple failure modes: the LLM returned garbage, the tool wasn't found, the tool's arguments didn't match its schema, the tool timed out, the tool ran but failed, the budget was exhausted. Each has a different recovery path. If these are represented as a bag of optional fields on a generic error object, every handler must independently reconstruct which failure mode it's dealing with. Every handler is a place for a bug. Every new failure mode is a silent regression in every existing handler.

## The Pattern

Discriminated unions make the valid states explicit. Each variant is a distinct type carrying exactly the data relevant to that case. A discriminant field (the tag) identifies which variant you're holding. Exhaustive matching forces every code path to handle every variant — and the compiler enforces it.

```ts
type ToolResult =
  | { readonly _tag: "Success"; readonly data: string }
  | { readonly _tag: "Timeout"; readonly elapsed: number }
  | { readonly _tag: "ExecutionError"; readonly message: string; readonly cause?: unknown };
```

No illegal combinations. `Success` always has `data`. `Timeout` always has `elapsed`. `ExecutionError` always has `message`. You can't construct a `Success` with an `error` field — the type doesn't have one.

Exhaustive matching via `switch` + `never`:

```ts
function handleResult(result: ToolResult): Recovery {
  switch (result._tag) {
    case "Success":
      return processData(result.data);
    case "Timeout":
      return retryOrSkip(result.elapsed);
    case "ExecutionError":
      return reportToLLM(result.message);
    default:
      // If a variant is unhandled, result is not `never`, and this is a compile error
      const _exhaustive: never = result;
      return _exhaustive;
  }
}
```

If you add a new variant to `ToolResult`, every `switch` that doesn't handle it fails to compile. The new case can't be silently ignored — the compiler forces you to decide what to do with it.

## Organon's Error Model

Organon's harness needs a richer error model than `ToolResult`. The agent lifecycle has multiple failure points, each with different recovery semantics. Plain TypeScript discriminated unions handle this cleanly — but Effect's `Data.TaggedError` adds something: each error class carries its `_tag` discriminant by construction. It's intrinsic to the definition, not a convention someone can forget.

### Plain TypeScript First

The union, using pure TS:

```ts
type HarnessError =
  | { readonly _tag: "LLMParseFailure"; readonly raw: string; readonly parseError: string }
  | { readonly _tag: "ToolNotFound"; readonly requestedTool: string; readonly available: string[] }
  | { readonly _tag: "ToolSchemaViolation"; readonly tool: string; readonly violations: string[] }
  | { readonly _tag: "ToolTimeout"; readonly tool: string; readonly elapsed: number }
  | { readonly _tag: "ToolExecutionError"; readonly tool: string; readonly message: string }
  | { readonly _tag: "BudgetExhausted"; readonly dimension: "tokens" | "calls" | "time"; readonly limit: number; readonly used: number };
```

This works. Every handler must match all six variants. The compiler enforces it.

### Effect's TaggedError — the Mature Version

```ts
import { Data } from "effect";

class LLMParseFailure extends Data.TaggedError("LLMParseFailure")<{
  readonly raw: string;
  readonly parseError: string;
}> {}

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

class BudgetExhausted extends Data.TaggedError("BudgetExhausted")<{
  readonly dimension: "tokens" | "calls" | "time";
  readonly limit: number;
  readonly used: number;
}> {}
```

The `_tag` is part of the class definition. You can't construct a `ToolNotFound` without it being tagged — it's not a convention you remember to follow, it's a structural fact about the class.

Applied to Effect's error channel, this means a function's type signature declares exactly which errors it can produce:

```ts
type ToolDispatch = Effect<ToolSuccess, ToolNotFound | ToolSchemaViolation | ToolTimeout | ToolExecutionError, ToolExecution>;
```

The caller must handle each variant. `.catch(() => null)` on a tagged error union is a type error — the error channel demands explicit handling of each case.

Each error carries the data needed for recovery:

- `LLMParseFailure` carries the raw response — the recovery path can send it back to the LLM with "this didn't parse, try again."
- `ToolNotFound` carries the available tools — the recovery can tell the LLM "you asked for X, available tools are [Y, Z]."
- `BudgetExhausted` carries which dimension was exceeded and by how much — the recovery can report partial results with an explanation.

The recovery path is informed by the error variant. Not "something went wrong" but "this specific thing went wrong, here's the context, here's what to do about it."

## Before and After

**Before — generic error handling:**

```ts
async function dispatchTool(call: ToolCall): Promise<string> {
  try {
    const tool = tools[call.name];
    if (!tool) return "Tool not found";
    const result = await tool.execute(call.arguments);
    return JSON.stringify(result);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
```

An LLM generates this. It handles the happy path and has a generic catch. It works for a while. Then:

- Budget tracking is added. Nothing in this function accounts for it — the budget is exhausted silently.
- Schema validation for tool arguments is added. This function doesn't check schemas — malformed arguments reach the tool.
- Rate limiting is needed. Nothing here knows about it.

Each addition requires finding and modifying this function (and every other handler) by hand. The LLM that wrote it has moved on. The next developer — or the next LLM invocation — doesn't know what's missing.

**After — tagged error union:**

```ts
function dispatchTool(
  call: ToolCallRequest
): Effect<ToolSuccess, ToolNotFound | ToolSchemaViolation | ToolTimeout | ToolExecutionError, ToolExecution> {
  // Every failure mode is a specific tagged error
  // The return type declares exactly what can go wrong
  // The caller must handle each variant
}
```

An LLM writing a caller for `dispatchTool` sees the error channel in the type. It can't ignore `ToolTimeout` — the compiler won't let it. The error model is the type signature. Reading the function is reading the contract.

## Scaling

You realize you need `RateLimited` in the error channel. Rate limiting wasn't part of the original design, but the LLM API started returning 429s in production.

You add the variant:

```ts
class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfter: number;
  readonly endpoint: string;
}> {}
```

And add it to the relevant function signatures.

The compiler reports errors. Every handler that doesn't account for rate limiting is flagged. Concretely:

- `src/harness/orchestrator.ts` — the main loop's error handler
- `src/harness/orchestrator.ts` — the retry logic
- `src/tools/dispatcher.ts` — the tool dispatch error mapper
- `src/tools/llm-caller.ts` — the LLM call wrapper
- `test/harness/orchestrator.test.ts` — the orchestrator test's error assertions
- `test/tools/dispatcher.test.ts` — the dispatcher test's error assertions

Six errors. Four files. Each one tells you exactly what to update.

Without the union: you grep for `catch` blocks. You find five call sites that need updating. The sixth — in a test helper that catches errors and returns a default value — doesn't match the grep pattern. It silently swallows `RateLimited` errors. Tests pass. The bug reaches production. You find it three weeks later when the agent enters an infinite retry loop against a rate-limited API.

The "skips validation" region from Post 1 is already gone. Now highlight programs that forget error cases, silently swallow failures, catch generic `Error` instead of specific variants, or have handlers that don't account for all failure modes. Apply the "illegal states" constraint — that region disappears. The valid space visibly shrinks. Two classes of bug are now structurally eliminated.

---

*Next: [Encoding Protocols in State](/encoding-protocols-in-state) — building Organon's conversation accumulator, where calling methods in the wrong order is a compile error.*
