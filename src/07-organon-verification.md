---
title: "Organon: Verification"
date: "2026-03-17T00:00:00.000Z"
slug: "organon-verification"
description: "Verifying LLM-generated code through property-based testing, model-based testing, and fault injection."
draft: true
---

# Organon: Verification

> Part 7 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

LLM-generated code that compiles and type-checks is not necessarily correct.

The structural guarantees from Posts 1–5 eliminate entire classes of bug: skipped validation, forgotten error cases, protocol violations, hidden side effects. The type system catches these at compile time. But types can't guarantee behavioral correctness. They can't tell you that the bounded loop actually terminates. That budget limits are enforced. That every error variant reaches a defined recovery state. That the tool dispatcher returns the right result for the right tool.

The structural constraints narrow the bug surface. Verification audits what remains.

This post covers three testing strategies. Each targets a specific architectural layer. Each is derived from or checked against the definitions from Post 6. The tests don't exist independently of the architecture — they're consequences of it.

## Strategy 1: Property-Based Testing (fast-check)

### What it targets: Parse boundaries (Post 1)

Property-based testing generates thousands of random inputs and checks that invariants hold for all of them. It doesn't test specific examples — it tests properties. "For all possible inputs, the parser either produces a valid typed value or rejects with a specific tagged error. No third outcome."

This strategy exists to hammer the parse boundaries from Post 1. The schema defines what's valid. Property tests verify that the decoder actually enforces it — across a space of inputs far larger than any human would write by hand.

### The Properties

**LLM response parsing.** Generate random payloads: valid JSON with correct structure, valid JSON with wrong structure, malformed JSON, missing fields, extra fields, hallucinated tool names, tool call arguments that don't match any schema.

Property: `Schema.decodeUnknownEither(LLMResponseSchema)(payload)` is either a `Right<LLMResponse>` (a valid typed union member) or a `Left<ParseError>` (a structured rejection). No exception. No partial decode. No malformed response reaching the tool dispatcher.

```ts
fc.assert(
  fc.property(arbitraryLLMPayload, (payload) => {
    const result = Schema.decodeUnknownEither(LLMResponseSchema)(payload);
    return Either.isRight(result) || Either.isLeft(result);
    // tautological on its own — the real assertions check:
    // - Right values satisfy the LLMResponse discriminated union
    // - Left values are ParseError with meaningful path info
    // - no side effects occur during parsing
  })
);
```

The interesting part is the *generator*. `arbitraryLLMPayload` generates inputs that are plausible — structurally similar to real LLM responses but with targeted corruptions. A tool call where `arguments` is a string instead of an object. A response with `_tag: "toolCall"` but missing `name`. Valid JSON wrapping garbage. The generator is informed by the schema — it knows the valid shape and systematically deforms it.

**Tool result parsing.** Same pattern per tool. Generate random outputs, verify decode-or-reject. A tool result with extra fields is accepted (schemas are permissive on extra fields by default). A tool result with missing required fields is rejected. A tool result with wrong types is rejected.

**Conversation sequences.** Generate random sequences of conversation operations: `addUserMessage`, `addToolCall`, `addToolResult`, `addAssistantText`. Property: the typestate invariant holds — `callLLM` is never invoked with a `Conversation<"toolCall">`. The generator produces *sequences of operations*, not individual messages, because the bug is in the ordering.

**Configuration.** Generate random config files: missing fields, contradictory settings (textExtractor enabled but no extraction model), invalid values (negative timeouts, zero budget limits). Property: the config loader either produces a valid `OrgConfig` or rejects with a precise error naming the specific problem.

### Counterexamples

Every property failure produces a minimal counterexample. fast-check shrinks the failing input to the smallest case that still fails.

"For all LLM payloads, the parser decodes or rejects" fails on:

```ts
{ _tag: "toolCall", name: "webFetch", arguments: null }
```

