---
title: "State Machines and Lifecycle"
date: "2026-03-17T00:00:00.000Z"
slug: "state-machines-and-lifecycle"
description: "Using XState to model an archive-packaging agent's lifecycle as a state machine — domain-specific circuit breakers, revision-loop stall detection, and runtime enforcement of valid transitions."
draft: true
---

# State Machines and Lifecycle

> Part 3 of [*Structural Guardrails for LLM-Generated Code*](/structural-guardrails)

## The Problem

The Darwin Core Archive agent's lifecycle — when to inspect source files, when to ask for confirmation, when to stop revising — depends on runtime information that the compiler can't predict.

The structuring step might find unconfirmed metadata or produce clean results. The user might accept or reject. Validation might pass, fail with fixable violations, or fail with a system error. These are runtime decisions that branch the workflow in ways no type annotation can anticipate.

Without a formal model, the lifecycle is scattered across `if/else` chains, boolean flags, and ad-hoc loops. Every handler makes independent decisions about what should happen next. An LLM generating code for one handler sees local context and makes a locally reasonable decision that might be globally wrong. The revision loop retries indefinitely because nothing told it about the loop bound. The generator re-enters validation because nothing told it the circuit breaker tripped. The lifecycle exists as an emergent property of scattered code — not as a definition anyone can inspect.

This post gives the agent a runtime lifecycle model. The next post pushes these same guarantees into the compiler.

## The Pattern

A state machine makes the lifecycle explicit. Every valid state is named. Every valid transition is declared. Events sent in states that don't handle them are absorbed silently — no crash, no undefined behavior. The machine definition is the single source of truth for what can happen and when.

The machine governs the agent's real-time behavior. When the LLM produces a non-deterministic result — unconfirmed metadata, a validation failure, a novel violation — the machine determines what happens next. Invalid transitions are absorbed silently. The circuit breaker fires based on observed behavior, not a hard-coded limit. This is runtime enforcement: the machine constrains what the agent can *do*, regardless of what the code *tries*.

The same definition constrains development. An LLM generating orchestration code sees the machine as a single source of truth. It can read the valid transitions from the definition. It can't write code that sends `START` from `validating` — the machine definition doesn't include that transition. The definition is both a runtime governor and a development-time contract.

## The Darwin Core Archive Agent

The Darwin Core Archive agent transforms biodiversity data sources into validated archive packages. Its workflow has eight top-level states:

- **idle** — waiting for a task
- **inspecting** — discovering source files from uploaded data
- **structuring** — inferring metadata fields with confidence scores
- **confirming** — waiting for user approval of unconfirmed metadata
- **gathering** — collecting the remaining metadata needed for the archive
- **generating** — writing the archive package
- **validating** — checking the generated archive against Darwin Core rules
- **revising** — adjusting the archive to fix validation failures
- **complete/failed** — terminal states

The `validating → revising → generating` loop is the critical cycle. After validation, guards evaluate the revision history and route accordingly: continue revising, or trip the circuit breaker and fail. This is the archive agent's equivalent of a generic tool-call loop — but with domain-specific stall detection instead of a flat retry counter.

### The Machine

