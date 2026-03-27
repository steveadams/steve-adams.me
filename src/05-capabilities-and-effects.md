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

**Capability-passing:** Instead of ambient access to broad interfaces (imports, globals, injected services with many methods), pass narrow capability objects that expose only the operations a component needs. A function that classifies columns receives sample data, not a shell handle. The generated code can only call what's in scope — not because of a policy check, but because of the absence of a pathway. There is nothing to call.

**Effect tracking:** Encode side effects in the type signature. A function's type declares which effects it requires to run. A pure function has no requirements. A function that reads source files has a `FileReader` requirement. A function that writes config has `ConfigWriter`. The requirements are visible in the type, enforced by the compiler, and propagate through the call graph — a caller inherits the requirements of everything it calls.

Capability-passing narrows what's available. Effect tracking makes what's used visible. Together, they eliminate hidden side effects and excess authority.

## DarwinKit Agent Tool Interfaces (Capability-Passing)

The DarwinKit configuration agent has four tools. Each is a narrow typed service — an interface with the minimum surface area needed to do its job.

```ts
// Each tool interface is a tagged service — the tag identifies it for Effect's Layer system
interface FileReader {
  readonly discover: (dir: string) => Effect<SourceFile[], SourceParseFailure, never>;
  readonly readSample: (path: string, rows: number) => Effect<SampleData, SourceParseFailure, never>;
}

interface Shell {
  readonly exec: (cmd: string, args: string[]) => Effect<ShellResult, ShellError, never>;
}

interface ConfigWriter {
  readonly write: (path: string, config: DarwinKitConfig) => Effect<void, WriteError, never>;
}

interface UserPrompt {
  readonly confirm: (question: ConfirmationQuestion) => Effect<UserConfirmation, ConfirmationTimeout, never>;
  readonly ask: (question: UserQuestion) => Effect<UserResponse, ConfirmationTimeout, never>;
}

type UserQuestion = {
  readonly context: string;       // what the agent is looking at
  readonly question: string;      // what it needs to know
  readonly options?: string[];    // suggested answers (optional)
  readonly column?: string;       // which column this is about
};
```

These interfaces are what each workflow phase sees. A phase doesn't see filesystem handles, shell environments, LLM API keys, or anything else. It sees the capability interface for the operations it needs — and nothing more.

### Phase-Scoped Capabilities

The agent's workflow has five phases, each with distinct capability needs. The capability set for each phase is determined at assembly time, not by convention or discipline.

**Collection** — discover and read source files:

```ts
const collectionLayer = Layer.mergeAll(
  FileReaderLive,
  ShellLive,
);
// FileReader for reading CSV/Excel, Shell for file discovery
```

**Classification** — LLM reasoning about column types, with user gap-filling:

```ts
const classificationLayer = Layer.mergeAll(
  UserPromptLive,
);
// The classifier function itself is pure (never in R).
// But the classification *phase* may need to ask the user
// gap-filling questions when the classifier is uncertain:
// "This column is labeled 'sp_code' — species code or sample point?"
// The user's response becomes context for the next classification attempt.
```

The classification phase literally doesn't have `ConfigWriter` in scope. If the LLM hallucinates a file-write tool call during classification, there's no handler to execute it — the capability boundary is enforced by absence. An LLM generating classifier code sees `Effect<..., never>` in the requirement position and can't add a `ConfigWriter.write()` call; the type system won't allow it.

**Confirmation** — interactive gate before generation:

```ts
const confirmationLayer = Layer.mergeAll(
  UserPromptLive,
);
// UserPrompt only — the operator reviews and approves the plan
```

**Generation** — write DarwinKit configuration:

```ts
const generationLayer = Layer.mergeAll(
  ConfigWriterLive,
);
// ConfigWriter is scoped to the output directory
```

