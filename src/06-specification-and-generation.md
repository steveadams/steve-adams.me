---
title: "Specification and Generation"
date: "2026-03-17T00:00:00.000Z"
slug: "specification-and-generation"
description: "Assembling the DarwinKit configuration agent by combining all structural guardrail patterns into a specification-driven code generation pipeline."
draft: true
---

# Specification and Generation

> Part 6 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

The typical agent harness is a bag of strings and hope.

Conversation history is `Array<any>`. Tool dispatch is a `switch` on a string name, with `default: throw new Error("unknown tool")`. Error handling is `catch(() => "something went wrong")`. The LLM produces subtly malformed tool calls and they silently corrupt state. Debugging means reading conversation logs and guessing where things went sideways.

This series has been building an alternative. This post assembles the pieces into a specification and generates an implementation against it — showing concretely that structural constraints reduce the review surface to a narrow band.

## The Specification

Over five posts, we've defined every component of the DarwinKit configuration agent's behavioral contract. Each definition is an authoritative source of truth from which downstream artifacts are derived:

| Component | Constraint Source | Key Definition |
|-----------|-----------------|----------------|
| Parse boundaries | Post 1 | `SourceFileSchema`, `SemanticClassificationSchema`, `DarwinKitConfigSchema` |
| Error model | Post 2 | `AgentError` tagged union (8 variants) |
| Agent lifecycle | Post 3 | XState machine (10 states) |
| Workflow protocol | Post 4 | Workflow typestate accumulator |
| Phase capabilities | Post 5 | `FileReader`, `Shell`, `ConfigWriter`, `UserPrompt` via Layers |

Together, these definitions form a specification. Each component's type signature, capability interface, and error channel are already defined. What remains is implementation — and the specification constrains it tightly.

### Test Invariants

Properties that must hold across all executions:

- The workflow never enters `configGenerated` without first passing through `gatesCleared` — every low-confidence classification has been confirmed by a human.
- Budget limits are never exceeded by more than one operation (the operation that crosses the threshold completes, then the harness stops).
- Every error variant reaches a defined recovery or terminal state.
- Config generation never occurs outside the `generating` state.
- A function with `never` in its requirements position never triggers an effect.
- Every LLM classification response is validated against `SemanticClassificationSchema` before it can influence a `ColumnMapping`.

## The Mold

The spec is so constraining that implementation is nearly determined. Consider the column classifier. Here is the type signature the LLM receives:

```ts
function classifyColumns(
  sources: ReadonlyArray<ParsedSource>,
): Effect<
  ReadonlyArray<SemanticClassification>,
  ClassificationFailure | UnknownDwCTerm,
  never
>
```

Every constraint is visible in this signature:

- **Input:** `ReadonlyArray<ParsedSource>` — already decoded via `SourceFileSchema` (Post 1). The column names, sample rows, and file format are typed. Not `string[]` and guesswork.
- **Output:** `ReadonlyArray<SemanticClassification>` — each classification must contain a valid Darwin Core term, a confidence score bounded to `[0, 1]`, and reasoning. The output schema (Post 1) enforces this.
- **Error channel:** Exactly two tagged errors (Post 2). `ClassificationFailure` for structural problems — the LLM couldn't produce a classification at all. `UnknownDwCTerm` for semantic problems — the LLM hallucinated a Darwin Core term that doesn't exist in the schema registry. The caller must handle each. No generic `catch`, no `Error` base class.
- **Effect:** `never` (Post 5). Pure reasoning. The classifier examines its arguments and returns classifications. No file reads, no shell commands, no config writes, no user prompts. The distinction between "deciding what each column is" and "acting on that decision" is structural.
- **State guard:** Only callable when the machine is in `classifying` (Post 3). The orchestrator can't invoke classification from `generating` or `validating` — the machine definition doesn't permit it.

The implementation space is narrow. Most of the decisions have been made by the specification. The LLM is filling in a mold, not designing from scratch.

## Generation in Practice

The spec constrains generation in two directions at once. During development, the LLM fills in a mold — the type signatures, error channels, and workflow protocol are already defined. Four compiler errors trace to four specific constraints from Posts 01-05. The spec determined most of the implementation; the LLM supplied the rest. At runtime, the same boundaries hold. The schema that caught a type error during development also catches a malformed LLM response during execution. The spec constrains both the writing and the running.

Let's see the development side concretely. We'll generate the column classifier — a component that sits at the intersection of every constraint surface — and watch what happens.

### The Prompt

The LLM receives the type signature above, plus:

