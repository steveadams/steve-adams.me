---
title: "Program Verification"
date: "2026-03-17T00:00:00.000Z"
slug: "verification"
description: "Verifying the DarwinKit configuration agent through property-based testing, model-based testing, and fault injection."
draft: true
---

# Program Verification

> Part 7 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

Post 6 showed that the specification constrains generation --- the compiler catches structural violations, and the review surface narrows to genuine design decisions. But compiled, type-checked code is not necessarily correct. The classifier might produce valid `SemanticClassification` values that happen to map every column to the wrong Darwin Core term. The state machine might accept a transition sequence that's valid per the definition but produces garbage output. Verification audits what remains after the structural constraints have done their work.

This post covers three testing strategies. Each targets a specific architectural layer. Each is derived from or checked against the definitions from Post 6. The tests don't exist independently of the architecture --- they're consequences of it.

## Strategy 1: Property-Based Testing (fast-check)

### What it targets: Parse boundaries (Post 1)

Property-based testing generates thousands of random inputs and checks that invariants hold for all of them. It doesn't test specific examples --- it tests properties. "For all possible inputs, the parser either produces a valid typed value or rejects with a specific tagged error. No third outcome."

This strategy exists to hammer the parse boundaries from Post 1. The schema defines what's valid. Property tests verify that the decoder actually enforces it --- that a confidence score of 1.2 is rejected, that a hallucinated DwC term is caught, that a malformed config fails to decode. This is verification across a space of inputs far larger than any human would write by hand.

### The Properties

**Column classification.** Generate random CSV column samples: headers with plausible names, headers with garbage, numeric columns, text columns, mixed-type columns, empty columns, columns with special characters and Unicode.

Property: for all CSV column samples, the classifier produces a valid `SemanticClassification` or rejects with `ClassificationFailure`. No exception. No partial classification. No hallucinated term reaching the mapping phase.

```ts
fc.assert(
  fc.property(arbitraryColumnSample, (sample) => {
    const result = Schema.decodeUnknownEither(ClassificationSchema)(
      classify(sample)
    );
    return Either.isRight(result) || Either.isLeft(result);
    // tautological on its own — the real assertions check:
    // - Right values are valid SemanticClassification members
    // - Left values are ClassificationFailure with meaningful diagnostics
    // - no side effects occur during classification
  })
);
```

The interesting part is the *generator*. `arbitraryColumnSample` produces inputs that are plausible --- structurally similar to real biodiversity data columns but with targeted corruptions. A column header "decimalLatitude" with text values. A column with a valid header but only nulls. A header that looks like a Darwin Core term but has a typo. The generator is informed by the schema --- it knows the valid shape and systematically deforms it.

**DwC term validation.** Generate random Darwin Core term references: valid terms, terms with typos, terms from obsolete versions of the standard, entirely fabricated terms that sound plausible (`coordinatePrecisionMeters`, `habitatClassification`, `specimenPreservationType`).

Property: for all generated DwC term references, the term exists in the DarwinKit spec registry or is rejected with a specific error naming the invalid term and suggesting alternatives.

```ts
fc.assert(
  fc.property(arbitraryDwCTermRef, (termRef) => {
    const result = lookupTerm(termRef);
    return (
      (result._tag === "Known" && specRegistry.has(result.term)) ||
      (result._tag === "Unknown" && result.suggestions.length >= 0)
    );
  })
);
```

This catches a category of bug that's invisible to type-checking: the classifier returns a `SemanticClassification` whose term field passes the schema (it's a string) but doesn't correspond to any real Darwin Core term. The property test verifies that the registry boundary is airtight.

**Config generation.** Generate random sets of validated column mappings: varying numbers of columns, different combinations of Darwin Core terms, optional fields present and absent, multiple source files with overlapping terms.

Property: for all sets of validated column mappings, the generated `darwinkit.yaml` is decodable by DarwinKit's `workspaceConfigSchema`. The config generator's output is always structurally valid --- if it produces output at all, that output passes schema validation.

```ts
fc.assert(
  fc.property(arbitraryValidatedMappings, (mappings) => {
    const config = generateConfig(mappings);
    const decoded = Schema.decodeUnknownEither(workspaceConfigSchema)(config);
    return Either.isRight(decoded);
  })
);
```

### Counterexamples

Every property failure produces a minimal counterexample. fast-check shrinks the failing input to the smallest case that still fails.

"For all column samples, the classifier produces a valid classification or rejects" fails on:

```ts
{
  header: "depth_m",
  values: ["12.5", "shallow", "7", "", "deep", "3.2"]
}
```

