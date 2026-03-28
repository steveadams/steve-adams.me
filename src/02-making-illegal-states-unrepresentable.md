---
title: "Making Illegal States Unrepresentable"
date: "2026-03-17T00:00:00.000Z"
slug: "making-illegal-states-unrepresentable"
description: "Using discriminated unions and exhaustive matching to eliminate entire categories of bugs at compile time."
draft: true
---

# Making Illegal States Unrepresentable

> Part 2 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

A tool executes and returns a result. What shape is that result? Here's a common approach:

```ts
type ToolResult = {
  ok: boolean;
  data?: string;
  error?: string;
  timedOut?: boolean;
};
```

Quick — which combinations are legal? Can `ok` be `true` with `error` set? Can `timedOut` be `true` with `data` present? Can all three optional fields be absent? The type permits every combination. The rules are implicit, encoded in `if/else` chains scattered through handlers:

```ts
function handleResult(result: ToolResult) {
  if (result.ok && result.data) {
    // success path
  } else if (result.timedOut) {
    // timeout path
  } else if (result.error) {
    // error path
  }
  // what if none of these match?
  // what if ok is true but data is missing?
  // silence.
}
```

An LLM writing a new handler generates something that looks like this. It covers the cases it can infer from context. It misses one — maybe the case where `ok` is `false` but `error` is also absent (a tool that failed without producing an error message). The code compiles. The missed case falls through silently. You find out in production.

Now scale this up. The Darwin Core Archive packaging agent's validation step produces structured violations. A malformed XML element in the EML metadata is a `SchemaViolation`. A mismatch between a column declared in `meta.xml` and the actual CSV header is a `CrossReferenceViolation`. A missing geographic coverage section when coordinate data exists is a `CompletenessViolation`. Each has a different recovery path — a schema violation means the LLM should regenerate the malformed section, a cross-reference violation means correcting the field name in `meta.xml`, a completeness violation might mean going back to the user to collect missing metadata. And validation failures are just one error type. The source file might not parse during inspection. The LLM might reference a Darwin Core term URI that doesn't exist. Archive generation might fail. The budget might be exhausted. If these are represented as a bag of optional fields on a generic error object, every handler must independently reconstruct which failure mode it's dealing with. Every handler is a place for a bug. Every new failure mode is a silent regression in every existing handler.

## The Pattern

Discriminated unions make the valid states explicit. Each variant is a distinct type carrying exactly the data relevant to that case. A discriminant field (the tag) identifies which variant you're holding. Exhaustive matching forces every code path to handle every variant — and the compiler enforces it.

```ts
type ToolResult =
  | { readonly _tag: "Success"; readonly data: string }
  | { readonly _tag: "Timeout"; readonly elapsed: number }
  | { readonly _tag: "ExecutionError"; readonly message: string; readonly cause?: unknown };
```

No illegal combinations. `Success` always has `data`. `Timeout` always has `elapsed`. `ExecutionError` always has `message`. You can't construct a `Success` with an `error` field — the type doesn't have one.

Exhaustive matching via `switch` + `never`:

```ts
function handleResult(result: ToolResult): Recovery {
  switch (result._tag) {
    case "Success":
      return processData(result.data);
    case "Timeout":
      return retryOrSkip(result.elapsed);
    case "ExecutionError":
      return reportToLLM(result.message);
    default:
      // If a variant is unhandled, result is not `never`, and this is a compile error
      const _exhaustive: never = result;
      return _exhaustive;
  }
}
```

If you add a new variant to `ToolResult`, every `switch` that doesn't handle it fails to compile. The new case can't be silently ignored — the compiler forces you to decide what to do with it.

## The Archive Agent's Error Model

