---
title: "Program Verification"
date: "2026-03-17T00:00:00.000Z"
slug: "verification"
description: "Verifying the Darwin Core Archive agent through property-based testing, model-based testing, and fault injection."
draft: true
---

# Program Verification

> Part 7 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

Post 6 showed that the specification constrains generation --- the compiler catches structural violations, and the review surface narrows to genuine design decisions. But compiled, type-checked code is not necessarily correct. The EML composer might produce valid XML that happens to describe the wrong geographic coverage. The state machine might accept a transition sequence that's valid per the definition but produces garbage output. Verification audits what remains after the structural constraints have done their work.

This post covers three testing strategies. Each targets a specific architectural layer. Each is derived from or checked against the definitions from Post 6. The tests don't exist independently of the architecture --- they're consequences of it.

## Strategy 1: Property-Based Testing (fast-check)

### What it targets: Parse boundaries (Post 1)

Property-based testing generates thousands of random inputs and checks that invariants hold for all of them. It doesn't test specific examples --- it tests properties. "For all possible inputs, the composer either produces valid XML or rejects with a specific tagged error. No third outcome."

This strategy exists to hammer the parse boundaries from Post 1. The schema defines what's valid. Property tests verify that the composers and generators actually enforce it --- that a bounding box with inverted coordinates is rejected, that a field name mismatch between meta.xml and CSV is caught, that EML with fabricated taxa fails validation. This is verification across a space of inputs far larger than any human would write by hand.

### The Properties

**EML generation.** Generate random sets of confirmed metadata: geographic bounding boxes with valid and invalid coordinate ranges, temporal coverages with varying date formats, taxonomic coverages with real and fabricated species names, contact elements with missing fields.

Property: for all sets of confirmed metadata, the EML composer produces XML that validates against the EML schema or rejects with a typed error. No malformed XML escaping to disk. No silent schema violations.

```ts
fc.assert(
  fc.property(arbitraryConfirmedMetadata, (metadata) => {
    const result = Effect.runSyncExit(composeEML(metadata));
    return (
      (Exit.isSuccess(result) && validateAgainstEMLSchema(result.value)) ||
      Exit.isFailure(result)
    );
    // the real assertions also check:
    // - Success values pass the EML XML Schema
    // - Failure values are SchemaViolation or CompletenessViolation with diagnostics
    // - no side effects occur during composition
  })
);
```

The interesting part is the *generator*. `arbitraryConfirmedMetadata` produces inputs that are plausible --- structurally similar to real biodiversity metadata but with targeted corruptions. A bounding box where west longitude exceeds east. A temporal coverage with end date before start date. A contact element with an email address but no name. The generator is informed by the schema --- it knows the valid shape and systematically deforms it.

**Meta.xml generation.** Generate random archive structures: varying numbers of extension files, different core types, CSV files with headers in different casing conventions, fields with and without defined terms.

Property: for all archive structures, the generated meta.xml declares fields that exist in the actual CSV headers. Every `<field>` element in meta.xml corresponds to a column that's present in the data file it references.

```ts
fc.assert(
  fc.property(arbitraryArchiveStructure, (structure) => {
    const metaXml = generateMetaXml(structure);
    const declaredFields = parseFieldDeclarations(metaXml);
    return declaredFields.every(
      (field) =>
        structure.files[field.filePath].headers.includes(field.term) ||
        structure.files[field.filePath].headers.includes(
          field.term.toLowerCase()
        )
    );
  })
);
```

This catches a category of bug that's invisible to type-checking: the LLM generates a meta.xml with camelCase field names (`scientificName`) but the actual CSV header is lowercase (`scientificname`). The meta.xml is valid XML. The field name is a real Darwin Core term. But the archive is broken --- the declared field doesn't match the actual header.

**Cross-validation.** Generate random archives with taxonomic data: CSV files containing species occurrence records, EML documents with taxonomic coverage sections, varying overlap between taxa in data and taxa declared in metadata.

Property: for all generated archives, the taxonomic coverage in EML reflects species actually present in the data. The taxa listed in the EML's `taxonomicCoverage` element are values found in the data, not column header names or inferred categories.

```ts
fc.assert(
  fc.property(arbitraryArchiveWithTaxa, (archive) => {
    const emlTaxa = extractTaxaCoverage(archive.eml);
    const dataTaxa = extractTaxaFromData(archive.coreFile);
    return emlTaxa.every((taxon) => dataTaxa.includes(taxon));
  })
);
```

### Counterexamples

Every property failure produces a minimal counterexample. fast-check shrinks the failing input to the smallest case that still fails.

**EML generation** fails on:

```ts
{
  geographic: {
    westBoundingCoordinate: 15.5,
    eastBoundingCoordinate: 10.2,
    // west > east — invalid bounding box
  }
}
```

The counterexample is specific: a metadata record with a geographic bounding box where the western boundary exceeds the eastern boundary. The composer generates XML --- the coordinates are valid numbers, the element structure is correct. But the EML schema rejects it because the bounding box is geometrically invalid.

**Meta.xml generation** fails on:

```ts
{
  extensionFile: "identification.csv",
  headers: ["scientificname", "identifiedby", "dateidentified"],
  metaXmlFields: ["scientificName", "identifiedBy", "dateIdentified"]
  // camelCase in meta.xml, lowercase in CSV
}
```

The LLM-generated meta.xml uses standard Darwin Core camelCase (`scientificName`) but the CSV header is lowercase (`scientificname`). The meta.xml is well-formed XML. The field names are valid Darwin Core terms. But the archive is broken --- the declared fields don't match the actual headers.

**Cross-validation** fails on:

```ts
{
  emlTaxonomicCoverage: ["scientificName", "kingdom", "phylum"],
  // these are column headers, not species names
  actualSpeciesInData: ["Quercus robur", "Pinus sylvestris", "Betula pendula"]
}
```

The EML lists taxa inferred from column headers rather than actual values --- it claims coverage of "scientificName" the column rather than "Quercus robur" the species. The EML is valid XML. The taxonomic coverage element is structurally correct. But the content is semantically wrong --- the metadata describes the data's shape instead of its contents.

Each counterexample is structured, actionable feedback. Not "the test failed" but "here's the minimal input that broke the property, here's which boundary it crossed, here's what went wrong." An LLM can use this to self-correct: the failing input, the expected behavior, and the constraint it violated are all present. The repair is targeted, not exploratory.

## Strategy 2: Model-Based Testing (XState)

### What it targets: The state machine (Post 3)

Model-based testing generates test paths from the machine definition and walks every reachable state. The machine is the source of truth --- the tests are derived from it.

XState's model-based testing tooling generates paths: sequences of events that visit every state and exercise every transition. Each path is a test case. All paths are generated from the machine definition --- you don't write them by hand. The confirmation gate can't be bypassed. The revision loop terminates. The circuit breaker trips when stall confidence is high. These guarantees fall out of the machine definition, not out of manually authored test cases.

Adding a state to the machine automatically generates new paths that exercise it. An LLM assisting with development doesn't write test paths --- they're derived from the spec. The development loop closes on the definition, not on the test suite.

### The Paths

**Happy path.** `idle → inspecting → structuring → gathering → confirming → generating → validating → complete`.

Assert: the context at each stage reflects the expected state. Assert: each event carries valid data for its transition. Assert: the final state is `complete` with a valid archive.

**Confirmation rejection.** `gathering → confirming → [USER_REJECTED] → gathering → confirming → [CONFIRMED] → generating`.

The user rejects the inferred bounding box. The machine returns to `gathering`, the agent re-infers geographic coverage from the data, and the user confirms the corrected values. Assert: the machine re-enters `gathering` on rejection. Assert: re-inference can produce different metadata (the agent retries with adjusted parameters). Assert: the confirmation gate cannot be skipped --- there is no transition from `gathering` to `generating` without passing through `confirming`.

**Revision loop.** `validating → revising → generating → validating → complete`.

Assert: `recordRevisionOutcome` fires on the transition to `revising`. Assert: `revisionRound` increments. Assert: `stallConfidence` is recomputed from the sliding window. Assert: the final validation passes.

**Circuit breaker.** Configure `breakerThreshold: 3`. Walk the revision loop with repeated failures where `stallConfidence` is high --- same violations reappearing, no improvement in violation count. Assert: when `revisionRound * stallConfidence > breakerThreshold`, the `always` guard on `revising` fires and the machine transitions immediately to `failed`.

Assert: this holds regardless of the specific violations or revision attempts. The breaker is structural --- it reads context, not implementation details.

**Specification gaps.** The generated code emits an event the machine doesn't handle. XState absorbs it silently --- safe behavior, no crash. But the model-based test flags it: an event was sent that produced no transition. This is a specification gap. The machine definition is incomplete --- either the event shouldn't be emitted (bug in the code) or the machine should handle it (gap in the spec).

## Strategy 3: Fault Injection

### What it targets: The error model (Post 2)

Fault injection triggers every tagged error variant deliberately. Deliberately bad EML with missing required elements. A meta.xml with field names that don't match CSV headers. A simulated user timeout. The goal: verify that each error is handled, reaches the correct state, and produces the correct recovery behavior.

### The Injections

**`ValidationFailure`:** Provide deliberately bad EML --- missing required geographic coverage when the archive contains coordinate data, a malformed contact element with an email but no name, an invalid XML namespace declaration. Assert: each violation type is identified and routed correctly.

Assert: `SchemaViolation` on geographic coverage --- the EML element is structurally malformed --- triggers the LLM to regenerate the coverage element. The violation carries `elementPath`, `expected`, and `actual`, so the LLM knows exactly which element is wrong and what it should look like.

Assert: `CrossReferenceViolation` on a field name mismatch between meta.xml and CSV --- the meta.xml declares `scientificName` but the CSV header is `scientificname` --- triggers correction of the field declaration. The violation carries the meta.xml field, the CSV header, and the file path.