```ts
interface RevisionRecord {
  readonly round: number
  readonly violationCount: number
  readonly repeatedViolations: number
  readonly adjustedFields: string[]
  readonly outcome: 'improved' | 'unchanged' | 'worsened'
}

function computeStallConfidence(
  recentRevisions: ReadonlyArray<RevisionRecord>,
): number {
  if (recentRevisions.length < 2) return 0

  // Signal 1: Repetition — same violations reappearing across rounds
  const lastRevision = recentRevisions[recentRevisions.length - 1]
  const repetition =
    lastRevision.violationCount > 0
      ? lastRevision.repeatedViolations / lastRevision.violationCount
      : 0

  // Signal 2: Stagnation — no improvement in violation count across window
  const outcomes = recentRevisions.map((r) => r.outcome)
  const improvedCount = outcomes.filter((o) => o === 'improved').length
  const stagnation = 1 - improvedCount / outcomes.length

  // Signal 3: Oscillation — fields being adjusted back and forth
  let oscillation = 0
  if (recentRevisions.length >= 3) {
    const fieldSets = recentRevisions.map((r) => new Set(r.adjustedFields))
    let flipFlops = 0
    let comparisons = 0
    for (let i = 2; i < fieldSets.length; i++) {
      for (const field of fieldSets[i]) {
        if (fieldSets[i - 2].has(field) && !fieldSets[i - 1].has(field)) {
          flipFlops++
        }
        comparisons++
      }
    }
    if (comparisons > 0) {
      oscillation = flipFlops / comparisons
    }
  }

  return Math.max(repetition, stagnation, oscillation)
}

const agentMachine = setup({
  types: {
    context: {} as AgentContext,
    events: {} as AgentEvent,
  },
  guards: {
    circuitBreakerOpen: ({ context }) =>
      context.revisionRound * context.stallConfidence >
      context.breakerThreshold,
  },
  actions: {
    recordInspection: assign(({ event }) => {
      const e = event as { type: 'INSPECTION_COMPLETE'; fileCount: number }
      return { filesTotal: e.fileCount }
    }),
    recordStructure: assign(({ event }) => {
      const e = event as { type: 'STRUCTURE_DETERMINED'; resolved: number }
      return { metadataFieldsResolved: e.resolved, unconfirmedCount: 0 }
    }),
    recordMetadataGathered: assign(({ event }) => {
      const e = event as {
        type: 'NEEDS_CONFIRMATION'
        resolved: number
        unconfirmedCount: number
      }
      return {
        metadataFieldsResolved: e.resolved,
        unconfirmedCount: e.unconfirmedCount,
      }
    }),
    recordGateCleared: assign(({ context }) => ({
      gatesCleared: context.gatesCleared + 1,
    })),
    recordRevisionOutcome: assign(({ context, event }) => {
      const e = event as {
        type: 'VALIDATION_FAIL'
        violationCount: number
        repeatedViolations: number
        adjustedFields: string[]
      }
      const round = context.revisionRound + 1
      const prevCount = context.recentRevisions.length > 0
        ? context.recentRevisions[context.recentRevisions.length - 1]
            .violationCount
        : Infinity
      const outcome: RevisionRecord['outcome'] =
        e.violationCount < prevCount  ? 'improved'
        : e.violationCount === prevCount ? 'unchanged'
        : 'worsened'
      const record: RevisionRecord = {
        round,
        violationCount: e.violationCount,
        repeatedViolations: e.repeatedViolations,
        adjustedFields: e.adjustedFields,
        outcome,
      }
      const recentRevisions = [...context.recentRevisions, record]
        .slice(-context.windowSize)
      return {
        revisionRound: round,
        recentRevisions,
        stallConfidence: computeStallConfidence(recentRevisions),
      }
    }),
  },
}).createMachine({
  id: 'agent',
  initial: 'idle',
  context: {
    filesTotal: 0,
    metadataFieldsResolved: 0,
    unconfirmedCount: 0,
    gatesCleared: 0,
    revisionRound: 0,
    recentRevisions: [],
    stallConfidence: 0,
    breakerThreshold: 10,
    windowSize: 5,
  },
  states: {
    idle: {
      on: {
        START: 'inspecting',
        CANCEL: 'failed',
      },
    },
    inspecting: {
      on: {
        INSPECTION_COMPLETE: {
          target: 'structuring',
          actions: 'recordInspection',
        },
        INSPECTION_FAILED: 'failed',
        CANCEL: 'failed',
      },
    },
    structuring: {
      on: {
        STRUCTURE_DETERMINED: {
          target: 'gathering',
          actions: 'recordStructure',
        },
        NEEDS_CONFIRMATION: {
          target: 'confirming',
          actions: 'recordMetadataGathered',
        },
        STRUCTURING_ERROR: 'failed',
        CANCEL: 'failed',
      },
    },
    confirming: {
      on: {
        GATES_CLEARED: {
          target: 'gathering',
          actions: 'recordGateCleared',
        },
        USER_REJECTED: 'structuring',
        CONFIRMATION_TIMEOUT: 'failed',
        CANCEL: 'failed',
      },
    },
    gathering: {
      on: {
        METADATA_COMPLETE: 'generating',
        CANCEL: 'failed',
      },
    },
    generating: {
      on: {
        ARCHIVE_GENERATED: 'validating',
        CANCEL: 'failed',
      },
    },
    validating: {
      on: {
        VALIDATION_PASS: 'complete',
        VALIDATION_FAIL: {
          target: 'revising',
          actions: 'recordRevisionOutcome',
        },
        VALIDATION_ERROR: 'failed',
        CANCEL: 'failed',
      },
    },
    revising: {
      always: [{ guard: 'circuitBreakerOpen', target: 'failed' }],
      on: {
        REVISED: 'generating',
        CANCEL: 'failed',
      },
    },
    complete: { type: 'final' },
    failed: { type: 'final' },
  },
})
```

