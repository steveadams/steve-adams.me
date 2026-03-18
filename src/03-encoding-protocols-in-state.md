---
title: "Encoding Protocols in State"
date: "2026-03-17T00:00:00.000Z"
slug: "encoding-protocols-in-state"
description: "Leveraging typestate patterns and state machines to enforce protocol correctness through the type system."
draft: true
---

# Encoding Protocols in State

> Part 3 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

An agent harness accumulates a conversation — a sequence of messages sent to and received from the LLM. The conversation has rules:

1. It starts with a user message (the task).
2. The LLM responds, possibly with a tool call.
3. If there's a tool call, the tool result must be appended before calling the LLM again.
4. The LLM is called with the full conversation. Only conversations where the last assistant message has been "resolved" (either it was plain text, or all tool calls have results) are valid to send.

Rule 3 is the one that breaks. It's a common bug in agent implementations: the code pushes a tool call onto the conversation, then calls the LLM without appending the tool result. The LLM sees a dangling tool call with no result. Some APIs error. Some hallucinate a result. Some quietly produce garbage. All of these are bad, and none are caught by the type system — because the conversation is usually typed as:

```ts
type Conversation = Array<Message>;
```

Every operation is available at all times. Push a user message, push an assistant message, push a tool result, call the LLM — nothing in the type distinguishes a conversation that's ready to send from one that has an unresolved tool call. An LLM generating code to extend the harness sees `Array<Message>` and has no structural reason to get the ordering right.

This generalizes beyond conversations. Any protocol with temporal coupling — steps that must happen in a specific order — has this problem. Builders where `.build()` is callable before required fields are set. Connections where `.send()` is callable before `.connect()`. Transactions where `.commit()` is callable before `.begin()`. The methods exist on the object at all times, and the only thing preventing misuse is the programmer's knowledge of the protocol.

## The Pattern: Two Complementary Approaches

**Typestate (compile-time):** Make the available operations depend on the current state by changing the type. A `Conversation<"pending">` has different methods than a `Conversation<"toolCall">`. Calling the LLM with a `Conversation<"toolCall">` is a type error — the method doesn't accept that type.

**State machines (runtime):** Define valid transitions in a machine. Events sent in states that don't handle them are absorbed silently (safe no-op) rather than crashing. The machine definition is the single source of truth for what can happen and when.

Typestate constrains what code can be *written*. State machines constrain what code can *do*. They target different layers and complement each other.

## Organon's Conversation Accumulator (Typestate)

The conversation has three states:

```ts
// The state is encoded in the type parameter
type Conversation<S extends "empty" | "pending" | "toolCall"> = {
  readonly _state: S;
  readonly messages: ReadonlyArray<Message>;
};
```

Transition functions produce conversations in the correct state:

```ts
// Starting point — empty conversation
function empty(): Conversation<"empty"> { /* ... */ }

// Add a user message to an empty conversation — now it's pending (ready to send)
function addUserMessage(
  conv: Conversation<"empty">,
  message: string
): Conversation<"pending"> { /* ... */ }

// The LLM responded with plain text — still pending (can call LLM again or finalize)
function addAssistantText(
  conv: Conversation<"pending">,
  text: string
): Conversation<"pending"> { /* ... */ }

// The LLM responded with a tool call — now in toolCall state (must resolve before continuing)
function addToolCall(
  conv: Conversation<"pending">,
  call: ToolCallRequest
): Conversation<"toolCall"> { /* ... */ }

// Tool result appended — back to pending
function addToolResult(
  conv: Conversation<"toolCall">,
  result: ToolResultMessage
): Conversation<"pending"> { /* ... */ }
```

The key constraint: the function that calls the LLM only accepts `Conversation<"pending">`:

```ts
function callLLM(
  conv: Conversation<"pending">
): Effect<LLMResponse, LLMParseFailure, LLMApi> { /* ... */ }
```

Passing a `Conversation<"toolCall">` is a compile error. The bug — calling the LLM with a dangling tool call — is structurally impossible.

### Honesty about TypeScript's typestate

This works, but it's verbose. TypeScript doesn't have ownership semantics — nothing prevents you from holding onto an old `Conversation<"pending">` reference after transitioning to `Conversation<"toolCall">`. The constraint is opt-in: if you use the transition functions, you get the guarantees. If you cast or bypass them, you don't.

For Organon, this is acceptable. The conversation accumulator is a small, contained module. The transition functions are the only API. The typestate catches the most common bug (dangling tool calls) at compile time. But it's worth being honest: TypeScript's typestate is an approximation, not an ironclad guarantee. This is one reason we also want runtime enforcement.

## Before and After

**Before — untyped conversation:**

```ts
const messages: Message[] = [];
messages.push({ role: "user", content: task });

const response = await callLLM(messages); // fine
messages.push({ role: "assistant", tool_calls: [{ name: "webFetch", arguments: { url } }] });

// BUG: calling LLM without appending the tool result
const nextResponse = await callLLM(messages); // compiles, runs, produces garbage
```

An LLM generates this. It looks reasonable. `messages` is an array, `callLLM` takes an array, the types agree. The bug — the missing tool result — is invisible. The API call succeeds but produces a confusing response because the conversation is malformed.

**After — typestate conversation:**

```ts
const conv = empty();
const withTask = addUserMessage(conv, task);
const response = await callLLM(withTask); // Conversation<"pending"> — accepted

const withToolCall = addToolCall(withTask, response.toolCall);
// withToolCall is Conversation<"toolCall">

await callLLM(withToolCall);
// ^^^^^^^^^^^^^^^^^^^^^^^^
// Type error: Argument of type 'Conversation<"toolCall">'
// is not assignable to parameter of type 'Conversation<"pending">'
```

The LLM generating this code hits the type error immediately. The fix is obvious: append the tool result first. The protocol is in the types.

## Scaling

You add `Conversation<"streaming">` for streaming responses. A new state where tokens are arriving incrementally and the conversation shouldn't be sent to the LLM or finalized yet. Every function that accepts `Conversation<"pending">` still works unchanged — it doesn't accept `"streaming"`, so calls that shouldn't happen during streaming are compile errors. You only write the transition functions and handlers for the new state. Existing code is unaffected and verified correct by the compiler.

---

Typestate constrains what code can be *written*. But the agent lifecycle depends on runtime decisions — LLM responses, tool timeouts, budget limits — that the compiler can't predict. The next post addresses this with runtime state machines.

*Next: [State Machines and Lifecycle](/state-machines-and-lifecycle) — Organon's agent lifecycle as an XState machine with bounded loops and a parallel budget tracker.*
