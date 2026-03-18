---
title: "Structural Guardrails for LLM-Generated Code"
date: "2026-03-17T00:00:00.000Z"
slug: "structural-guardrails"
description: "A series on software patterns that create compile-time and runtime guarantees — and why they matter more when an LLM is writing the code."
draft: true
---

# Structural Guardrails for LLM-Generated Code

I've noticed a pattern. If I get Claude to make something without a clear spec, or existing conventions, it eventually turns into a really shitty programmer. It starts off pretty good, then turns kind of *alright*, then gradually declines into slop unless you frequently intervene.

The longer you let it go, the worse it gets — the success rate drops, the bugs compound, and you're forced into extensive review and revision. This isn't how I want to spend my time. I'd rather focus on the architectural problems that actually matter than babysit an LLM's output.

What can you do about it? Not just better prompts or more instructions — those help, but they don't *constrain*. The LLM can always ignore a prompt. It can't ignore a type error.

There are software patterns that create structural guarantees — constraints where incorrect programs fail to compile, fail to run, or fail visibly. These patterns aren't new. What's new is how much they matter when an LLM is in the picture, and they matter in two distinct ways.

**The development problem.** An LLM is helping you write code. It will confidently produce any program the structure allows. If your types permit skipping validation, it will skip validation. If your error model permits swallowing failures, it will swallow failures. Not out of malice — out of plausibility. Structural constraints narrow what it can generate to programs that are more likely correct.

**The runtime problem.** Your application *uses* an LLM, and its output is non-deterministic. The model returns structured responses that might be malformed, tool calls with invalid arguments, or hallucinated function names. These aren't bugs in your code — they're the normal operating conditions of a system with a non-deterministic component. The same patterns that constrain code generation also constrain runtime behavior.

Different problems, same solution. This series explores both — by building something.

## Organon

Organon is an agent tool-use harness. It governs an LLM's interaction with external tools: receiving tasks, planning actions, executing tool calls, handling results, producing structured output. It's the kind of thing where most implementations are a bag of strings and hope. Organon is the opposite — structurally constrained, where most classes of bug are impossible by construction.

Here's what a single execution looks like, and what can go wrong at every step.

**A task arrives. The harness loads its configuration.** The config file defines which tools are available, their settings, budget limits, and LLM parameters. It's the first untrusted input. A missing field, a contradictory setting, a wrong type — if bad config gets through, every decision downstream is built on a lie. *Challenge: how do you validate data at a boundary so that the proof of validation survives into every function that touches it?*

**The harness calls the LLM.** The model returns a structured response — text, a tool call, or both. But the response is non-deterministic. It might be malformed JSON. It might contain a tool name that doesn't exist. It might have arguments that don't match the tool's schema. *Challenge: how do you parse non-deterministic output into typed, trustworthy data — or reject it cleanly?*

**A tool call is dispatched.** The harness looks up the tool, validates the arguments, and executes. But which tools should the harness have access to? A read-only research task shouldn't be able to write files. A data transform shouldn't be able to make network calls. *Challenge: how do you restrict what the harness can reach — not by policy, but by the absence of a pathway?*

**The tool returns a result.** It might be valid, malformed, or a timeout. The harness must handle each case. But "handle" means something specific — not a generic catch block, but a distinct recovery path for each failure mode. *Challenge: how do you ensure every error variant is handled, and that adding a new one forces every handler to update?*

**The harness decides what to do next.** Call the LLM again with the result? Call another tool? Finish? This is a protocol — certain sequences of actions are valid, others aren't. You can't call the LLM with a dangling tool call that has no result. You can't execute a tool when you're not in the execution phase. *Challenge: how do you make protocol violations impossible — not just at runtime, but at compile time?*

**The loop repeats.** The harness calls the LLM, dispatches tools, collects results, and decides, over and over. But the loop must terminate. Budget limits — tokens, API calls, wall-clock time — must be enforced. *Challenge: how do you guarantee bounded execution?*

Each of these challenges has a known solution — a pattern that eliminates the problem structurally. This series defines those patterns one at a time, each building a piece of Organon's specification. By the final post, the spec is complete, and we assemble the implementation from the pieces the series produced.

This is spec-driven development in practice. Each post defines a component's constraints with enough rigor that the implementation is nearly determined. An LLM generating code against these specs operates in a narrow space where most programs are correct — because the spec eliminates the rest. The series isn't just *about* structural guardrails. It *is* one.

## The Series

1. **[Types as Receipts](/types-as-receipts)** — Validation that changes the type. Parsing as proof that a boundary check happened, using Effect Schema to define once and derive the type, decoder, and error reporting.

2. **[Making Illegal States Unrepresentable](/making-illegal-states-unrepresentable)** — Discriminated unions and exhaustive matching. Organon's error model as a tagged union where the compiler enforces handling of every failure mode.

3. **[Encoding Protocols in State](/encoding-protocols-in-state)** — Typestate patterns for compile-time protocol enforcement. Organon's conversation accumulator, where calling the LLM with a dangling tool call is a type error.

4. **[State Machines and Lifecycle](/state-machines-and-lifecycle)** — Runtime state machines for dynamic behavior. Organon's agent lifecycle as an XState machine with bounded loops and a parallel budget tracker.

5. **[Capabilities and Effects](/capabilities-and-effects)** — Controlling what code can do by passing capabilities explicitly. Effect tracking makes side effects visible in the type signature.

6. **[Organon: Specification and Generation](/organon-specification-and-generation)** — Assembly. Every piece from Posts 1–5 becomes a specification, and we generate implementations against it — showing that structural constraints reduce the review surface to a narrow band.

7. **[Organon: Verification](/organon-verification)** — Property-based testing, model-based testing, and fault injection — each targeting a different architectural layer, each derived from the same definitions.