Walk through a concrete archive packaging execution to see why each state exists.

**`idle → inspecting`:** A packaging task arrives. The machine moves to `inspecting`, where the harness scans the uploaded data sources and discovers source files. If inspection fails (`INSPECTION_FAILED`), the task fails immediately — there's nothing to package.

**`inspecting → structuring`:** Source files were found. The `recordInspection` action stores the file count in context. The structuring step examines each file and infers metadata fields with confidence scores. Two outcomes branch from here: all fields resolved with high confidence (`STRUCTURE_DETERMINED`), or some fall below the confidence threshold (`NEEDS_CONFIRMATION`).

**`structuring → confirming`:** Unconfirmed metadata fields need human approval. The machine enters `confirming` and waits for the user. Three outcomes: the user accepts (`GATES_CLEARED`), rejects (`USER_REJECTED`), or the confirmation window times out (`CONFIRMATION_TIMEOUT`).

**`confirming → structuring` (user rejection):** The user rejected the inferred metadata. The machine returns to `structuring` for another attempt. This is a legitimate loop — the structuring step retries with different parameters or the user provides hints. The loop naturally terminates because either the structuring step improves (→ `STRUCTURE_DETERMINED` → `gathering`) or the user eventually accepts (→ `GATES_CLEARED` → `gathering`).

**`gathering → generating → validating`:** The linear pipeline. Collect remaining metadata, generate the archive package, validate it against Darwin Core rules. These three states have no branching — each produces one event that advances the pipeline.

**`validating → revising → generating` (the revision loop):** Validation failed with fixable violations. The `recordRevisionOutcome` action fires on the transition to `revising`, updating the revision window and recomputing stall confidence. On entry to `revising`, the `always` transition evaluates the circuit breaker guard. If the guard passes (breaker open), the machine transitions immediately to `failed`. Otherwise, `revising` waits for the `REVISED` event and routes back to `generating` for another attempt.

This is the key structural guarantee: **the circuit breaker is enforced by the machine, not by the code inside the loop.** The code that handles `VALIDATION_FAIL` doesn't check whether the agent is stalling — the guard does. The `recordRevisionOutcome` action and `always` guard also solve a subtle XState v5 issue: guards evaluate *before* a transition's actions execute. If the guard and action were on the same transition, the guard would read stale context. By recording the revision outcome on the transition *into* `revising` and evaluating the circuit breaker via `always` *on entry*, the action fires first, and the guard evaluates against the updated context.

**Cancellation:** `CANCEL` is handled in every non-terminal state, all transitioning to `failed`. Cancellation comes from outside the machine — the user closing the tab, a deployment signal, an admin override. It's distinct from domain failures like `INSPECTION_FAILED` or `CONFIRMATION_TIMEOUT`, which are produced by the workflow itself.

