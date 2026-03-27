---
title: "Types as Receipts"
date: "2026-03-17T18:38:21.000Z"
slug: "types-as-receipts"
description: "Validation that changes the type — parsing as proof that a boundary check happened, and why this matters for LLM-generated code."
draft: true
---

> Part 1 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

In the [series introduction](/structural-guardrails), we walked through what the DarwinKit configuration agent does — and what can go wrong at every step. Each step previewed a structural challenge. Now let's make those challenges concrete.

We'll build a naive configuration agent using common TypeScript patterns. It will work. It will look reasonable. Then we'll add a confirmation gate, and watch everything that's fragile become visible.

## The MVP

The agent helps scientists map biodiversity data into Darwin Core. It reads source files, classifies columns, maps them to DwC terms, and generates a `darwinkit.yaml` config. The harness starts by loading its own configuration — what tools are available, LLM parameters, which standard to target. Here's a type for that, and a validator:

```ts
type Config = {
  sourceDir: string;
  outputDir: string;
  llm: { model: string; maxTokens: number };
  standard: string;
  tools: {
    fileRead?: { enabled: boolean };
    shell?: { enabled: boolean };
    fileWrite?: { enabled: boolean };
    userPrompt?: { enabled: boolean };
  };
};

function validateConfig(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.sourceDir !== "string") return false;
  if (typeof obj.outputDir !== "string") return false;
  if (typeof obj.standard !== "string") return false;
  if (typeof obj.llm !== "object" || obj.llm === null) return false;
  if (typeof obj.tools !== "object" || obj.tools === null) return false;
  // doesn't recurse into tools sub-objects
  // doesn't check that sourceDir exists or outputDir is writable
  return true;
}

function loadConfig(path: string): Config {
  const raw = JSON.parse(Deno.readTextFileSync(path));
  if (!validateConfig(raw)) {
    throw new Error("Invalid config");
  }
  return raw as Config; // the cast — no proof this is actually Config
}
```

The validator checks top-level fields but doesn't recurse into `tools`. The `Config` type and the validator are separate artifacts. They can drift.

Next, the types for conversation messages and a stubbed LLM client:

```ts
type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "assistant"; toolCall: { name: string; arguments: Record<string, unknown> } }
  | { role: "tool"; name: string; result: string };

type LLMResponse =
  | { type: "text"; content: string }
  | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
  | { type: "mixed"; content: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> };

// Stub: cycles through a canned sequence
const cannedResponses: LLMResponse[] = [
  { type: "toolCall", name: "fileRead", arguments: { path: "specimens.csv" } },
  { type: "toolCall", name: "shell", arguments: { command: "darwinkit validate config.yaml" } },
  { type: "text", content: "Based on the source file, I've mapped 12 columns to Darwin Core terms." },
];

let responseIndex = 0;

async function callLLM(messages: Message[]): Promise<LLMResponse> {
  // In a real harness, this calls an API and parses the response.
  // The stub returns canned responses in sequence.
  const response = cannedResponses[responseIndex % cannedResponses.length];
  responseIndex++;
  return response;
}
```

The LLM client is stubbed — we're focused on the harness, not the API integration. In a real implementation, `callLLM` would call an endpoint and parse the JSON response manually, with the same structural issues.

Four tools, each stubbed to return canned data. The dispatcher uses a switch on the tool name:

```ts
function fileRead(args: Record<string, unknown>): { content: string; path: string; format: string } {
  return {
    content: "scientificName,decimalLatitude,decimalLongitude\nQuercus robur,51.5,-0.1",
    path: String(args.path),
    format: "csv",
  };
}

function shell(args: Record<string, unknown>): { stdout: string; exitCode: number } {
  return { stdout: "Validation passed: 12 fields mapped.", exitCode: 0 };
}

function fileWrite(args: Record<string, unknown>): { path: string; bytesWritten: number } {
  return { path: String(args.path), bytesWritten: 1024 };
}

function userPrompt(args: Record<string, unknown>): { response: string; confirmed: boolean } {
  return { response: "Yes, that mapping looks correct.", confirmed: true };
}

function dispatchTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "fileRead":
        return JSON.stringify(fileRead(args));
      case "shell":
        return JSON.stringify(shell(args));
      case "fileWrite":
        return JSON.stringify(fileWrite(args));
      case "userPrompt":
        return JSON.stringify(userPrompt(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return `Tool execution failed: ${(err as Error).message}`;
  }
}
```

