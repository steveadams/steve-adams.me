import { describe, it, expect } from 'vitest'
import { createActor } from 'xstate'
import { createAgentMachine } from '../agentMachine'

function run(events: Array<{ type: string; [k: string]: any }>, config = {}) {
  const machine = createAgentMachine(config)
  const actor = createActor(machine)
  actor.start()
  for (const event of events) {
    actor.send(event as any)
  }
  const snap = actor.getSnapshot()
  actor.stop()
  return snap
}

function stateString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([p, c]) => (typeof c === 'string' ? `${p}.${c}` : p))
      .join(', ')
  }
  return String(value)
}

describe('agent machine', () => {
  describe('happy path (all high confidence)', () => {
    it('idle → collecting → classifying → mapping → generating → validating → complete', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 10 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 10 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('complete')
      expect(snap.context.columnsTotal).toBe(10)
      expect(snap.context.columnsClassified).toBe(10)
      expect(snap.context.lowConfidenceCount).toBe(0)
    })
  })

  describe('confirmation path', () => {
    it('classifying → confirming → mapping when gates cleared', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 8 },
        { type: 'HAS_LOW_CONFIDENCE', classified: 8, lowCount: 3 },
        { type: 'GATES_CLEARED' },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('complete')
      expect(snap.context.lowConfidenceCount).toBe(3)
      expect(snap.context.gatesCleared).toBe(1)
    })
  })

  describe('user rejection loop', () => {
    it('confirming → classifying → confirming → mapping', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'HAS_LOW_CONFIDENCE', classified: 5, lowCount: 2 },
        { type: 'USER_REJECTED' },
        // Reclassify — this time all high
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
      ])
      expect(stateString(snap.value)).toBe('generating')
    })
  })

  describe('revision loop', () => {
    it('validating → revising → generating → validating → complete', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        {
          type: 'VALIDATION_FAIL',
          violationCount: 3,
          repeatedViolations: 0,
          adjustedFields: ['decimalLatitude'],
        },
        { type: 'REVISED' },
        { type: 'CONFIG_WRITTEN' },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('complete')
      expect(snap.context.revisionRound).toBe(1)
    })

    it('tracks revision rounds and stall confidence', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        {
          type: 'VALIDATION_FAIL',
          violationCount: 5,
          repeatedViolations: 0,
          adjustedFields: ['fieldA'],
        },
        { type: 'REVISED' },
        { type: 'CONFIG_WRITTEN' },
        {
          type: 'VALIDATION_FAIL',
          violationCount: 5,
          repeatedViolations: 4,
          adjustedFields: ['fieldB'],
        },
      ])
      expect(stateString(snap.value)).toBe('revising')
      expect(snap.context.revisionRound).toBe(2)
      expect(snap.context.stallConfidence).toBeGreaterThan(0)
    })
  })

  describe('circuit breaker', () => {
    it('trips when revision risk exceeds threshold', () => {
      const events: Array<{ type: string; [k: string]: any }> = [
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
      ]
      // Send repeated validation failures with same violations (high stall confidence)
      for (let i = 0; i < 5; i++) {
        events.push({
          type: 'VALIDATION_FAIL',
          violationCount: 3,
          repeatedViolations: 3,
          adjustedFields: ['decimalLatitude'],
        })
        // After enough rounds, the circuit breaker should trip on entry to revising
        if (i < 4) {
          events.push({ type: 'REVISED' })
          events.push({ type: 'CONFIG_WRITTEN' })
        }
      }
      const snap = run(events, { breakerThreshold: 2, windowSize: 5 })
      expect(stateString(snap.value)).toBe('failed')
      expect(snap.context.revisionRound).toBeGreaterThanOrEqual(3)
    })

    it('does not trip when violations improve each round', () => {
      const snap = run(
        [
          { type: 'START' },
          { type: 'SOURCES_FOUND', columnCount: 5 },
          { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
          { type: 'MAPPINGS_READY' },
          { type: 'CONFIG_WRITTEN' },
          {
            type: 'VALIDATION_FAIL',
            violationCount: 10,
            repeatedViolations: 0,
            adjustedFields: ['fieldA'],
          },
          { type: 'REVISED' },
          { type: 'CONFIG_WRITTEN' },
          {
            type: 'VALIDATION_FAIL',
            violationCount: 5,
            repeatedViolations: 0,
            adjustedFields: ['fieldB'],
          },
          { type: 'REVISED' },
          { type: 'CONFIG_WRITTEN' },
          {
            type: 'VALIDATION_FAIL',
            violationCount: 2,
            repeatedViolations: 0,
            adjustedFields: ['fieldC'],
          },
        ],
        { breakerThreshold: 2, windowSize: 5 },
      )
      expect(stateString(snap.value)).toBe('revising')
      // Should still be in revising because stall confidence is low (improving)
      expect(snap.context.stallConfidence).toBe(0)
    })
  })

  describe('no sources', () => {
    it('collecting → failed when no sources found', () => {
      const snap = run([{ type: 'START' }, { type: 'NO_SOURCES' }])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('classification error', () => {
    it('classifying → failed on error', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'CLASSIFICATION_ERROR' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('confirmation timeout', () => {
    it('confirming → failed on timeout', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'HAS_LOW_CONFIDENCE', classified: 5, lowCount: 2 },
        { type: 'CONFIRMATION_TIMEOUT' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('validation system error', () => {
    it('validating → failed on system error', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        { type: 'VALIDATION_ERROR' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('cancellation', () => {
    it('CANCEL in idle → failed', () => {
      const snap = run([{ type: 'CANCEL' }])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in collecting → failed', () => {
      const snap = run([{ type: 'START' }, { type: 'CANCEL' }])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in classifying → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in confirming → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'HAS_LOW_CONFIDENCE', classified: 5, lowCount: 2 },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in mapping → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in generating → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in validating → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in revising → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        {
          type: 'VALIDATION_FAIL',
          violationCount: 3,
          repeatedViolations: 0,
          adjustedFields: ['fieldA'],
        },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('event absorption', () => {
    it('VALIDATION_PASS is absorbed in classifying', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('classifying')
    })

    it('SOURCES_FOUND is absorbed in mapping', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'SOURCES_FOUND', columnCount: 10 },
      ])
      expect(stateString(snap.value)).toBe('mapping')
      expect(snap.context.columnsTotal).toBe(5)
    })

    it('START is absorbed in validating', () => {
      const snap = run([
        { type: 'START' },
        { type: 'SOURCES_FOUND', columnCount: 5 },
        { type: 'ALL_CLASSIFIED_HIGH', classified: 5 },
        { type: 'MAPPINGS_READY' },
        { type: 'CONFIG_WRITTEN' },
        { type: 'START' },
      ])
      expect(stateString(snap.value)).toBe('validating')
    })
  })
})
