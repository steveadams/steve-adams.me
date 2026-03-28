---
title: "Specification and Generation"
date: "2026-03-17T00:00:00.000Z"
slug: "specification-and-generation"
description: "Assembling the Darwin Core Archive agent by combining all structural guardrail patterns into a specification-driven code generation pipeline."
draft: true
---

# Specification and Generation

> Part 6 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

The typical agent harness is a bag of strings and hope.

Conversation history is `Array<any>`. Tool dispatch is a `switch` on a string name, with `default: throw new Error("unknown tool")`. Error handling is `catch(() => "something went wrong")`. The LLM produces subtly malformed tool calls and they silently corrupt state. Debugging means reading conversation logs and guessing where things went sideways.

This series has been building an alternative. This post assembles the pieces into a specification and generates an implementation against it — showing concretely that structural constraints reduce the review surface to a narrow band.

## The Specification

Over five posts, we've defined every component of the Darwin Core Archive agent's behavioral contract. Each definition is an authoritative source of truth from which downstream artifacts are derived:

| Component | Constraint Source | Key Definition |
|-----------|-----------------|----------------|
| Parse boundaries | Post 1 | `ValidatedSourceSchema`, `ArchiveStructureSchema`, `MetadataRecordSchema`, `ArchiveManifestSchema` |
| Error model | Post 2 | `HarnessError` tagged union, `ArchiveViolation` nested union |
| Agent lifecycle | Post 3 | XState machine (inspecting, structuring, gathering, confirming, generating, validating, revising) |
| Workflow protocol | Post 4 | Workflow typestate accumulator (initial, dataInspected, structureDetermined, metadataGathered, metadataConfirmed, archiveGenerated, validated, revising) |
| Phase capabilities | Post 5 | `FileReader`, `ArchiveWriter`, `UserPrompt` via Layers |

Together, these definitions form a specification. Each component's type signature, capability interface, and error channel are already defined. What remains is implementation — and the specification constrains it tightly.

### Test Invariants

Properties that must hold across all executions:

- The workflow never enters `archiveGenerated` without first passing through `metadataConfirmed` — every piece of inferred metadata has been confirmed by a human.
- Budget limits are never exceeded by more than one operation (the operation that crosses the threshold completes, then the harness stops).
- Every error variant reaches a defined recovery or terminal state.
- Archive generation never occurs outside the `generating` state.
- A function with `never` in its requirements position never triggers an effect — validation is pure computation, no capabilities required.
- Every LLM-authored metadata field is validated against the relevant schema before inclusion in the archive.

## The Mold

The spec is so constraining that implementation is nearly determined. Consider the EML metadata composer — the function that takes confirmed metadata and archive structure and produces a standards-compliant EML XML document. Here is the type signature:

```ts
function composeEML(
  metadata: ConfirmedMetadata,
  structure: ArchiveStructure,
): Effect<
  EMLDocument,
  SchemaViolation | CompletenessViolation,
  never
>
```

Every constraint is visible in this signature:

- **Input:** `ConfirmedMetadata` — already decoded via `MetadataRecordSchema`, with `UserConfirmation` receipts intact (Post 1). The geographic bounding box, temporal extent, taxonomic coverage, abstract, keywords, and contact information are typed. Not `Record<string, string>` and hope.
- **Input:** `ArchiveStructure` — decoded via `ArchiveStructureSchema` (Post 1). Core type, extension files, and row types are typed. The composer knows what kind of archive it's building metadata for.
- **Output:** `EMLDocument` — a typed representation of the EML XML structure that must conform to the EML XML Schema. The document structure is constrained by the schema's element and attribute definitions.
- **Error channel:** Exactly two tagged errors (Post 2). `SchemaViolation` for structural problems — a required EML element is missing or malformed. `CompletenessViolation` for semantic problems — the archive structure implies required metadata sections that aren't present (geographic coverage is required when coordinate data exists, temporal coverage when dates exist). The caller must handle each. No generic `catch`, no `Error` base class.
- **Effect:** `never` (Post 5). Pure computation. The composer examines its arguments and produces an EML document. No file reads, no archive writes, no user prompts. The distinction between "assembling the metadata document" and "writing it to disk" is structural. During the validation phase, the same `never` requirement ensures validators can't trigger side effects either.
- **State guard:** Only callable when the machine is in `generating` (Post 3). The orchestrator can't invoke EML composition from `gathering` or `validating` — the machine definition doesn't permit it.
- **Typestate:** Requires a `Workflow<"metadataConfirmed">` to have been reached (Post 4). The `generateArchive` function that calls `composeEML` only accepts `Workflow<"metadataConfirmed">`. Passing `Workflow<"metadataGathered">` — skipping the confirmation step — is a compile error.

