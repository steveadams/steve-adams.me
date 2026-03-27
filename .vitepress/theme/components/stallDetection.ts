export interface RevisionRecord {
  readonly round: number
  readonly violationCount: number
  readonly repeatedViolations: number
  readonly adjustedFields: string[]
  readonly outcome: 'improved' | 'unchanged' | 'worsened'
}

export function computeStallConfidence(
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
