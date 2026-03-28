// darwinkit-naive.ts — A naive Darwin Core Archive packaging agent
// Companion artifact for the "Structural Guardrails for LLM-Generated Code" series
// Demonstrates the fragilities that structural guardrail patterns eliminate.

// ─── Types ──────────────────────────────────────────────────────────

type Config = {
  llm: { model: string; apiKey: string; maxTokens: number };
  timeout: number;
  maxRetries: number;
  maxRevisions: number;
  budgetLimit: number;
  sourceDir: string;
  outputDir: string;
  tools: {
    fileRead?: { enabled: boolean };
    archiveWrite?: { enabled: boolean };
    userPrompt?: { enabled: boolean };
  };
};

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "assistant"; toolCall: { name: string; arguments: Record<string, unknown> } }
  | { role: "tool"; name: string; result: string };

type LLMResponse =
  | { type: "text"; content: string }
  | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

type ToolResult = {
  ok: boolean;
  data?: string;
  error?: string;
  timedOut?: boolean;
};

// ─── Config Loading ─────────────────────────────────────────────────

// BUG: Validator doesn't check tool sub-objects, sourceDir, or outputDir.
// Type and validator disagree — the type says sourceDir exists, but the validator
// doesn't verify it. loadConfig casts with `as Config`, creating a lie.
function validateConfig(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.timeout !== "number") return false;
  if (typeof obj.maxRetries !== "number") return false;
  if (typeof obj.maxRevisions !== "number") return false;
  if (typeof obj.budgetLimit !== "number") return false;
  if (typeof obj.llm !== "object" || obj.llm === null) return false;
  if (typeof obj.tools !== "object" || obj.tools === null) return false;
  return true;
}

function loadConfig(path: string): Config {
  const raw = JSON.parse(Deno.readTextFileSync(path));
  if (!validateConfig(raw)) {
    throw new Error("Invalid config");
  }
  return raw as Config;
}

// ─── LLM Client ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a biodiversity data specialist. You help scientists package validated Darwin Core CSV files into Darwin Core Archive (DwC-A) format. For each dataset, determine the archive structure (Occurrence core or Event core, with extensions), infer metadata (geographic bounding box, temporal extent, taxonomic coverage) from the data, gather additional metadata from the user (abstract, methods, keywords), generate EML XML and meta.xml, and assemble the archive zip.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "fileRead",
      description: "Read a file from the source directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to read" },
          maxRows: { type: "number", description: "Maximum rows to return for CSV preview" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "archiveWrite",
      description: "Write an archive artifact (meta.xml, eml.xml, or zip) to the output directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path within output directory" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "userPrompt",
      description: "Ask the user a yes/no confirmation question",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask" },
          context: { type: "string", description: "Additional context for the user" },
        },
        required: ["question"],
      },
    },
  },
];

async function callLLM(
  messages: Message[],
  config: Config,
): Promise<LLMResponse> {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((msg) => {
          if ("toolCall" in msg) {
            return {
              role: "assistant",
              content: "",
              tool_calls: [{
                function: { name: msg.toolCall.name, arguments: msg.toolCall.arguments },
              }],
            };
          }
          if (msg.role === "tool") {
            return { role: "tool", content: msg.result, name: msg.name };
          }
          return { role: msg.role, content: msg.content };
        }),
      ],
      tools: TOOLS,
      stream: false,
    }),
  });

  const data = await response.json();
  const msg = data.message;

  if (msg.tool_calls?.length > 0) {
    const tc = msg.tool_calls[0];
    return {
      type: "toolCall",
      name: tc.function.name,
      arguments: tc.function.arguments,
    };
  }
  return { type: "text", content: msg.content };
}

// ─── Tool Implementations ───────────────────────────────────────────