### What the Machine Gives You

From this single definition, four artifacts are derived:

**Runtime behavior.** The machine runs. Events sent in states that don't handle them are absorbed — no crash, no undefined behavior. Send `START` while in `validating`? Nothing happens. Send `INSPECTION_COMPLETE` while in `gathering`? Absorbed. The machine only responds to events that are valid in the current state.

**TypeScript types.** XState v5's `setup()` with typed context and events means the compiler knows which events exist and which states are valid. Sending an event that doesn't exist is a type error.

**Visual documentation.** XState's inspector renders the machine as an interactive statechart. The documentation is always accurate because it's generated from the definition — not a diagram someone drew and forgot to update.

**Test paths.** Model-based testing generates paths through the machine: every reachable state, every valid transition sequence. The happy path, the confirmation loop, the revision loop, circuit breaker termination — all derived from the definition.

Four artifacts from one definition. At runtime, the machine governs behavior. At development time, the definition constrains code generation and provides the types that the compiler enforces. The documentation and test paths are accurate by derivation, not by maintenance. An LLM assisting with development reads the definition and understands the lifecycle — it doesn't reconstruct it from scattered `if/else` chains.

### The Revision Loop and Stall Detection

A flat loop bound (`revisionRound < maxRevisions`) is a blunt instrument. The right number is unknowable in advance. It can't distinguish productive revision from spinning. It treats the symptom (too many revisions) rather than the cause (the agent is stuck).

The circuit breaker replaces the flat bound with a composite guard:

```
risk = revisionRound × stallConfidence
```

The breaker trips when `risk > breakerThreshold`. Neither signal alone trips it easily. A productive agent can revise many times (high round count, low confidence). A briefly confused agent gets room to recover (low round count, high confidence). An agent that's both stuck *and* burning revisions gets stopped.

**Stall confidence** is computed from a sliding window of recent `RevisionRecord`s:

```ts
interface RevisionRecord {
  readonly round: number
  readonly violationCount: number
  readonly repeatedViolations: number
  readonly adjustedFields: string[]
  readonly outcome: 'improved' | 'unchanged' | 'worsened'
}
```

Each revision record captures what happened in that round: how many violations remain, how many are repeats from the previous round, which fields were adjusted, and whether the overall count improved. Three signals contribute to stall confidence, combined via `max()`:

1. **Repetition** — what fraction of current violations are repeats from the previous round. The agent fixes violation A but reintroduces it next round: `repeatedViolations / violationCount`. Five violations, all seen before: 1.0. Five violations, all new: 0.0.
2. **Stagnation** — what fraction of recent rounds failed to improve the violation count. A window of five rounds where none reduced the count: 1.0. A window where every round improved: 0.0.
3. **Oscillation** — are the same fields being adjusted back and forth? If round 3 adjusts `decimalLatitude`, round 2 didn't touch it, but round 1 did — that field is flip-flopping. The ratio of flip-flopped fields to total adjusted fields in the window.

These three signals are domain-meaningful at runtime. Repetition detects the LLM reintroducing the same violations. Stagnation detects a plateau. Oscillation detects the LLM toggling a field between two values — `decimalLatitude` set to one format, then another, then back. A generic "same tool call repeated" signal can't distinguish productive revision from spinning — it doesn't know that adjusting `decimalLatitude` three times might be fine (different adjustments) or terrible (the same two values alternating). The signals watch what the agent *does*, not how many times it tried.

The `computeStallConfidence` function is pure — no side effects, testable in isolation. It takes `ReadonlyArray<RevisionRecord>` and returns a number between 0 and 1. The function can't reach into context, call an API, or mutate state. The inputs are typed. The output is bounded. An LLM generating or modifying this function operates in a narrow space — it can change the weighting or add a fourth signal, but the contract is fixed. The `recordRevisionOutcome` action calls it on every validation failure, storing the result in context where the guard and the XState inspector can see it.

