---
title: "Encoding Protocols in State"
date: "2026-03-17T00:00:00.000Z"
slug: "encoding-protocols-in-state"
description: "Typestate patterns that make protocol violations compile errors — the compile-time complement to the runtime state machine."
draft: true
---

# Encoding Protocols in State

> Part 4 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

The [state machine from Post 3](/state-machines-and-lifecycle) governs the agent's lifecycle at runtime. Invalid transitions are absorbed. The circuit breaker fires. But the machine can't prevent you from *writing* code that attempts an invalid transition — it can only absorb the event silently at runtime.

Typestate pushes these guarantees into the compiler. The same protocol the machine enforces at runtime becomes a compile-time constraint on the code itself.

The DarwinKit protocol has rules, and the machine handles all of them:

1. You can't classify columns without parsed sources.
2. You can't generate a config without clearing all confidence gates — every low-confidence mapping must be confirmed by a human.
3. You can't skip classification and go straight to mapping.
4. You can't validate a config that hasn't been generated from cleared gates.

At runtime, the machine absorbs violations of these rules — send `MAPPINGS_READY` while in `classifying` and nothing happens. But at development time, nothing prevents an LLM from *generating* code that tries. The machine silently swallows the invalid event, and the bug manifests as missing behavior rather than an error. Rule 2 is where this matters most. The code classifies columns, some come back low-confidence, and the generation step runs anyway — without user confirmation. The machine absorbs the premature event. The generated config never appears. No error, no crash — just silence where a config should have been. Or worse: the code is structured to bypass the machine entirely, calling generation logic directly. "collector" gets mapped to `recordedBy` when it should have been `identifiedBy`. "depth_m" gets mapped to `maximumDepthInMeters` when the user would have corrected it to `minimumDepthInMeters`. The config validates successfully — the terms are real, the formats are correct — but the data is subtly wrong. Records enter the biodiversity database with the wrong semantics. Nobody notices until someone queries for all records identified by "J. Smith" and gets nothing, because those records were filed under `recordedBy`.

The machine prevents runtime violations. But nothing prevents an LLM from generating this code, which the machine would silently absorb:

```ts
interface WorkflowState {
  sources: SourceFile[];
  classifications: SemanticClassification[];
  confirmations: UserConfirmation[];
  config: DarwinKitConfig | null;
  validation: ValidationResult | null;
}
```

Every operation is available at all times. Nothing in the type distinguishes a workflow that has cleared its confidence gates from one that hasn't. An LLM generating code to extend the harness sees a flat object with nullable fields and has no structural reason to enforce the ordering. The machine catches the violation at runtime. Typestate catches it at compile time — before the code ever runs.

## The Pattern

Typestate makes the available operations depend on the current state by changing the type. A `Workflow<"columnsClassified">` has different transition functions available than a `Workflow<"gatesCleared">`. Calling `generateConfig` with a `Workflow<"columnsClassified">` is a type error — the function doesn't accept that type. The machine constrains what the agent can *do*. Typestate constrains what code can be *written*. They target different layers and complement each other.

The DarwinKit workflow accumulator has six states, each representing a completed phase:

```ts
// The state is encoded in the type parameter
type Workflow<
  S extends
    | "initial"
    | "sourceParsed"
    | "columnsClassified"
    | "gatesCleared"
    | "configGenerated"
    | "validated"
> = {
  readonly _state: S;
  readonly sources: ReadonlyArray<SourceFile>;
  readonly classifications: ReadonlyArray<SemanticClassification>;
  readonly confirmations: ReadonlyArray<UserConfirmation>;
  readonly config: DarwinKitConfig | null;
  readonly validation: ValidationResult | null;
};
```

Transition functions produce workflows in the correct state:

```ts
// Starting point — empty workflow
function initial(): Workflow<"initial"> { /* ... */ }

// Parse source files — now the agent knows what columns exist
function parseSources(
  w: Workflow<"initial">,
  sources: SourceFile[]
): Workflow<"sourceParsed"> { /* ... */ }

// Classify columns using LLM reasoning — each column gets a DwC term and confidence
function classifyColumns(
  w: Workflow<"sourceParsed">,
  classifications: SemanticClassification[]
): Workflow<"columnsClassified"> { /* ... */ }

// User confirms all low-confidence mappings — every gate is cleared
function clearGates(
  w: Workflow<"columnsClassified">,
  confirmations: UserConfirmation[]
): Workflow<"gatesCleared"> { /* ... */ }

// Generate the darwinkit.yaml config — only possible after all gates are cleared
function generateConfig(
  w: Workflow<"gatesCleared">
): Workflow<"configGenerated"> { /* ... */ }

// Run DarwinKit validation against actual data
function recordValidation(
  w: Workflow<"configGenerated">,
  result: ValidationResult
): Workflow<"validated"> { /* ... */ }
```

The key constraint: `generateConfig` only accepts `Workflow<"gatesCleared">`:

```ts
function generateConfig(
  w: Workflow<"gatesCleared">
): Workflow<"configGenerated"> { /* ... */ }
```

Passing a `Workflow<"columnsClassified">` — skipping the confirmation step — is a compile error. The bug where unconfirmed low-confidence mappings slip into a generated config is structurally impossible.

