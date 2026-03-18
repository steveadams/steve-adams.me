---
title: "Organon: Types as Receipts"
date: "2026-03-17T18:38:21.000Z"
slug: "types-as-receipts"
description: "Validation that changes the type — parsing as proof that a boundary check happened, and why this matters for LLM-generated code."
draft: true
---

> Part 1 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

In the [series introduction](/structural-guardrails), we walked through what can go wrong at every step of an agent's execution — from loading configuration to dispatching tools to deciding when to stop. Each challenge previewed a structural pattern. This post addresses the first: validation at the boundary.

## The Problem

You have a function that processes configuration. It takes some input, does something with it, returns a result. The input comes from a file — JSON, YAML, whatever. It's untrusted.

The obvious thing to do is validate it:

```ts
function validateConfig(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  if (!("timeout" in input)) return false;
  if (typeof input.timeout !== "number") return false;
  // ... twenty more checks
  return true;
}
```

Then you might call it somewhere and do something like this:

```ts
    const config = loadConfig(configPath);
    
    if (!validateConfig(config)) {
      throw Error("Config is invalid");
    }
```

This works. The problem is what happens next. `validateConfig` returns `true`, but `input` is still `unknown`. The type hasn't changed. Every function downstream faces the same question: has this been validated already, or not?

That question opens the door to a surprising number of failures.

**Validation can be present but insufficient.** The validator exists, it runs, it returns `true` — but it doesn't check what you think.

- **Partial checks.** The validator checks that `timeout` is a number but not that it's positive. It checks top-level fields but doesn't recurse into nested objects. It gave a green light to data it only glanced at.
- **Stale validators.** A field is added, a type changes from `string` to `string | null`, but the validator isn't updated. It still passes data that matched the old shape.
- **Type-level lies.** Someone writes `return input as Config` and calls it validation. No runtime check occurred. The cast tells the compiler "trust me," and the compiler obliges.
- **Silent coercion.** `Number("")` is `0`. `Number(null)` is `0`. Both pass a `typeof === "number"` check downstream. The validator didn't reject bad data — it laundered it into the right type with the wrong value.

**Even correct validation doesn't help if the guarantee doesn't survive.**

- **Trust decay.** By the time data reaches a function three calls deep, the signature says `unknown` or `Record<string, unknown>`. Did someone already validate? The code can't tell. Trust upstream and hope the call chain never changes, or re-validate and hope the redundant checks agree.
- **Re-validation disagreement.** They don't agree. One function checks `timeout > 0`, another checks `timeout >= 0`, a third only checks the upper bound. The real constraint is the intersection of all three, but nobody wrote that down — it exists only as an emergent property of scattered code.
- **Narrowing loss.** TypeScript narrows a type inside an `if` block, but the narrowing doesn't survive a function boundary, a callback, or an async gap. The proof evaporates when the data moves.
- **Mutation after validation.** The data is validated, then mutated before use. The original check was correct — but it checked different data than what's actually consumed.

**Sometimes the problem is structural — not any individual validator, but how validation is organized.**

- **Boundary ambiguity.** It's unclear where validation happens. At load time? At the subsystem boundary? At field access? Every answer is defensible, so validation ends up everywhere and nowhere — a shotgun pattern of checks with no single authority.
- **Ordering dependencies.** Validator A normalizes dates from strings to timestamps. Validator B checks that dates fall within a range. Run B before A and it fails on raw strings. The dependency is implicit.
- **Error swallowing.** `JSON.parse` throws, the catch returns `{}`, and downstream code processes an empty config as valid. The validation "passed" — it just didn't validate anything.

Now put an LLM in this picture. It's generating a new function that processes config. It sees the type is `unknown` (or worse, `any`, or worse still, `Record<string, unknown>`). It has no evidence of prior validation. It doesn't know which of three conflicting timeout checks is canonical. It doesn't know where the boundary is. So it does the reasonable thing — it generates something plausible:

```ts
function getExtractionSettings(config: Record<string, unknown>) {
  const model = config.extractionModel as { maxTokens: number; model: string };
  return { maxTokens: model.maxTokens, model: model.model };
}
```

