<template>
  <div class="agent-lifecycle">
    <!-- State Display -->
    <div class="state-row">
      <div class="state-display">
        <span class="state-label">State</span>
        <span class="state-badge" :class="stateColorClass">{{ currentStateString }}</span>
      </div>
      <div class="context-display">
        <span class="context-item">
          <span class="context-label">classified</span>
          <span class="context-value">{{ snapshot.context.columnsClassified }}/{{ snapshot.context.columnsTotal }}</span>
        </span>
        <span class="context-item">
          <span class="context-label">gates</span>
          <span class="context-value">{{ snapshot.context.gatesCleared }}/{{ snapshot.context.lowConfidenceCount }}</span>
        </span>
        <span class="context-item">
          <span class="context-label">revision</span>
          <span class="context-value">{{ snapshot.context.revisionRound }}</span>
        </span>
        <span class="context-item">
          <span class="context-label">stall</span>
          <span class="context-value" :class="stallClass">
            {{ (snapshot.context.stallConfidence * 100).toFixed(0) }}%
          </span>
        </span>
        <span class="context-item">
          <span class="context-label">risk</span>
          <span class="context-value" :class="riskClass">
            {{ risk.toFixed(1) }}
          </span>
        </span>
      </div>
    </div>

    <!-- Event Buttons -->
    <div class="events-section">
      <div v-for="group in EVENT_GROUPS" :key="group.label" class="event-group">
        <span class="group-label">{{ group.label }}</span>
        <div class="group-buttons">
          <button
            v-for="event in group.events"
            :key="event"
            class="event-btn"
            :class="{ active: canSend(event), absorbed: !canSend(event) }"
            :disabled="isTerminal"
            @click="sendEvent(event)"
          >
            {{ event }}
          </button>
        </div>
      </div>
    </div>

    <!-- Transition Log -->
    <div v-if="log.length > 0" class="log-section">
      <span class="log-label">Transitions</span>
      <div class="log-list">
        <TransitionGroup name="log-entry">
          <div
            v-for="entry in log"
            :key="entry.id"
            class="log-entry"
            :class="{ 'log-absorbed': entry.absorbed }"
          >
            <div class="log-main">
              <span class="log-event">{{ entry.event }}</span>
              <span class="log-arrow">&rarr;</span>
              <span class="log-state" :class="stateColor(entry.toState)">{{ entry.toState }}</span>
            </div>
            <div v-if="entry.note" class="log-note">{{ entry.note }}</div>
          </div>
        </TransitionGroup>
      </div>
    </div>

    <!-- Controls -->
    <div class="controls">
      <div class="control-left">
        <label class="loop-bound-control">
          <span class="control-label">Breaker threshold</span>
          <input
            type="number"
            class="loop-bound-input"
            :value="breakerThreshold"
            :disabled="currentStateString !== 'idle'"
            min="1"
            max="50"
            @input="onThresholdChange"
          />
        </label>
      </div>
      <div class="control-right">
        <button class="btn btn-reset" @click="reset">Reset</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { shallowRef, ref, computed, onUnmounted } from 'vue'
import { createActor, type SnapshotFrom } from 'xstate'
import { createAgentMachine, EVENT_GROUPS, ALL_EVENTS } from './agentMachine'

interface TransitionLogEntry {
  id: number
  event: string
  fromState: string
  toState: string
  note: string
  absorbed: boolean
}

const MAX_LOG_ENTRIES = 15

const breakerThreshold = ref(10)
let machine = createAgentMachine({ breakerThreshold: breakerThreshold.value })
let actor = createActor(machine)
const snapshot = shallowRef(actor.getSnapshot())
const log = ref<TransitionLogEntry[]>([])
let logId = 0

function startActor() {
  actor.subscribe((s) => {
    snapshot.value = s
  })
  actor.start()
}

startActor()

onUnmounted(() => {
  actor.stop()
})

function formatStateValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries
      .map(([parent, child]) =>
        typeof child === 'string' ? `${parent}.${child}` : parent
      )
      .join(', ')
  }
  return String(value)
}

const currentStateString = computed(() => formatStateValue(snapshot.value.value))

const isTerminal = computed(() => snapshot.value.status === 'done')

