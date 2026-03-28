import { setup, assign } from 'xstate'
import { computeStallConfidence, type RevisionRecord } from './stallDetection'

export type { RevisionRecord }

export interface AgentContext {
  readonly filesTotal: number
  readonly metadataFieldsResolved: number
  readonly unconfirmedCount: number
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
  | { type: 'INSPECTION_COMPLETE'; fileCount: number }
  | { type: 'INSPECTION_FAILED' }
  | { type: 'STRUCTURE_DETERMINED'; resolved: number }
  | { type: 'NEEDS_CONFIRMATION'; resolved: number; unconfirmedCount: number }
  | { type: 'STRUCTURING_ERROR' }
  | { type: 'GATES_CLEARED' }
  | { type: 'USER_REJECTED' }
  | { type: 'CONFIRMATION_TIMEOUT' }
  | { type: 'METADATA_COMPLETE' }
  | { type: 'ARCHIVE_GENERATED' }
  | { type: 'VALIDATION_PASS' }
  | {
      type: 'VALIDATION_FAIL'
      violationCount: number
      repeatedViolations: number
      adjustedFields: string[]
    }
  | { type: 'VALIDATION_ERROR' }
  | { type: 'REVISED' }

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
      recordInspection: assign(({ event }) => {
        const e = event as { type: 'INSPECTION_COMPLETE'; fileCount: number }
        return { filesTotal: e.fileCount }
      }),
      recordStructure: assign(({ event }) => {
        const e = event as { type: 'STRUCTURE_DETERMINED'; resolved: number }
        return {
          metadataFieldsResolved: e.resolved,
          unconfirmedCount: 0,
        }
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
      filesTotal: 0,
      metadataFieldsResolved: 0,
      unconfirmedCount: 0,
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
}