Every tool failure — timeout, bad arguments, unknown tool — becomes the same string: `"Tool execution failed: ..."`. The caller can't distinguish them.

Long conversations need compaction — older messages are summarized to stay within the LLM's context window. A token estimator and a compaction function:

```ts
function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    const text = 'toolCall' in m ? JSON.stringify(m.toolCall)
               : 'result' in m  ? m.result
               : m.content;
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

function compactConversation(messages: Message[], tokenBudget: number): Message[] {
  if (estimateTokens(messages) < tokenBudget) return messages;

  const task = messages[0];
  const recent = messages.slice(-6);
  const middle = messages.slice(1, messages.length - 6);

  const summary = middle
    .map((m) =>
      'toolCall' in m ? `Called ${m.toolCall.name}`
      : 'result' in m ? `${m.name}: ${m.result.slice(0, 80)}`
      : m.content.slice(0, 100)
    )
    .join(' → ');

  return [
    task,
    { role: "assistant", content: `[Earlier context: ${summary}]` },
    ...recent,
  ];
}
```

Token estimation uses a rough heuristic (`length / 4`). Compaction keeps the original task, the six most recent messages, and a one-line summary of everything in between.

The main loop ties it together:

```ts
async function runAgent(task: string, config: Config): Promise<string> {
  let messages: Message[] = [{ role: "user", content: task }];
  let iterations = 0;
  let totalTokens = 0;

  while (iterations < 20) {
    messages = compactConversation(messages, config.llm.maxTokens * 0.8);
    const response = await callLLM(messages);
    totalTokens += 100; // rough estimate

    if (totalTokens > 10000) {
      return "Budget exceeded. Partial result: " + messages[messages.length - 1].content;
    }

    if (response.type === "text") {
      messages.push({ role: "assistant", content: response.content });
      return response.content;
    }

    if (response.type === "toolCall") {
      messages.push({ role: "assistant", toolCall: { name: response.name, arguments: response.arguments } });
      const result = dispatchTool(response.name, response.arguments);
      messages.push({ role: "tool", name: response.name, result });
    }

    iterations++;
  }

  return "Max iterations reached.";
}
```

The conversation is an untyped array. Nothing prevents pushing messages in the wrong order. Budget checking is one if-statement estimating tokens. The iteration counter is the only thing preventing an infinite loop. Context compaction runs before each LLM call but doesn't respect message pairs — if the slice boundary lands between a tool call and its result, the compacted conversation is malformed. And notice: the loop handles `"text"` and `"toolCall"` but not `"mixed"` — if the LLM returns both text and tool calls, the iteration increments and nothing happens. No error, no handling, just silence.

And the entry point that wires it all together:

```ts
const config = loadConfig("config.json");
const result = await runAgent("Map specimens.csv to Darwin Core", config);
console.log("Result:", result);
```

This works. Run it and you get `"Result: Based on the source file, I've mapped 12 columns to Darwin Core terms."` The happy path is fine.

## The Audit

This works. It's not broken. Now add a confirmation gate.

The naive harness has no confirmation step. The agent reads source files, classifies columns, and generates a config — but nothing requires the user to confirm low-confidence classifications before the config is written. Adding `userPrompt` as a confirmation tool means touching every layer of the harness, and each layer reveals a different fragility.

**The config type and the validator disagree.** The `Config` type already has `userPrompt?: { enabled: boolean }` in the `tools` block. The validator doesn't know — it never checks inside `tools`. The `as Config` cast on the last line of `loadConfig` promises a shape the validator didn't verify. Downstream code accesses `config.tools.userPrompt.enabled` and gets `undefined` at runtime, despite the type saying `boolean`. *We'll fix this first, below.*

**The deeper problem: nothing proves the user was consulted.** Even with `userPrompt` in the config and the tool wired up, nothing forces the agent to call it. The agent can classify a column as `decimalLatitude` with 40% confidence, skip the confirmation step, and write a config that maps GPS coordinates to the wrong field. The type system doesn't distinguish "classification that was confirmed" from "classification that was not." There's no receipt. *We'll fix this too — below.*