This is the only phase that can write files. At runtime, a hallucinated `fileWrite` during any other phase has nowhere to go. At development time, a function in the collection or classification phase that tries to call `ConfigWriter.write()` fails to compile — the requirement isn't in the type.

**Validation** — invoke DarwinKit CLI to check the output:

```ts
const validationLayer = Layer.mergeAll(
  ShellLive,
);
// Shell for DarwinKit CLI invocation only
```

The agent's code is identical regardless of which layer implementations back the interfaces. The collection phase calls `reader.discover(dir)` — if `FileReader` was never provided, this code path is unreachable. The generation phase calls `writer.write(path, config)` — swap `ConfigWriterLive` for `ConfigWriterDryRun` and writes become logs, with zero changes to any consumer.

The agent doesn't know which version it's running in. It doesn't need to. The capability boundary is invisible from the inside — which is the point.

### Capability-Passing in Plain TypeScript

Before reaching for a framework, the core idea works with plain interfaces and function arguments:

```ts
// Plain TypeScript: pass narrow interfaces as arguments
interface FileReader {
  discover(dir: string): SourceFile[];
  readSample(path: string, rows: number): SampleData;
}

interface Shell {
  exec(cmd: string, args: string[]): ShellResult;
}

function collectSources(
  sourceDir: string,
  reader: FileReader  // only capability available
): SourceFile[] {
  // can call reader.discover and reader.readSample
  // cannot write files, cannot run shell commands, cannot prompt user
  // not because of a policy, but because those interfaces aren't in scope
}

function validateConfig(
  configPath: string,
  shell: Shell  // only capability available
): ValidationResult {
  // can call shell.exec to invoke the DarwinKit CLI
  // cannot read source files, cannot write config, cannot prompt user
}
```

Each function receives exactly the capabilities it needs. The classification function doesn't take a `Shell` argument, so it can't run shell commands — not because of a rule, but because there's nothing to call. An LLM generating the body of `collectSources` sees `reader: FileReader` in the signature. It can call `reader.discover` and `reader.readSample`. It cannot call `configWriter.write` because `configWriter` doesn't exist in this scope.

This works, but as the harness grows, manually threading interfaces through every function call becomes unwieldy. Five phases, four tool interfaces, multiple orchestration layers — the wiring code dominates the logic. Effect's Layer system automates this wiring while preserving the same structural guarantee: if a capability isn't in the Layer, the code can't reach it.

### Capabilities via Effect's Layer System

Each tool interface is an Effect `Context.Tag`. The Layer system wires implementations to tags at startup:

```ts
class FileReaderTag extends Context.Tag("FileReader")<FileReaderTag, FileReader>() {}
class ShellTag extends Context.Tag("Shell")<ShellTag, Shell>() {}
class ConfigWriterTag extends Context.Tag("ConfigWriter")<ConfigWriterTag, ConfigWriter>() {}
class UserPromptTag extends Context.Tag("UserPrompt")<UserPromptTag, UserPrompt>() {}
```

A phase function declares its requirements:

```ts
function collectSources(
  sourceDir: string
): Effect<SourceFile[], CollectionError, FileReaderTag | ShellTag> {
  // can only read files and run discovery commands
  // cannot write config, cannot prompt the user
}
```

If `ConfigWriterTag` isn't in the requirement set, the function can't access the config writer. Not "shouldn't" — *can't*. The compiler enforces it.

If a capability is missing from the phase's layer, no Layer is constructed for it. Any code path that requires it won't compile when you try to run the program — the requirement is unsatisfied. The absence is caught before execution, not at dispatch time.

## Effect Tracking: Making Side Effects Visible

The `R` parameter in `Effect<A, E, R>` formalizes capability-passing in the type system. `A` is the success type, `E` is the error type, `R` is the set of requirements — the capabilities the function needs to run.

This gives you something beyond capability-passing alone: the type signature *is* the dependency declaration. Not an import list (which might include unused modules). Not a constructor parameter (which might accept a broad interface). The `R` parameter lists exactly what the function uses, and the compiler verifies it.