function canSend(eventType: string): boolean {
  return snapshot.value.can({ type: eventType } as any)
}

function topLevelState(stateStr: string): string {
  return stateStr.split('.')[0]
}

function stateColor(stateStr: string): string {
  return `state-${topLevelState(stateStr)}`
}

const stateColorClass = computed(() => stateColor(currentStateString.value))

const risk = computed(
  () =>
    snapshot.value.context.revisionRound *
    snapshot.value.context.stallConfidence,
)

const stallClass = computed(() => {
  const c = snapshot.value.context.stallConfidence
  if (c >= 0.8) return 'context-danger'
  if (c >= 0.4) return 'context-warn'
  return ''
})

const riskClass = computed(() => {
  const r = risk.value
  const t = snapshot.value.context.breakerThreshold
  if (r > t) return 'context-danger'
  if (r > t * 0.7) return 'context-warn'
  return ''
})

function sendEvent(eventType: string) {
  if (isTerminal.value) return

  const fromState = currentStateString.value
  const couldTransition = canSend(eventType)

  // Events with demo data for the interactive component.
  // VALIDATION_FAIL uses fixed values so that clicking it repeatedly
  // demonstrates stall detection and the circuit breaker tripping.
  let event: Record<string, any> = { type: eventType }
  if (eventType === 'SOURCES_FOUND') {
    event = { ...event, columnCount: 12 }
  } else if (eventType === 'ALL_CLASSIFIED_HIGH') {
    event = { ...event, classified: 12 }
  } else if (eventType === 'HAS_LOW_CONFIDENCE') {
    event = { ...event, classified: 12, lowCount: 4 }
  } else if (eventType === 'VALIDATION_FAIL') {
    event = {
      ...event,
      violationCount: 3,
      repeatedViolations: 3,
      adjustedFields: ['decimalLatitude'],
    }
  }

  actor.send(event as any)

  const toState = formatStateValue(snapshot.value.value)
  const toContext = snapshot.value.context
  const absorbed = !couldTransition

  let note = ''
  if (absorbed) {
    note = `Absorbed — no handler for ${eventType} in ${fromState}`
  } else if (eventType === 'VALIDATION_FAIL') {
    const riskVal = toContext.revisionRound * toContext.stallConfidence
    if (toState === 'failed') {
      note = `Circuit breaker tripped: risk ${riskVal.toFixed(1)} > threshold ${toContext.breakerThreshold}`
    } else {
      note = `Revision round ${toContext.revisionRound}: ${event.violationCount} violations (risk ${riskVal.toFixed(1)})`
    }
  } else if (eventType === 'VALIDATION_PASS') {
    note = 'Configuration validated successfully'
  } else if (eventType === 'USER_REJECTED') {
    note = 'User rejected mapping — reclassifying'
  } else if (eventType === 'NO_SOURCES') {
    note = 'No data files found in source directory'
  } else if (eventType === 'CLASSIFICATION_ERROR') {
    note = 'LLM failed to classify columns'
  } else if (eventType === 'CONFIRMATION_TIMEOUT') {
    note = 'User confirmation timed out'
  } else if (eventType === 'VALIDATION_ERROR') {
    note = 'DarwinKit CLI system error (exit code 3)'
  }

  log.value.unshift({
    id: logId++,
    event: eventType,
    fromState,
    toState: absorbed ? fromState : toState,
    note,
    absorbed,
  })

  if (log.value.length > MAX_LOG_ENTRIES) {
    log.value.pop()
  }
}

function onThresholdChange(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  if (!isNaN(val) && val >= 1 && val <= 50) {
    breakerThreshold.value = val
  }
}

function reset() {
  actor.stop()
  log.value = []
  machine = createAgentMachine({ breakerThreshold: breakerThreshold.value })
  actor = createActor(machine)
  snapshot.value = actor.getSnapshot()
  startActor()
}
</script>

<style scoped>
.agent-lifecycle {
  margin: 2rem 0;
  padding: 1.5rem;
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
}

@media (max-width: 768px) {
  .agent-lifecycle {
    padding: 1rem;
  }
}

/* State display */
.state-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

@media (max-width: 768px) {
  .state-row {
    flex-direction: column;
    align-items: stretch;
  }
}

