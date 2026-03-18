---
title: "State Machines and Lifecycle"
date: "2026-03-17T00:00:00.000Z"
slug: "state-machines-and-lifecycle"
description: "Using XState to model the agent lifecycle as a state machine — bounded loops, budget tracking, and runtime enforcement of valid transitions."
draft: true
---

# State Machines and Lifecycle

> Part 4 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

The typestate conversation accumulator from Post 3 handles protocol ordering at compile time. But the agent's *lifecycle* — when to call the LLM, when to execute tools, when to stop — depends on runtime information that the compiler can't predict.

The LLM might return plain text or a tool call. A tool might succeed, fail, or time out. The budget might be exhausted mid-loop. An external interrupt might arrive. These are runtime decisions. The compiler can't resolve them — it doesn't know what the LLM will return or when a tool will time out.

Without a formal model, the lifecycle is scattered across `if/else` chains, boolean flags, and ad-hoc loops. Every handler makes independent decisions about what should happen next. An LLM generating code for one handler doesn't see the full picture — it sees a local context and makes a locally reasonable decision that might be globally wrong. The tool executor retries indefinitely because nothing told it about the loop bound. The planner re-enters execution because nothing told it the budget was exhausted. The lifecycle exists as an emergent property of scattered code — not as a definition anyone can inspect.

## The Pattern

A state machine makes the lifecycle explicit. Every valid state is named. Every valid transition is declared. Events sent in states that don't handle them are absorbed silently — no crash, no undefined behavior. The machine definition is the single source of truth for what can happen and when.

This is the runtime complement to typestate. Typestate constrains what code can be *written*. State machines constrain what code can *do*. Together, they cover both layers — compile-time protocol enforcement and runtime lifecycle control.

## Organon's Agent Lifecycle

The agent lifecycle has five top-level states:

- **idle** — waiting for a task
- **planning** — deciding what to do next (call the LLM, synthesize, abort)
- **executing** — actively interacting with the LLM and tools
- **evaluating** — examining the result and deciding if more work is needed
- **complete/failed** — terminal states

The `executing` state has its own substates: `callLLM` and `executeTool`. This nesting models the tool-call loop — the harness calls the LLM, the LLM requests a tool, the tool executes, the result feeds back to the LLM — as an explicit cycle within the `executing` state.

### The Machine

```ts
const agentMachine = setup({
  types: {
    context: {} as AgentContext,
    events: {} as AgentEvent,
  },
  guards: {
    withinLoopBound: ({ context }) => context.toolCallCount < context.maxToolCalls,
    budgetRemaining: ({ context }) => !context.budgetExhausted,
  },
}).createMachine({
  id: "agent",
  initial: "idle",
  states: {
    idle: {
      on: { START: "planning" },
    },
    planning: {
      on: {
        CALL_LLM: "executing.callLLM",
        SYNTHESIZE: "evaluating",
        ABORT: "failed",
      },
    },
    executing: {
      initial: "callLLM",
      states: {
        callLLM: {
          on: {
            LLM_TEXT: "#agent.evaluating",
            LLM_TOOL_CALL: "executeTool",
            LLM_PARSE_FAILURE: "#agent.planning",
          },
        },
        executeTool: {
          on: {
            TOOL_SUCCESS: [
              { guard: "withinLoopBound", target: "callLLM" },
              { target: "#agent.evaluating" },
            ],
            TOOL_ERROR: "#agent.planning",
            TOOL_TIMEOUT: "#agent.planning",
          },
        },
      },
    },
    evaluating: {
      on: {
        COMPLETE: "complete",
        NEEDS_MORE: "planning",
      },
    },
    complete: { type: "final" },
    failed: { type: "final" },
  },
});
```

Walk through a concrete execution to see why each state exists.

**`idle → planning`:** A task arrives. The machine moves to `planning`, where the planner examines the task and decides the first action. This is a pure decision — no side effects, no LLM calls. The planner produces a `Decision`: call the LLM, synthesize from existing data, or abort.

**`planning → executing.callLLM`:** The planner decides to call the LLM. The machine enters `executing.callLLM`. The harness sends the conversation to the LLM and waits for a response. Three outcomes are possible: the LLM returns text (`LLM_TEXT`), requests a tool call (`LLM_TOOL_CALL`), or returns unparseable output (`LLM_PARSE_FAILURE`).

**`executing.callLLM → executing.executeTool`:** The LLM requested a tool call. The machine moves to `executeTool`. The harness validates the tool call, dispatches it, and waits. Three outcomes again: `TOOL_SUCCESS`, `TOOL_ERROR`, `TOOL_TIMEOUT`.

**`executing.executeTool → executing.callLLM` (bounded):** The tool succeeded. Should the harness call the LLM again with the result? Only if the loop bound hasn't been reached. The `withinLoopBound` guard checks `toolCallCount < maxToolCalls`. If the guard passes, the machine transitions back to `callLLM`. If it fails, the machine exits to `evaluating` — the loop terminates.

This is the key structural guarantee: **the loop bound is enforced by the machine, not by the code inside the loop.** The code that handles `TOOL_SUCCESS` doesn't need to check the bound — the guard does it. An LLM generating the tool success handler can't accidentally create an infinite loop, because the transition that would continue the loop is guarded.

**Error recovery:** `LLM_PARSE_FAILURE`, `TOOL_ERROR`, and `TOOL_TIMEOUT` all transition back to `planning`. The planner re-examines the situation with the error context and decides what to do next — retry, skip, or abort. Error recovery is the planner's job, not the executor's. This separation means the executor doesn't need retry logic, backoff logic, or fallback logic. It reports what happened. The planner decides what to do about it.