The Darwin Core Archive packaging agent needs a richer error model than `ToolResult`. The agent workflow — inspect sources, determine structure, generate archive, validate — has failure points at every step, each with different recovery semantics. The validation step alone produces several distinct violation types, and the harness needs to route each one to a specific recovery path. This is where discriminated unions earn their keep: the nested tagged union — violation types inside a validation failure — is the pattern composing with itself, and the place where both lenses of the series thesis converge most sharply.

Plain TypeScript discriminated unions handle this cleanly — but Effect's `Data.TaggedError` adds something: each error class carries its `_tag` discriminant by construction. It's intrinsic to the definition, not a convention someone can forget.

### Plain TypeScript First

The union, using pure TS:

```ts
type HarnessError =
  | { readonly _tag: "SourceInspectionFailure"; readonly path: string; readonly reason: string }
  | { readonly _tag: "StructureDeterminationFailure"; readonly reason: string; readonly inspectedFiles: string[] }
  | { readonly _tag: "UnknownTermURI"; readonly uri: string; readonly available: string[] }
  | { readonly _tag: "ConfirmationTimeout"; readonly step: string; readonly elapsed: number }
  | { readonly _tag: "ArchiveGenerationError"; readonly message: string; readonly phase: string }
  | { readonly _tag: "ValidationFailure"; readonly violations: ArchiveViolation[]; readonly archivePath: string }
  | { readonly _tag: "XMLParseError"; readonly file: string; readonly line: number; readonly message: string }
  | { readonly _tag: "BudgetExhausted"; readonly dimension: "tokens" | "calls" | "time"; readonly limit: number; readonly used: number };
```

This works. Every handler must match all eight variants. The compiler enforces it.

### Nested Tagged Unions — the Centerpiece

`ValidationFailure` carries `ArchiveViolation[]` — but what is an `ArchiveViolation`? Archive validation produces different *kinds* of violation, each with different data and a different recovery path. This is a tagged union inside a tagged union — the pattern composing with itself:

```ts
type ArchiveViolation =
  | { readonly _tag: "SchemaViolation"; readonly elementPath: string; readonly expected: string; readonly actual: string }
  | { readonly _tag: "CrossReferenceViolation"; readonly metaXmlField: string; readonly csvHeader: string; readonly filePath: string }
  | { readonly _tag: "CompletenessViolation"; readonly missingSection: string; readonly triggeringCharacteristic: string }
  | { readonly _tag: "UniquenessViolation"; readonly field: string; readonly duplicateValue: string }
  | { readonly _tag: "ReferentialViolation"; readonly extensionFile: string; readonly foreignKeyField: string; readonly missingId: string };
```

Each violation carries exactly the data needed to describe what went wrong. A `SchemaViolation` has `elementPath`, `expected`, and `actual` — you know exactly which XML element is malformed and what it should look like. A `CrossReferenceViolation` has the `meta.xml` field name and the CSV header — you can see the mismatch. A `CompletenessViolation` names the missing section and what triggered the requirement — there's no ambiguity about what needs to be added.

When the harness receives a `ValidationFailure`, it doesn't just know that validation failed — it can iterate the violations and generate a specific correction plan for the LLM. A `SchemaViolation` on `/eml/dataset/coverage/geographicCoverage` means "the EML element is malformed — regenerate this section with the correct attribute order." A `CrossReferenceViolation` between `meta.xml` declaring `"scientificname"` and the CSV header `"scientificName"` means "correct the field name in `meta.xml` to match the CSV — or re-inspect the source file." A `CompletenessViolation` on `temporalCoverage` triggered by existing date columns means "go back to the user and ask for the date range — the archive has date data but no temporal coverage metadata." Each violation type routes to a different recovery path, and the tagged union ensures the harness can't confuse them:

```ts
function describeViolation(v: ArchiveViolation): string {
  switch (v._tag) {
    case "SchemaViolation":
      return `${v.elementPath}: expected ${v.expected}, got ${v.actual}`;
    case "CrossReferenceViolation":
      return `${v.filePath}: meta.xml declares "${v.metaXmlField}" but CSV header is "${v.csvHeader}"`;
    case "CompletenessViolation":
      return `${v.missingSection}: required because ${v.triggeringCharacteristic}`;
    case "UniquenessViolation":
      return `${v.field}: duplicate value "${v.duplicateValue}"`;
    case "ReferentialViolation":
      return `${v.extensionFile}: ${v.foreignKeyField} references missing ID "${v.missingId}"`;
    default:
      const _exhaustive: never = v;
      return _exhaustive;
  }
}
```

The runtime value of this is immediate: the harness interprets each violation type correctly and generates targeted correction instructions instead of a generic "validation failed, try again." The LLM receiving those instructions can act on specifics — it knows *which* element, *what* was wrong, and *what the expected structure is*.

The development value is equally sharp. An LLM generating a new violation handler must handle every variant — the exhaustive `switch` plus the `never` default make an unhandled case a compile error. And when the model evolves — say you add `ReferentialViolation` because extension files with Event/Occurrence/MeasurementOrFact relationships introduce referential integrity constraints — every incomplete handler breaks at compile time. The compiler tells you exactly which files need updating. In code a human wrote and in code an LLM generated.

The pattern composes. The outer union (`HarnessError`) tells you *what went wrong*. The inner union (`ArchiveViolation`) tells you *how it went wrong*. Both are exhaustively matched. Both are compiler-enforced.

### Effect's TaggedError — the Mature Version

```ts
import { Data } from "effect";

class SourceInspectionFailure extends Data.TaggedError("SourceInspectionFailure")<{
  readonly path: string;
  readonly reason: string;
}> {}

class StructureDeterminationFailure extends Data.TaggedError("StructureDeterminationFailure")<{
  readonly reason: string;
  readonly inspectedFiles: ReadonlyArray<string>;
}> {}

class UnknownTermURI extends Data.TaggedError("UnknownTermURI")<{
  readonly uri: string;
  readonly available: ReadonlyArray<string>;
}> {}

class ConfirmationTimeout extends Data.TaggedError("ConfirmationTimeout")<{
  readonly step: string;
  readonly elapsed: number;
}> {}

class ArchiveGenerationError extends Data.TaggedError("ArchiveGenerationError")<{
  readonly message: string;
  readonly phase: string;
}> {}

class ValidationFailure extends Data.TaggedError("ValidationFailure")<{
  readonly violations: ReadonlyArray<ArchiveViolation>;
  readonly archivePath: string;
}> {}

class XMLParseError extends Data.TaggedError("XMLParseError")<{
  readonly file: string;
  readonly line: number;
  readonly message: string;
}> {}

class BudgetExhausted extends Data.TaggedError("BudgetExhausted")<{
  readonly dimension: "tokens" | "calls" | "time";
  readonly limit: number;
  readonly used: number;
}> {}
```

The `_tag` is part of the class definition. You can't construct an `UnknownTermURI` without it being tagged — it's not a convention you remember to follow, it's a structural fact about the class.

Applied to Effect's error channel, this means a function's type signature declares exactly which errors it can produce:

```ts
type GenerateEML = Effect<
  EMLDocument,
  SchemaViolation | CompletenessViolation | ArchiveGenerationError,
  never
>;
```

An LLM generating a caller for this function sees the error channel in the type — three specific tagged errors, not a generic `Error`. It must handle each variant. `.catch(() => null)` on a tagged error union is a type error — the error channel demands explicit handling of each case. The type signature is the contract, visible to both the compiler and to any LLM reading the function.

Each error carries the data needed for recovery at runtime:

