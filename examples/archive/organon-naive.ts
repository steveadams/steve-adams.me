// organon-naive.ts — A naive agent tool-use harness
// Companion artifact for the "Structural Guardrails for LLM-Generated Code" series

// ─── Types ──────────────────────────────────────────────────────────

type Config = {
  llm: { model: string; apiKey: string; maxTokens: number };
  timeout: number;
  maxRetries: number;
  maxIterations: number;
  budgetLimit: number;
  tools: {
    webFetcher?: { enabled: boolean; allowedDomains: string[] };
    textExtractor?: { enabled: boolean; maxLength: number };
    calculator?: { enabled: boolean };
    fileWriter?: { enabled: boolean; outputDir: string };
  };
};

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "assistant"; toolCall: { name: string; arguments: Record<string, unknown> } }
  | { role: "tool"; name: string; result: string };

type LLMResponse =
  | { type: "text"; content: string }
  | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
  | {
      type: "mixed";
      content: string;
      toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    };

type ToolResult = {
  ok: boolean;
  data?: string;
  error?: string;
  timedOut?: boolean;
};

// ─── Config Loading ─────────────────────────────────────────────────

function validateConfig(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.timeout !== "number") return false;
  if (typeof obj.maxRetries !== "number") return false;
  if (typeof obj.maxIterations !== "number") return false;
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

// ─── LLM Client (streaming) ────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a helpful research assistant. Use the provided tools to look up information and perform calculations. Respond with your final answer when done.";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "webFetcher",
      description: "Fetch a web page and return its content",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate a mathematical expression",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "The math expression to evaluate",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fileWriter",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to write to" },
          content: { type: "string", description: "The content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
];

function formatMessages(messages: Message[]) {
  return messages.map((msg) => {
    if ("toolCall" in msg) {
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: msg.toolCall.name,
              arguments: msg.toolCall.arguments,
            },
          },
        ],
      };
    }
    if (msg.role === "tool") {
      return { role: "tool", content: msg.result, name: msg.name };
    }
    return { role: msg.role, content: msg.content };
  });
}

const encoder = new TextEncoder();

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
        ...formatMessages(messages),
      ],
      tools: TOOLS,
      stream: true,
      think: false,
    }),
  });

  let text = "";
  let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  let done = false;

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);

      if (chunk.message?.content) {
        text += chunk.message.content;
        Deno.stdout.writeSync(encoder.encode(chunk.message.content));
      }

      if (chunk.message?.tool_calls) {
        toolCalls.push(
          ...chunk.message.tool_calls.map((tc: any) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        );
      }

      if (chunk.done) {
        done = true;
      }
    }
  }

  if (toolCalls.length > 0 && text.length > 0) {
    return { type: "mixed", content: text, toolCalls };
  }
  if (toolCalls.length > 0) {
    return {
      type: "toolCall",
      name: toolCalls[0].name,
      arguments: toolCalls[0].arguments,
    };
  }
  return { type: "text", content: text };
}

// ─── Tool Implementations ───────────────────────────────────────────

async function webFetcher(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = String(args.url);
  const response = await fetch(url);
  const html = await response.text();
  const main =
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
    html;
  const text = main
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { ok: true, data: text.slice(0, 8000) };
}

function calculator(args: Record<string, unknown>): ToolResult {
  const expression = String(args.expression);
  const result = new Function("return " + expression)();
  return { ok: true, data: String(result) };
}

function fileWriter(args: Record<string, unknown>): ToolResult {
  const path = String(args.path);
  const content = String(args.content);
  Deno.writeTextFileSync(path, content);
  return { ok: true, data: `Wrote ${content.length} bytes to ${path}` };
}

function textExtractor(_args: Record<string, unknown>): ToolResult {
  throw new Error("textExtractor is not implemented");
}

// ─── Tool Dispatch ──────────────────────────────────────────────────

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolResult> {
  // Permission check — bolted on, inconsistent
  if (name === "fileWriter" && !config.tools.fileWriter?.enabled) {
    return { ok: false, error: "fileWriter is disabled" };
  }

  const timeout = config.timeout;

  try {
    const resultPromise = (() => {
      switch (name) {
        case "webFetcher":
          return webFetcher(args);
        case "calculator":
          return Promise.resolve(calculator(args));
        case "fileWriter":
          return Promise.resolve(fileWriter(args));
        case "textExtractor":
          return Promise.resolve(textExtractor(args));
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    })();

    const result = await Promise.race([
      resultPromise,
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error("Tool timed out")), timeout),
      ),
    ]);

    return result;
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false,
      error: message,
      timedOut: message === "Tool timed out",
    };
  }
}

// ─── Retry Logic ────────────────────────────────────────────────────