**`evaluating → complete` or `evaluating → planning`:** The evaluator examines the LLM's output and decides: is this done, or does it need more work? `COMPLETE` is terminal. `NEEDS_MORE` cycles back to `planning` for another round. This outer loop is also bounded — by the budget tracker.

### What the Machine Gives You

From this single definition, four artifacts are derived:

**Runtime behavior.** The machine runs. Events sent in states that don't handle them are absorbed — no crash, no undefined behavior. Send `START` while in `executing`? Nothing happens. Send `TOOL_SUCCESS` while in `planning`? Absorbed. The machine only responds to events that are valid in the current state.

**TypeScript types.** XState v5's `setup()` with typed context and events means the compiler knows which events exist and which states are valid. Sending an event that doesn't exist is a type error.

**Visual documentation.** XState's inspector renders the machine as an interactive statechart. The documentation is always accurate because it's generated from the definition — not a diagram someone drew and forgot to update.

**Test paths.** Model-based testing generates paths through the machine: every reachable state, every valid transition sequence. The happy path, the bounded loop termination, error recovery paths — all derived from the machine.

Four artifacts. One definition. Nothing drifts.

### The Parallel Budget Tracker

The loop bound caps the tool-call cycle, but the agent has other resource limits: token usage, API call count, wall-clock time. These are tracked by a parallel state machine that runs alongside the main lifecycle:

```ts
budgetTracker: {
  type: "parallel",
  states: {
    tokens: {
      initial: "tracking",
      states: {
        tracking: {
          on: {
            TOKENS_USED: [
              { guard: "tokenBudgetExceeded", target: "exceeded" },
              { target: "tracking" },
            ],
          },
        },
        exceeded: { entry: raise({ type: "BUDGET_EXCEEDED", dimension: "tokens" }) },
      },
    },
    calls: {
      // Same structure — monitors API call count
    },
    time: {
      // Same structure — monitors wall-clock time
    },
  },
},
```

Each dimension runs independently. When any dimension crosses its limit, the tracker raises a `BUDGET_EXCEEDED` event. The main machine handles this by transitioning to graceful shutdown (partial results) or hard stop, depending on which limit was hit and the current state.

The parallel structure means budget tracking doesn't complicate the main lifecycle. The lifecycle machine doesn't check budgets in its transitions. The budget tracker doesn't know about the lifecycle states. Each does its job. The event system connects them.

## Before and After

**Before — ad-hoc lifecycle:**

```ts
let iterations = 0;
while (iterations < maxIterations) {
  const response = await callLLM(messages);
  if (response.type === "text") break;
  if (response.type === "toolCall") {
    const result = await executeTool(response.toolCall);
    messages.push(result);
    iterations++;
  }
  // What about parse failures? Budget limits? Timeouts?
  // What if executeTool throws? Does the loop continue?
  // What if we need to add a retry state? Where does it go?
}
```

An LLM generates this. It handles the happy path and the simple loop. But the lifecycle decisions are embedded in `if/else` chains — there's no single place to see all the states and transitions. Adding retry logic means adding nested conditions inside the loop. Adding budget tracking means adding more conditions. Each addition makes the control flow harder to reason about, and the LLM generating the next addition has no structural model to work from.

**After — state machine lifecycle:**

```ts
const actor = createActor(agentMachine, { input: { task, config } });
actor.start();
actor.send({ type: "START" });
// The machine governs everything from here.
// Invalid transitions are absorbed. The loop is bounded. The budget is tracked.
// Error recovery routes through the planner. Terminal states are explicit.
```

The lifecycle is the machine definition. The code that runs the machine is trivial — start it and send events. All the interesting decisions (what can happen in each state, how errors are handled, when loops terminate) are in the definition, visible in one place.

## Scaling

You add a `retrying` substate to the execution loop — when a tool times out, the machine waits and retries before escalating to the planner:

```ts
executeTool: {
  on: {
    TOOL_SUCCESS: [
      { guard: "withinLoopBound", target: "callLLM" },
      { target: "#agent.evaluating" },
    ],
    TOOL_ERROR: "#agent.planning",
    TOOL_TIMEOUT: "retrying",
  },
},
retrying: {
  after: {
    RETRY_DELAY: [
      { guard: "retriesRemaining", target: "executeTool" },
      { target: "#agent.planning" }, // retries exhausted
    ],
  },
},
```

You add the state and its transitions to the machine definition. The inspector immediately visualizes the new state. Model-based testing generates new paths that include the retry — paths through `executeTool → retrying → executeTool` and `executeTool → retrying → planning` (retry exhausted). You didn't write those test paths. They fell out of the machine definition.

### XState Inspector

[Interactive statechart — first appearance]

The Organon lifecycle machine, rendered from the definition. Send events and watch transitions:

- Send `START` in `idle` — transitions to `planning`.
- Send `CALL_LLM` in `planning` — transitions to `executing.callLLM`.
- Send `LLM_TOOL_CALL` — transitions to `executeTool`.
- Send `TOOL_SUCCESS` — transitions back to `callLLM` (if within bound) or to `evaluating` (if bound reached).
- Send `START` in `executing` — nothing happens. Absorbed.
- Trigger budget interrupt — watch the parallel state emit and the main machine respond.

The reader experiences the machine's guarantees directly. Invalid transitions don't crash — they're ignored. The bounded loop terminates. The budget tracker interrupts. The behavior is the definition.

---

*Next: [Capabilities and Effects](/capabilities-and-effects) — building Organon's tool interfaces and ensuring the type system makes side effects visible and controllable.*