Assert: `CompletenessViolation` on temporal coverage --- the archive contains date data but the EML has no temporal coverage section --- routes back to `gathering` to ask the user for the date range. The violation carries the missing section name and the characteristic that triggered the requirement.

**`ConfirmationTimeout`:** Simulate user non-response during the confirmation gate. Assert: the machine transitions from `confirming` to `failed` via the `CONFIRMATION_TIMEOUT` event. Assert: partial work is preserved --- the gathered metadata is available for retry. Assert: the timeout duration is configurable and the timeout fires after the configured interval, not before.

### Contract Violations

The most interesting fault injection test is the one that catches a contract violation: generated code throws a raw `Error("XML parse failed")` instead of returning a `SchemaViolation`.

The Effect runtime surfaces this as an *untagged defect* --- a type-level contract violation. The error channel declared `SchemaViolation | CompletenessViolation`, but an untagged `Error` escaped. Effect distinguishes between expected errors (the tagged union) and unexpected defects (things that shouldn't happen).

The fix is mechanical: wrap the raw error in the tagged class, routing it into the typed error channel. An LLM generating the fix needs only the error type and the contract --- the Effect runtime surfaces the violation precisely, and the tagged union defines what the fix must produce. The test verifies that after the fix, the same raw `Error` is caught and wrapped. The harness never surfaces untagged defects to the agent.

## The Punchline

Each strategy targets a different layer:

| Strategy | Layer | Contract |
|---|---|---|
| **Property tests** | Parse boundaries | "For all metadata inputs, the EML composer produces valid XML or rejects with a typed error." |
| **Model-based tests** | State machine | "Every reachable state is visited, every transition is valid, every path terminates." |
| **Fault injection** | Error model | "Every `ArchiveViolation` variant is handled, reaches the correct recovery state, produces correct behavior." |

Every failure is legible. It traces to a specific definition and a specific contract:

- A property test failure traces to a schema (Post 1). The EML composer produced a bounding box where west exceeds east. The meta.xml generator declared fields that don't match CSV headers. The taxonomic coverage listed column names instead of species.
- A model-based test failure traces to the machine definition (Post 3). The confirmation gate was bypassed. The revision loop didn't terminate. The circuit breaker didn't trip when stall confidence was high.
- A fault injection failure traces to the error model (Post 2). A `SchemaViolation` on geographic coverage wasn't routed to regeneration. A `CompletenessViolation` on temporal coverage didn't return to `gathering`. A raw `Error` escaped instead of a typed `SchemaViolation`.

Contrast with a typical agent harness where a failure surfaces as "the agent did something weird." Debugging means reading conversation logs, reconstructing state in your head, and guessing which of several hundred lines of loosely typed code misbehaved.

In the Darwin Core Archive agent, the failure tells you where to look. The definitions tell you what's correct. The fix is mechanical.

## The Fix Cycle

The LLM receives a failure:

- A minimal counterexample from a property test: "this metadata record with west > east bounding coordinates produced XML the EML schema rejects."
- An unreachable state from model-based testing: "the `confirming` state was bypassed when unconfirmed metadata existed."
- An unhandled error tag from fault injection: "raw `Error("XML parse failed")` escaped instead of `SchemaViolation`."

Each failure points to a specific definition. The LLM generates a corrected implementation against the same constraints that produced the original. The constraints haven't changed --- only the implementation within them.

The fix cycle is mechanical because the architecture makes diagnosis and repair separable from understanding the whole system. The LLM doesn't need to comprehend the full harness to fix a schema boundary. It needs the schema, the failing input, and the expected behavior. The constraints provide the context.

## Demo: XState Inspector

[Interactive statechart --- third appearance]

Model-based test paths visualized on the machine. The reader watches the test walker traverse states:

- Green highlights: states and transitions that have been exercised by the test suite.
- Red highlights: states that should be reachable but weren't reached (specification gaps).
- Animated path walk: the happy path plays through, then the confirmation loop, then the revision loop with circuit breaker termination.

The reader sees the test suite's coverage mapped directly onto the machine definition. The visualization answers "how much of the spec is tested?" without requiring the reader to mentally map test names to machine states.

---

## Series Conclusion

The series thesis: **define once, derive everything.**

A schema defines valid data. The type, the decoder, and the error reporting are derived from it (Post 1). A union defines valid states. Exhaustive matching requirements are derived from it (Post 2). A machine definition derives runtime behavior, types, documentation, and test paths (Post 3). A typestate protocol defines valid transitions. The API surface at each state is derived from it (Post 4). Capability interfaces and effect signatures define what code can do. The compiler enforces the boundaries (Post 5).

For LLMs generating code against these definitions, the consequence is direct: the fewer independent artifacts to reconcile, the more likely the output is correct. When there is one source of truth and multiple enforcement layers derived from it, the LLM operates in a tightly constrained space. Most mistakes are structural failures --- caught by the compiler, the runtime, or the test suite --- rather than silent semantic errors.

The Darwin Core Archive agent is a demonstration. The same principles apply to any system where an LLM generates code: define the constraints first, derive everything from them, and let the structure do the work that humans and LLMs will inevitably fail to do by hand.