```ts
// The source data type — already decoded from raw files
type ParsedSource = Schema.Schema.Type<typeof SourceFileSchema>;
// { _tag: "sourceFile", path: string, format: "csv" | "tsv" | "xlsx",
//   columns: string[], sampleRows: string[][] }

// The classification output type
const SemanticClassificationSchema = Schema.Struct({
  _tag: Schema.Literal("semanticClassification"),
  column: Schema.String,
  dwcTerm: Schema.String,
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
  reasoning: Schema.String,
});

type SemanticClassification = Schema.Schema.Type<typeof SemanticClassificationSchema>;

// The tagged error types it must use
class ClassificationFailure extends Data.TaggedError("ClassificationFailure")<{
  readonly column: string;
  readonly reason: string;
}> {}

class UnknownDwCTerm extends Data.TaggedError("UnknownDwCTerm")<{
  readonly term: string;
  readonly available: ReadonlyArray<string>;
}> {}

// The valid DwC term registry
const DWC_TERMS: ReadonlyArray<string> = [
  "scientificName", "decimalLatitude", "decimalLongitude",
  "eventDate", "basisOfRecord", "occurrenceID",
  "minimumDepthInMeters", "maximumDepthInMeters",
  "recordedBy", "identifiedBy", "coordinateUncertaintyInMeters",
  // ... ~200 more
];
```

The instruction: "Implement `classifyColumns` with this signature. For each source column, examine the column name and sample data to determine the most likely Darwin Core term. Validate every proposed term against `DWC_TERMS`. Use Effect's generator syntax."

### First Attempt

The LLM generates:

```ts
function classifyColumns(
  sources: ReadonlyArray<ParsedSource>,
): Effect<
  ReadonlyArray<SemanticClassification>,
  ClassificationFailure | UnknownDwCTerm,
  never
> {
  return Effect.gen(function* () {
    const classifications: SemanticClassification[] = [];

    for (const source of sources) {
      for (const column of source.columns) {
        // Analyze column name and sample values
        const analysis = analyzeColumn(column, source.sampleRows);

        // Validate the proposed term exists
        if (!DWC_TERMS.includes(analysis.term)) {
          yield* new UnknownDwCTerm({
            term: analysis.term,
            available: DWC_TERMS,
          });
        }

        // Decode the classification through the schema
        const classified = yield* Schema.decodeUnknown(SemanticClassificationSchema)({
          _tag: "semanticClassification",
          column,
          dwcTerm: analysis.term,
          confidence: analysis.confidence,
          reasoning: analysis.reasoning,
        }).pipe(
          Effect.mapError((parseError) =>
            new ClassificationFailure({
              column,
              reason: parseError.message,
            })
          ),
        );

        classifications.push(classified);
      }
    }

    return classifications;
  });
}
```

This is a reasonable first attempt. The structure is right — iterate sources, classify each column, validate the term, decode through the schema. But the constraints catch problems the LLM didn't anticipate.

### What the Compiler Caught

**Constructing a `ColumnMapping` without a classification receipt.** Elsewhere in the generated code, the LLM tried to build a `ColumnMapping` directly from the analysis result — bypassing the `SemanticClassificationSchema` decode step. The `ColumnMapping` schema requires a `classification` field of type `SemanticClassification`. Without decoding through the schema, the raw analysis object doesn't satisfy the type. The compiler flags it: `Type '{ term: string; confidence: number; }' is not assignable to type 'SemanticClassification'`.

**Using a Darwin Core term not in the schema.** The LLM used `coordinatePrecisionMeters` — a plausible-sounding term that doesn't exist. The term registry is a const array of literal strings. `DWC_TERMS.includes("coordinatePrecisionMeters")` returns `false` at runtime, but the compiler catches a related issue: the generated config uses the term directly in a `Schema.Literal` position where only registry terms are valid. The type `string` doesn't satisfy the literal union — the schema enforces the vocabulary.

**Calling `generateConfig` with the wrong workflow state.** The LLM wrote orchestration code that calls `generateConfig` after classification but before clearing the confirmation gates — passing `Workflow<"columnsClassified">` instead of `Workflow<"gatesCleared">`. The compiler flags this immediately: `Argument of type 'Workflow<"columnsClassified">' is not assignable to parameter of type 'Workflow<"gatesCleared">'`. The typestate (Post 4) catches the protocol violation.

**`ParseError` API mismatch.** The `mapError` maps `ParseError` to `ClassificationFailure`, but `parseError.message` doesn't exist on Effect's `ParseError`. The actual API is `TreeFormatter.formatError(parseError)`. The compiler flags it: `Property 'message' does not exist on type 'ParseError'`.