## Before and After

**Before — ad-hoc lifecycle:**

```ts
let revisions = 0;
while (revisions < maxRevisions) {
  const archive = await generateArchive(metadata);
  const result = await validate(archive);
  if (result.pass) return archive;
  revisions++;
  // What if the same violations keep reappearing?
  // What if the LLM is flip-flopping between two archives?
  // What if validation itself throws? Does the loop continue?
  // What about user confirmation for unconfirmed metadata?
  // Where does that go? Before this loop? Inside it?
}
throw new Error("Max revisions exceeded");
```

An LLM generates this. It handles the happy path and the simple loop. But the lifecycle decisions are embedded in `if/else` chains — there's no single place to see all the states and transitions. Adding user confirmation means restructuring the flow. Adding stall detection means adding nested conditions inside the loop. Each addition makes the control flow harder to reason about, and the LLM generating the next addition has no structural model to work from.

**After — state machine lifecycle:**

```ts
const machine = createAgentMachine({ breakerThreshold: 10, windowSize: 5 });
const actor = createActor(machine);
actor.start();
actor.send({ type: "START" });
// The machine governs everything from here.
// Invalid transitions are absorbed. The circuit breaker is adaptive.
// User confirmation loops through structuring → confirming naturally.
// Stall detection watches for repetition, stagnation, and oscillation.
// Terminal states are explicit.
```

The lifecycle is the machine definition. The code that runs the machine is trivial — start it and send events. All the interesting decisions (what can happen in each state, how errors are handled, when loops terminate) are in the definition, visible in one place.

## Scaling

You need to handle the case where a user rejects the inferred geographic coverage. Without the machine, this means adding a callback, a flag, and a conditional branch somewhere in the middle of the pipeline. With the machine, you add the transition:

```ts
confirming: {
  on: {
    GATES_CLEARED: {
      target: 'gathering',
      actions: 'recordGateCleared',
    },
    USER_REJECTED: 'structuring',
    CONFIRMATION_TIMEOUT: 'failed',
    CANCEL: 'failed',
  },
},
```

`USER_REJECTED` sends the machine back to `structuring`. The structuring step runs again — re-inferring the metadata or accepting manual entry. If it produces unconfirmed results again, the machine enters `confirming` again. If the structuring step resolves everything, it produces `STRUCTURE_DETERMINED` and skips confirmation entirely.

You didn't write the test paths for this loop. They fell out of the machine definition. Model-based testing generates paths that include `structuring → confirming → structuring → confirming → gathering` (multiple rejections before acceptance) and `structuring → confirming → structuring → gathering` (rejection followed by high-confidence resolution). Revision outcomes from the later validation loop interact with the confirmation count — the context carries `gatesCleared` through the entire workflow, visible to any guard or action that needs it.

### Interaction Flow

The Darwin Core Archive agent lifecycle, traced through its transitions:

- Send `START` in `idle` — transitions to `inspecting`.
- Send `INSPECTION_COMPLETE` — transitions to `structuring`.
- Send `NEEDS_CONFIRMATION` — transitions to `confirming`.
- Send `USER_REJECTED` — back to `structuring`.
- Send `STRUCTURE_DETERMINED` — transitions to `gathering`, skipping confirmation.
- Send `METADATA_COMPLETE` — transitions to `generating`.
- Send `ARCHIVE_GENERATED` — transitions to `validating`.
- Send `VALIDATION_FAIL` in `validating` — transitions to `revising`. If stall confidence is high enough, the circuit breaker trips and it transitions immediately to `failed`.
- Send `CANCEL` at any point — transitions to `failed`. Send `START` in `validating` — nothing happens. Absorbed.

Invalid transitions don't crash — they're ignored. The revision loop terminates adaptively. The behavior is the definition.

---

*Next: [Encoding Protocols in State](/encoding-protocols-in-state) — typestate patterns that make protocol violations compile errors.*