This compiles. It works on the test config. It crashes at runtime when someone passes a config where the text extractor is disabled and `extractionModel` is absent. The LLM had no structural reason to check — the type didn't require it, and no constraint prevented the access. It isn't doing anything a human wouldn't do. It's doing it more often, with less suspicion, and without the institutional memory that tells a human developer "oh, you need to check for that."

The validation function exists somewhere, but the type system doesn't know about it. The gap between "validated" and "not validated" is invisible.

## The Pattern

Parsing is validation that changes the type.

Instead of a function that returns `boolean`, write a function that returns a new type — one that can only be obtained by passing through the check. The new type is a *receipt*: proof that the boundary check happened. Every function downstream that accepts the receipt is guaranteed valid input without re-checking.

```ts
type ParsedConfig = {
  readonly timeout: number;
  readonly maxRetries: number;
  readonly tools: ReadonlyArray<ToolConfig>;
};

type ConfigError = {
  readonly _tag: "ConfigError";
  readonly message: string;
  readonly path: string;
};

function parseConfig(input: unknown): ParsedConfig | ConfigError {
  // validate and transform — if it passes, return ParsedConfig
  // if it fails, return ConfigError with what went wrong and where
}
```

Now `getExtractionSettings` takes `ParsedConfig`, not `Record<string, unknown>`. The LLM generating this function can't skip validation — there's no way to obtain a `ParsedConfig` without going through `parseConfig`. The constraint is structural. There is no valid program that bypasses it.

This is the pattern. No libraries, no frameworks — just the idea that the return type of your validation function should prove something.

## The Duplication Problem

The hand-rolled parser works, but look at what you're maintaining:

1. The TypeScript type (`ParsedConfig`) — the shape of valid data.
2. The parser function (`parseConfig`) — the runtime logic that checks and transforms.
3. The error messages — what to report when validation fails.

Three artifacts, one truth. They can drift.

Add a field to `ParsedConfig` — say, `budgetLimit: number`. The type now says it exists. But if you forget to update `parseConfig`, the parser never checks for it. The receipt is a lie: `ParsedConfig` claims `budgetLimit` is present, but the parser never verified it. Downstream code accesses `config.budgetLimit` and gets `undefined` at runtime despite the type saying `number`.

This is the exact class of bug the pattern was supposed to eliminate. You traded "forgot to validate" for "forgot to update the parser." The root cause is the same: multiple artifacts that must agree, maintained by hand, with no machine-checked link between them.

## Effect Schema: One Definition, Three Derivations

Effect Schema collapses the three artifacts into one. You write the schema. The TypeScript type, the runtime decoder, and the error reporting are all derived from it.

```ts
import { Schema } from "effect";

const ToolConfigSchema = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  settings: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const ConfigSchema = Schema.Struct({
  timeout: Schema.Number.pipe(Schema.positive()),
  maxRetries: Schema.Number.pipe(Schema.int(), Schema.between(0, 10)),
  tools: Schema.Array(ToolConfigSchema),
  budgetLimit: Schema.Number.pipe(Schema.positive()),
});
```

The TypeScript type is derived:

```ts
type OrgConfig = Schema.Schema.Type<typeof ConfigSchema>;
// OrgConfig.timeout is number, OrgConfig.tools is Array<ToolConfig>, etc.
```

The runtime decoder is derived:

```ts
const decodeConfig = Schema.decodeUnknownEither(ConfigSchema);

const result = decodeConfig(rawJsonFromFile);
// Either<OrgConfig, ParseError>
// — the parsed, typed config, or a structured error explaining what failed
```

The error reporting is derived — a `ParseError` with the path to the failing field, the expected type, and the actual value. Not `"invalid config"` but `"Expected positive number at .timeout, got -5"`.

Add `budgetLimit` to the schema — the type updates, the decoder checks it, the error messages cover it. Remove a field — the type updates, downstream code that accesses it is a compile error. Tighten a constraint (change `Schema.Number` to `Schema.Number.pipe(Schema.positive())`) — the decoder enforces it, no downstream changes needed.

One definition. Three derivations. Nothing drifts.

This is "define once, derive everything" in its most concrete form. The schema is the single source of truth. The type and the decoder are shadows of it — always consistent, by construction.