Four compiler errors. Each traces to a specific constraint:
1. The receipt chain — enforced by `ColumnMappingSchema` requiring a decoded `SemanticClassification` (Post 1)
2. The term vocabulary — enforced by `DWC_TERMS` and schema literals (Post 1)
3. The workflow protocol — enforced by typestate (Post 4)
4. The `ParseError` API — enforced by Effect's type definitions (Post 1)

After the compiler errors are fixed, the generated code compiles. What remains to review?

### What's Left to Review

The review surface is small:

1. **Classification strategy.** The classifier examines column names and sample values to propose a Darwin Core term. The heuristic for matching — fuzzy string similarity? exact prefix match? sample-value pattern analysis? — is unconstrained by the spec. The spec says the output must be a valid `SemanticClassification` with a real DwC term. How the classifier arrives at that term is a genuine design decision.

2. **Confidence calibration.** The classifier assigns confidence scores. What makes something 0.9 vs. 0.6? The spec constrains the range (`[0, 1]`) and the downstream behavior (low-confidence classifications require user confirmation). But the threshold between "confident enough" and "needs confirmation" is a policy decision the spec intentionally leaves open.

3. **Ambiguity resolution.** "depth_m" could be `minimumDepthInMeters` or `maximumDepthInMeters`. The classifier must pick one and assign a confidence. How it handles genuine ambiguity — pick the more common term? return the lower confidence? flag both options? — is a decision the spec doesn't make. This is the kind of domain judgment that should be reviewed by a scientist, not decided by structure.

Three review items. Each is a genuine design decision that the spec intentionally left open. Everything else — the input parsing, the term validation, the error types, the capability boundary, the effect signature, the workflow protocol — was forced by the specification.

This is the series' core claim made concrete: **structural constraints reduce code review from "is this correct?" to "are these three design choices appropriate?"** The compiler eliminated structural bugs. What remains is the narrow surface where human judgment actually matters.

## Scaling

The specification constrains the implementation, but the harness is parameterized by the target profile. The same machine, same error model, same typestate protocol, same capability interfaces — different profiles, different validation rules, different required fields.

Here's the DarwinKit configuration agent configured for OBIS marine biodiversity data:

```ts
const obisProfile = {
  standard: "dwc" as const,
  profile: "obis",
  datasets: [
    { type: "event", source: "stations.csv", format: "csv" as const },
    { type: "occurrence", source: "specimens.csv", format: "csv" as const },
    { type: "measurementOrFact", source: "measurements.csv", format: "csv" as const },
  ],
  foreignKeys: [
    { from: { dataset: "occurrence", field: "eventID" }, to: { dataset: "event", field: "eventID" } },
    { from: { dataset: "measurementOrFact", field: "occurrenceID" }, to: { dataset: "occurrence", field: "occurrenceID" } },
  ],
  requiredFields: ["decimalLatitude", "decimalLongitude", "eventDate", "basisOfRecord", "scientificName", "measurementType", "measurementValue"],
};
```

Here it is configured for GBIF terrestrial biodiversity data:

```ts
const gbifProfile = {
  standard: "dwc" as const,
  profile: "gbif",
  datasets: [
    { type: "occurrence", source: "observations.csv", format: "csv" as const },
  ],
  foreignKeys: [],
  requiredFields: ["decimalLatitude", "decimalLongitude", "eventDate", "basisOfRecord", "scientificName", "occurrenceID"],
};
```

Same machine. Same error model. Same typestate protocol. Same workflow accumulator. Same capability interfaces. Different datasets, different foreign key rules, different required fields. The OBIS profile has three related datasets with referential integrity constraints — Event records linked to Occurrence records linked to MeasurementOrFact records. The GBIF profile has a single flat Occurrence dataset with no cross-references.

Nothing about the harness moved. The classifier uses the same `classifyColumns` function with the same signature. The validator enforces different rules because the profile schema is different. The confirmation gates fire for the same reason — low-confidence classifications need human review whether the data is marine invertebrates or terrestrial plants. The circuit breaker watches for stalls with the same signals. The only thing that changed is the configuration — which is itself decoded through a schema, validated at the boundary, and carried as a typed receipt through every phase.

### XState Inspector

[Interactive statechart — second appearance]

The full DarwinKit configuration agent machine: lifecycle, revision sub-loop, parallel budget tracker. Richer than the Post 4 version — the reader now understands every component. Walk through a complete agent run: idle → collecting → classifying → confirming → mapping → generating → validating → complete. Trigger interrupts. Watch error recovery. Send `VALIDATION_FAIL` and observe the circuit breaker evaluate stall confidence. The machine is the spec, and the inspector is the spec made interactive.

---

*Next: [Verification](/verification) — property-based testing, model-based testing, and fault injection — each targeting a different architectural layer, each derived from the same definitions.*