The implementation space is narrow. Most of the decisions have been made by the specification. The LLM is filling in a mold, not designing from scratch.

## Generation in Practice

The spec constrains generation in two directions at once. During development, the LLM fills in a mold — the type signatures, error channels, and workflow protocol are already defined. Four compiler errors trace to four specific constraints from Posts 01-05. The spec determined most of the implementation; the LLM supplied the rest. At runtime, the same boundaries hold. The schema that caught a type error during development also catches a malformed LLM response during execution. The spec constrains both the writing and the running.

Let's see the development side concretely. We'll generate the EML metadata composer — a component that sits at the intersection of every constraint surface — and watch what happens.

### The Prompt

The LLM receives the type signature above, plus:

```ts
// The confirmed metadata type — already decoded, receipts intact
type ConfirmedMetadata = {
  readonly abstract: MetadataRecord;
  readonly geographic: MetadataRecord;
  readonly temporal: MetadataRecord;
  readonly taxonomic: MetadataRecord;
  readonly contact: MetadataRecord;
  readonly methods: MetadataRecord;
  readonly keywords: MetadataRecord;
};

// The archive structure — decoded from ArchiveStructureSchema
type ArchiveStructure = Schema.Schema.Type<typeof ArchiveStructureSchema>;
// { _tag: "archiveStructure", coreType: "Occurrence" | "Event",
//   coreFile: string, extensions: Array<{ file: string, rowType: string }>,
//   reasoning: string }

// The EML document output type
const EMLDocumentSchema = Schema.Struct({
  _tag: Schema.Literal("emlDocument"),
  title: Schema.String,
  abstract: Schema.String,
  creator: EMLContactSchema,
  contact: EMLContactSchema,
  geographicCoverage: Schema.optional(GeographicCoverageSchema),
  temporalCoverage: Schema.optional(TemporalCoverageSchema),
  taxonomicCoverage: Schema.optional(TaxonomicCoverageSchema),
  methods: Schema.optional(Schema.String),
  keywordSets: Schema.Array(KeywordSetSchema),
  intellectualRights: Schema.optional(Schema.String),
});

type EMLDocument = Schema.Schema.Type<typeof EMLDocumentSchema>;

// The tagged error types it must use
class SchemaViolation extends Data.TaggedError("SchemaViolation")<{
  readonly element: string;
  readonly reason: string;
  readonly path: string;
}> {}

class CompletenessViolation extends Data.TaggedError("CompletenessViolation")<{
  readonly missingSection: string;
  readonly requiredBecause: string;
}> {}

// Valid EML element names — constrained by the schema
const EML_ELEMENTS = [
  "title", "creator", "contact", "abstract",
  "geographicCoverage", "temporalCoverage", "taxonomicCoverage",
  "methods", "keywordSet", "intellectualRights",
  "additionalInfo", "pubDate", "language",
  // ... more from the EML specification
] as const;
```

The instruction: "Implement `composeEML` with this signature. Given confirmed metadata and archive structure, produce an EML document. Validate every element name against `EML_ELEMENTS`. Use Effect's generator syntax."

### First Attempt

The LLM generates:

```ts
function composeEML(
  metadata: ConfirmedMetadata,
  structure: ArchiveStructure,
): Effect<
  EMLDocument,
  SchemaViolation | CompletenessViolation,
  never
> {
  return Effect.gen(function* () {
    // Check required sections based on archive structure
    if (structure.coreType === "Occurrence" || structure.coreType === "Event") {
      if (!metadata.geographic) {
        yield* new CompletenessViolation({
          missingSection: "geographicCoverage",
          requiredBecause: "archive contains coordinate data",
        });
      }
    }

    // Build the EML document
    const eml = yield* Schema.decodeUnknown(EMLDocumentSchema)({
      _tag: "emlDocument",
      title: metadata.abstract.value,
      abstract: metadata.abstract.value,
      creator: buildContact(metadata.contact),
      contact: buildContact(metadata.contact),
      geographicCoverage: buildGeographicCoverage(metadata.geographic),
      temporalCoverage: buildTemporalCoverage(metadata.temporal),
      taxonomicCoverage: buildTaxonomicCoverage(metadata.taxonomic),
      methods: metadata.methods.value,
      keywordSets: buildKeywordSets(metadata.keywords),
    }).pipe(
      Effect.mapError((parseError) =>
        new SchemaViolation({
          element: "eml",
          reason: TreeFormatter.formatError(parseError),
          path: "/eml",
        })
      ),
    );

    return eml;
  });
}
```

This is a reasonable first attempt. The structure is right — check required sections based on archive structure, build the document, decode through the schema. But the constraints catch problems the LLM didn't anticipate.

### What the Compiler Caught

**Constructing an `ArchiveManifest` without a confirmed metadata receipt.** Elsewhere in the generated code, the LLM tried to build an `ArchiveManifest` directly from gathered metadata — bypassing the confirmation step. The `ArchiveManifestSchema` requires a `metadata` field of type `ReadonlyArray<MetadataRecord>`, and each `MetadataRecord` carries an `archiveStructure` receipt and an optional `UserConfirmation` receipt. Without the confirmation receipt, the raw metadata object doesn't satisfy the type. The compiler flags it: `Type '{ field: string; value: string; source: "inferred" }' is not assignable to type 'MetadataRecord'` — the receipt chain (Post 1) is incomplete.

**Using a non-existent EML element name.** The LLM used `geographicExtent` — a plausible-sounding element that doesn't exist in the EML schema. The valid element names are a const array of literal strings. The generated code tried to use the term in a position where only `EML_ELEMENTS` values are valid. The type `string` doesn't satisfy the literal union — the schema enforces the vocabulary. The correct element name is `geographicCoverage`.

**Calling `generateArchive` with the wrong workflow state.** The LLM wrote orchestration code that calls `generateArchive` after metadata gathering but before confirmation — passing `Workflow<"metadataGathered">` instead of `Workflow<"metadataConfirmed">`. The compiler flags this immediately: `Argument of type 'Workflow<"metadataGathered">' is not assignable to parameter of type 'Workflow<"metadataConfirmed">'`. The typestate (Post 4) catches the protocol violation. The user hasn't confirmed the inferred bounding box — the one that might include an outlier at [0, 0] — and the compiler refuses to let generation proceed.

**XML builder API mismatch.** The LLM called a method on the EML builder that doesn't exist — `builder.addElement("geographicExtent", ...)` instead of using the typed builder API that requires `EMLDocument` fields. The builder API is typed to match the `EMLDocumentSchema` fields, so arbitrary element names produce a compile error: `Argument of type '"geographicExtent"' is not assignable to parameter of type keyof EMLDocument`.

Four compiler errors. Each traces to a specific constraint:
1. The receipt chain — enforced by `ArchiveManifestSchema` requiring decoded `MetadataRecord` values with their receipts intact (Post 1)
2. The EML element vocabulary — enforced by `EML_ELEMENTS` and schema literals (Post 1)
3. The workflow protocol — enforced by typestate (Post 4)
4. The builder API — enforced by typed element names derived from `EMLDocumentSchema` (Post 1)

After the compiler errors are fixed, the generated code compiles. What remains to review?

### What's Left to Review

The review surface is small:

1. **Abstract quality.** The LLM authored an abstract from the user's description and the data characteristics. Is it accurate? Appropriate for the audience? The spec constrains the abstract to be a `string` that passes through `MetadataRecordSchema` — but whether the abstract clearly describes the dataset's purpose, scope, and significance is a genuine language quality judgment that the type system can't make.

2. **Keyword selection.** The LLM selected keywords from GBIF's controlled vocabulary. Are they the most appropriate terms? Are important keywords missing? The spec constrains keywords to come from a controlled vocabulary — `KeywordSetSchema` with a `thesaurus` field. But whether "marine invertebrates" is more appropriate than "benthic fauna" for this particular dataset is a domain decision the spec intentionally leaves open.

3. **Coverage granularity.** The geographic coverage could be a single bounding box or a set of named regions. The temporal coverage could be a single date range or multiple collection events. How fine-grained should the metadata be? The spec constrains the structure — `GeographicCoverageSchema` and `TemporalCoverageSchema` define valid shapes. But whether a study spanning three sites should have one bounding box or three named localities depends on the publication context and the conventions of the target repository.

Three review items. Each is a genuine decision that requires domain judgment. Everything else — the input parsing, the element validation, the error types, the capability boundary, the effect signature, the workflow protocol — was forced by the specification.

This is the series' core claim made concrete: **structural constraints reduce code review from "is this correct?" to "are these three design choices appropriate?"** The compiler eliminated structural bugs. What remains is the narrow surface where human judgment actually matters.

## Scaling

The specification constrains the implementation, but the harness is parameterized by the target publication profile. The same machine, same error model, same typestate protocol, same capability interfaces — different EML requirements, different validation rules, different required sections.

Here's the agent configured for GBIF terrestrial biodiversity data:

```ts
const gbifProfile = {
  target: "gbif",
  requiredEMLSections: ["geographic", "temporal", "taxonomic", "contact", "methods"],
  controlledVocabularies: { keywords: "gbif-thesaurus" },
  archiveType: "occurrence",
};
```

Here it is configured for OBIS marine biodiversity data:

```ts
const obisProfile = {
  target: "obis",
  requiredEMLSections: ["geographic", "temporal", "taxonomic", "contact", "methods", "sampling"],
  controlledVocabularies: { keywords: "obis-thesaurus" },
  archiveType: "event-with-extensions",
};
```

And for DataONE, a general-purpose data repository:

```ts
const dataOneProfile = {
  target: "dataone",
  requiredEMLSections: ["geographic", "temporal", "contact", "intellectualRights"],
  controlledVocabularies: { keywords: "none" },
  archiveType: "occurrence",
};
```

Same machine. Same error model. Same typestate protocol. Same workflow accumulator. Same capability interfaces. Different required EML sections, different controlled vocabulary sources, different archive types. The OBIS profile requires a `sampling` section and uses event-based archives with extensions — Event records linked to Occurrence records linked to MeasurementOrFact records. The GBIF profile uses a simpler occurrence archive. DataONE requires `intellectualRights` but doesn't enforce a controlled keyword vocabulary.

Nothing about the harness moved. The EML composer uses the same `composeEML` function with the same signature. The validator enforces different completeness rules because the profile's `requiredEMLSections` are different — a `CompletenessViolation` fires when a required section is absent. The confirmation gates operate the same way — inferred metadata needs human review whether the data is marine invertebrates or terrestrial plants. The circuit breaker watches for stalls with the same signals. The only thing that changed is the profile — which is itself decoded through a schema, validated at the boundary, and carried as a typed receipt through every phase.

### XState Inspector

[Interactive statechart — second appearance]

The full Darwin Core Archive agent machine: lifecycle, revision sub-loop, parallel budget tracker. Richer than the Post 3 version — the reader now understands every component. Walk through a complete agent run: idle → inspecting → structuring → gathering → confirming → generating → validating → complete. Trigger interrupts. Watch error recovery. Send `VALIDATION_FAIL` and observe the circuit breaker evaluate stall confidence. The machine is the spec, and the inspector is the spec made interactive.

---

*Next: [Verification](/verification) — property-based testing, model-based testing, and fault injection — each targeting a different architectural layer, each derived from the same definitions.*