The counterexample is specific: `arguments` is `null` instead of an object. The schema expected `Schema.Unknown` (which accepts `null`), but the tool's argument schema expected a struct. The bug is in the boundary between the response schema (which accepts the payload) and the tool's argument schema (which doesn't). The fix: tighten the response schema or add explicit null-checking at the tool dispatch boundary.

The counterexample is structured, actionable feedback. Not "the test failed" but "here's the minimal input that broke the property, here's which boundary it crossed, here's what went wrong."

## Strategy 2: Model-Based Testing (XState)

### What it targets: The state machine (Post 4)

Model-based testing generates test paths from the machine definition and walks every reachable state. The machine is the source of truth — the tests are derived from it.

XState's model-based testing tooling generates paths: sequences of events that visit every state and exercise every transition. Each path is a test case.

### The Paths

**Happy path.** `idle → [START] → planning → [CALL_LLM] → executing.callLLM → [LLM_TOOL_CALL] → executing.executeTool → [TOOL_SUCCESS] → executing.callLLM → [LLM_TEXT] → evaluating → [COMPLETE] → complete`.

Assert: the conversation at each stage is in the expected typestate. Assert: each event carries valid data for its transition. Assert: the final state is `complete` with a result.

**Bounded loop termination.** Configure `maxToolCalls: 3`. Walk the tool-call loop three times. On the fourth `TOOL_SUCCESS`, assert: the machine transitions to `evaluating` instead of `callLLM`. The guard `withinLoopBound` rejects the transition.

Assert: this holds regardless of the specific tool calls or results. The bound is structural.

**Budget interrupts.** Set `maxTokens: 100`. Generate enough LLM calls to exceed the limit. Assert: the budget tracker emits `BUDGET_EXCEEDED`. Assert: the main machine transitions to graceful shutdown. Assert: partial results are available.

Repeat for call count and wall-clock time.

**Error recovery.** For each tagged error variant, generate a path that triggers it and assert the correct recovery:

- `LLMParseFailure` → retry via planner (up to limit) → fail if retries exhausted
- `ToolNotFound` → inform LLM of available tools → retry
- `ToolSchemaViolation` → send schema error to LLM → retry
- `ToolTimeout` → retry or skip per config
- `ToolExecutionError` → report to LLM → replan
- `BudgetExhausted` → graceful shutdown
- `RateLimited` → back off → retry

Each path is generated from the machine. Each assertion checks that the tagged error reaches its defined recovery state.

**Specification gaps.** The generated code emits an event the machine doesn't handle. XState absorbs it silently — safe behavior, no crash. But the model-based test flags it: an event was sent that produced no transition. This is a specification gap. The machine definition is incomplete — either the event shouldn't be emitted (bug in the code) or the machine should handle it (gap in the spec).

## Strategy 3: Fault Injection

### What it targets: The error model (Post 2)

Fault injection triggers every tagged error variant deliberately. The goal: verify that each error is handled, reaches the correct state, and produces the correct recovery behavior.

### The Injections

**`ToolTimeout`:** Provide a tool implementation that never resolves. The tool dispatcher's timeout fires. Assert: `ToolTimeout` is produced with the correct elapsed time. Assert: the machine transitions to the recovery state.

**`ToolSchemaViolation`:** Provide a tool that returns data not matching its output schema. Assert: the parse boundary catches it. Assert: `ToolSchemaViolation` is produced with the specific schema violations.

**`BudgetExhausted`:** Set budget limits to zero. Assert: the harness starts, recognizes the budget is already exhausted, and transitions to graceful shutdown. Assert: no tool execution occurs.

**`ToolNotFound`:** Construct a `ToolCallRequest` for a tool not in the capability set. Assert: `ToolNotFound` is produced with the requested name and the list of available tools.

**`RateLimited`:** Provide a mock LLM API that returns 429 with a retry-after header. Assert: `RateLimited` is produced. Assert: the harness backs off for the specified duration. Assert: it retries after the backoff.

**`ToolExecutionError`:** Provide a tool that throws an `Error`. Assert: the raw error is wrapped in `ToolExecutionError`. Assert: the raw exception does *not* propagate unhandled.

### Contract Violations

The most interesting fault injection test is the one that catches a contract violation: generated code throws a raw `Error("connection reset")` instead of returning a `ToolExecutionError`.

The Effect runtime surfaces this as an *untagged defect* — a type-level contract violation. The error channel declared `ToolExecutionError`, but an untagged `Error` escaped. Effect distinguishes between expected errors (the tagged union) and unexpected defects (things that shouldn't happen).

The fix: wrap the raw error in the tagged class, routing it into the typed error channel. The test verifies that after the fix, the same raw `Error` is caught and wrapped. The harness never surfaces untagged defects to the agent.

## The Punchline

Each strategy targets a different layer:

- **Property tests** audit the parse boundaries. "For all inputs, the decoder either produces a valid value or rejects with a typed error."
- **Model-based tests** audit the state machine. "Every reachable state is visited, every transition is valid, every path terminates correctly."
- **Fault injection** audits the error model. "Every tagged error variant is handled, reaches the correct recovery state, and produces the correct behavior."

Every failure is legible. It traces to a specific definition and a specific contract:

- A property test failure traces to a schema (Post 1).
- A model-based test failure traces to the machine definition (Post 4).
- A fault injection failure traces to the error model (Post 2).

Contrast with a typical agent harness where a failure surfaces as "the agent did something weird." Debugging means reading conversation logs, reconstructing state in your head, and guessing which of several hundred lines of loosely typed code misbehaved.

In Organon, the failure tells you where to look. The definitions tell you what's correct. The fix is mechanical.

## The Fix Cycle

The LLM receives a failure:

- A minimal counterexample from a property test: "this payload decoded when it shouldn't have."
- An unreachable state from model-based testing: "the `retrying` state was never entered."
- An unhandled error tag from fault injection: "raw `Error` escaped instead of `ToolExecutionError`."

Each failure points to a specific definition. The LLM generates a corrected implementation against the same constraints that produced the original. The constraints haven't changed — only the implementation within them.

The fix cycle is mechanical because the architecture makes diagnosis and repair separable from understanding the whole system. The LLM doesn't need to comprehend the full harness to fix a schema boundary. It needs the schema, the failing input, and the expected behavior. The constraints provide the context.

## Demo: XState Inspector

[Interactive statechart — third appearance]

Model-based test paths visualized on the machine. The reader watches the test walker traverse states:

- Green highlights: states and transitions that have been exercised by the test suite.
- Red highlights: states that should be reachable but weren't reached (specification gaps).
- Animated path walk: the happy path plays through, then the bounded loop termination, then an error recovery path.

The reader sees the test suite's coverage mapped directly onto the machine definition. The visualization answers "how much of the spec is tested?" without requiring the reader to mentally map test names to machine states.

---

## Series Conclusion

The series thesis: **define once, derive everything.**

A schema defines valid data. The type, the decoder, and the error reporting are derived from it (Post 1). A union defines valid states. Exhaustive matching requirements are derived from it (Post 2). A typestate protocol defines valid transitions. The API surface at each state is derived from it (Post 3). A machine definition derives runtime behavior, types, documentation, and test paths (Post 4). Capability interfaces and effect signatures define what code can do. The compiler enforces the boundaries (Post 5).

For LLMs generating code against these definitions, the consequence is direct: the fewer independent artifacts to reconcile, the more likely the output is correct. When there is one source of truth and multiple enforcement layers derived from it, the LLM operates in a tightly constrained space. Most mistakes are structural failures — caught by the compiler, the runtime, or the test suite — rather than silent semantic errors.

Organon is a demonstration. The same principles apply to any system where an LLM generates code: define the constraints first, derive everything from them, and let the structure do the work that humans and LLMs will inevitably fail to do by hand.
