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
    it('idle → inspecting → structuring → gathering → generating → validating → complete', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 10 },
        { type: 'STRUCTURE_DETERMINED', resolved: 10 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('complete')
      expect(snap.context.filesTotal).toBe(10)
      expect(snap.context.metadataFieldsResolved).toBe(10)
      expect(snap.context.unconfirmedCount).toBe(0)
    })
  })

  describe('confirmation path', () => {
    it('structuring → confirming → gathering when gates cleared', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 8 },
        { type: 'NEEDS_CONFIRMATION', resolved: 8, unconfirmedCount: 3 },
        { type: 'GATES_CLEARED' },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('complete')
      expect(snap.context.unconfirmedCount).toBe(3)
      expect(snap.context.gatesCleared).toBe(1)
    })
  })

  describe('user rejection loop', () => {
    it('structuring → confirming → structuring → gathering', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'NEEDS_CONFIRMATION', resolved: 5, unconfirmedCount: 2 },
        { type: 'USER_REJECTED' },
        // Reclassify — this time all high
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
      ])
      expect(stateString(snap.value)).toBe('generating')
    })
  })

  describe('revision loop', () => {
    it('validating → revising → generating → validating → complete', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
        {
          type: 'VALIDATION_FAIL',
          violationCount: 3,
          repeatedViolations: 0,
          adjustedFields: ['decimalLatitude'],
        },
        { type: 'REVISED' },
        { type: 'ARCHIVE_GENERATED' },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('complete')
      expect(snap.context.revisionRound).toBe(1)
    })

    it('tracks revision rounds and stall confidence', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
        {
          type: 'VALIDATION_FAIL',
          violationCount: 5,
          repeatedViolations: 0,
          adjustedFields: ['fieldA'],
        },
        { type: 'REVISED' },
        { type: 'ARCHIVE_GENERATED' },
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
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
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
          events.push({ type: 'ARCHIVE_GENERATED' })
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
          { type: 'INSPECTION_COMPLETE', fileCount: 5 },
          { type: 'STRUCTURE_DETERMINED', resolved: 5 },
          { type: 'METADATA_COMPLETE' },
          { type: 'ARCHIVE_GENERATED' },
          {
            type: 'VALIDATION_FAIL',
            violationCount: 10,
            repeatedViolations: 0,
            adjustedFields: ['fieldA'],
          },
          { type: 'REVISED' },
          { type: 'ARCHIVE_GENERATED' },
          {
            type: 'VALIDATION_FAIL',
            violationCount: 5,
            repeatedViolations: 0,
            adjustedFields: ['fieldB'],
          },
          { type: 'REVISED' },
          { type: 'ARCHIVE_GENERATED' },
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

  describe('inspection failed', () => {
    it('inspecting → failed when inspection fails', () => {
      const snap = run([{ type: 'START' }, { type: 'INSPECTION_FAILED' }])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('structuring error', () => {
    it('structuring → failed on error', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURING_ERROR' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('confirmation timeout', () => {
    it('confirming → failed on timeout', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'NEEDS_CONFIRMATION', resolved: 5, unconfirmedCount: 2 },
        { type: 'CONFIRMATION_TIMEOUT' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })
  })

  describe('validation system error', () => {
    it('validating → failed on system error', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
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

    it('CANCEL in inspecting → failed', () => {
      const snap = run([{ type: 'START' }, { type: 'CANCEL' }])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in structuring → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in confirming → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'NEEDS_CONFIRMATION', resolved: 5, unconfirmedCount: 2 },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in gathering → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in generating → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in validating → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
        { type: 'CANCEL' },
      ])
      expect(stateString(snap.value)).toBe('failed')
    })

    it('CANCEL in revising → failed', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
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
    it('VALIDATION_PASS is absorbed in structuring', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'VALIDATION_PASS' },
      ])
      expect(stateString(snap.value)).toBe('structuring')
    })

    it('INSPECTION_COMPLETE is absorbed in gathering', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'INSPECTION_COMPLETE', fileCount: 10 },
      ])
      expect(stateString(snap.value)).toBe('gathering')
      expect(snap.context.filesTotal).toBe(5)
    })

    it('START is absorbed in validating', () => {
      const snap = run([
        { type: 'START' },
        { type: 'INSPECTION_COMPLETE', fileCount: 5 },
        { type: 'STRUCTURE_DETERMINED', resolved: 5 },
        { type: 'METADATA_COMPLETE' },
        { type: 'ARCHIVE_GENERATED' },
        { type: 'START' },
      ])
      expect(stateString(snap.value)).toBe('validating')
    })
  })
})