- `UnknownTermURI` carries the available terms — the LLM referenced `"http://rs.tdwg.org/dwc/terms/decimalLongitude"` but the valid URI is `"http://rs.tdwg.org/dwc/terms/verbatimLongitude"`. The recovery path can tell the LLM "you used this URI, valid term URIs are [...]" and the LLM can self-correct.
- `SourceInspectionFailure` carries the path and reason — the recovery can tell the LLM "this file couldn't be read for inspection, here's why."
- `ValidationFailure` carries the typed violations from the nested union — the recovery generates a specific correction plan per violation, not a generic retry.
- `BudgetExhausted` carries which dimension was exceeded (`tokens`, `calls`, or `time`) and by how much — the recovery can report partial results with an explanation of what limit was hit.

The recovery path is informed by the error variant. Not "something went wrong" but "this specific thing went wrong, here's the context, here's what to do about it."

## Before and After

**Before — generic error handling:**

```ts
async function generateEML(
  metadata: Record<string, unknown>,
  dataFiles: string[]
): Promise<string> {
  try {
    let eml = '<?xml version="1.0" encoding="UTF-8"?>\n<eml:eml>';
    eml += `<dataset><title>${metadata.title ?? "Untitled"}</title>`;

    if (metadata.geographicCoverage) {
      eml += `<coverage><geographicCoverage>`;
      eml += `<westBoundingCoordinate>${metadata.west}</westBoundingCoordinate>`;
      // ... more string concatenation
      eml += `</geographicCoverage></coverage>`;
    }
    // missing temporal coverage? silently omitted.
    // malformed XML from bad metadata? no validation.

    eml += "</dataset></eml:eml>";
    return eml;
  } catch (e) {
    return "<eml:eml/>"; // generation failed — return stub, no one knows
  }
}
```

An LLM generates this. It handles the happy path and has a generic catch. It works for a while. Then:

- The metadata has coordinate data but no geographic coverage section. The EML is technically valid but incomplete — GBIF will flag it during ingestion.
- The `meta.xml` references `"scientificname"` but the CSV header is `"scientificName"`. The case mismatch silently breaks column resolution.
- An extension file references core record IDs that don't exist. The archive validates structurally but the data relationships are broken.

Each addition requires finding and modifying this function (and every other handler) by hand. The LLM that wrote it has moved on. The next developer — or the next LLM invocation — doesn't know what's missing.

**After — tagged error union:**

```ts
function generateEML(
  metadata: InspectionReceipt,
  structure: StructureReceipt
): Effect<
  EMLDocument,
  SchemaViolation | CompletenessViolation | ArchiveGenerationError,
  never
> {
  // Every failure mode is a specific tagged error
  // The return type declares exactly what can go wrong
  // The caller must handle each variant
}
```

An LLM writing a caller for `generateEML` sees the error channel in the type. It can't ignore `CompletenessViolation` — the compiler won't let it. The error model is the type signature. Reading the function is reading the contract.

## Scaling

The nested union already demonstrated how adding `ReferentialViolation` breaks every incomplete handler at compile time. The same dynamic applies at the outer level. Add `XMLParseError` to the `HarnessError` union because the generated EML might not parse — the compiler flags every handler that doesn't account for it. Six errors, four files, each telling you exactly what to update.

Without the union: you grep for `catch` blocks. You find five call sites that need updating. The sixth — in a test helper that catches errors and returns a default mapping — doesn't match the grep pattern. It silently swallows the new error and proceeds with unconfirmed mappings. Tests pass. The bug reaches production.

This works at both levels. At runtime, every new error variant forces explicit recovery logic — no silent fallthrough. At development time, whether it's a human or an LLM writing the next handler, the compiler rejects incomplete matches. The "skips validation" region from Post 1 is already gone. Now highlight programs that forget error cases, silently swallow failures, catch generic `Error` instead of specific variants, or have handlers that don't account for all failure modes. Apply the "illegal states" constraint — that region disappears. The valid space visibly shrinks. Two classes of bug are now structurally eliminated.

---

*Next: [State Machines and Lifecycle](/state-machines-and-lifecycle) — the Darwin Core Archive agent's lifecycle as an XState machine with bounded loops and stall detection.*
