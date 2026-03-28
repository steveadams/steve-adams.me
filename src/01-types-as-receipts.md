---
title: "Types as Receipts"
date: "2026-03-17T18:38:21.000Z"
slug: "types-as-receipts"
description: "Validation that changes the type — parsing as proof that a boundary check happened, and why this matters for LLM-generated code."
draft: true
---

> Part 1 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

In the [series introduction](/structural-guardrails), we walked through what the Darwin Core Archive packaging agent does — and what can go wrong at every step. Each step previewed a structural challenge. Now let's make those challenges concrete.

We'll build a naive archive packaging agent using common TypeScript patterns. It will work. It will look reasonable. Then we'll add a confirmation gate, and watch everything that's fragile become visible.

## The MVP

The agent helps scientists package validated Darwin Core data into a Darwin Core Archive — a zip containing standardized CSVs, a `meta.xml` descriptor declaring archive structure, and an `eml.xml` metadata document for cataloguing and discovery. It reads source files, determines archive structure, infers metadata from the data, gathers additional metadata from the user, and generates the archive components. The harness starts by loading its own configuration — what tools are available, LLM parameters, output settings. Here's a type for that, and a validator:

```ts
type Config = {
  sourceDir: string;
  outputDir: string;
  llm: { model: string; maxTokens: number };
  standard: string;
  tools: {
    fileRead?: { enabled: boolean };
    archiveWrite?: { enabled: boolean };
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
  { type: "toolCall", name: "archiveWrite", arguments: { path: "meta.xml", content: "<archive>...</archive>" } },
  { type: "text", content: "Based on the source files, I've generated the archive with Occurrence core, eml.xml, and meta.xml." },
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

Three tools, each stubbed to return canned data. The dispatcher uses a switch on the tool name:

```ts
function fileRead(args: Record<string, unknown>): { content: string; path: string; format: string } {
  return {
    content: "scientificName,decimalLatitude,decimalLongitude\nQuercus robur,51.5,-0.1",
    path: String(args.path),
    format: "csv",
  };
}

function archiveWrite(args: Record<string, unknown>): { path: string; bytesWritten: number } {
  return { path: String(args.path), bytesWritten: 1024 };
}

function userPrompt(args: Record<string, unknown>): { response: string; confirmed: boolean } {
  return { response: "Yes, that bounding box looks correct.", confirmed: true };
}

function dispatchTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "fileRead":
        return JSON.stringify(fileRead(args));
      case "archiveWrite":
        return JSON.stringify(archiveWrite(args));
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
const result = await runAgent(
  "Package specimens.csv as a Darwin Core Archive with Occurrence core, eml.xml, and meta.xml",
  config,
);
console.log("Result:", result);
```

This works. Run it and you get `"Result: Based on the source files, I've generated the archive with Occurrence core, eml.xml, and meta.xml."` The happy path is fine.

## The Audit

This works. It's not broken. Now add a confirmation gate.

The naive harness has no confirmation step. The agent reads source files, infers metadata from the data — geographic bounding box from coordinates, temporal extent from date columns, taxonomic coverage from species fields — and generates archive components without asking the user whether any of it is correct. Adding `userPrompt` as a confirmation tool means touching every layer of the harness, and each layer reveals a different fragility.

**The config type and the validator disagree.** The `Config` type already has `userPrompt?: { enabled: boolean }` in the `tools` block. The validator doesn't know — it never checks inside `tools`. The `as Config` cast on the last line of `loadConfig` promises a shape the validator didn't verify. Downstream code accesses `config.tools.userPrompt.enabled` and gets `undefined` at runtime, despite the type saying `boolean`. *We'll fix this first, below.*

**The deeper problem: nothing proves the user was consulted.** Even with `userPrompt` in the config and the tool wired up, nothing forces the agent to call it. The agent can compute a geographic bounding box from coordinate columns that includes an outlier at [0, 0] — a common sentinel value for missing data — producing a coverage area that spans the entire globe. Without a confirmation gate, it writes that bounding box into `eml.xml` and the archive ships with geographic metadata that's wrong. The type system doesn't distinguish "inferred metadata that was confirmed" from "inferred metadata that was not." There's no receipt. *We'll fix this too — below.*

**Every error is the same string.** `userPrompt` can fail in ways the other tools can't — the user might reject inferred metadata, the terminal might not be interactive, the prompt might time out. But `dispatchTool` catches everything as `Error` and returns `"Tool execution failed: ..."`. The agent can't tell a user rejection from a timeout. *Post 2: discriminated unions and exhaustive matching.*

**The conversation has no protocol.** The `messages` array accepts any message in any order. After `dispatchTool` returns, nothing prevents calling `callLLM` again without pushing the tool result first — a dangling tool call the LLM API will reject with a confusing error. The type is `Message[]`. It doesn't encode "you must resolve tool calls before calling the LLM again." *Post 4: typestate patterns enforce ordering at compile time.*

**Every tool is always available.** A read-only metadata inference task has the same access as one that writes archive components — `dispatchTool` doesn't care. If the LLM hallucinates an `archiveWrite` call during an inspection-only phase, the harness will execute it. There's no structural restriction, just hope. *Post 5: capabilities and effects.*

**Budget enforcement is an afterthought.** Token counting is a single if-statement with a rough estimate. Add API call limits or wall-clock time and you add more if-statements, scattered through the loop body, each checking independently. Nothing ensures all dimensions are checked or that the checks are consistent. *Post 3: state machines with parallel budget tracking.*

**Context compaction is brittle.** Metadata inference produces detailed results — bounding box coordinates, temporal ranges, taxonomic lists, confirmation decisions. `compactConversation` truncates these to 80 characters, losing information the agent needs to track which metadata was confirmed. Worse, `slice(-6)` doesn't respect message pairs. If the boundary falls between a `userPrompt` tool call and its result, the compacted conversation has a dangling confirmation with no outcome — and the agent has lost the receipt of user approval. Losing an inferred metadata receipt means the agent re-infers it (wasteful) or proceeds without confirmation (dangerous — the bounding box included an outlier at [0, 0] that makes geographic coverage span the entire globe). *Compaction is a cross-cutting concern — the missing receipt (Post 1), indistinguishable outcomes (Post 2), protocol-breaking slices (Post 3), ungoverned timing (Post 4), and hidden summarization effects (Post 5) each appear in subsequent posts.*

This isn't bad code. It's normal code — the kind most agent harnesses use. The problems are natural consequences of common patterns. Each one becomes a structural fix in a subsequent post.

## Separating Concerns

Before fixing these individually, let's separate them so each fix is a targeted change. The loop body tangles compaction, budget checking, response handling, and tool dispatch together. Extract the pre-turn concerns into named stages with a shared signature:

```ts
type CheckResult = { continue: true } | { continue: false; reason: string };