// BUG: No capability restriction. fileRead can read ANY file, not just source directory.
// archiveWrite can write ANYWHERE, not just output directory.
function fileRead(args: Record<string, unknown>, _config: Config): ToolResult {
  const path = String(args.path);
  try {
    const content = Deno.readTextFileSync(path);
    const maxRows = Number(args.maxRows) || 10;
    const lines = content.split("\n");
    const preview = lines.slice(0, maxRows + 1).join("\n");
    return { ok: true, data: `Columns: ${lines[0]}\n\nPreview (${Math.min(lines.length - 1, maxRows)} rows):\n${preview}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// BUG: No output directory scoping. Can write to any path.
function archiveWrite(args: Record<string, unknown>, _config: Config): ToolResult {
  const path = String(args.path);
  const content = String(args.content);
  try {
    Deno.writeTextFileSync(path, content);
    return { ok: true, data: `Wrote ${content.length} bytes to ${path}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// BUG: Auto-confirms everything. No actual user interaction.
// The naive implementation has no way to ask the user gap-filling questions
// like "is this bounding box correct? It includes coordinates at [0,0]"
// or "the temporal extent spans 1850–2024 — is that expected?" It can only
// auto-confirm, and even that is skipped in practice because nothing forces
// the agent to call this tool.
function userPrompt(args: Record<string, unknown>, _config: Config): ToolResult {
  const question = String(args.question);
  console.log(`[Auto-confirmed] ${question}`);
  return { ok: true, data: "confirmed" };
}

// ─── Tool Dispatch ──────────────────────────────────────────────────

// BUG: Permission check only on archiveWrite. fileRead has no restrictions.
// All errors are generic strings — no structured error types.
function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  config: Config,
): ToolResult {
  if (name === "archiveWrite" && !config.tools.archiveWrite?.enabled) {
    return { ok: false, error: "archiveWrite is disabled" };
  }

  try {
    switch (name) {
      case "fileRead":
        return fileRead(args, config);
      case "archiveWrite":
        return archiveWrite(args, config);
      case "userPrompt":
        return userPrompt(args, config);
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Stall Detection ────────────────────────────────────────────────

// BUG: Checks if the last 3 tool calls are identical. Doesn't detect
// revision loops, oscillation, or stagnation in EML validation results.
function isStuck(messages: Message[]): boolean {
  const recentToolCalls = messages
    .filter((m): m is Extract<Message, { toolCall: unknown }> => "toolCall" in m)
    .slice(-3);

  if (recentToolCalls.length < 3) return false;

  const first = JSON.stringify(recentToolCalls[0].toolCall);
  return recentToolCalls.every((tc) => JSON.stringify(tc.toolCall) === first);
}

// ─── Pre-Turn Pipeline ──────────────────────────────────────────────

// Same concerns as the inline checks, extracted into named stages.
// Each stage can be replaced independently as we improve the harness.

type CheckResult = { continue: true } | { continue: false; reason: string };

// BUG: Can split related messages (tool call from its result).
// Doesn't know which messages carry proof of user metadata decisions.
function compactContext(messages: Message[], _config: Config): CheckResult {
  if (messages.length <= 30) return { continue: true };
  const trimmed = [messages[0], ...messages.slice(-20)];
  messages.length = 0;
  messages.push(...trimmed);
  console.log(`Trimmed to ${messages.length} messages`);
  return { continue: true };
}

// BUG: Uses rough chars/4 heuristic. Doesn't track actual token usage.
function checkBudget(messages: Message[], config: Config): CheckResult {
  const tokenEstimate = messages.reduce((sum, m) => {
    if ("content" in m) return sum + (m as { content: string }).content.length / 4;
    if ("toolCall" in m)
      return sum + JSON.stringify((m as { toolCall: unknown }).toolCall).length / 4;
    if ("result" in m) return sum + (m as { result: string }).result.length / 4;
    return sum;
  }, 0);
  if (tokenEstimate > config.budgetLimit) {
    return {
      continue: false,
      reason: `Budget exceeded (${Math.ceil(tokenEstimate)} estimated tokens).`,
    };
  }
  return { continue: true };
}

// BUG: Only checks for 3 identical consecutive tool calls.
// Doesn't detect EML revision loops, oscillation, or stagnation.
function detectStall(messages: Message[], _config: Config): CheckResult {
  if (isStuck(messages)) {
    return { continue: false, reason: "Agent stuck — could not complete archive packaging." };
  }
  return { continue: true };
}

const preTurnChecks = [compactContext, checkBudget, detectStall];

// ─── Main Loop ──────────────────────────────────────────────────────

// BUG: No protocol enforcement. The agent can:
// - Generate an archive without determining structure first
// - Skip user confirmation on inferred metadata
// - Finalize without validating EML
// - Write to arbitrary paths
// The "workflow" is whatever the LLM decides to do.
async function runAgent(config: Config): Promise<string> {
  const messages: Message[] = [
    {
      role: "user",
      content: `Examine the data files in ${config.sourceDir} and package them as a Darwin Core Archive. Determine whether this is an Occurrence core or Event core archive. Infer geographic coverage, temporal extent, and taxonomic coverage from the data. Ask me for an abstract, methods description, and keywords. Generate eml.xml and meta.xml, then assemble the archive zip in ${config.outputDir}. Validate the EML against the schema. If validation fails, revise and try again.`,
    },
  ];

  let iterations = 0;

  while (iterations < config.maxRevisions) {
    console.log(`\n--- Iteration ${iterations + 1} ---`);

    for (const check of preTurnChecks) {
      const result = check(messages, config);
      if (!result.continue) return result.reason;
    }

    const response = await callLLM(messages, config);

    if (response.type === "text") {
      console.log("\nAgent produced final answer.");
      return response.content;
    }

    if (response.type === "toolCall") {
      console.log(`\nTool call: ${response.name}(${JSON.stringify(response.arguments)})`);
      messages.push({
        role: "assistant",
        toolCall: { name: response.name, arguments: response.arguments },
      });
      const result = dispatchTool(response.name, response.arguments, config);
      messages.push({
        role: "tool",
        name: response.name,
        result: result.ok ? (result.data ?? "") : `Error: ${result.error}`,
      });
    }

    iterations++;
  }

  return `Max revisions (${config.maxRevisions}) reached.`;
}

// ─── Entry Point ────────────────────────────────────────────────────

const config = loadConfig(new URL("config.json", import.meta.url).pathname);
const result = await runAgent(config);
console.log("\nResult:", result);