### Thinking vs. Acting

The DarwinKit configuration agent draws a structural line between deciding what to do and doing it.

**The classifier** examines sample data and decides what each column is — a pure reasoning step:

```ts
function classifyColumns(
  sample: SampleData,
  schema: DarwinKitSchema,
  userContext?: UserResponse[],  // gap-filling responses from previous rounds
): Effect<ColumnClassification[], ClassificationError, never> {
  //                                                    ^^^^^ — no requirements
  // This function cannot read files. Cannot write config. Cannot prompt the user.
  // It can only examine its arguments and produce classifications.
  // User context is *data* passed in, not a *capability* to invoke.
}
```

The `never` in the requirements position means: this function has no side effects. It receives user context as data (from earlier gap-filling), but cannot initiate interaction itself. At runtime, the classifier examines data and produces classifications — no side effects occur. At development time, the `never` in the requirements position tells an LLM generating this function: this is pure. Don't add imports. Don't add service calls. There's nowhere to put them.

The **classification phase orchestrator** is what invokes `UserPrompt.ask()` when the classifier reports uncertainty — then feeds the response back as input:

```ts
function classificationPhase(
  sample: SampleData,
  schema: DarwinKitSchema,
): Effect<ColumnClassification[], ClassificationError, UserPromptTag> {
  //                                                   ^^^^^^^^^^^^^^ — needs UserPrompt
  // Calls classifyColumns (pure). If any column has low confidence,
  // asks the user for context via UserPrompt.ask(), then re-classifies
  // with the user's response as additional input. The classifier stays
  // pure; the orchestrator handles the interaction.
}
```

The distinction between "deciding what each column is" (pure) and "asking the user for help" (effect) is structural — enforced by the type, not by convention. The classifier can't prompt the user. The orchestrator can.

**The config generator** determines mappings from classifications — also pure:

```ts
function generateConfig(
  classifications: ColumnClassification[],
  sourceMetadata: SourceMetadata,
): Effect<DarwinKitConfig, GenerationError, never> {
  //                                        ^^^^^ — no requirements
  // Pure transformation from classifications to config structure
}
```

**The file reader** has a `FileReader` effect:

```ts
function readSourceSample(
  path: string,
  rows: number,
): Effect<SampleData, SourceParseFailure, FileReaderTag> {
  //                                      ^^^^^^^^^^^^^ — needs file read access
}
```

**The config writer** has a `ConfigWriter` effect:

```ts
function writeConfig(
  path: string,
  config: DarwinKitConfig,
): Effect<void, WriteError, ConfigWriterTag> {
  //                        ^^^^^^^^^^^^^^^ — needs config write access
}
```

**The validator** has a `Shell` effect:

```ts
function validateConfig(
  configPath: string,
): Effect<ValidationResult, ShellError, ShellTag> {
  //                                    ^^^^^^^^ — needs shell access for DarwinKit CLI
}
```

Each effect is visible in the type. Each is provided (or not) by the runtime environment. The classifier cannot accidentally write config. The config writer cannot accidentally read source files. The boundaries are in the types.

### Effect Propagation

A function that calls another function inherits its requirements. The top-level `runAgent` function calls through every phase, so its type signature accumulates all capabilities:

```ts
function runAgent(
  sourceDir: string,
  outputDir: string,
): Effect<FinalConfig, AgentError, FileReaderTag | ShellTag | ConfigWriterTag | UserPromptTag | LLMApi> {
  //                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // The full dependency graph, visible in one place
}
```

Every capability the agent needs — file reading, shell execution, config writing, user confirmation, LLM access — appears in that type signature. If a phase deep in the stack introduces a new requirement, that requirement propagates through every caller to the top level. The change is visible in the type signatures before you run anything. Nothing is hidden.

## Before and After

**Before — ambient authority:**

Recall the MVP's `dispatchTool` from [Post 01](/types-as-receipts):

