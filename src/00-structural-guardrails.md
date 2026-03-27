---
title: "Structural Guardrails for LLM-Generated Code"
date: "2026-03-17T00:00:00.000Z"
slug: "structural-guardrails"
description: "Software patterns that create compile-time and runtime guarantees, and why LLMs make them more important than ever"
draft: true
---

# Structural Guardrails for LLM-Generated Code

Here's the recursive observation at the center of this series: the same structural patterns that make LLM harness behavior deterministic also make LLM-assisted development reliable. These aren't two separate problems with a convenient overlap. They're the same problem — the absence of structural constraints — manifesting at different levels.

**Runtime.** Your application uses an LLM. Its output is non-deterministic. The model returns structured responses that might be malformed, tool calls with invalid arguments, or hallucinated function names. Structural patterns constrain what your harness can do with that output — parsing it into typed data or rejecting it, never silently passing it through.

**Development.** An LLM helps you write code. Without a clear spec or existing conventions, it eventually turns into a really shitty programmer — starts off pretty good, declines into slop, and you're stuck babysitting instead of doing the architectural work that matters. Structural patterns constrain what it can generate. If your types permit skipping validation, it will skip validation. If your error model permits swallowing failures, it will swallow failures. Not out of malice — out of plausibility.

What allows more deterministic behavior in LLM harnesses also leads to more predictable, stable, safe programs. The constraints are recursive. They govern the program at runtime. They govern the process of writing the program.

What can you do about it? Not better prompts or more instructions — those help, but they don't *constrain*. The LLM can always ignore a prompt. It can't ignore a type error.

Different manifestations, same solution. This series explores both by building something.