The counterexample is specific: a column with mixed numeric and text values classified as `decimalLatitude`. The generated config passes schema validation --- `decimalLatitude` is a valid DwC term, and the config structure is correct. But it fails DarwinKit's `FormatConstraint` at runtime, because `"shallow"` and `"deep"` aren't decimal numbers.

The bug is in the boundary between classification (which accepted the column) and validation (which rejected the values). The classifier saw numeric-looking data and inferred a numeric DwC term, but didn't account for the non-numeric entries. The fix: tighten the classifier to check value-type consistency, or flag mixed-type columns for user confirmation.

The counterexample is structured, actionable feedback. Not "the test failed" but "here's the minimal input that broke the property, here's which boundary it crossed, here's what went wrong." An LLM can use this to self-correct: the failing input, the expected behavior, and the constraint it violated are all present. The repair is targeted, not exploratory.

## Strategy 2: Model-Based Testing (XState)

### What it targets: The state machine (Post 3)

Model-based testing generates test paths from the machine definition and walks every reachable state. The machine is the source of truth --- the tests are derived from it.

XState's model-based testing tooling generates paths: sequences of events that visit every state and exercise every transition. Each path is a test case. All paths are generated from the machine definition --- you don't write them by hand. The confirmation gate can't be bypassed. The revision loop terminates. The circuit breaker trips when stall confidence is high. These guarantees fall out of the machine definition, not out of manually authored test cases.

Adding a state to the machine automatically generates new paths that exercise it. An LLM assisting with development doesn't write test paths --- they're derived from the spec. The development loop closes on the definition, not on the test suite.

### The Paths

**Happy path.** `idle → [START] → collecting → [SOURCES_FOUND] → classifying → [ALL_CLASSIFIED_HIGH] → mapping → [MAPPINGS_READY] → generating → [CONFIG_WRITTEN] → validating → [VALIDATION_PASS] → complete`.

Assert: the context at each stage reflects the expected state. Assert: each event carries valid data for its transition. Assert: the final state is `complete` with a valid configuration.

**Confirmation path.** `idle → collecting → classifying → [HAS_LOW_CONFIDENCE] → confirming → [GATES_CLEARED] → mapping → generating → validating → complete`.

Assert: `lowConfidenceCount` is set on the transition to `confirming`. Assert: `gatesCleared` increments when the user approves. Assert: the confirmation gate cannot be skipped --- there is no transition from `classifying` to `mapping` when low-confidence columns exist without going through `confirming`.

**User rejection loop.** `classifying → [HAS_LOW_CONFIDENCE] → confirming → [USER_REJECTED] → classifying → [HAS_LOW_CONFIDENCE] → confirming → [GATES_CLEARED] → mapping`.

Assert: the machine re-enters `classifying` on rejection. Assert: reclassification can produce different results (the classifier retries with different parameters). Assert: the loop terminates naturally --- either the classifier improves or the user accepts.

**Revision loop.** `validating → [VALIDATION_FAIL] → revising → [REVISED] → generating → [CONFIG_WRITTEN] → validating → [VALIDATION_PASS] → complete`.

Assert: `recordRevisionOutcome` fires on the transition to `revising`. Assert: `revisionRound` increments. Assert: `stallConfidence` is recomputed from the sliding window. Assert: the final validation passes.

**Circuit breaker.** Configure `breakerThreshold: 3`. Walk the revision loop with repeated failures where `stallConfidence` is high --- same violations reappearing, no improvement in violation count. Assert: when `revisionRound * stallConfidence > breakerThreshold`, the `always` guard on `revising` fires and the machine transitions immediately to `failed`.

Assert: this holds regardless of the specific violations or revision attempts. The breaker is structural --- it reads context, not implementation details.

**Specification gaps.** The generated code emits an event the machine doesn't handle. XState absorbs it silently --- safe behavior, no crash. But the model-based test flags it: an event was sent that produced no transition. This is a specification gap. The machine definition is incomplete --- either the event shouldn't be emitted (bug in the code) or the machine should handle it (gap in the spec).

## Strategy 3: Fault Injection

### What it targets: The error model (Post 2)

Fault injection triggers every tagged error variant deliberately. A deliberately bad config with dates in the wrong format. A hallucinated DwC term injected into classification output. A simulated user timeout. The goal: verify that each error is handled, reaches the correct state, and produces the correct recovery behavior.

### The Injections