.state-display {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.state-label,
.log-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-2);
}

.state-badge {
  display: inline-block;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: var(--vp-font-family-mono);
  transition: background 0.2s ease, color 0.2s ease;
}

.state-idle {
  background: color-mix(in srgb, var(--vp-c-text-3) 15%, transparent);
  color: var(--vp-c-text-2);
}

.state-collecting {
  background: color-mix(in srgb, #3b82f6 20%, transparent);
  color: #3b82f6;
}

.state-classifying {
  background: color-mix(in srgb, #8b5cf6 20%, transparent);
  color: #8b5cf6;
}

.state-confirming {
  background: color-mix(in srgb, #f59e0b 20%, transparent);
  color: #f59e0b;
}

.state-mapping {
  background: color-mix(in srgb, #14b8a6 20%, transparent);
  color: #14b8a6;
}

.state-generating {
  background: color-mix(in srgb, #6366f1 20%, transparent);
  color: #6366f1;
}

.state-validating {
  background: color-mix(in srgb, #06b6d4 20%, transparent);
  color: #06b6d4;
}

.state-revising {
  background: color-mix(in srgb, #f97316 20%, transparent);
  color: #f97316;
}

.state-complete {
  background: color-mix(in srgb, var(--vp-c-green-1, #10b981) 20%, transparent);
  color: var(--vp-c-green-1, #10b981);
}

.state-failed {
  background: color-mix(in srgb, var(--vp-c-red-1, #ef4444) 20%, transparent);
  color: var(--vp-c-red-1, #ef4444);
}

/* Context display */
.context-display {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.context-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
}

.context-label {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}

.context-value {
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
}

/* Event buttons */
.events-section {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.event-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.group-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-3);
}

.group-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.event-btn {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.7rem;
  font-family: var(--vp-font-family-mono);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  white-space: nowrap;
}

.event-btn.active {
  border-color: var(--vp-c-brand-1);
  background: color-mix(in srgb, var(--vp-c-brand-1) 10%, var(--vp-c-bg));
}

.event-btn.active:hover {
  background: color-mix(in srgb, var(--vp-c-brand-1) 20%, var(--vp-c-bg));
}

.event-btn.absorbed {
  opacity: 0.35;
  cursor: pointer;
}

.event-btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

/* Transition log */
.log-section {
  margin-bottom: 1.25rem;
}

.log-list {
  margin-top: 0.5rem;
  max-height: 240px;
  overflow-y: auto;
  border-radius: 6px;
  background: var(--vp-code-bg);
  padding: 0.5rem;
}

.log-entry {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid color-mix(in srgb, var(--vp-c-divider) 50%, transparent);
}

.log-entry:last-child {
  border-bottom: none;
}

.log-entry.log-absorbed {
  opacity: 0.5;
}

.log-main {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
}

.log-event {
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.log-arrow {
  color: var(--vp-c-text-3);
}

.log-state {
  font-family: var(--vp-font-family-mono);
  font-weight: 500;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-size: 0.75rem;
}

.log-note {
  font-size: 0.7rem;
  color: var(--vp-c-text-3);
  margin-top: 0.15rem;
  font-style: italic;
}

/* Log transitions */
.log-entry-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.log-entry-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

/* Controls */
.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

@media (max-width: 768px) {
  .controls {
    flex-direction: column;
    align-items: stretch;
  }
}

.control-left,
.control-right {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

@media (max-width: 768px) {
  .control-left,
  .control-right {
    justify-content: center;
  }
}

.loop-bound-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.control-label {
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}

.loop-bound-input {
  width: 3.5rem;
  padding: 0.3rem 0.4rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  font-family: var(--vp-font-family-mono);
  text-align: center;
}

.loop-bound-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn {
  padding: 0.4rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.btn:hover {
  border-color: var(--vp-c-brand-1);
}

.btn-reset {
  border-color: var(--vp-c-text-3);
}

.btn-reset:hover {
  border-color: var(--vp-c-text-1);
}

.context-warn {
  color: #f59e0b;
}

.context-danger {
  color: var(--vp-c-red-1, #ef4444);
  font-weight: 700;
}
</style>