Look at the function signatures. An LLM generating orchestration code doesn't need to know the DarwinKit domain. It doesn't need to understand why confirmation matters for biodiversity data quality. The types tell it what order things must happen: `parseSources` requires `Workflow<"initial">`, `classifyColumns` requires `Workflow<"sourceParsed">`, `clearGates` requires `Workflow<"columnsClassified">`, `generateConfig` requires `Workflow<"gatesCleared">`. The protocol is visible in the API surface. Skip a step and the compiler rejects the code before it ever reaches the runtime machine.

At runtime, the typestate accumulator carries proof through the workflow. A `Workflow<"gatesCleared">` value exists only because the code path that produced it went through `clearGates` — which required a `Workflow<"columnsClassified">` — which required `classifyColumns` — which required `Workflow<"sourceParsed">`. The proof is structural: the value couldn't exist without every preceding step having completed. The type parameter is a receipt for the entire protocol up to that point.

### Honesty about TypeScript's typestate

This works, but it's verbose. TypeScript doesn't have ownership semantics — nothing prevents you from holding onto an old `Workflow<"columnsClassified">` reference after transitioning to `Workflow<"gatesCleared">`. The constraint is opt-in: if you use the transition functions, you get the guarantees. If you cast or bypass them, you don't.

For the DarwinKit configuration agent, this is acceptable. The workflow accumulator is a small, contained module. The transition functions are the only API. The typestate catches the most dangerous bug — skipping user confirmation on low-confidence mappings — at compile time. But it's worth being honest: TypeScript's typestate is an approximation, not an ironclad guarantee. This is one reason the runtime machine from [Post 3](/state-machines-and-lifecycle) matters. The machine absorbs invalid transitions regardless of how the code was written. The typestate prevents most invalid code from being written in the first place. Neither is sufficient alone.

## Before and After

**Before — flat workflow state:**

```ts
const state = {
  sources: [] as SourceFile[],
  classifications: [] as SemanticClassification[],
  confirmations: [] as UserConfirmation[],
  config: null as DarwinKitConfig | null,
};

state.sources = await parseSources(inputFiles);
state.classifications = await classifyColumns(state.sources);

// BUG: generating config without confirming low-confidence mappings
// "collector" → recordedBy (70% confidence, never confirmed)
// "depth_m" → maximumDepthInMeters (65% confidence, never confirmed)
state.config = generateConfig(state.classifications); // compiles, runs, produces subtly wrong data
```

An LLM generates this. It looks reasonable. `state` has all the fields, `generateConfig` takes classifications, the types agree. The bug — the missing confirmation step — is invisible. The config validates against DarwinKit because the terms exist and the formats are correct. But "collector" should have been `identifiedBy`, and "depth_m" should have been `minimumDepthInMeters`. The data enters the biodiversity database with wrong semantics that nobody catches until downstream queries return wrong results.

**After — typestate workflow:**

```ts
const w0 = initial();
const w1 = parseSources(w0, inputFiles);
const w2 = classifyColumns(w1, classifications);

generateConfig(w2);
// ^^^^^^^^^^^^^^^
// Type error: Argument of type 'Workflow<"columnsClassified">'
// is not assignable to parameter of type 'Workflow<"gatesCleared">'
```

The LLM generating this code hits the type error immediately. The fix is obvious: call `clearGates` first to confirm the low-confidence mappings. The protocol is in the types. You can't produce a config with unconfirmed mappings — not because of a policy, but because of the absence of a pathway.

This is the confirmation gate doing its job at two levels. During development, the type error forces the LLM to include the confirmation step — it can't generate code that compiles without it. At runtime, the `Workflow<"gatesCleared">` value is proof that confirmation actually happened — the `clearGates` function ran, the `UserConfirmation[]` array was provided, the gate was cleared. The "before" code isn't just a development-time mistake the compiler catches. It's a runtime invariant violation that would have produced subtly corrupt biodiversity data. The typestate prevents both simultaneously.

## Scaling

The [revision loop from Post 3](/state-machines-and-lifecycle) — `validating -> revising -> generating -> validating` — handles the runtime cycle: stall detection watches for repetition, stagnation, and oscillation, and the circuit breaker terminates unproductive loops. Typestate adds the compile-time complement. Two new transition functions extend the accumulator:

```ts
// Validation failed — enter revision state with the diagnosis
function beginRevision(
  w: Workflow<"validated">,
  diagnosis: RevisionDiagnosis
): Workflow<"revising"> { /* ... */ }

// Revision complete — back to gatesCleared, ready to regenerate
function completeRevision(
  w: Workflow<"revising">,
  updatedConfirmations: UserConfirmation[]
): Workflow<"gatesCleared"> { /* ... */ }
```

The key insight: `completeRevision` produces `Workflow<"gatesCleared">`, not `Workflow<"configGenerated">`. Revision goes back through the confirmation gate. If the revision changes any mappings, those changes must clear gates again — the user sees what changed before a new config is generated. An LLM generating revision code can't skip this step. `generateConfig` still requires `Workflow<"gatesCleared">`, whether the workflow arrived there from initial classification or from a revision cycle. The confirmation gate is the star of this protocol because it guards the same invariant in both paths.

---

The machine governs what the agent can *do*. Typestate governs what code can be *written*. Together, the confirmation gate is enforced twice — once by the compiler rejecting code that skips it, once by the machine absorbing events that arrive out of order. But neither controls what the agent can *reach*. The classification phase shouldn't write files. The generation phase shouldn't make network calls. The next post addresses this with typed capabilities.

*Next: [Capabilities and Effects](/capabilities-and-effects) — controlling what code can do by passing capabilities explicitly, so each phase's access is structurally enforced.*
