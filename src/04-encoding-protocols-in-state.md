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

1. You can't determine structure without inspected data.
2. You can't generate an archive without confirmed metadata — every piece of inferred metadata must be reviewed by a human.
3. You can't skip metadata gathering and go straight to archive generation.
4. You can't validate an archive that hasn't been generated from confirmed state.

At runtime, the machine absorbs violations of these rules — send `ARCHIVE_READY` while in `gatheringMetadata` and nothing happens. But at development time, nothing prevents an LLM from *generating* code that tries. The machine silently swallows the invalid event, and the bug manifests as missing behavior rather than an error. Rule 2 is where this matters most. The agent infers metadata from the data — geographic bounding box, temporal extent, taxonomic coverage — and the generation step runs anyway, without user confirmation. The machine absorbs the premature event. The generated archive never appears. No error, no crash — just silence where an archive should have been. Or worse: the code is structured to bypass the machine entirely, calling generation logic directly. The agent infers a bounding box that includes an outlier at [0,0], so the published dataset claims global coverage. The actual data is from British Columbia. The archive validates against the EML schema — the XML is structurally correct, the bounding box coordinates are valid numbers — but the metadata is semantically wrong. Other researchers discover the dataset when searching for data near the equator. The actual specimens are all from the Pacific Northwest. The dataset's credibility is damaged, and nobody notices until someone tries to use the data and finds it thousands of kilometers from where the metadata claimed.

The machine prevents runtime violations. But nothing prevents an LLM from generating this code, which the machine would silently absorb:

```ts
interface WorkflowState {
  sources: ValidatedSource[];
  structure: ArchiveStructure | null;
  inferredMetadata: InferredMetadata[];
  userMetadata: UserProvidedMetadata[];
  confirmations: UserConfirmation[];
  archive: ArchiveManifest | null;
  validation: ValidationResult | null;
}
```

Every operation is available at all times. Nothing in the type distinguishes a workflow that has confirmed its metadata from one that hasn't. An LLM generating code to extend the harness sees a flat object with nullable fields and has no structural reason to enforce the ordering. The machine catches the violation at runtime. Typestate catches it at compile time — before the code ever runs.

## The Pattern

Typestate makes the available operations depend on the current state by changing the type. A `Workflow<"metadataGathered">` has different transition functions available than a `Workflow<"metadataConfirmed">`. Calling `generateArchive` with a `Workflow<"metadataGathered">` is a type error — the function doesn't accept that type. The machine constrains what the agent can *do*. Typestate constrains what code can be *written*. They target different layers and complement each other.

The DarwinKit workflow accumulator has eight states, each representing a completed phase:

```ts
// The state is encoded in the type parameter
type Workflow<
  S extends
    | "initial"
    | "dataInspected"
    | "structureDetermined"
    | "metadataGathered"
    | "metadataConfirmed"
    | "archiveGenerated"
    | "validated"
    | "revising"
> = {
  readonly _state: S;
  readonly sources: ReadonlyArray<ValidatedSource>;
  readonly structure: ArchiveStructure | null;
  readonly inferredMetadata: ReadonlyArray<InferredMetadata>;
  readonly userMetadata: ReadonlyArray<UserProvidedMetadata>;
  readonly confirmations: ReadonlyArray<UserConfirmation>;
  readonly archive: ArchiveManifest | null;
  readonly validation: ValidationResult | null;
};
```

Transition functions produce workflows in the correct state:

```ts
// Starting point — empty workflow
function initial(): Workflow<"initial"> { /* ... */ }

// Inspect source data — now the agent knows what files and columns exist
function inspectData(
  w: Workflow<"initial">,
  sources: ValidatedSource[]
): Workflow<"dataInspected"> { /* ... */ }

// Determine archive structure — core vs extension files, ID relationships
function determineStructure(
  w: Workflow<"dataInspected">,
  structure: ArchiveStructure
): Workflow<"structureDetermined"> { /* ... */ }

// Gather metadata from data — bounding box, temporal extent, taxonomic coverage
function gatherMetadata(
  w: Workflow<"structureDetermined">,
  metadata: MetadataRecord
): Workflow<"metadataGathered"> { /* ... */ }

// User confirms all inferred metadata — every inference is reviewed
function confirmMetadata(
  w: Workflow<"metadataGathered">,
  confirmations: UserConfirmation[]
): Workflow<"metadataConfirmed"> { /* ... */ }

// Generate the Darwin Core Archive — only possible after metadata is confirmed
function generateArchive(
  w: Workflow<"metadataConfirmed">
): Workflow<"archiveGenerated"> { /* ... */ }

// Run validation against EML schema and archive structure
function recordValidation(
  w: Workflow<"archiveGenerated">,
  result: ValidationResult
): Workflow<"validated"> { /* ... */ }
```

The key constraint: `generateArchive` only accepts `Workflow<"metadataConfirmed">`:

```ts
function generateArchive(
  w: Workflow<"metadataConfirmed">
): Workflow<"archiveGenerated"> { /* ... */ }
```

Passing a `Workflow<"metadataGathered">` — skipping the confirmation step — is a compile error. The bug where unconfirmed inferred metadata slips into a generated archive is structurally impossible.

Look at the function signatures. An LLM generating orchestration code doesn't need to know the DarwinKit domain. It doesn't need to understand why confirmation matters for biodiversity data quality. The types tell it what order things must happen: `inspectData` requires `Workflow<"initial">`, `determineStructure` requires `Workflow<"dataInspected">`, `gatherMetadata` requires `Workflow<"structureDetermined">`, `confirmMetadata` requires `Workflow<"metadataGathered">`, `generateArchive` requires `Workflow<"metadataConfirmed">`. The protocol is visible in the API surface. Skip a step and the compiler rejects the code before it ever reaches the runtime machine.

