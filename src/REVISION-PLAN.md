# Series Revision Plan: DarwinKit Config → Darwin Core Archive Packaging

## Overview

The harness shifts from a single monolithic LLM task (column classification → darwinkit.yaml) to orchestrating multiple distinct LLM tasks that collectively justify the harness:

- **Archive structure determination** — is this Event core or Occurrence core? Which files are extensions?
- **Metadata authoring** — abstract, methods description, keyword selection
- **Metadata inference** — bounding box, temporal extent, taxonomic coverage from data
- **EML generation** — producing schema-compliant XML from confirmed metadata

No single task is the "star." Each phase anchors different posts. The harness's value is the orchestration — typed handoffs between phases, scoped capabilities per phase, and guarantees that no phase can skip what came before.

### Validation changes

Old: DarwinKit CLI invoked via `Shell` capability. Exit codes parsed. External tool.
New: In-process XML schema validation (EML schema, meta.xml schema) + cross-validation (meta.xml fields vs CSV headers, EML coverage vs data content). Pure computation — no `Shell` needed.

This is a *stronger* capabilities story. Validation has `never` in its requirements position.

### Key domain objects (old → new)

| Old | New |
|-----|-----|
| `SemanticClassification` | `ArchiveStructure`, `InferredMetadata`, `UserProvidedMetadata` |
| `ColumnMapping` | `MetadataRecord` (combining inferred + user-provided + confirmed) |
| `UserConfirmation` (for classification confidence) | `UserConfirmation` (for inferred metadata, archive structure) |
| `DarwinKitConfig` (darwinkit.yaml) | `ArchiveManifest` (meta.xml + eml.xml + file list) |
| `FieldViolation` (Range, Format, Required) | `ArchiveViolation` (Schema, CrossReference, Completeness) |
| DWC_TERMS registry | EML schema + DwC term URIs for meta.xml |

### Machine states (old → new)

| Old | New | Notes |
|-----|-----|-------|
| idle | idle | Same |
| collecting | inspecting | Read source files, inventory columns, validate structure |
| classifying | structuring | Determine core vs extensions, row types (LLM reasoning) |
| confirming | confirming | Now covers: archive structure + inferred metadata + user-provided metadata |
| mapping | gathering | Collect metadata from user + infer derived metadata from data |
| generating | generating | Produce meta.xml, eml.xml, archive zip |
| validating | validating | EML schema + meta.xml schema + cross-validation |
| revising | revising | Same loop, same stall detection |
| complete/failed | complete/failed | Same |

Note: "gathering" combines what was "mapping" with new metadata collection. The inferring step (bounding box, temporal extent) could be a sub-state of gathering or a separate state. Recommend keeping it within gathering for simplicity — the machine is already rich enough — and using the typestate in Post 04 to enforce that inference happens before confirmation.

### Capability profiles (old → new)

| Phase | Old | New |
|-------|-----|-----|
| Inspection | FileReader + Shell | FileReader |
| Structuring | (was classification: UserPrompt) | UserPrompt |
| Gathering | (was mapping: none) | UserPrompt + FileReader (read-only, for inference) |
| Confirmation | UserPrompt | UserPrompt |
| Generation | ConfigWriter | ArchiveWriter (scoped to output dir) |
| Validation | Shell (DarwinKit CLI) | **never** — pure computation |

The validation phase having `never` in R is a cleaner example than needing Shell.

---

## Post 01: Types as Receipts

**Rewrite level: Heavy**

### What stays
- The pattern explanation (parsing is validation that changes the type)
- The Effect Schema section (one definition, three derivations)
- The duplication problem (type + validator + error messages drifting)
- The context compaction / lost receipts concept
- The "separating concerns" refactor of the main loop
- The pipeline extraction pattern (CheckResult, preTurnChecks)

### What changes

