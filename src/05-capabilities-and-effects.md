---
title: "Capabilities and Effects"
date: "2026-03-17T00:00:00.000Z"
slug: "capabilities-and-effects"
description: "Controlling what code can do by passing capabilities explicitly and tracking effects at the type level."
draft: true
---

# Capabilities and Effects

> Part 5 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

A function is supposed to transform data. It takes records in, normalizes dates, adjusts formats, returns records out. Pure transformation. Except somewhere in the body, someone added a logging call that writes to a file. And a metrics push over HTTP. And a cache write to Redis.

None of this is visible in the function signature. The signature says `(records: Record[]) => TransformedRecord[]`. It doesn't say "also writes to the filesystem, hits the network twice, and mutates a cache." You find out about the side effects when the function runs in a context where the filesystem is read-only, or the network is unavailable, or Redis is down.

An LLM generating code makes this worse. It sees the function accepts `Record[]` and returns `TransformedRecord[]`. It sees that the module imports a database client at the top of the file. It decides the function could helpfully pre-cache results by writing them to the database. The function still takes `Record[]` and returns `TransformedRecord[]`. The type signature hasn't changed. The side effect is invisible.

More broadly: when a function has access to everything the module imports, the set of things it *can* do is enormous. The set of things it *should* do is small. Nothing in the code distinguishes the two. The LLM can call anything in scope — not because it's malicious, but because the interface doesn't tell it what's off-limits.

## The Pattern

Two complementary ideas address this.

**Capability-passing:** Instead of ambient access to broad interfaces (imports, globals, injected services with many methods), pass narrow capability objects that expose only the operations a component needs. A function that normalizes dates receives `{ parseDate: (s: string) => Date }`, not a database connection. The generated code can only call what's in scope — not because of a policy check, but because of the absence of a pathway. There is nothing to call.

**Effect tracking:** Encode side effects in the type signature. A function's type declares which effects it requires to run. A pure function has no requirements. A function that reads from the database has a `DatabaseRead` requirement. A function that writes has `DatabaseWrite`. The requirements are visible in the type, enforced by the compiler, and propagate through the call graph — a caller inherits the requirements of everything it calls.

Capability-passing narrows what's available. Effect tracking makes what's used visible. Together, they eliminate hidden side effects and excess authority.

## Organon's Tool Interfaces (Capability-Passing)

Each tool in Organon is a narrow typed service — an interface with the minimum surface area needed to do its job.

```ts
// Each tool interface is a tagged service — the tag identifies it for Effect's Layer system
interface WebFetcher {
  readonly fetch: (url: string) => Effect<FetchResult, FetchError, never>;
}

interface TextExtractor {
  readonly extract: (
    content: string,
    prompt: string,
    outputSchema: Schema.Schema<unknown>
  ) => Effect<unknown, ExtractionError, never>;
}

interface FileWriter {
  readonly write: (path: string, content: string) => Effect<void, WriteError, never>;
}

interface Calculator {
  readonly evaluate: (expression: string) => Effect<number, EvalError, never>;
}
```

These interfaces are what the tool dispatcher sees. It doesn't see HTTP clients, filesystem handles, LLM API keys, or anything else. It sees the capability interface for the tool it's dispatching to.

### Assembly from Configuration

The tool set is assembled at startup from configuration. The config determines which tools are available — and "available" means "the capability exists," not "the capability is enabled."

Three configurations, same harness:

**Read-only research:**

```ts
const readOnlyLayer = Layer.mergeAll(
  WebFetcherLive,
  TextExtractorLive,
  CalculatorLive,
);
// FileWriter is not provided. Not disabled — absent.
```

**Write-enabled:**

```ts
const writeEnabledLayer = Layer.mergeAll(
  WebFetcherLive,
  TextExtractorLive,
  CalculatorLive,
  FileWriterLive,
);
```

**Attenuated (dry-run writes):**

```ts
const dryRunLayer = Layer.mergeAll(
  WebFetcherLive,
  TextExtractorLive,
  CalculatorLive,
  FileWriterDryRun, // same interface, logs what it would write, writes nothing
);
```

The agent's code is identical in all three configurations. The tool dispatcher calls `writer.write(path, content)` — in the first configuration, this code path is unreachable because `FileWriter` was never provided. In the third, `write` logs and returns success without touching the filesystem.

The agent doesn't know which version it's running in. It doesn't need to. The capability boundary is invisible from the inside — which is the point.

### Capabilities via Effect's Layer System

Each tool interface is an Effect `Context.Tag`. The Layer system wires implementations to tags at startup:

```ts
class WebFetcherTag extends Context.Tag("WebFetcher")<WebFetcherTag, WebFetcher>() {}
class FileWriterTag extends Context.Tag("FileWriter")<FileWriterTag, FileWriter>() {}
// etc.
```

A function that dispatches tools declares its requirements:

```ts
function dispatchTool(
  call: ToolCallRequest
): Effect<ToolResult, ToolDispatchError, WebFetcherTag | TextExtractorTag | CalculatorTag> {
  // can only call tools whose tags are in the requirement set
}
```

If `FileWriterTag` isn't in the requirement set, the function can't access the file writer. Not "shouldn't" — *can't*. The compiler enforces it.

If a tool is missing from the config, no Layer is constructed for it. Any code path that requires it won't compile when you try to run the program — the requirement is unsatisfied. The absence is caught before execution, not at dispatch time.

## Effect Tracking: Making Side Effects Visible

The `R` parameter in `Effect<A, E, R>` formalizes capability-passing in the type system. `A` is the success type, `E` is the error type, `R` is the set of requirements — the capabilities the function needs to run.

