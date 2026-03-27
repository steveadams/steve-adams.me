import { setup, assign } from 'xstate'
import { computeStallConfidence, type RevisionRecord } from './stallDetection'

export type { RevisionRecord }

export interface AgentContext {
  readonly columnsTotal: number
  readonly columnsClassified: number
  readonly lowConfidenceCount: number
  readonly gatesCleared: number
  readonly revisionRound: number
  readonly recentRevisions: ReadonlyArray<RevisionRecord>
  readonly stallConfidence: number
  readonly breakerThreshold: number
  readonly windowSize: number
}

export type AgentEvent =
  | { type: 'START' }
  | { type: 'CANCEL' }
  | { type: 'SOURCES_FOUND'; columnCount: number }
  | { type: 'NO_SOURCES' }
  | { type: 'ALL_CLASSIFIED_HIGH'; classified: number }
  | { type: 'HAS_LOW_CONFIDENCE'; classified: number; lowCount: number }
  | { type: 'CLASSIFICATION_ERROR' }
  | { type: 'GATES_CLEARED' }
  | { type: 'USER_REJECTED' }
  | { type: 'CONFIRMATION_TIMEOUT' }
  | { type: 'MAPPINGS_READY' }
  | { type: 'CONFIG_WRITTEN' }
  | { type: 'VALIDATION_PASS' }
  | {
      type: 'VALIDATION_FAIL'
      violationCount: number
      repeatedViolations: number
      adjustedFields: string[]
    }
  | { type: 'VALIDATION_ERROR' }
  | { type: 'REVISED' }

export const EVENT_GROUPS = [
  { label: 'Lifecycle', events: ['START', 'CANCEL'] },
  { label: 'Collection', events: ['SOURCES_FOUND', 'NO_SOURCES'] },
  {
    label: 'Classification',
    events: ['ALL_CLASSIFIED_HIGH', 'HAS_LOW_CONFIDENCE', 'CLASSIFICATION_ERROR'],
  },
  {
    label: 'Confirmation',
    events: ['GATES_CLEARED', 'USER_REJECTED', 'CONFIRMATION_TIMEOUT'],
  },
  { label: 'Mapping', events: ['MAPPINGS_READY'] },
  { label: 'Generation', events: ['CONFIG_WRITTEN'] },
  {
    label: 'Validation',
    events: ['VALIDATION_PASS', 'VALIDATION_FAIL', 'VALIDATION_ERROR'],
  },
  { label: 'Revision', events: ['REVISED'] },
] as const

export const ALL_EVENTS = EVENT_GROUPS.flatMap((g) => [...g.events])

export interface AgentMachineConfig {
  breakerThreshold?: number
  windowSize?: number
}

export function createAgentMachine(config: AgentMachineConfig = {}) {
  const { breakerThreshold = 10, windowSize = 5 } = config

  return setup({
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
      recordSources: assign(({ event }) => {
        const e = event as { type: 'SOURCES_FOUND'; columnCount: number }
        return { columnsTotal: e.columnCount }
      }),
      recordClassificationHigh: assign(({ event }) => {
        const e = event as { type: 'ALL_CLASSIFIED_HIGH'; classified: number }
        return {
          columnsClassified: e.classified,
          lowConfidenceCount: 0,
        }
      }),
      recordClassificationLow: assign(({ event }) => {
        const e = event as {
          type: 'HAS_LOW_CONFIDENCE'
          classified: number
          lowCount: number
        }
        return {
          columnsClassified: e.classified,
          lowConfidenceCount: e.lowCount,
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
        const prevCount =
          context.recentRevisions.length > 0
            ? context.recentRevisions[context.recentRevisions.length - 1]
                .violationCount
            : Infinity
        const outcome: RevisionRecord['outcome'] =
          e.violationCount < prevCount
            ? 'improved'
            : e.violationCount === prevCount
              ? 'unchanged'
              : 'worsened'
        const record: RevisionRecord = {
          round,
          violationCount: e.violationCount,
          repeatedViolations: e.repeatedViolations,
          adjustedFields: e.adjustedFields,
          outcome,
        }
        const recentRevisions = [...context.recentRevisions, record].slice(
          -context.windowSize,
        )
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
      columnsTotal: 0,
      columnsClassified: 0,
      lowConfidenceCount: 0,
      gatesCleared: 0,
      revisionRound: 0,
      recentRevisions: [],
      stallConfidence: 0,
      breakerThreshold,
      windowSize,
    },
    states: {
      idle: {
        on: {
          START: 'collecting',
          CANCEL: 'failed',
        },
      },
      collecting: {
        on: {
          SOURCES_FOUND: {
            target: 'classifying',
            actions: 'recordSources',
          },
          NO_SOURCES: 'failed',
          CANCEL: 'failed',
        },
      },
      classifying: {
        on: {
          ALL_CLASSIFIED_HIGH: {
            target: 'mapping',
            actions: 'recordClassificationHigh',
          },
          HAS_LOW_CONFIDENCE: {
            target: 'confirming',
            actions: 'recordClassificationLow',
          },
          CLASSIFICATION_ERROR: 'failed',
          CANCEL: 'failed',
        },
      },
      confirming: {
        on: {
          GATES_CLEARED: {
            target: 'mapping',
            actions: 'recordGateCleared',
          },
          USER_REJECTED: 'classifying',
          CONFIRMATION_TIMEOUT: 'failed',
          CANCEL: 'failed',
        },
      },
      mapping: {
        on: {
          MAPPINGS_READY: 'generating',
          CANCEL: 'failed',
        },
      },
      generating: {
        on: {
          CONFIG_WRITTEN: 'validating',
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
}