At runtime, the typestate accumulator carries proof through the workflow. A `Workflow<"metadataConfirmed">` value exists only because the code path that produced it went through `confirmMetadata` — which required a `Workflow<"metadataGathered">` — which required `gatherMetadata` — which required `Workflow<"structureDetermined">`. The proof is structural: the value couldn't exist without every preceding step having completed. The type parameter is a receipt for the entire protocol up to that point.

### Honesty about TypeScript's typestate

This works, but it's verbose. TypeScript doesn't have ownership semantics — nothing prevents you from holding onto an old `Workflow<"metadataGathered">` reference after transitioning to `Workflow<"metadataConfirmed">`. The constraint is opt-in: if you use the transition functions, you get the guarantees. If you cast or bypass them, you don't.

For the DarwinKit archive agent, this is acceptable. The workflow accumulator is a small, contained module. The transition functions are the only API. The typestate catches the most dangerous bug — skipping user confirmation on inferred metadata — at compile time. But it's worth being honest: TypeScript's typestate is an approximation, not an ironclad guarantee. This is one reason the runtime machine from [Post 3](/state-machines-and-lifecycle) matters. The machine absorbs invalid transitions regardless of how the code was written. The typestate prevents most invalid code from being written in the first place. Neither is sufficient alone.

## Before and After

**Before — flat workflow state:**

```ts
const state = {
  sources: [] as ValidatedSource[],
  structure: null as ArchiveStructure | null,
  inferredMetadata: [] as InferredMetadata[],
  confirmations: [] as UserConfirmation[],
  archive: null as ArchiveManifest | null,
};

state.sources = await inspectData(inputFiles);
state.structure = await determineStructure(state.sources);
state.inferredMetadata = await gatherMetadata(state.structure);

// BUG: generating archive without confirming inferred metadata
// bounding box includes outlier at [0,0] — claims global coverage
// actual data is from British Columbia
state.archive = generateArchive(state.inferredMetadata); // compiles, runs, produces semantically wrong metadata
```

An LLM generates this. It looks reasonable. `state` has all the fields, `generateArchive` takes metadata, the types agree. The bug — the missing confirmation step — is invisible. The archive validates against the EML schema because the XML is structurally correct and the coordinates are valid numbers. But the bounding box encompasses the entire globe because an outlier at [0,0] was never caught. The dataset appears in searches for equatorial data when every specimen is actually from the Pacific Northwest.

**After — typestate workflow:**

```ts
const w0 = initial();
const w1 = inspectData(w0, sources);
const w2 = determineStructure(w1, structure);
const w3 = gatherMetadata(w2, metadata);

generateArchive(w3);
// ^^^^^^^^^^^^^^^^
// Type error: Argument of type 'Workflow<"metadataGathered">'
// is not assignable to parameter of type 'Workflow<"metadataConfirmed">'
```

The LLM generating this code hits the type error immediately. The fix is obvious: call `confirmMetadata` first to review the inferred metadata. The protocol is in the types. You can't produce an archive with unconfirmed metadata — not because of a policy, but because of the absence of a pathway.

This is the confirmation gate doing its job at two levels. During development, the type error forces the LLM to include the confirmation step — it can't generate code that compiles without it. At runtime, the `Workflow<"metadataConfirmed">` value is proof that confirmation actually happened — the `confirmMetadata` function ran, the `UserConfirmation[]` array was provided, the metadata was reviewed. The "before" code isn't just a development-time mistake the compiler catches. It's a runtime invariant violation that would have produced subtly corrupt biodiversity metadata. The typestate prevents both simultaneously.

## Scaling

The [revision loop from Post 3](/state-machines-and-lifecycle) — `validating -> revising -> generating -> validating` — handles the runtime cycle: stall detection watches for repetition, stagnation, and oscillation, and the circuit breaker terminates unproductive loops. Typestate adds the compile-time complement. Two new transition functions extend the accumulator:

```ts
// Validation failed — enter revision state with the diagnosis
function beginRevision(
  w: Workflow<"validated">,
  diagnosis: RevisionDiagnosis
): Workflow<"revising"> { /* ... */ }

// Revision complete — back to metadataConfirmed, ready to regenerate
function completeRevision(
  w: Workflow<"revising">,
  updatedMetadata: MetadataRecord
): Workflow<"metadataConfirmed"> { /* ... */ }
```

The key insight: `completeRevision` produces `Workflow<"metadataConfirmed">`, not `Workflow<"archiveGenerated">`. Revision goes back through the confirmation gate. If the revision changes any metadata, those changes must be confirmed again — the user sees what changed before a new archive is generated. An LLM generating revision code can't skip this step. `generateArchive` still requires `Workflow<"metadataConfirmed">`, whether the workflow arrived there from initial metadata gathering or from a revision cycle. The confirmation gate is the star of this protocol because it guards the same invariant in both paths.

---

The machine governs what the agent can *do*. Typestate governs what code can be *written*. Together, the confirmation gate is enforced twice — once by the compiler rejecting code that skips it, once by the machine absorbing events that arrive out of order. But neither controls what the agent can *reach*. The inspection phase shouldn't write files. The generation phase shouldn't make network calls. The next post addresses this with typed capabilities.

*Next: [Capabilities and Effects](/capabilities-and-effects) — controlling what code can do by passing capabilities explicitly, so each phase's access is structurally enforced.*