The series uses [Effect](https://effect.website) throughout — not as a library preference but as a deliberate structural decision. Effect provides a modular, composable basis for the guardrails we build: schemas that are both types and validators, tagged errors with exhaustive handling, typed effect channels that make side effects visible. Each post shows a pattern in plain TypeScript first, then in Effect — but Effect is the production choice because it composes these patterns without the boilerplate collapsing under its own weight. Choosing Effect is itself a guardrail. It signals to an LLM assisting with development that these patterns are the established mechanism, reducing the surface where ad-hoc solutions can appear in generated code.

## The DarwinKit Configuration Agent

Darwin Core is the international standard for biodiversity data — hundreds of terms, specific formatting requirements, relationships between record types like occurrences, events, and measurements. Scientists have data in CSV files, databases, spreadsheets. They need it in Darwin Core. The spec is complex. Getting it wrong means rejected submissions, broken data pipelines, or biodiversity records that can't be aggregated with anyone else's.

This problem is universal. "I have data in one shape and need it in another, the target spec is complex, and getting it wrong has consequences." Every industry has its version — FHIR for healthcare, XBRL for finance, FIX for trading. The structural challenges are the same.

The DarwinKit Configuration Agent is a harness that helps scientists map unfamiliar biodiversity data into Darwin Core by producing a `darwinkit.yaml` configuration file. It reads source data files, semantically classifies columns using LLM reasoning, confirms ambiguous mappings with the user, generates a typed configuration, validates it against the real DarwinKit tool, and revises if the validation fails.

It's the kind of thing where most implementations are a bag of strings and hope. This one is structurally constrained, where most classes of bug are impossible by construction.

Here's what a single execution looks like, and what can go wrong at every step.

**Source data arrives. The agent reads its columns.** Column headers are ambiguous. "lat" could be `decimalLatitude`, a lab code, or garbage. "depth_m" could be any of five Darwin Core depth terms. The agent must classify semantically, not just pattern-match — and the source data is the first untrusted input. A corrupted file, unexpected encoding, missing headers — if bad data gets through, every classification downstream is built on a lie. This is the runtime problem in its purest form: untrusted data crossing a boundary, where the same validation pattern also tells an LLM writing the next handler exactly what shape of data it's allowed to assume. *Challenge: how do you validate data at a boundary so that the proof of validation survives into every function that touches it?*

**The agent classifies columns using LLM reasoning.** This is non-deterministic. It might hallucinate a Darwin Core term that doesn't exist — `coordinatePrecisionMeters` sounds plausible but isn't real. It might classify "depth_m" as `maximumDepthInMeters` when it's actually `minimumDepthInMeters`. When the classifier is uncertain, it needs to ask the user — "this column is labeled 'sp_code', is that a species code or a sample point identifier?" The user's response becomes context that constrains subsequent classification, not just a yes/no gate. This is the runtime constraint at its sharpest — the model's output is the untrusted input, and the parsing boundary must reject what doesn't fit the schema. The same schema constrains an LLM writing the classifier: if the parser only accepts known Darwin Core terms, there's nowhere to put a hallucinated one. *Challenge: how do you parse non-deterministic output into typed, trustworthy data — or reject it cleanly?*

**Low-confidence classifications need user confirmation.** An interactive gate. The agent identified "collector" as probably `recordedBy` but it could be `identifiedBy` — different concepts in Darwin Core. The harness must not proceed without confirmation, and the confirmation must be recorded as proof that a human approved the mapping. Both lenses converge here: the runtime gate prevents unconfirmed mappings from reaching config generation, and the development constraint means an LLM writing this code can't construct a `ConfirmedMapping` without the confirmation receipt — the type won't let it. *Challenge: how do you make it impossible to finalize a mapping that hasn't been confirmed — not by policy, but by the absence of a pathway?*

**The agent generates a `darwinkit.yaml` config.** Capability restriction. It should write only to the output directory. It should never modify source data. It should never make network calls during generation. A read-only classification phase shouldn't be able to write files. A generation phase shouldn't be able to re-read and reinterpret source data. This is the development constraint made structural: when capabilities are typed and passed explicitly, an LLM generating the generation phase literally cannot call a function that requires a network capability — the type signature won't accept it. The runtime benefit follows: the harness can't reach what it wasn't given. *Challenge: how do you restrict what the harness can reach — not by policy, but by the absence of a pathway?*

**DarwinKit validates the config against actual data.** Validation errors are structured — `FormatViolation` (a date in the wrong format), `RangeViolation` (latitude outside -90 to 90), `RequiredFieldViolation` (missing `basisOfRecord`). The agent must interpret these domain-specifically. A `FormatViolation` on `eventDate` means "rewrite the date transformation." A `RequiredFieldViolation` on `basisOfRecord` means "ask the user — this can't be inferred from the source data." Each failure mode has a different recovery path. The development constraint is doing the heavy lifting: exhaustive matching on a discriminated union means an LLM writing the error handler must account for every variant. Add a new violation type and the compiler breaks every incomplete handler — in code a human wrote and in code an LLM generated. *Challenge: how do you ensure every error variant is handled, and that adding a new one forces every handler to update?*

**The agent revises and re-validates.** Protocol enforcement. It can't just regenerate the config blindly — it must understand what failed and why, apply targeted fixes, and re-validate. But the revision loop must terminate. It can't retry forever. Budget limits — iterations, API calls, wall-clock time — must be enforced. And the loop has structure: certain sequences are valid (validate, diagnose, revise, re-validate), others aren't (revise without diagnosing, skip validation, re-validate without changing anything). This is the runtime constraint governing the agent's lifecycle — the state machine absorbs invalid transitions rather than crashing, and domain-specific stall detection catches revision loops that aren't converging. *Challenge: how do you make protocol violations impossible and guarantee bounded execution?*

Each of these challenges has a known solution — a pattern that eliminates the problem structurally. This series defines those patterns one at a time, each building a piece of the configuration agent's specification. By the final post, the spec is complete, and we assemble the implementation from the pieces the series produced.

This is spec-driven development in practice. Each post defines a component's constraints with enough rigor that the implementation is nearly determined. An LLM generating code against these specs operates in a narrow space where most programs are correct — because the spec eliminates the rest. The series isn't just *about* structural guardrails. It *is* one.

## The Series

1. **[Types as Receipts](/types-as-receipts)** — Validation that changes the type. A `ColumnMapping` requires a `SemanticClassification` receipt — proof that the LLM's output was parsed and validated against known Darwin Core terms. Hallucinated mappings are type errors.

2. **[Making Illegal States Unrepresentable](/making-illegal-states-unrepresentable)** — Discriminated unions and exhaustive matching. DarwinKit's validation produces typed violations — `FormatViolation`, `RangeViolation`, `RequiredFieldViolation` — where the compiler enforces handling of every failure mode and each variant carries the data needed for recovery.

3. **[State Machines and Lifecycle](/state-machines-and-lifecycle)** — The overall workflow as an XState machine. The revision loop with domain-specific stall detection — repetition, stagnation, oscillation — replaces flat retry counters. The machine governs what the agent can do at runtime; invalid transitions are absorbed, not crashed.

4. **[Encoding Protocols in State](/encoding-protocols-in-state)** — Typestate patterns for compile-time protocol enforcement. The compiler enforces that user confirmation precedes config generation — skipping the gate is a type error, not a policy. `SourceParsed` -> `ColumnsClassified` -> `GatesCleared` -> `ConfigGenerated` -> `ValidationPassed`. Each phase transition is a type-level proof.

5. **[Capabilities and Effects](/capabilities-and-effects)** — Controlling what code can do by passing capabilities explicitly. The collection phase gets `file_read` + `shell`. Classification is pure reasoning — no effects. Generation gets `file_write` scoped to the output directory. Each phase's capability set is structurally enforced.

6. **[Specification and Generation](/specification-and-generation)** — The cumulative specification constrains generation. Every piece from Posts 1-5 becomes the mold, and we generate implementations against it. Compiler errors trace to specific constraints. The review surface narrows to genuine design decisions.

7. **[Verification](/verification)** — Property-based testing, model-based testing, and fault injection — each targeting a different architectural layer, each proving the specification holds under adversarial conditions.