async function callLLMWithRetry(
  messages: Message[],
  config: Config,
): Promise<LLMResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await callLLM(messages, config);
    } catch (err) {
      lastError = err as Error;
      console.error(
        `LLM call failed (attempt ${attempt + 1}): ${lastError.message}`,
      );
      if (attempt < config.maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

// ─── Context Management ─────────────────────────────────────────────

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if ("content" in msg) chars += (msg as { content: string }).content.length;
    if ("toolCall" in msg)
      chars += JSON.stringify(
        (msg as { toolCall: unknown }).toolCall,
      ).length;
    if ("result" in msg) chars += (msg as { result: string }).result.length;
  }
  return Math.ceil(chars / 4);
}

function trimMessages(messages: Message[]): Message[] {
  if (messages.length <= 20) return messages;
  return [messages[0], ...messages.slice(-15)];
}

// ─── Stall Detection ────────────────────────────────────────────────

function isStuck(messages: Message[]): boolean {
  const recentToolCalls = messages
    .filter(
      (m): m is Extract<Message, { toolCall: unknown }> => "toolCall" in m,
    )
    .slice(-3);

  if (recentToolCalls.length < 3) return false;

  const first = JSON.stringify(recentToolCalls[0].toolCall);
  return recentToolCalls.every(
    (tc) => JSON.stringify(tc.toolCall) === first,
  );
}

// ─── Main Loop ──────────────────────────────────────────────────────

async function runAgent(task: string, config: Config): Promise<string> {
  const messages: Message[] = [{ role: "user", content: task }];
  let iterations = 0;
  let totalTokens = 0;

  while (iterations < config.maxIterations) {
    console.log(`\n--- Iteration ${iterations + 1} ---`);

    // Stall detection — bolted on
    if (isStuck(messages)) {
      console.log("Agent appears stuck. Stopping.");
      const lastText = messages.findLast(
        (m) => "content" in m && m.role === "assistant",
      );
      return `Agent stuck after ${iterations} iterations. Last response: ${
        lastText ? (lastText as { content: string }).content : "none"
      }`;
    }

    // Context management — bolted on
    const tokenEstimate = estimateTokens(messages);
    if (tokenEstimate > config.budgetLimit) {
      const lastAssistant = messages.findLast(
        (m) => "content" in m && m.role === "assistant",
      ) as { content: string } | undefined;
      return `Budget exceeded (${tokenEstimate} estimated tokens). Partial result: ${
        lastAssistant?.content ?? "none"
      }`;
    }

    // Trim if getting long — bolted on
    if (messages.length > 20) {
      const before = messages.length;
      const trimmed = trimMessages(messages);
      messages.length = 0;
      messages.push(...trimmed);
      console.log(`Trimmed messages: ${before} → ${messages.length}`);
    }

    // LLM call with retry
    const response = await callLLMWithRetry(messages, config);

    // Crude token tracking (vestigial — budget check above uses estimateTokens instead)
    totalTokens += (response as { content?: string }).content?.length ?? 100;

    // Response handling
    if (response.type === "text") {
      console.log("\nAgent produced final answer.");
      return response.content;
    }

    if (response.type === "toolCall") {
      console.log(
        `\nTool call: ${response.name}(${JSON.stringify(response.arguments)})`,
      );
      messages.push({
        role: "assistant",
        toolCall: { name: response.name, arguments: response.arguments },
      });
      const result = await dispatchTool(
        response.name,
        response.arguments,
        config,
      );
      if (result.ok) {
        console.log(`Tool result: ${result.data?.slice(0, 200)}...`);
        messages.push({
          role: "tool",
          name: response.name,
          result: result.data ?? "",
        });
      } else {
        console.log(`Tool error: ${result.error}`);
        messages.push({
          role: "tool",
          name: response.name,
          result: `Error: ${result.error}`,
        });
      }
    }

    if (response.type === "mixed") {
      const tc = response.toolCalls[0];
      console.log(
        `\nTool call (mixed): ${tc.name}(${JSON.stringify(tc.arguments)})`,
      );
      messages.push({
        role: "assistant",
        toolCall: { name: tc.name, arguments: tc.arguments },
      });
      const result = await dispatchTool(tc.name, tc.arguments, config);
      if (result.ok) {
        messages.push({
          role: "tool",
          name: tc.name,
          result: result.data ?? "",
        });
      } else {
        messages.push({
          role: "tool",
          name: tc.name,
          result: `Error: ${result.error}`,
        });
      }
    }

    iterations++;
  }

  return `Max iterations (${config.maxIterations}) reached.`;
}

// ─── Entry Point ────────────────────────────────────────────────────

const config = loadConfig(new URL("config.json", import.meta.url).pathname);
const result = await runAgent(
  "What is the current population of Tokyo, and what percentage of Japan's total population does it represent?",
  config,
);
console.log("\nResult:", result);