**`ValidationFailure`:** Provide a deliberately bad configuration --- a `darwinkit.yaml` with an `eventDate` formatted as `DD/MM/YYYY` instead of ISO 8601, a `decimalLatitude` outside the valid range, a missing `basisOfRecord`. Run DarwinKit validation. Assert: the agent interprets each violation type correctly. Assert: `FormatViolation` on `eventDate` triggers a date-format revision. Assert: `RangeViolation` on `decimalLatitude` triggers a value-constraint revision. Assert: `RequiredFieldViolation` on `basisOfRecord` triggers a user prompt, because the value can't be inferred from source data.

**`UnknownDwCTerm`:** Inject a hallucinated term into the classification output --- `coordinatePrecisionMeters`, `habitatClassification`, `specimenPreservationType`. Assert: the term is caught at the registry boundary. Assert: the error includes the invalid term name and a list of available alternatives (e.g., `coordinatePrecisionMeters` suggests `coordinateUncertaintyInMeters`). Assert: the hallucinated term never reaches the config generator.

**`ConfirmationTimeout`:** Simulate user non-response during the confirmation gate. Assert: the machine transitions from `confirming` to `failed` via the `CONFIRMATION_TIMEOUT` event. Assert: partial work is preserved --- the classification results are available for retry. Assert: the timeout duration is configurable and the timeout fires after the configured interval, not before.

**`ShellError`:** DarwinKit's CLI returns structured exit codes. Exit code 1 means validation failure (the config has violations, but DarwinKit processed it correctly). Exit code 3 means system error (DarwinKit itself failed --- missing binary, corrupted installation, permissions issue). Assert: the agent distinguishes between these. Assert: exit code 1 produces `VALIDATION_FAIL` with parsed violations, routing to `revising`. Assert: exit code 3 produces `VALIDATION_ERROR`, routing directly to `failed`. The distinction matters: validation failures are recoverable (revise and retry); system errors are not.

### Contract Violations

The most interesting fault injection test is the one that catches a contract violation: generated code throws a raw `Error("connection reset")` instead of returning a `ShellError`.

The Effect runtime surfaces this as an *untagged defect* --- a type-level contract violation. The error channel declared `ShellError`, but an untagged `Error` escaped. Effect distinguishes between expected errors (the tagged union) and unexpected defects (things that shouldn't happen).

The fix is mechanical: wrap the raw error in the tagged class, routing it into the typed error channel. An LLM generating the fix needs only the error type and the contract --- the Effect runtime surfaces the violation precisely, and the tagged union defines what the fix must produce. The test verifies that after the fix, the same raw `Error` is caught and wrapped. The harness never surfaces untagged defects to the agent.

## The Punchline

Each strategy targets a different layer:

| Strategy | Layer | Contract |
|---|---|---|
| **Property tests** | Parse boundaries | "For all inputs, the decoder either produces a valid value or rejects with a typed error." |
| **Model-based tests** | State machine | "Every reachable state is visited, every transition is valid, every path terminates correctly." |
| **Fault injection** | Error model | "Every tagged error variant is handled, reaches the correct recovery state, and produces the correct behavior." |

Every failure is legible. It traces to a specific definition and a specific contract:

- A property test failure traces to a schema (Post 1). The column classifier accepted a mixed-type column it should have rejected. The DwC term registry missed a hallucinated term. The config generator produced output that doesn't match `workspaceConfigSchema`.
- A model-based test failure traces to the machine definition (Post 3). The confirmation gate was bypassed. The revision loop didn't terminate. The circuit breaker didn't trip when stall confidence was high.
- A fault injection failure traces to the error model (Post 2). A `ValidationFailure` wasn't interpreted correctly. An `UnknownDwCTerm` reached the config generator. A `ShellError` was conflated with a validation failure.

Contrast with a typical agent harness where a failure surfaces as "the agent did something weird." Debugging means reading conversation logs, reconstructing state in your head, and guessing which of several hundred lines of loosely typed code misbehaved.

In the DarwinKit configuration agent, the failure tells you where to look. The definitions tell you what's correct. The fix is mechanical.

## The Fix Cycle

The LLM receives a failure:

- A minimal counterexample from a property test: "this column with mixed numeric/text values was classified as `decimalLatitude`."
- An unreachable state from model-based testing: "the `confirming` state was bypassed when low-confidence columns existed."
- An unhandled error tag from fault injection: "raw `Error` escaped instead of `ShellError`."

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

The DarwinKit configuration agent is a demonstration. The same principles apply to any system where an LLM generates code: define the constraints first, derive everything from them, and let the structure do the work that humans and LLMs will inevitably fail to do by hand.