**The MVP.** Currently: a naive column classifier that produces darwinkit.yaml. Replace with: a naive archive packager that reads validated DwC files and generates an EML document + meta.xml + zip. The naive version hardcodes archive structure, concatenates strings for EML, doesn't validate, and has no confirmation gates.

**The Config schema.** The harness config (sourceDir, outputDir, llm params, tools) stays structurally similar. Rename tool-specific fields:
- `shell` → probably remove (no external CLI)
- `fileWrite` → `archiveWrite`
- Keep `fileRead`, `userPrompt`

**The stub tools.** Replace:
- `shell` stub (was: `darwinkit validate config.yaml`) → remove or replace with a generic utility
- `fileWrite` stub → `archiveWrite` stub (writes meta.xml, eml.xml)
- `fileRead` stays (reads CSVs)
- `userPrompt` stays

**The canned LLM responses.** Update to reflect archive packaging tasks instead of column classification.

**The audit section.** Currently adds a confirmation gate for low-confidence classifications. Replace with: adding a confirmation gate for inferred metadata. The agent computes a geographic bounding box from coordinate columns but doesn't ask the user if it's correct — the box might include outlier coordinates, or the user might want it to cover their intended study area rather than just the data extent.

The seven fragilities map directly:
1. "Config type and validator disagree" → same, generic
2. "Nothing proves the user was consulted" → inferred metadata accepted without confirmation
3. "Every error is the same string" → same, generic
4. "The conversation has no protocol" → same
5. "Every tool is always available" → same
6. "Budget enforcement is an afterthought" → same
7. "Context compaction is brittle" → confirmation of inferred metadata lost during compaction

**The receipt chain.** Replace:
- `SourceFileSchema` → stays, but rename to emphasize archive source inspection
- `SemanticClassificationSchema` → `ArchiveStructureSchema` (core type, extensions, row types)
- `UserConfirmationSchema` → stays, now confirms inferred metadata + archive structure
- `UserResponseSchema` → stays, gap-filling answers
- `ColumnMappingSchema` → `MetadataRecordSchema` (requires confirmed metadata receipts)
- `DarwinKitConfigSchema` → `ArchiveManifestSchema` (meta.xml + eml.xml structure)

**The receipt chain narrative.** Instead of "a ColumnMapping requires a SemanticClassification receipt," the story is: an `ArchiveManifest` requires `ConfirmedMetadata` receipts — proof that inferred geographic coverage was verified, that the user-provided abstract was reviewed, that the archive structure was approved. Multiple receipt types feed into the manifest, each proving a different kind of verification happened.

**LLMResponse schema.** Stays the same — this is generic.

**Context compaction.** The receipt preservation concept is identical. The example changes: instead of losing a column classification receipt, compaction loses an `InferredMetadata` receipt for the geographic bounding box. The agent re-infers it (wasteful) or proceeds without confirmation (dangerous — the bounding box included an outlier coordinate at [0, 0] that makes the coverage span the entire globe).

**Scaling section.** Instead of adding a `webFetch` tool for reference taxonomies, add a `SchemaRegistry` tool for fetching controlled vocabulary terms (EML keywords, DwC term URIs). Same pattern: add a config schema + result schema, the type updates, the decoder checks it.

### Post 01 ends with

Same structure: four fragilities fixed (validation that changes type, proof of user consultation, receipt-preserving compaction), four deferred to subsequent posts (generic errors, no protocol, ambient authority, budget).

---

## Post 02: Making Illegal States Unrepresentable

**Rewrite level: Moderate**

### What stays
- The opening problem (ToolResult with ok/data/error/timedOut booleans)
- The pattern (discriminated unions, exhaustive matching, switch + never)
- The ToolResult union (Success/Timeout/ExecutionError) — this is generic
- The before/after comparison structure
- The scaling argument (add a variant, compiler breaks incomplete handlers)
- Effect's TaggedError section

### What changes

**HarnessError union.** Replace 8 variants:

Old → New:
- `SourceParseFailure` → `SourceInspectionFailure` (file couldn't be read/parsed for inspection)
- `ClassificationFailure` → `StructureDeterminationFailure` (couldn't determine archive structure)
- `UnknownDwCTerm` → `UnknownTermURI` (meta.xml references a DwC term URI that doesn't exist) — or remove if term URIs are validated by schema
- `ConfirmationTimeout` → stays
- `ConfigGenerationError` → `ArchiveGenerationError`
- `ValidationFailure` → stays, but carries `ArchiveViolation[]` instead of `FieldViolation[]`
- `ShellError` → remove (no external CLI) or replace with `XMLParseError`
- `BudgetExhausted` → stays

**FieldViolation → ArchiveViolation (the nested union centerpiece).** Replace:

Old → New:
- `RangeViolation` (latitude outside [-90,90]) → `SchemaViolation` (malformed XML element, missing required attribute, wrong element order)
- `FormatViolation` (date in wrong format) → `CrossReferenceViolation` (meta.xml declares column "scientificname" but CSV header is "scientificName" — case mismatch; or meta.xml references a file not in the archive)
- `RequiredFieldViolation` (missing basisOfRecord) → `CompletenessViolation` (geographic coverage section missing when coordinate data exists; temporal coverage missing when date columns exist)
- `UniquenessViolation` → possibly keep (duplicate column declarations in meta.xml)
- `ForeignKeyViolation` → `ReferentialViolation` (extension file references core IDs that don't exist in the core file)

Each violation still carries exactly the data needed for recovery:
- `SchemaViolation`: element path, expected structure, actual structure
- `CrossReferenceViolation`: meta.xml field name, CSV header, file path
- `CompletenessViolation`: missing section name, triggering data characteristic (e.g., "coordinates exist")
- `ReferentialViolation`: extension file, foreign key field, missing ID value

Recovery paths:
- `SchemaViolation` → LLM regenerates the malformed EML section
- `CrossReferenceViolation` → correct the field name in meta.xml (possibly needs re-inspection of CSV)
- `CompletenessViolation` → go back to gathering to collect the missing metadata from the user
- `ReferentialViolation` → flag data integrity issue, may need user intervention

**The describeViolation function.** Update with new variants, same exhaustive switch pattern.

**The before/after comparison.** Replace the `classifyAndMap` example:
- Before: a function that generates EML by string concatenation, catches generic errors, silently drops invalid metadata
- After: tagged error union with explicit handling per phase

**Effect TaggedError section.** Update class names and fields. Same structural point.

**The classifyColumns Effect type signature example.** Replace with an archive-relevant function, e.g.:

```ts
type GenerateEML = Effect<
  EMLDocument,
  SchemaViolation | CompletenessViolation | ArchiveGenerationError,
  never
>;
```

**Closing line.** Update: "Next: State Machines and Lifecycle — the Darwin Core Archive agent's lifecycle..."

---

## Post 03: State Machines and Lifecycle

**Rewrite level: Moderate**

### What stays
- The problem statement (lifecycle scattered across if/else chains)
- The pattern explanation (state machines make lifecycle explicit)
- The machine code structure (setup, guards, actions, createMachine)
- `RevisionRecord` interface — unchanged
- `computeStallConfidence` — unchanged (completely domain-agnostic)
- The circuit breaker guard — unchanged
- The revision loop and stall detection section — unchanged
- The before/after comparison structure
- The interactive visualization concept

### What changes

**Machine states.** Rename per the mapping table above. The machine definition code gets new state names and event names but the same structure.

**Events.** Rename:
- `START` → stays
- `SOURCES_FOUND` → `INSPECTION_COMPLETE`
- `NO_SOURCES` → `INSPECTION_FAILED`
- `ALL_CLASSIFIED_HIGH` → `STRUCTURE_DETERMINED` (or split: `STRUCTURE_CLEAR` / `STRUCTURE_AMBIGUOUS`)
- `HAS_LOW_CONFIDENCE` → `NEEDS_CONFIRMATION` (inferred metadata needs user review)
- `GATES_CLEARED` → stays
- `USER_REJECTED` → stays (user rejects inferred metadata, back to gathering/structuring)
- `MAPPINGS_READY` → `METADATA_COMPLETE`
- `CONFIG_WRITTEN` → `ARCHIVE_GENERATED`
- `VALIDATION_PASS` / `VALIDATION_FAIL` / `VALIDATION_ERROR` → stay
- `REVISED` → stays
- `CANCEL` → stays

**Actions.** Rename to match:
- `recordSources` → `recordInspection`
- `recordClassificationHigh` / `recordClassificationLow` → `recordStructure` / `recordMetadataGathered`
- `recordGateCleared` → stays
- `recordRevisionOutcome` → stays (completely generic)

**Context fields.** Some rename:
- `columnsTotal` → `filesTotal` or `sourceFilesCount`
- `columnsClassified` → `metadataFieldsResolved` or similar
- `lowConfidenceCount` → `unconfirmedCount`
- `gatesCleared` → stays
- Revision context fields all stay as-is

**The walkthrough.** Rewrite to walk through a concrete archive packaging execution. Same structure: each transition explained with domain context.

**The "what the machine gives you" section.** Stays almost verbatim — runtime behavior, TypeScript types, visual documentation, test paths. Update the specific examples.

**The scaling section.** The "user rejects proposed classifications" example becomes "user rejects inferred geographic coverage" — back to gathering for re-inference or manual entry. Same pattern, different domain.

**The interactive visualization.** Update AgentLifecycle.vue for the new machine definition. The event buttons in the walkthrough change names.

---

## Post 04: Encoding Protocols in State

**Rewrite level: Moderate**

### What stays
- The problem statement (machine absorbs invalid transitions at runtime, but can't prevent writing invalid code)
- The pattern (typestate makes available operations depend on current state)
- The honesty section about TypeScript's typestate limitations
- The before/after comparison structure
- The revision loop extension

### What changes

**The protocol rules.** Replace:

Old:
1. Can't classify without parsed sources
2. Can't generate config without clearing confidence gates
3. Can't skip classification
4. Can't validate without generating from cleared gates

New:
1. Can't determine structure without inspected data
2. Can't generate archive without confirmed metadata
3. Can't skip metadata gathering
4. Can't validate without generating from confirmed state

**Workflow type parameter.** Replace states:

```ts
type Workflow<S extends
  | "initial"
  | "dataInspected"
  | "structureDetermined"
  | "metadataGathered"
  | "metadataConfirmed"
  | "archiveGenerated"
  | "validated"
> = { ... };
```

**Workflow fields.** Replace:

```ts
{
  readonly _state: S;
  readonly sources: ReadonlyArray<ValidatedSource>;
  readonly structure: ArchiveStructure | null;
  readonly inferredMetadata: ReadonlyArray<InferredMetadata>;
  readonly userMetadata: ReadonlyArray<UserProvidedMetadata>;
  readonly confirmations: ReadonlyArray<UserConfirmation>;
  readonly archive: ArchiveManifest | null;
  readonly validation: ValidationResult | null;
}
```

**Transition functions.** Replace:

```ts
function initial(): Workflow<"initial">
function inspectData(w: Workflow<"initial">, sources: ValidatedSource[]): Workflow<"dataInspected">
function determineStructure(w: Workflow<"dataInspected">, structure: ArchiveStructure): Workflow<"structureDetermined">
function gatherMetadata(w: Workflow<"structureDetermined">, metadata: MetadataRecord): Workflow<"metadataGathered">
function confirmMetadata(w: Workflow<"metadataGathered">, confirmations: UserConfirmation[]): Workflow<"metadataConfirmed">
function generateArchive(w: Workflow<"metadataConfirmed">): Workflow<"archiveGenerated">
function recordValidation(w: Workflow<"archiveGenerated">, result: ValidationResult): Workflow<"validated">
```

Key constraint: `generateArchive` requires `Workflow<"metadataConfirmed">`.

**The "before" bug.** Replace: instead of skipping confirmation on column classifications (leading to wrong DwC terms), the code skips confirmation on inferred metadata (leading to incorrect geographic coverage in the published EML — the bounding box includes an outlier at [0,0] and the published dataset claims to cover the entire globe, or the temporal extent is wrong because the agent misinterpreted a date column).

The consequence is similar in severity: the archive validates against the EML schema (the XML is structurally correct) but the metadata is semantically wrong. Other researchers discover the dataset when searching for data from the equator, but the actual data is from British Columbia. The dataset's credibility is damaged.

**The revision loop typestate.**

```ts
function beginRevision(
  w: Workflow<"validated">,
  diagnosis: RevisionDiagnosis
): Workflow<"revising">

function completeRevision(
  w: Workflow<"revising">,
  updatedMetadata: MetadataRecord
): Workflow<"metadataConfirmed">
```

Same insight: revision goes back through the confirmation gate. If the revision changes any metadata, those changes must be confirmed before a new archive is generated.

---

## Post 05: Capabilities and Effects

**Rewrite level: Moderate (improved)**

### What stays
- The problem statement (hidden side effects, ambient authority)
- The pattern (capability-passing + effect tracking)
- The plain TypeScript capability-passing section
- The Effect Layer system section
- Effect propagation through call graph
- The before/after comparison (dispatchTool vs phase-scoped layers)
- The thinking vs acting distinction

### What changes

**Tool interfaces.** Replace:

```ts
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

Note: `Shell` is gone. No external CLI tool.

**Phase-scoped capabilities.**

```ts
// Inspection — read source files
const inspectionLayer = Layer.mergeAll(FileReaderLive);

// Structuring — LLM reasoning + user questions about archive layout
const structuringLayer = Layer.mergeAll(UserPromptLive);

// Gathering — user interview + read data for inference
const gatheringLayer = Layer.mergeAll(UserPromptLive, FileReaderLive);

// Confirmation — user reviews and approves
const confirmationLayer = Layer.mergeAll(UserPromptLive);

// Generation — write archive components
const generationLayer = Layer.mergeAll(ArchiveWriterLive);

// Validation — pure computation, no capabilities
// (no layer needed — R is `never`)
```

The validation phase having NO capabilities is the cleanest example in the series. Emphasize this. The old version needed Shell for DarwinKit CLI — the new version proves validation can be pure.

**The "thinking vs acting" section.** Replace the classifier example with the EML content authoring function:

```ts
function composeEMLMetadata(
  confirmedMetadata: ConfirmedMetadata,
  archiveStructure: ArchiveStructure,
): Effect<EMLDocument, ArchiveGenerationError, never> {
  // Pure. Takes confirmed metadata, produces EML structure.
  // Cannot read files, cannot write files, cannot prompt user.
}
```

And the metadata inference function:

```ts
function inferGeographicCoverage(
  sources: ReadonlyArray<ValidatedSource>,
): Effect<GeographicCoverage, InferenceError, FileReaderTag> {
  // Needs FileReader to read coordinate columns.
  // Cannot write files. Cannot prompt user.
}
```

The contrast is sharper: inference needs FileReader (read-only), authoring is pure, writing needs ArchiveWriter. Three phases, three different capability profiles, zero overlap between writing and reading.

**The before/after.** Same dispatchTool example (it's generic), but the "after" example emphasizes that the LLM hallucinates a file write during EML authoring and there's nothing to route it to.

**The scaling section.** Replace the audited ConfigWriter with an audited ArchiveWriter:

```ts
const AuditedArchiveWriter = Layer.map(ArchiveWriterLive, (writer) => ({
  writeEML: (path, eml) =>
    AuditLog.record("emlWrite", { path, timestamp: Date.now() }).pipe(
      Effect.flatMap(() => writer.writeEML(path, eml)),
    ),
  // ... same for writeMetaXML and assembleArchive
}));
```

---

## Post 06: Specification and Generation

**Rewrite level: Heavy**

### What stays
- The problem statement (bag of strings and hope)
- The structure: spec table → test invariants → the mold → generation in practice → what the compiler caught → what's left to review → scaling
- The core claim (structural constraints reduce review surface)

### What changes

**The spec table.** Update all references:

| Component | Constraint Source | Key Definition |
|-----------|-----------------|----------------|
| Parse boundaries | Post 1 | `ValidatedSourceSchema`, `ArchiveStructureSchema`, `MetadataRecordSchema`, `ArchiveManifestSchema` |
| Error model | Post 2 | `HarnessError` tagged union, `ArchiveViolation` nested union |
| Agent lifecycle | Post 3 | XState machine (new states) |
| Workflow protocol | Post 4 | Workflow typestate accumulator (new states) |
| Phase capabilities | Post 5 | `FileReader`, `ArchiveWriter`, `UserPrompt` via Layers |

**Test invariants.** Update:
- The workflow never enters `archiveGenerated` without `metadataConfirmed`
- Budget limits enforced
- Every error variant reaches a defined recovery or terminal
- Archive generation never occurs outside the `generating` state
- Validation functions have `never` in requirements — no side effects
- Every LLM-authored metadata field is validated against the relevant schema before inclusion in the archive

**The generation target.** Replace the column classifier with the **EML metadata composer** — the function that takes confirmed metadata and produces an EML XML document. This sits at the intersection of all constraints:

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

- Input: `ConfirmedMetadata` — already decoded, receipts intact (Post 1)
- Output: `EMLDocument` — must conform to EML XML Schema
- Errors: two tagged variants (Post 2)
- Effects: `never` — pure computation (Post 5)
- State guard: only callable in `generating` (Post 3)
- Typestate: requires `Workflow<"metadataConfirmed">` (Post 4)

**First attempt and compiler errors.** Generate an EML composer that:
1. Tries to construct an `ArchiveManifest` without confirmed metadata receipt → type error (Post 1)
2. Uses a non-existent EML element name → caught by schema literal (Post 1)
3. Calls `generateArchive` from `Workflow<"metadataGathered">` → typestate error (Post 4)
4. Misuses the XML builder API → type error

**What's left to review.** Replace the three items:
1. **Abstract quality** — the LLM authored an abstract from the user's description and the data characteristics. Is it accurate? Appropriate for the audience? This is genuine language quality judgment.
2. **Keyword selection** — the LLM selected keywords from GBIF's controlled vocabulary. Are they the most appropriate terms? Are important keywords missing?
3. **Coverage granularity** — the geographic coverage could be a bounding box or a set of named regions. The temporal coverage could be a single range or multiple collection events. How fine-grained should the metadata be? This depends on the publication context.

Three review items. Each is a genuine decision that requires domain judgment. Everything else was forced by the specification.

**Scaling section.** Replace OBIS/GBIF profiles with different publication target profiles:

```ts
const gbifProfile = {
  target: "gbif",
  requiredEMLSections: ["geographic", "temporal", "taxonomic", "contact", "methods"],
  controlledVocabularies: { keywords: "gbif-thesaurus" },
  archiveType: "occurrence",
};

const obisProfile = {
  target: "obis",
  requiredEMLSections: ["geographic", "temporal", "taxonomic", "contact", "methods", "sampling"],
  controlledVocabularies: { keywords: "obis-thesaurus" },
  archiveType: "event-with-extensions",
};

const dataOneProfile = {
  target: "dataone",
  requiredEMLSections: ["geographic", "temporal", "contact", "intellectualRights"],
  controlledVocabularies: { keywords: "none" },
  archiveType: "occurrence",
};
```

Same machine, same error model, same typestate, same capabilities. Different EML requirements, different validation rules, different required sections.

---

## Post 07: Verification

**Rewrite level: Moderate**

### What stays
- The three-strategy structure (property-based, model-based, fault injection)
- The mapping of strategies to architectural layers
- The counterexample concept
- The fix cycle section
- The series conclusion

### What changes

**Property-based testing examples.** Replace column classification properties with:

1. **EML generation.** For all sets of confirmed metadata, the EML composer produces XML that validates against the EML schema. Counterexample: a metadata record with a geographic bounding box where west > east — the composer generates XML the schema rejects.

2. **Meta.xml generation.** For all archive structures, the generated meta.xml declares fields that exist in the actual CSV headers. Counterexample: an extension file where the LLM-generated meta.xml uses camelCase (`scientificName`) but the CSV header is lowercase (`scientificname`).

3. **Cross-validation.** For all generated archives, the taxonomic coverage in EML reflects species actually present in the data. Counterexample: the EML lists taxa inferred from column headers rather than actual values — it claims coverage of "scientificName" the column rather than "Quercus robur" the species.

**Model-based testing paths.** Update state names in all paths:

- Happy path: `idle → inspecting → structuring → gathering → confirming → generating → validating → complete`
- Confirmation rejection: `gathering → confirming → [USER_REJECTED] → gathering` (user rejects inferred bounding box, agent re-infers)
- Revision loop: `validating → revising → generating → validating → complete`
- Circuit breaker: same concept, new state names

**Fault injection.** Replace:

- `ValidationFailure`: provide deliberately bad EML — missing required geographic coverage when coordinates exist, malformed contact element, invalid XML namespace. Assert each violation type is identified and routed correctly.
- `SchemaViolation` on geographic coverage → LLM regenerates the coverage element
- `CrossReferenceViolation` → correct the field name mismatch between meta.xml and CSV
- `CompletenessViolation` on temporal coverage → route back to gathering to ask the user for date range
- `ConfirmationTimeout`: same as before
- Remove `ShellError` / DarwinKit exit code examples
- Contract violation example: raw `Error("XML parse failed")` instead of typed `SchemaViolation`. Same concept — Effect surfaces it as an untagged defect.

**The punchline table.** Update:

| Strategy | Layer | Contract |
|---|---|---|
| Property tests | Parse boundaries | "For all metadata inputs, the EML composer produces valid XML or rejects with a typed error." |
| Model-based tests | State machine | "Every reachable state is visited, every transition is valid, every path terminates." |
| Fault injection | Error model | "Every ArchiveViolation variant is handled, reaches the correct recovery state, produces correct behavior." |

**Series conclusion.** Update "DarwinKit configuration agent" to "Darwin Core Archive agent." The conclusion text is mostly generic and needs minimal changes.

---

## Cross-cutting notes

### Things to grep and replace globally
- `DarwinKit` / `darwinkit` / `darwinKit` → context-dependent replacement
- `darwinkit.yaml` → `meta.xml` / `eml.xml` / "archive" depending on context
- `ColumnMapping` → `MetadataRecord` or similar
- `SemanticClassification` → `ArchiveStructure` or `InferredMetadata` depending on context
- `DarwinKitConfig` → `ArchiveManifest`
- `ConfigWriter` → `ArchiveWriter`
- References to "column classification" → phase-appropriate replacement

### The naive example in examples/naive/
The file `examples/naive/darwinkit-naive.ts` needs rewriting to be a naive archive packager.

### The test file
`agentMachine.test.ts` needs updating for new state names and events.

### The Vue component
`AgentLifecycle.vue` needs updating for the new machine definition.

### Order of operations
Recommend revising in this order:
1. Post 03 first — the machine definition drives everything else
2. Post 01 — the schemas and receipts that the machine references
3. Post 02 — the error model
4. Post 04 — typestate (depends on schema types from 01)
5. Post 05 — capabilities (depends on tool interfaces)
6. Post 06 — specification (references everything)
7. Post 07 — verification (references everything)