This gives you something beyond capability-passing alone: the type signature *is* the dependency declaration. Not an import list (which might include unused modules). Not a constructor parameter (which might accept a broad interface). The `R` parameter lists exactly what the function uses, and the compiler verifies it.

### Thinking vs. Acting

Organon's architecture draws a structural line between deciding what to do and doing it.

**The planner** examines conversation history, current state, and available tools, and decides the next action: `CallLLM | ExecuteTool | Synthesize | Abort`.

```ts
function plan(
  conversation: Conversation<"pending">,
  state: AgentState,
  availableTools: ReadonlyArray<string>,
): Effect<Decision, PlanningError, never> {
  //                                ^^^^^ — no requirements
  // This function cannot call the LLM. Cannot execute a tool. Cannot write a file.
  // It can only examine its arguments and produce a Decision.
}
```

The `never` in the requirements position means: this function has no side effects. It doesn't need any capabilities. The distinction between "deciding what to do" and "doing it" is structural — enforced by the type, not by convention.

**The LLM caller** has an `LLMApi` effect:

```ts
function callLLM(
  conversation: Conversation<"pending">
): Effect<LLMResponse, LLMParseFailure | RateLimited, LLMApi> {
  //                                                   ^^^^^^ — needs LLM access
}
```

**The tool executor** has a `ToolExecution` effect:

```ts
function executeTool(
  call: ToolCallRequest
): Effect<ToolResult, ToolExecutionError | ToolTimeout, ToolExecution> {
  //                                                     ^^^^^^^^^^^^^ — needs tool access
}
```

**The file writer tool** has a `FileSystem` effect:

```ts
function writeOutput(
  path: string,
  content: string
): Effect<void, WriteError, FileSystem> {
  //                        ^^^^^^^^^^ — needs filesystem access
}
```

Each effect is visible in the type. Each is provided (or not) by the runtime environment. The planner cannot accidentally call the LLM. The LLM caller cannot accidentally write files. The boundaries are in the types.

### Effect Propagation

A function that calls another function inherits its requirements. If `orchestrate` calls `callLLM` and `executeTool`, its type signature reflects both:

```ts
function orchestrate(
  task: string
): Effect<AgentResult, HarnessError, LLMApi | ToolExecution | FileSystem | Clock> {
  //                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // The full dependency graph, visible in one place
}
```

If a tool deep in the stack introduces a new effect — say, `NetworkIO` for a tool that needs raw network access — that requirement propagates through every caller to the top level. The change is visible in the type signatures before you run anything. Nothing is hidden.

## Before and After

**Before — ambient authority:**

```ts
import { db } from "../db";
import { httpClient } from "../http";

function transformRecords(records: RawRecord[]): TransformedRecord[] {
  const transformed = records.map(normalize);

  // LLM-generated "helpful" addition: pre-cache the results
  db.batchInsert("transformed_cache", transformed);

  // LLM-generated "helpful" addition: notify monitoring
  httpClient.post("https://metrics.internal/transformed", { count: transformed.length });

  return transformed;
}
```

The function signature says `RawRecord[] → TransformedRecord[]`. Pure transformation. The body writes to a database and hits the network. The LLM added these because `db` and `httpClient` were in scope, and caching and monitoring seemed like good ideas. The code compiles. The side effects are invisible until they cause problems.

**After — effect tracking:**

```ts
function transformRecords(
  records: ReadonlyArray<RawRecord>
): Effect<ReadonlyArray<TransformedRecord>, ValidationError, never> {
  //                                                         ^^^^^ — no effects
  // db.batchInsert? Type error — DatabaseWrite not in requirements.
  // httpClient.post? Type error — NetworkIO not in requirements.
  // The function can only transform data. That's what the type says, and the compiler enforces it.
}
```

The LLM can't add the database write. The capability isn't in scope. The effect isn't in the type signature. If it tries, the compiler rejects it. Not because of a policy — because of the type system.

## Scaling

**Capabilities:** You add rate limiting to the web fetcher. You wrap the `WebFetcher` implementation with a rate-limiting decorator:

```ts
const RateLimitedWebFetcher = Layer.map(WebFetcherLive, (fetcher) => ({
  fetch: (url: string) =>
    RateLimiter.withLimit("webFetch", () => fetcher.fetch(url)),
}));
```

Zero changes to the tool dispatcher. Zero changes to the agent. Zero changes to any consumer. The rate limit is invisible to everything above it — the interface is unchanged, and the implementation detail is encapsulated in the Layer. Swap the Layer, change the behavior, touch nothing else.

**Effects:** A new tool needs network access. Its effect signature includes `NetworkIO`. That requirement propagates through every function that calls it — the tool dispatcher, the orchestrator, the top-level entry point. The top-level composition now requires a `NetworkIO` handler. You see the full dependency change in the type signatures before you run anything. If you forget to provide the handler, the program doesn't compile.

Contrast with the implicit version: a new tool quietly imports `node:net` and opens a socket. Nothing in any type signature changes. You find out about the new dependency when the tool runs in a sandboxed environment and the socket fails.


Apply the constraint. The remaining valid space is a narrow band. Most programs in it are correct or close to correct. The cumulative visual across five posts is the series thesis made geometric: each pattern eliminates a class of bug, and the combined constraints leave the LLM operating in a space where most of the walls are load-bearing.

---

*Next: [Organon: Specification and Generation](/organon-specification-and-generation) — every piece from Posts 1–5 becomes a specification, and we generate implementations against it.*
