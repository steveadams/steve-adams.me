import { describe, it, expect } from 'vitest'
import { computeStallConfidence, type RevisionRecord } from '../stallDetection'

function revision(
  round: number,
  violationCount: number,
  repeatedViolations: number,
  adjustedFields: string[] = [],
  outcome: 'improved' | 'unchanged' | 'worsened' = 'unchanged',
): RevisionRecord {
  return { round, violationCount, repeatedViolations, adjustedFields, outcome }
}

describe('computeStallConfidence', () => {
  it('returns 0 for empty window', () => {
    expect(computeStallConfidence([])).toBe(0)
  })

  it('returns 0 for single revision', () => {
    expect(computeStallConfidence([revision(1, 5, 0)])).toBe(0)
  })

  describe('repetition signal', () => {
    it('detects all violations repeating', () => {
      const revisions = [
        revision(1, 5, 0),
        revision(2, 5, 5),
      ]
      // repeatedViolations/violationCount = 5/5 = 1.0
      expect(computeStallConfidence(revisions)).toBe(1.0)
    })

    it('detects partial repetition', () => {
      const revisions = [
        revision(1, 5, 0, [], 'improved'),
        revision(2, 4, 2, [], 'improved'),
      ]
      // repetition = 2/4 = 0.5, stagnation = 0 (all improved)
      expect(computeStallConfidence(revisions)).toBeCloseTo(0.5)
    })

    it('returns 0 repetition when no violations repeat', () => {
      const revisions = [
        revision(1, 5, 0, [], 'improved'),
        revision(2, 3, 0, [], 'improved'),
      ]
      // 0/3 = 0, but stagnation = 1 - 2/2 = 0 (all improved)
      expect(computeStallConfidence(revisions)).toBe(0)
    })

    it('handles zero violation count in last revision', () => {
      const revisions = [
        revision(1, 5, 0, [], 'improved'),
        revision(2, 0, 0, [], 'improved'),
      ]
      expect(computeStallConfidence(revisions)).toBe(0)
    })
  })

  describe('stagnation signal', () => {
    it('detects no improvement across window', () => {
      const revisions = [
        revision(1, 5, 3, [], 'unchanged'),
        revision(2, 5, 3, [], 'unchanged'),
        revision(3, 5, 3, [], 'worsened'),
      ]
      // 0 improved / 3 total = stagnation 1.0
      expect(computeStallConfidence(revisions)).toBe(1.0)
    })

    it('detects partial improvement', () => {
      const revisions = [
        revision(1, 5, 0, [], 'improved'),
        revision(2, 4, 2, [], 'unchanged'),
        revision(3, 4, 2, [], 'improved'),
        revision(4, 3, 1, [], 'unchanged'),
      ]
      // 2 improved / 4 total = stagnation 0.5
      expect(computeStallConfidence(revisions)).toBeCloseTo(0.5)
    })

    it('returns 0 stagnation when all rounds improve', () => {
      const revisions = [
        revision(1, 5, 0, [], 'improved'),
        revision(2, 3, 0, [], 'improved'),
        revision(3, 1, 0, [], 'improved'),
      ]
      // 3/3 improved → stagnation = 0
      expect(computeStallConfidence(revisions)).toBe(0)
    })
  })

  describe('oscillation signal', () => {
    it('detects field flip-flopping', () => {
      const revisions = [
        revision(1, 3, 0, ['decimalLatitude']),
        revision(2, 3, 2, ['eventDate']),
        revision(3, 3, 2, ['decimalLatitude']),
      ]
      // Round 3 adjusts decimalLatitude, which was adjusted in round 1 but not 2 → flip-flop
      expect(computeStallConfidence(revisions)).toBeGreaterThan(0.5)
    })

    it('does not detect oscillation with fewer than 3 revisions', () => {
      const revisions = [
        revision(1, 3, 0, ['decimalLatitude']),
        revision(2, 3, 2, ['eventDate']),
      ]
      // Only stagnation and repetition signals, no oscillation possible
      const confidence = computeStallConfidence(revisions)
      // Check that oscillation signal is not contributing (both records are unchanged → stagnation = 1.0)
      expect(confidence).toBe(1.0) // from stagnation, not oscillation
    })

    it('returns 0 oscillation when different fields adjusted each round', () => {
      const revisions = [
        revision(1, 3, 0, ['fieldA'], 'improved'),
        revision(2, 2, 0, ['fieldB'], 'improved'),
        revision(3, 1, 0, ['fieldC'], 'improved'),
      ]
      expect(computeStallConfidence(revisions)).toBe(0)
    })
  })

  describe('max() combination', () => {
    it('returns highest signal when stagnation exceeds repetition', () => {
      const revisions = [
        revision(1, 5, 0, [], 'unchanged'),
        revision(2, 5, 1, [], 'unchanged'),
      ]
      // repetition = 1/5 = 0.2, stagnation = 1 - 0/2 = 1.0
      expect(computeStallConfidence(revisions)).toBe(1.0)
    })

    it('returns highest signal when repetition exceeds stagnation', () => {
      const revisions = [
        revision(1, 5, 0, [], 'improved'),
        revision(2, 5, 5, [], 'improved'),
      ]
      // repetition = 5/5 = 1.0, stagnation = 1 - 2/2 = 0
      expect(computeStallConfidence(revisions)).toBe(1.0)
    })

    it('combines signals — highest wins', () => {
      const revisions = [
        revision(1, 10, 0, ['fieldA'], 'improved'),
        revision(2, 8, 4, ['fieldB'], 'unchanged'),
        revision(3, 7, 3, ['fieldA'], 'improved'),
      ]
      // repetition = 3/7 ≈ 0.43
      // stagnation = 1 - 2/3 ≈ 0.33
      // oscillation: fieldA in round 3 was in round 1 but not round 2 → 1/1 = 1.0
      expect(computeStallConfidence(revisions)).toBe(1.0)
    })
  })
})