```ts
function dispatchTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "fileRead":
        return JSON.stringify(fileRead(args));
      case "shell":
        return JSON.stringify(shell(args));
      case "fileWrite":
        return JSON.stringify(fileWrite(args));
      case "userPrompt":
        return JSON.stringify(userPrompt(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return `Tool execution failed: ${(err as Error).message}`;
  }
}
```

Every tool is always available. The dispatcher doesn't know what phase the agent is in — classification, generation, validation — it doesn't matter. If the LLM returns a tool call, `dispatchTool` routes it.

During a classification-only phase, the LLM is supposed to examine sample data and produce column classifications. Pure reasoning. But the LLM hallucinates a `fileWrite` tool call — maybe it decides to "helpfully" save intermediate results. `dispatchTool` routes it to the `fileWrite` handler and executes it. The classification phase just wrote a file it shouldn't have access to. The LLM calls `shell` during what should be pure reasoning? Executed. There's no structural restriction — `dispatchTool` routes to anything it knows, regardless of what the current phase should be allowed to do.

**After — phase-scoped capabilities:**

```ts
// The classification phase only has UserPrompt in its layer.
// No FileReader, no Shell, no ConfigWriter.
const classificationLayer = Layer.mergeAll(
  UserPromptLive,
);

function classifyColumns(
  sample: SampleData,
  schema: DarwinKitSchema,
): Effect<ColumnClassification[], ClassificationError, never> {
  //                                                    ^^^^^ — no effects
  // The classifier is pure. It can't call fileWrite — there's no handler in scope.
  // It can't call shell — Shell isn't in the layer.
  // The LLM hallucinates a fileWrite tool call? There's nothing to route it to.
  // The capability boundary is enforced by absence, not by a policy check.
}
```

The dispatcher doesn't exist in this model. Each phase gets a layer with exactly the capabilities it needs. The classification phase has `UserPrompt` for gap-filling questions — and nothing else. If the LLM generates code that tries to call `ConfigWriter.write()`, the compiler rejects it: `ConfigWriter` isn't in the requirements. If at runtime the LLM hallucinates a tool call the phase can't handle, there's no handler to execute it. The boundary is structural.

## Scaling

**Capabilities:** You need audit logging on every config write — a record of what got written, when, and by which agent run. You wrap the `ConfigWriter` implementation with a logging decorator:

```ts
const AuditedConfigWriter = Layer.map(ConfigWriterLive, (writer) => ({
  write: (path: string, config: DarwinKitConfig) =>
    AuditLog.record("configWrite", { path, timestamp: Date.now() }).pipe(
      Effect.flatMap(() => writer.write(path, config)),
    ),
}));
```

Zero changes to the generation phase. Zero changes to the agent. Zero changes to any consumer. The audit log is invisible to everything above it — the interface is unchanged, and the implementation detail is encapsulated in the Layer. Swap the Layer, change the behavior, touch nothing else.

**Effects:** A new phase needs network access — say, fetching a remote schema registry. Its effect signature includes `NetworkIO`. That requirement propagates through every function that calls it — the phase runner, the orchestrator, the top-level entry point. The top-level composition now requires a `NetworkIO` handler. You see the full dependency change in the type signatures before you run anything. If you forget to provide the handler, the program doesn't compile.

Contrast with the implicit version: a new phase quietly imports `node:net` and opens a socket. Nothing in any type signature changes. You find out about the new dependency when the phase runs in a sandboxed environment and the socket fails.


Apply the constraint. The remaining valid space is a narrow band. Most programs in it are correct or close to correct. The cumulative visual across five posts is the series thesis made geometric: each pattern eliminates a class of bug, and the combined constraints leave the LLM operating in a space where most of the walls are load-bearing.

---

*Next: [Specification and Generation](/specification-and-generation) — every piece from Posts 1-5 becomes a specification, and we generate implementations against it.*