function compact(messages: Message[], config: Config): CheckResult {
  const compacted = compactConversation(messages, config.llm.maxTokens * 0.8);
  messages.length = 0;
  messages.push(...compacted);
  return { continue: true };
}

function checkBudget(messages: Message[], config: Config): CheckResult {
  if (estimateTokens(messages) > config.llm.maxTokens) {
    return { continue: false, reason: "Budget exceeded." };
  }
  return { continue: true };
}

const preTurnChecks = [compact, checkBudget];
```

The main loop becomes a pipeline:

```ts
async function runAgent(task: string, config: Config): Promise<string> {
  let messages: Message[] = [{ role: "user", content: task }];
  let iterations = 0;

  while (iterations < 20) {
    for (const check of preTurnChecks) {
      const result = check(messages, config);
      if (!result.continue) return result.reason;
    }

    const response = await callLLM(messages);

    if (response.type === "text") return response.content;

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

Same problems. The `compact` stage still destroys receipts with `slice(-6)`. The budget check still uses a rough heuristic. The dispatcher still catches everything as a generic string. Nothing is structurally safer — just isolated. Each subsequent post replaces a specific stage.

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
    readonly archiveWrite?: { readonly enabled: boolean };
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

const ArchiveWriteConfigSchema = Schema.Struct({
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
    archiveWrite: Schema.optional(ArchiveWriteConfigSchema),
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

The config boundary is the first, but it's not the only one. The archive packaging agent has boundaries everywhere untrusted data enters — and some of those boundaries carry real-world consequences.

#### Source Files

When the agent reads a CSV file, it gets raw bytes. Before archive structure determination can begin, those bytes need to become structured metadata:

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

At runtime, a tool that returns malformed file metadata is caught at the boundary — not three function calls later when the structure determination step tries to access `columns` on an object that doesn't have any. At development time, an LLM generating the file-reading code can't produce a `SourceFile` without going through the decoder.

#### Archive Structure

The agent determines what kind of archive this data represents — Occurrence core or Event core, which files are extensions, what the row type is for each. A structure determination carries the reasoning and the decision:

```ts
const ArchiveStructureSchema = Schema.Struct({
  _tag: Schema.Literal("archiveStructure"),
  coreType: Schema.Literal("Occurrence", "Event"),
  coreFile: Schema.String,
  extensions: Schema.Array(Schema.Struct({
    file: Schema.String,
    rowType: Schema.String,
  })),
  reasoning: Schema.String,
});

type ArchiveStructure = Schema.Schema.Type<typeof ArchiveStructureSchema>;
```

The `_tag` is a convention — a literal string that distinguishes this type from every other. The `coreType` is constrained to `"Occurrence"` or `"Event"` at the boundary, not by a comment or convention. Downstream code that branches on `structure.coreType` knows the value is one of those two — because the schema proved it. The LLM's structural determination is non-deterministic — the schema is the gate between non-deterministic output and typed, trustworthy data.

#### The Receipt Chain: Metadata to Manifest

Here's where "types as receipts" becomes more than a config-loading trick. An `ArchiveManifest` — the structure that drives generation of `meta.xml` and `eml.xml` — should only exist if the archive structure was determined and the inferred metadata was confirmed.

The agent infers metadata from the data: a geographic bounding box from coordinate columns, a temporal extent from date fields, taxonomic coverage from species columns. Each inference is a receipt:

```ts
const UserConfirmationSchema = Schema.Struct({
  _tag: Schema.Literal("userConfirmation"),
  metadataField: Schema.String,
  inferredValue: Schema.String,
  userApproved: Schema.Boolean,
  timestamp: Schema.String,
});

type UserConfirmation = Schema.Schema.Type<typeof UserConfirmationSchema>;

const UserResponseSchema = Schema.Struct({
  _tag: Schema.Literal("userResponse"),
  field: Schema.String,
  question: Schema.String,
  response: Schema.String,
  timestamp: Schema.String,
});

type UserResponse = Schema.Schema.Type<typeof UserResponseSchema>;

const MetadataRecordSchema = Schema.Struct({
  _tag: Schema.Literal("metadataRecord"),
  field: Schema.String,
  value: Schema.String,
  source: Schema.Literal("inferred", "userProvided"),
  archiveStructure: ArchiveStructureSchema,
  confirmation: Schema.optional(UserConfirmationSchema),
  userContext: Schema.optional(Schema.Array(UserResponseSchema)),
});

type MetadataRecord = Schema.Schema.Type<typeof MetadataRecordSchema>;
```

Notice: `MetadataRecord` requires an `archiveStructure` field whose type is `ArchiveStructure`. You can't construct a `MetadataRecord` without first having a decoded `ArchiveStructure`. The structure determination is the receipt — proof that the archive's shape was analyzed before metadata was assembled.

There are two kinds of user interaction receipts. `UserConfirmation` is the yes/no gate for inferred metadata — proof that the user verified a specific inference. The agent computed a geographic bounding box from coordinate columns, but did the user confirm it's correct? The box might include an outlier at [0, 0] — a common sentinel for missing coordinates — that makes the coverage span the entire globe. `UserResponse` is a gap-filling answer — the user provided an abstract, described collection methods, or selected keywords from a controlled vocabulary. Both are receipts: they record what the user said, when, and about which metadata field. If either is lost during context compaction, the agent has lost proof of a decision that constrains the archive's metadata.

In the naive version, nothing prevented the agent from skipping structure determination and going straight to archive generation. Here, the type makes it impossible. A `MetadataRecord` without an `archiveStructure` fails to decode. The receipt chain is structural.

#### The Archive Manifest

The final output structure — what drives generation of `meta.xml` and `eml.xml` — also gets a schema:

```ts
const ArchiveManifestSchema = Schema.Struct({
  _tag: Schema.Literal("archiveManifest"),
  structure: ArchiveStructureSchema,
  metadata: Schema.Array(MetadataRecordSchema),
  standard: Schema.Literal("dwc", "abcd"),
});

type ArchiveManifest = Schema.Schema.Type<typeof ArchiveManifestSchema>;
```

The manifest requires an `ArchiveStructure` receipt and an array of `MetadataRecord` receipts — each of which carries its own `ArchiveStructure` receipt and optional `UserConfirmation` receipts. Multiple receipt types feed into the manifest, each proving a different kind of verification happened: that archive structure was determined, that inferred geographic coverage was verified, that the user-provided abstract was reviewed. The manifest is decoded before it drives generation. If the agent produces a manifest with an invalid `standard` or a metadata record lacking its structure receipt, the boundary catches it. The agent doesn't generate archive components from unverified metadata and hope the output is correct.

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

The compaction problem is sharper now. In the naive version, compacting away a tool result loses some text. In the receipt-based version, compacting away an `ArchiveStructure` or a `UserConfirmation` loses proof.

Consider the agent midway through a session. It has determined the archive structure, inferred a geographic bounding box and temporal extent, and asked the user to confirm both. The user approved the temporal extent but corrected the bounding box — the computed extent included outlier coordinates at [0, 0], and the user narrowed it to their actual study area. The conversation is long. Compaction runs. If `slice(-6)` drops the messages containing those confirmations, the agent has lost the receipts. It has two choices: re-infer the bounding box and re-ask the user (wasteful, and the user may not give the same correction), or proceed without confirmation (exactly the bug the receipt chain was supposed to prevent — the bounding box reverts to including the [0, 0] outlier, and the archive ships with geographic coverage spanning the entire globe).

The receipt schemas fix this. The same schemas that validate data at boundaries also identify which messages carry proof:

```ts
const receiptSchemas = [
  ArchiveStructureSchema,
  UserConfirmationSchema,
  UserResponseSchema,
];

function isReceipt(msg: Message): boolean {
  if (msg.role !== "tool") return false;
  try {
    const data = JSON.parse(msg.result);
    return receiptSchemas.some((schema) =>
      Either.isRight(Schema.decodeUnknownEither(schema)(data))
    );
  } catch {
    return false;
  }
}
```

The `compact` stage from the extracted pipeline now uses this to preserve receipts during compaction:

```ts
function compact(messages: Message[], config: Config): CheckResult {
  if (estimateTokens(messages) < config.llm.maxTokens * 0.8) return { continue: true };

  const task = messages[0];
  const recent = messages.slice(-6);
  const older = messages.slice(1, -6);
  const olderReceipts = older.filter(isReceipt);
  const compactable = older.filter((m) => !isReceipt(m));

  const summary = compactable
    .map((m) =>
      'toolCall' in m ? `Called ${m.toolCall.name}`
      : 'result' in m ? `${m.name}: ${m.result.slice(0, 80)}`
      : m.content.slice(0, 100))
    .join(' → ');

  messages.length = 0;
  messages.push(
    task,
    { role: "assistant", content: `[Earlier context: ${summary}]` },
    ...olderReceipts,
    ...recent,
  );
  return { continue: true };
}
```

Non-receipt messages are summarized and truncated. Receipt messages are preserved regardless of their position. The schema serves two enforcement points: it validates data crossing a boundary, and it identifies proof that compaction must preserve. One definition, two derivations. Add a new receipt type — say, a `SchemaValidation` for confirming EML validates against the XML schema — and `isReceipt` automatically preserves it. The receipt schemas are the source of truth for both "is this valid?" and "must this survive?"

### Scaling

Adding a new tool means adding two schemas — one for the config, one for the result. Say the harness needs a `schemaRegistry` tool for fetching controlled vocabulary terms — EML keywords, Darwin Core term URIs:

```ts
const SchemaRegistryConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  registryUrl: Schema.String,
});

const SchemaRegistryResultSchema = Schema.Struct({
  _tag: Schema.Literal("schemaRegistryResult"),
  termUri: Schema.String,
  vocabulary: Schema.String,
  matchedTerms: Schema.Array(Schema.String),
});
```

Add `schemaRegistry: Schema.optional(SchemaRegistryConfigSchema)` to the `tools` struct in `ConfigSchema`. The type updates. The decoder checks it. The error messages cover it. No cast, no hand-rolled validator to forget.

And if the new tool's result needs to feed into the receipt chain — say, a registry lookup that validates keyword selections against a controlled vocabulary — you add the receipt requirement to `MetadataRecordSchema`. Every existing metadata record that lacks the new receipt is now a decode error. The compiler tells you everywhere the chain is incomplete.

The audit's first finding — "the config type and the validator disagree" — is eliminated. They can't disagree because they don't exist separately. The schema is the type and the validator. And the deeper finding — "nothing proves the user was consulted" — is eliminated by the receipt chain. A `MetadataRecord` without an `ArchiveStructure` is structurally impossible. Inferred metadata without a `UserConfirmation` is a policy decision you can enforce at the schema level.

---

## What's Next

The audit surfaced seven fragilities. We separated the inline concerns into named middleware stages — same problems, just isolated — then fixed three: validation that doesn't change the type, nothing proving the user was consulted, and context compaction that destroys receipts. Receipt schemas now drive both boundary validation and compaction preservation — one definition, two enforcement points. Four more map to subsequent posts, each replacing a specific stage:

- **Errors are generic strings.** Every failure is the same catch block. *Next: [Making Illegal States Unrepresentable](/making-illegal-states-unrepresentable) — discriminated unions where the compiler enforces exhaustive handling.*
- **Budget enforcement is scattered and the lifecycle has no structure.** Ad-hoc if-statements and a while loop with a counter. *[State Machines and Lifecycle](/state-machines-and-lifecycle) — XState with bounded loops and a parallel budget tracker.*
- **The conversation has no protocol.** Messages can arrive in any order. *[Encoding Protocols in State](/encoding-protocols-in-state) — typestate at compile time.*
- **Every tool is always available.** No structural restriction on what the harness can reach. *[Capabilities and Effects](/capabilities-and-effects) — narrow interfaces and effect tracking.*

Each post takes the codebase from here and replaces a specific stage. The same middleware pipeline, progressively constrained, until most classes of bug have nowhere to live.