## Organon: The Parse Boundaries

Organon — the agent harness this series builds toward — has three distinct parse boundaries. Each is governed by an Effect Schema. Each is a place where untrusted data crosses into typed territory.

### Configuration

The config file defines which tools are available, their settings, budget limits, and LLM parameters. It's the first thing the harness reads and the first boundary exercised.

The schema encodes cross-field constraints as refinements:

```ts
// Sketch — the real schema will be more detailed, but the structure is this:
const OrgConfigSchema = Schema.Struct({
  tools: Schema.Struct({
    webFetcher: Schema.optional(WebFetcherConfigSchema),
    textExtractor: Schema.optional(TextExtractorConfigSchema),
    fileWriter: Schema.optional(FileWriterConfigSchema),
    calculator: Schema.optional(CalculatorConfigSchema),
  }),
  llm: LLMConfigSchema,
  budget: BudgetConfigSchema,
}).pipe(
  // Cross-field: if textExtractor is enabled, llm must include extraction model settings
  Schema.filter((config) =>
    config.tools.textExtractor != null && config.llm.extractionModel == null
      ? { message: "textExtractor enabled but no extractionModel configured in llm" }
      : undefined
  )
);
```

A malformed config — missing fields, contradictory settings, wrong types — is rejected with a precise, typed error before the harness starts. The rest of the system never sees bad config.

### LLM Responses

The LLM returns structured responses. Each is decoded into a typed union or rejected at the boundary:

```ts
const LLMResponseSchema = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("text"), content: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("toolCall"), name: Schema.String, arguments: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.Literal("mixed"), content: Schema.String, toolCalls: Schema.Array(ToolCallSchema) }),
);

type LLMResponse = Schema.Schema.Type<typeof LLMResponseSchema>;
// TextResponse | ToolCallRequest | MixedResponse — nothing else
```

Tool call arguments are further decoded against the specific tool's input schema. No malformed or unexpected response reaches the tool dispatcher.

### Tool Results

Each tool declares its output schema. Results are decoded at the boundary — valid data becomes typed, invalid data is rejected and routed to error handling. A tool that returns malformed data never corrupts the agent's decision-making.

The three boundaries share the same mechanism. The schema defines the shape, the decoder enforces it, the error reports what went wrong. This pattern repeats at every point where untrusted data enters the system. By the end of Organon, there is no path through which unvalidated data reaches decision-making code.

## Before and After

**Before — the unconstrained version:**

```ts
function getExtractionSettings(config: Record<string, unknown>) {
  const model = config.extractionModel as { maxTokens: number; model: string };
  return { maxTokens: model.maxTokens, model: model.model };
}
```

An LLM generates this. It compiles. It works on the happy-path test config where `extractionModel` happens to exist. It crashes when the text extractor is disabled. The cast (`as`) is a lie — it tells the compiler "trust me," and the compiler obliges.

**After — the constrained version:**

```ts
function getExtractionSettings(config: OrgConfig) {
  // config.tools.textExtractor is TextExtractorConfig | undefined
  // config.llm.extractionModel is present if textExtractor is — the schema proved it
  // The LLM must handle the optional, or the compiler rejects the code
}
```

The LLM can't skip validation. `OrgConfig` can only be obtained through the schema decoder. The fields are typed, the optionality is explicit, the cross-field constraint is already verified. The bug from the "before" example has no place to exist.

## Scaling

Adding a new tool to Organon means adding a new result schema. The Calculator tool's result:

```ts
const CalculatorResultSchema = Schema.Struct({
  _tag: Schema.Literal("calculatorResult"),
  expression: Schema.String,
  result: Schema.Number,
});
```

~10 lines. The TypeScript type is derived. The decoder is derived. The error reporting is derived. Every function downstream that handles decoded tool results already works — because it accepts the parsed type, not the raw output. The new tool slots in with zero changes to existing consumers.

Without the schema, adding a tool means writing a type, writing a parser, writing error messages, and hoping all three agree. With the schema, you write the definition. The rest follows.

---

*Next: [Making Illegal States Unrepresentable](/making-illegal-states-unrepresentable) — encoding Organon's error model as a discriminated union where the compiler enforces exhaustive handling.*