**Every error is the same string.** `userPrompt` can fail in ways the other tools can't — the user might reject a classification, the terminal might not be interactive, the prompt might time out. But `dispatchTool` catches everything as `Error` and returns `"Tool execution failed: ..."`. The agent can't tell a user rejection from a timeout. *Post 2: discriminated unions and exhaustive matching.*

**The conversation has no protocol.** The `messages` array accepts any message in any order. After `dispatchTool` returns, nothing prevents calling `callLLM` again without pushing the tool result first — a dangling tool call the LLM API will reject with a confusing error. The type is `Message[]`. It doesn't encode "you must resolve tool calls before calling the LLM again." *Post 4: typestate patterns enforce ordering at compile time.*

**Every tool is always available.** A read-only classification task has the same access as one that writes configs — `dispatchTool` doesn't care. If the LLM hallucinates a `fileWrite` call during a classification-only phase, the harness will execute it. There's no structural restriction, just hope. *Post 5: capabilities and effects.*

**Budget enforcement is an afterthought.** Token counting is a single if-statement with a rough estimate. Add API call limits or wall-clock time and you add more if-statements, scattered through the loop body, each checking independently. Nothing ensures all dimensions are checked or that the checks are consistent. *Post 3: state machines with parallel budget tracking.*

**Context compaction is brittle.** Classification decisions produce detailed results — column names, confidence scores, reasoning, user confirmations. `compactConversation` truncates these to 80 characters, losing information the agent needs to track which columns were confirmed. Worse, `slice(-6)` doesn't respect message pairs. If the boundary falls between a `userPrompt` tool call and its result, the compacted conversation has a dangling confirmation with no outcome — and the agent has lost the receipt of user approval. Losing a classification receipt means re-asking the user, or worse, proceeding without confirmation. *Compaction is a cross-cutting concern — the missing receipt (Post 1), indistinguishable outcomes (Post 2), protocol-breaking slices (Post 3), ungoverned timing (Post 4), and hidden summarization effects (Post 5) each appear in subsequent posts.*

This isn't bad code. It's normal code — the kind most agent harnesses use. The problems are natural consequences of common patterns. Each one becomes a structural fix in a subsequent post. We start with the first.

## Types as Receipts

### The Pattern

Parsing is validation that changes the type.

Instead of a function that returns `boolean`, write a function that returns a new type — one that can only be obtained by passing through the check. The new type is a *receipt*: proof that the boundary check happened. Every function downstream that accepts the receipt is guaranteed valid input without re-checking.

```ts
type ParsedConfig = {
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly llm: { readonly model: string; readonly maxTokens: number };
  readonly standard: string;
  readonly tools: {
    readonly fileRead?: { readonly enabled: boolean };
    readonly shell?: { readonly enabled: boolean };
    readonly fileWrite?: { readonly enabled: boolean };
    readonly userPrompt?: { readonly enabled: boolean };
  };
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

Now `runAgent` takes `ParsedConfig`, not `Config`. There's no way to obtain a `ParsedConfig` without going through `parseConfig`. The constraint is structural.

This is the pattern. No libraries, no frameworks — just the idea that the return type of your validation function should prove something.

This works at both levels of the dual lens. At development time, an LLM generating harness code can't skip validation — there is no valid program that obtains a `ParsedConfig` without calling `parseConfig`. At runtime, untrusted input (a config file, an LLM response, a tool result) must pass through the same gate. A malformed config doesn't silently become a `ParsedConfig` — it fails to parse. The parse boundary is the same boundary regardless of whether the untrusted data comes from a file or from an LLM.

### The Duplication Problem

The hand-rolled parser works, but look at what you're maintaining:

1. The TypeScript type (`ParsedConfig`) — the shape of valid data.
2. The parser function (`parseConfig`) — the runtime logic that checks and transforms.
3. The error messages — what to report when validation fails.

Three artifacts, one truth. They can drift.

Add a field to `ParsedConfig` — say, `standard: "dwc" | "abcd"`. The type now constrains it to two values. But if you forget to update `parseConfig`, the parser accepts `"anything"`. The receipt is a lie: `ParsedConfig` claims `standard` is one of two values, but the parser never verified it. Downstream code pattern-matches on `config.standard` expecting only `"dwc"` or `"abcd"` and hits the impossible default branch at runtime.

This is the exact class of bug the pattern was supposed to eliminate. You traded "forgot to validate" for "forgot to update the parser." The root cause is the same: multiple artifacts that must agree, maintained by hand, with no machine-checked link between them.

### Effect Schema: One Definition, Three Derivations

Effect Schema collapses the three artifacts into one. You write the schema. The TypeScript type, the runtime decoder, and the error reporting are all derived from it.

```ts
import { Schema } from "effect";

const FileReadConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

const ShellConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

const FileWriteConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

const UserPromptConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

const ConfigSchema = Schema.Struct({
  sourceDir: Schema.String,
  outputDir: Schema.String,
  llm: Schema.Struct({
    model: Schema.String,
    maxTokens: Schema.Number.pipe(Schema.positive()),
  }),
  standard: Schema.Literal("dwc", "abcd"),
  tools: Schema.Struct({
    fileRead: Schema.optional(FileReadConfigSchema),
    shell: Schema.optional(ShellConfigSchema),
    fileWrite: Schema.optional(FileWriteConfigSchema),
    userPrompt: Schema.optional(UserPromptConfigSchema),
  }),
});

type Config = Schema.Schema.Type<typeof ConfigSchema>;
```

The TypeScript type is derived — `Config.sourceDir` is `string`, `Config.standard` is `"dwc" | "abcd"`, `Config.tools.fileRead` is `{ enabled: boolean } | undefined`, and so on. No separate type definition to maintain.

The runtime decoder is derived:

```ts
const decodeConfig = Schema.decodeUnknownEither(ConfigSchema);

const result = decodeConfig(JSON.parse(Deno.readTextFileSync("config.json")));
// Either<Config, ParseError>
// — the parsed, typed config, or a structured error explaining what failed
```

The error reporting is derived — a `ParseError` with the path to the failing field, the expected type, and the actual value. Not `"Invalid config"` but `"Expected "dwc" | "abcd" at .standard, got "itis""`.

Add `standard` to the schema — the type updates, the decoder checks it, the error messages cover it. Remove a field — the type updates, downstream code that accesses it is a compile error. Tighten a constraint (change `Schema.String` to `Schema.Literal("dwc", "abcd")`) — the decoder enforces it, no downstream changes needed.

One definition. Three derivations. Nothing drifts.

Choosing Effect Schema is itself a structural decision. It signals to an LLM helping develop the harness: *schemas are how boundaries work here.* When the LLM encounters a new boundary — a new tool result, a new config field, a new LLM response format — the established pattern is clear: write a schema, derive the type and decoder from it. The LLM doesn't need to decide whether to use a hand-rolled validator, a Zod schema, a type assertion, or an `as` cast. The decision is made. This reduces the surface area for ad-hoc solutions in generated code.

### The Other Boundaries

The config boundary is the first, but it's not the only one. The DarwinKit configuration agent has boundaries everywhere untrusted data enters — and some of those boundaries carry real-world consequences.

#### Source Files

When the agent reads a CSV file, it gets raw bytes. Before classification can begin, those bytes need to become structured metadata:

```ts
const SourceFileSchema = Schema.Struct({
  _tag: Schema.Literal("sourceFile"),
  path: Schema.String,
  format: Schema.Literal("csv", "tsv", "xlsx"),
  columns: Schema.Array(Schema.String),
  sampleRows: Schema.Array(Schema.Array(Schema.String)).pipe(
    Schema.maxItems(5),
  ),
});

type SourceFile = Schema.Schema.Type<typeof SourceFileSchema>;
```

At runtime, a tool that returns malformed file metadata is caught at the boundary — not three function calls later when the classifier tries to access `columns` on an object that doesn't have any. At development time, an LLM generating the file-reading code can't produce a `SourceFile` without going through the decoder.

#### Column Classification

The agent classifies each column against Darwin Core terms. A classification carries a confidence score and reasoning:

```ts
const SemanticClassificationSchema = Schema.Struct({
  _tag: Schema.Literal("semanticClassification"),
  column: Schema.String,
  dwcTerm: Schema.String,
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
  reasoning: Schema.String,
});

