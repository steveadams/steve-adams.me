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

**Capability-passing:** Instead of ambient access to broad interfaces (imports, globals, injected services with many methods), pass narrow capability objects that expose only the operations a component needs. A function that composes EML metadata receives confirmed data, not a file handle. The generated code can only call what's in scope — not because of a policy check, but because of the absence of a pathway. There is nothing to call.

**Effect tracking:** Encode side effects in the type signature. A function's type declares which effects it requires to run. A pure function has no requirements. A function that reads source files has a `FileReader` requirement. A function that writes archive components has `ArchiveWriter`. The requirements are visible in the type, enforced by the compiler, and propagate through the call graph — a caller inherits the requirements of everything it calls.

Capability-passing narrows what's available. Effect tracking makes what's used visible. Together, they eliminate hidden side effects and excess authority.

## DarwinKit Agent Tool Interfaces (Capability-Passing)

The DarwinKit archive agent has three tools. Each is a narrow typed service — an interface with the minimum surface area needed to do its job.

```ts
// Each tool interface is a tagged service — the tag identifies it for Effect's Layer system
interface FileReader {
  readonly discover: (dir: string) => Effect<ValidatedSource[], SourceInspectionFailure, never>;
  readonly readSample: (path: string, rows: number) => Effect<SampleData, SourceInspectionFailure, never>;
}

interface ArchiveWriter {
  readonly writeMetaXML: (path: string, descriptor: MetaXMLDescriptor) => Effect<void, WriteError, never>;
  readonly writeEML: (path: string, eml: EMLDocument) => Effect<void, WriteError, never>;
  readonly assembleArchive: (outputPath: string, components: ArchiveComponents) => Effect<void, WriteError, never>;
}

interface UserPrompt {
  readonly confirm: (question: ConfirmationQuestion) => Effect<UserConfirmation, ConfirmationTimeout, never>;
  readonly ask: (question: UserQuestion) => Effect<UserResponse, ConfirmationTimeout, never>;
}
```

These interfaces are what each workflow phase sees. A phase doesn't see filesystem handles, shell environments, LLM API keys, or anything else. It sees the capability interface for the operations it needs — and nothing more.

### Phase-Scoped Capabilities

The agent's workflow has six phases, each with distinct capability needs. The capability set for each phase is determined at assembly time, not by convention or discipline.

**Inspection** — discover and read source files:

```ts
const inspectionLayer = Layer.mergeAll(FileReaderLive);
// FileReader for discovering and sampling CSV/Excel sources
```

**Structuring** — LLM reasoning about archive layout, with user questions:

```ts
const structuringLayer = Layer.mergeAll(UserPromptLive);
// The structuring phase asks the user about dataset organization:
// "Should these three CSVs be separate core entities or extensions?"
// No file reading, no file writing — just interactive reasoning.
```

**Gathering** — user interview plus data-driven inference:

```ts
const gatheringLayer = Layer.mergeAll(UserPromptLive, FileReaderLive);
// UserPrompt for asking the operator about metadata.
// FileReader for reading coordinate columns to infer geographic coverage.
```

**Confirmation** — interactive gate before generation:

```ts
const confirmationLayer = Layer.mergeAll(UserPromptLive);
// UserPrompt only — the operator reviews and approves the plan
```

**Generation** — write Darwin Core Archive components:

```ts
const generationLayer = Layer.mergeAll(ArchiveWriterLive);
// ArchiveWriter is scoped to the output directory
```

This is the only phase that can write files. At runtime, a hallucinated `fileWrite` during any other phase has nowhere to go. At development time, a function in the inspection or structuring phase that tries to call `ArchiveWriter.writeEML()` fails to compile — the requirement isn't in the type.

**Validation** — pure computation, no capabilities:

```ts
// No layer needed — R is `never`
// Validation checks structural invariants of the assembled archive:
// Are all referenced files present? Does the meta.xml schema match the data?
// Pure functions over the archive structure. No I/O required.
```

The validation phase having no capabilities at all is the cleanest example of this pattern. There is no layer because there are no requirements. The functions take data in and return results out. An LLM generating validation code sees `never` in the requirements position — there is nowhere to add a side effect. This is not a phase with restricted capabilities; it is a phase with *no* capabilities. The `R` parameter is `never`, and the compiler enforces it.

The agent's code is identical regardless of which layer implementations back the interfaces. The inspection phase calls `reader.discover(dir)` — if `FileReader` was never provided, this code path is unreachable. The generation phase calls `writer.writeEML(path, eml)` — swap `ArchiveWriterLive` for `ArchiveWriterDryRun` and writes become logs, with zero changes to any consumer.

The agent doesn't know which version it's running in. It doesn't need to. The capability boundary is invisible from the inside — which is the point.

### Capability-Passing in Plain TypeScript

Before reaching for a framework, the core idea works with plain interfaces and function arguments:

```ts
// Plain TypeScript: pass narrow interfaces as arguments
interface FileReader {
  discover(dir: string): ValidatedSource[];
  readSample(path: string, rows: number): SampleData;
}

interface ArchiveWriter {
  writeEML(path: string, eml: EMLDocument): void;
  writeMetaXML(path: string, descriptor: MetaXMLDescriptor): void;
  assembleArchive(outputPath: string, components: ArchiveComponents): void;
}

function inspectSources(
  sourceDir: string,
  reader: FileReader  // only capability available
): ValidatedSource[] {
  // can call reader.discover and reader.readSample
  // cannot write files, cannot prompt user
  // not because of a policy, but because those interfaces aren't in scope
}

function validateArchive(
  archive: ArchiveStructure,
): ValidationResult {
  // no capabilities at all — pure computation
  // cannot read files, cannot write files, cannot prompt user
}
```

Each function receives exactly the capabilities it needs. The validation function doesn't take any capability argument, so it can't perform any side effects — not because of a rule, but because there's nothing to call. An LLM generating the body of `inspectSources` sees `reader: FileReader` in the signature. It can call `reader.discover` and `reader.readSample`. It cannot call `writer.writeEML` because `writer` doesn't exist in this scope.

This works, but as the harness grows, manually threading interfaces through every function call becomes unwieldy. Six phases, three tool interfaces, multiple orchestration layers — the wiring code dominates the logic. Effect's Layer system automates this wiring while preserving the same structural guarantee: if a capability isn't in the Layer, the code can't reach it.

### Capabilities via Effect's Layer System

Each tool interface is an Effect `Context.Tag`. The Layer system wires implementations to tags at startup:

```ts
class FileReaderTag extends Context.Tag("FileReader")<FileReaderTag, FileReader>() {}
class ArchiveWriterTag extends Context.Tag("ArchiveWriter")<ArchiveWriterTag, ArchiveWriter>() {}
class UserPromptTag extends Context.Tag("UserPrompt")<UserPromptTag, UserPrompt>() {}
```

A phase function declares its requirements:

```ts
function inspectSources(
  sourceDir: string
): Effect<ValidatedSource[], SourceInspectionFailure, FileReaderTag> {
  // can only read and discover source files
  // cannot write archive components, cannot prompt the user
}
```

If `ArchiveWriterTag` isn't in the requirement set, the function can't access the archive writer. Not "shouldn't" — *can't*. The compiler enforces it.

If a capability is missing from the phase's layer, no Layer is constructed for it. Any code path that requires it won't compile when you try to run the program — the requirement is unsatisfied. The absence is caught before execution, not at dispatch time.

## Effect Tracking: Making Side Effects Visible

The `R` parameter in `Effect<A, E, R>` formalizes capability-passing in the type system. `A` is the success type, `E` is the error type, `R` is the set of requirements — the capabilities the function needs to run.

This gives you something beyond capability-passing alone: the type signature *is* the dependency declaration. Not an import list (which might include unused modules). Not a constructor parameter (which might accept a broad interface). The `R` parameter lists exactly what the function uses, and the compiler verifies it.

### Thinking vs. Acting

The DarwinKit archive agent draws a structural line between deciding what to do and doing it. Three functions illustrate three different capability profiles — with zero overlap between reading and writing.

**EML metadata composition** takes confirmed metadata and produces an EML document — a pure authoring step:

```ts
function composeEMLMetadata(
  confirmedMetadata: ConfirmedMetadata,
  archiveStructure: ArchiveStructure,
): Effect<EMLDocument, ArchiveGenerationError, never> {
  //                                           ^^^^^ — no requirements
  // Pure. Takes confirmed metadata, produces EML structure.
  // Cannot read files, cannot write files, cannot prompt user.
}
```

The `never` in the requirements position means: this function has no side effects. It receives confirmed metadata as data (from earlier phases), but cannot initiate any I/O. At development time, the `never` in the requirements position tells an LLM generating this function: this is pure. Don't add imports. Don't add service calls. There's nowhere to put them.

**Geographic coverage inference** needs to read source data to examine coordinate columns:

```ts
function inferGeographicCoverage(
  sources: ReadonlyArray<ValidatedSource>,
): Effect<GeographicCoverage, InferenceError, FileReaderTag> {
  //                                          ^^^^^^^^^^^^^ — needs FileReader
  // Needs FileReader to read coordinate columns from source files.
  // Cannot write files. Cannot prompt user.
}
```

The contrast is sharp: inference needs `FileReader` (read-only), authoring is pure, and writing needs `ArchiveWriter`. Three phases, three different capability profiles. The function that composes EML metadata cannot read source files. The function that infers geographic coverage cannot write archive components. The boundaries are structural.

**The archive writer** has an `ArchiveWriter` effect:

```ts
function writeEMLDocument(
  path: string,
  eml: EMLDocument,
): Effect<void, WriteError, ArchiveWriterTag> {
  //                        ^^^^^^^^^^^^^^^^ — needs archive write access
}
```

**The validator** has no effects at all:

```ts
function validateArchiveStructure(
  archive: ArchiveStructure,
  manifest: ArchiveManifest,
): Effect<ValidationResult, ArchiveViolation, never> {
  //                                          ^^^^^ — no requirements
  // Pure computation. Checks structural invariants:
  // Are all referenced files present? Does meta.xml match the data?
  // No I/O. No capabilities. The R parameter is `never`.
}
```

Each effect is visible in the type. Each is provided (or not) by the runtime environment. The EML composer cannot accidentally write files. The archive writer cannot accidentally read source data. The validator cannot do anything except examine its arguments and return a result. The boundaries are in the types.

### Effect Propagation

A function that calls another function inherits its requirements. The top-level `runAgent` function calls through every phase, so its type signature accumulates all capabilities:

```ts
function runAgent(
  sourceDir: string,
  outputDir: string,
): Effect<ArchiveManifest, AgentError, FileReaderTag | ArchiveWriterTag | UserPromptTag | LLMApi> {
  //                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // The full dependency graph, visible in one place
}
```

Every capability the agent needs — file reading, archive writing, user confirmation, LLM access — appears in that type signature. If a phase deep in the stack introduces a new requirement, that requirement propagates through every caller to the top level. The change is visible in the type signatures before you run anything. Nothing is hidden.

## Before and After

**Before — ambient authority:**

Recall the MVP's `dispatchTool` from [Post 01](/types-as-receipts):

```ts
function dispatchTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "fileRead":
        return JSON.stringify(fileRead(args));
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

Every tool is always available. The dispatcher doesn't know what phase the agent is in — inspection, generation, validation — it doesn't matter. If the LLM returns a tool call, `dispatchTool` routes it.

During the EML authoring step, the LLM is supposed to compose metadata from confirmed inputs. Pure reasoning. But the LLM hallucinates a `fileWrite` tool call — maybe it decides to "helpfully" save intermediate results to disk. `dispatchTool` routes it to the `fileWrite` handler and executes it. The authoring step just wrote a file it shouldn't have access to. There's no structural restriction — `dispatchTool` routes to anything it knows, regardless of what the current phase should be allowed to do.

**After — phase-scoped capabilities:**

```ts
// EML composition is pure — no layer needed.
// R is `never`. No capabilities in scope.
function composeEMLMetadata(
  confirmedMetadata: ConfirmedMetadata,
  archiveStructure: ArchiveStructure,
): Effect<EMLDocument, ArchiveGenerationError, never> {
  //                                           ^^^^^ — no effects
  // Pure authoring. Can't call fileWrite — there's no handler in scope.
  // Can't read files — FileReader isn't in the requirements.
  // The LLM hallucinates a fileWrite tool call? There's nothing to route it to.
  // The capability boundary is enforced by absence, not by a policy check.
}
```

The dispatcher doesn't exist in this model. Each phase gets a layer with exactly the capabilities it needs — or no layer at all, when the phase is pure. If the LLM generates code that tries to call `ArchiveWriter.writeEML()` during metadata composition, the compiler rejects it: `ArchiveWriter` isn't in the requirements. If at runtime the LLM hallucinates a tool call the phase can't handle, there's no handler to execute it. The boundary is structural.

## Scaling

**Capabilities:** You need audit logging on every archive write — a record of what got written, when, and by which agent run. You wrap the `ArchiveWriter` implementation with a logging decorator:

```ts
const AuditedArchiveWriter = Layer.map(ArchiveWriterLive, (writer) => ({
  writeEML: (path, eml) =>
    AuditLog.record("emlWrite", { path, timestamp: Date.now() }).pipe(
      Effect.flatMap(() => writer.writeEML(path, eml)),
    ),
  // ... same for writeMetaXML and assembleArchive
}));
```

Zero changes to the generation phase. Zero changes to the agent. Zero changes to any consumer. The audit log is invisible to everything above it — the interface is unchanged, and the implementation detail is encapsulated in the Layer. Swap the Layer, change the behavior, touch nothing else.

**Effects:** A new phase needs network access — say, fetching a remote vocabulary registry for Darwin Core terms. Its effect signature includes `NetworkIO`. That requirement propagates through every function that calls it — the phase runner, the orchestrator, the top-level entry point. The top-level composition now requires a `NetworkIO` handler. You see the full dependency change in the type signatures before you run anything. If you forget to provide the handler, the program doesn't compile.

Contrast with the implicit version: a new phase quietly imports `node:net` and opens a socket. Nothing in any type signature changes. You find out about the new dependency when the phase runs in a sandboxed environment and the socket fails.


Apply the constraint. The remaining valid space is a narrow band. Most programs in it are correct or close to correct. The cumulative visual across five posts is the series thesis made geometric: each pattern eliminates a class of bug, and the combined constraints leave the LLM operating in a space where most of the walls are load-bearing.

---

*Next: [Specification and Generation](/specification-and-generation) — every piece from Posts 1-5 becomes a specification, and we generate implementations against it.*