type SemanticClassification = Schema.Schema.Type<typeof SemanticClassificationSchema>;
```

The `_tag` is a convention — a literal string that distinguishes this type from every other. The `confidence` score is constrained to `[0, 1]` at the boundary, not by a comment or convention. Downstream code that checks `classification.confidence < 0.8` knows the value is a number in range — because the schema proved it. The LLM's classification output is non-deterministic — the schema is the gate between non-deterministic output and typed, trustworthy data.

#### The Receipt Chain: Classification to Mapping

Here's where "types as receipts" becomes more than a config-loading trick. A `ColumnMapping` — the structure that ends up in the generated `darwinkit.yaml` — should only exist if the column was classified. And if the classification confidence was low, the mapping should only exist if the user confirmed it.

```ts
const UserConfirmationSchema = Schema.Struct({
  _tag: Schema.Literal("userConfirmation"),
  column: Schema.String,
  dwcTerm: Schema.String,
  originalConfidence: Schema.Number.pipe(Schema.between(0, 1)),
  userApproved: Schema.Boolean,
  timestamp: Schema.String,
});

type UserConfirmation = Schema.Schema.Type<typeof UserConfirmationSchema>;

const UserResponseSchema = Schema.Struct({
  _tag: Schema.Literal("userResponse"),
  column: Schema.String,
  question: Schema.String,
  response: Schema.String,
  timestamp: Schema.String,
});

type UserResponse = Schema.Schema.Type<typeof UserResponseSchema>;

const ColumnMappingSchema = Schema.Struct({
  _tag: Schema.Literal("columnMapping"),
  sourceColumn: Schema.String,
  dwcTerm: Schema.String,
  classification: SemanticClassificationSchema,
  confirmation: Schema.optional(UserConfirmationSchema),
  userContext: Schema.optional(Schema.Array(UserResponseSchema)),
});

type ColumnMapping = Schema.Schema.Type<typeof ColumnMappingSchema>;
```

Notice: `ColumnMapping` requires a `classification` field whose type is `SemanticClassification`. You can't construct a `ColumnMapping` without first having a decoded `SemanticClassification`. The classification is the receipt — proof that the column was analyzed before it was mapped.

There are two kinds of user interaction receipts. `UserConfirmation` is the yes/no gate for low-confidence classifications — proof that the user approved a specific mapping. `UserResponse` is a gap-filling answer — the user told the agent that "sp_code" means "species code," and that context informed the classification. Both are receipts: they record what the user said, when, and about which column. If either is lost during context compaction, the agent has lost proof of a decision that constrains downstream mappings.

In the naive version, nothing prevented the agent from skipping classification and going straight to config generation. Here, the type makes it impossible. A `ColumnMapping` without a `classification` fails to decode. The receipt chain is structural.

#### The Generated Config

The final output — the `darwinkit.yaml` config — also gets a schema:

```ts
const FieldMappingSchema = Schema.Struct({
  sourceField: Schema.String,
  dwcField: Schema.String,
});

const DatasetSchema = Schema.Struct({
  source: Schema.String,
  format: Schema.Literal("csv", "tsv", "xlsx"),
  fieldMappings: Schema.Array(FieldMappingSchema),
});

const DarwinKitConfigSchema = Schema.Struct({
  _tag: Schema.Literal("darwinKitConfig"),
  standard: Schema.Literal("dwc", "abcd"),
  datasets: Schema.Array(DatasetSchema),
});

type DarwinKitConfig = Schema.Schema.Type<typeof DarwinKitConfigSchema>;
```

The generated config is decoded before it's written to disk. If the agent produces a config with an invalid `standard` or a malformed field mapping, the boundary catches it. The agent doesn't write garbage and hope the DarwinKit CLI figures it out later.

#### LLM Responses

LLM responses are decoded at the boundary, same as everything else:

```ts
const ToolCallSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Unknown,
});

const LLMResponseSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("text"),
    content: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("toolCall"),
    name: Schema.String,
    arguments: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.Literal("mixed"),
    content: Schema.String,
    toolCalls: Schema.Array(ToolCallSchema),
  }),
);

type LLMResponse = Schema.Schema.Type<typeof LLMResponseSchema>;
```

The `_tag` field distinguishes each variant. The MVP used `type`, but `_tag` is the Effect convention for discriminated unions. The `"mixed"` variant is now part of the union — the loop can't silently skip it because the compiler will require exhaustive handling (more on this in Post 2). This is the most direct runtime boundary — every LLM response passes through this decoder before the harness acts on it.

### Context Compaction and Lost Receipts

The compaction problem is sharper now. In the naive version, compacting away a tool result loses some text. In the receipt-based version, compacting away a `SemanticClassification` or a `UserConfirmation` loses proof.

Consider the agent midway through a session. It has classified 15 columns, asked the user to confirm 3 low-confidence mappings, and received approval for 2 of them. The conversation is long. Compaction runs. If `slice(-6)` drops the messages containing those confirmations, the agent has lost the receipts. It has two choices: re-ask the user (annoying, and the user may not give the same answer), or proceed without confirmation (exactly the bug the receipt chain was supposed to prevent).

This is why compaction can't be a generic text-truncation function. It needs to understand what receipts exist in the conversation and preserve them. The receipt schema tells you which messages carry proof — that's a structural advantage over the naive version, where nothing distinguishes a classification result from any other tool output. Receipt-aware compaction — understanding which messages carry proof and preserving them — is a significant problem that deserves its own treatment. This series focuses on the structural patterns themselves; a follow-up could address how compaction interacts with each of them.

### Scaling

Adding a new tool means adding two schemas — one for the config, one for the result. Say the harness needs a `webFetch` tool for pulling reference taxonomies:

```ts
const WebFetchConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  allowedDomains: Schema.Array(Schema.String),
});

const WebFetchResultSchema = Schema.Struct({
  _tag: Schema.Literal("webFetchResult"),
  url: Schema.String,
  content: Schema.String,
  statusCode: Schema.Number,
});
```

Add `webFetch: Schema.optional(WebFetchConfigSchema)` to the `tools` struct in `ConfigSchema`. The type updates. The decoder checks it. The error messages cover it. No cast, no hand-rolled validator to forget.

And if the new tool's result needs to feed into the receipt chain — say, a taxonomy lookup that validates a `dwcTerm` — you add the receipt requirement to `ColumnMappingSchema`. Every existing mapping that lacks the new receipt is now a decode error. The compiler tells you everywhere the chain is incomplete.

The audit's first finding — "the config type and the validator disagree" — is eliminated. They can't disagree because they don't exist separately. The schema is the type and the validator. And the deeper finding — "nothing proves the user was consulted" — is eliminated by the receipt chain. A `ColumnMapping` without a `SemanticClassification` is structurally impossible. A low-confidence mapping without a `UserConfirmation` is a policy decision you can enforce at the schema level.

---

## What's Next

The audit surfaced seven fragilities. This post fixed the first two — validation that doesn't change the type, and nothing proving the user was consulted — by introducing receipt chains that carry proof through the agent's workflow. Four more map to subsequent posts:

- **Errors are generic strings.** Every failure is the same catch block. *Next: [Making Illegal States Unrepresentable](/making-illegal-states-unrepresentable) — discriminated unions where the compiler enforces exhaustive handling.*
- **Budget enforcement is scattered and the lifecycle has no structure.** Ad-hoc if-statements and a while loop with a counter. *[State Machines and Lifecycle](/state-machines-and-lifecycle) — XState with bounded loops and a parallel budget tracker.*
- **The conversation has no protocol.** Messages can arrive in any order. *[Encoding Protocols in State](/encoding-protocols-in-state) — typestate at compile time.*
- **Every tool is always available.** No structural restriction on what the harness can reach. *[Capabilities and Effects](/capabilities-and-effects) — narrow interfaces and effect tracking.*

Each post takes the MVP from this post and applies one fix. The same codebase, progressively constrained, until most classes of bug have nowhere to live.
