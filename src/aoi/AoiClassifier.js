/**
 * Classifies gaze samples into AOIs using interval validity and priority.
 *
 * Requirement links: `FR-AOI-008`, `FR-AOI-009`, `FR-AOI-010`,
 * `FR-EYE-008`, and `FR-PERF-006`.
 * The classifier runs post-trial so AOI snapshots can be generated whenever
 * game state changes while gaze collection stays independent and high-rate.
 */
export class AoiClassifier {
  /**
 * Creates a classifier.
 *
 * Requirement links: `FR-AOI-008` and `FR-DATA-006`.
 * The labels are configurable for tests, but production rows use dictionary
 * values from the current schema.
 *
 * @param {{outsideAoi?: string, invalidAoi?: string}} options Label options.
   */
  constructor(options = {}) {
    this.outsideAoi = options.outsideAoi ?? 'outside';
    this.invalidAoi = options.invalidAoi ?? 'invalid';
  }

  /**
 * Classifies one gaze sample against AOI intervals.
 *
 * Requirement links: `FR-AOI-008`, `FR-AOI-009`, and `FR-DATA-005`.
 * Higher-priority rectangles win when AOIs overlap. This resolves active
 * piece over landing zone over board without needing mutually exclusive AOI
 * geometry.
   *
   * @param {Record<string, unknown>} sample Canonical gaze sample object.
   * @param {Record<string, unknown>[]} snapshots Canonical AOI snapshot objects.
   * @returns {Record<string, unknown>} Classification result.
   */
  classifySample(sample, snapshots) {
    if (!sample.valid) {
      return {
        ...sample,
        aoi: this.invalidAoi,
        aoi_state_id: null,
        priority: null,
        matching_aois: [],
        matching_aoi_state_ids: [],
        matching_priorities: [],
      };
    }
    const active = snapshots
      .filter((snapshot) => snapshot.trial_id === sample.trial_id)
      .filter((snapshot) => sample.t_trial_ms >= snapshot.valid_from_t_trial_ms)
      .filter((snapshot) => snapshot.valid_to_t_trial_ms === null || sample.t_trial_ms < snapshot.valid_to_t_trial_ms)
      .filter((snapshot) => pointInRect(sample.x, sample.y, snapshot))
      .sort((left, right) => Number(right.priority) - Number(left.priority));
    const winner = active[0];
    if (!winner) {
      return {
        ...sample,
        aoi: this.outsideAoi,
        aoi_state_id: null,
        priority: null,
        matching_aois: [],
        matching_aoi_state_ids: [],
        matching_priorities: [],
      };
    }
    return {
      ...sample,
      piece_id: sample.piece_id ?? winner.piece_id,
      aoi: winner.aoi,
      aoi_state_id: winner.aoi_state_id,
      priority: winner.priority,
      matching_aois: active.map((snapshot) => snapshot.aoi),
      matching_aoi_state_ids: active.map((snapshot) => snapshot.aoi_state_id),
      matching_priorities: active.map((snapshot) => snapshot.priority),
    };
  }

  /**
 * Classifies a list of gaze samples.
 *
 * Requirement links: `FR-AOI-008`, `FR-AOI-010`, and `FR-PERF-006`.
 * Batch classification keeps raw gaze collection simple during gameplay and
 * creates derived rows only after AOI intervals are complete.
 *
 * @param {Record<string, unknown>[]} samples Canonical gaze sample objects.
   * @param {Record<string, unknown>[]} snapshots Canonical AOI snapshot objects.
   * @returns {Record<string, unknown>[]} Classified samples with AOI labels.
   */
  classifySamples(samples, snapshots) {
    return samples.map((sample) => this.classifySample(sample, snapshots));
  }
}

/**
 * Collapses classified gaze samples into AOI visit rows.
 *
 * Requirement links: `FR-AOI-010`, `FR-AOI-011`, `FR-ANA-003`,
 * and `FR-PERF-006`.
 * Consecutive samples with the same trial, piece, and AOI become one visit.
 * This simple rule is transparent for MVP validation and can be refined after
 * pilots if researchers need fixation algorithms or gap filling.
 *
 * @param {Record<string, unknown>[]} classifiedSamples Classified gaze samples.
 * @returns {Record<string, unknown>[]} Canonical `aoi_visits` row objects.
 */
export function buildAoiVisits(classifiedSamples) {
  const samples = [...classifiedSamples]
    .filter((sample) => sample.aoi !== 'invalid')
    .sort((left, right) => Number(left.t_trial_ms) - Number(right.t_trial_ms));
  const visits = [];
  let current = null;

  for (const sample of samples) {
    const key = `${sample.trial_id}|${sample.piece_id ?? 'none'}|${sample.aoi}`;
    if (!current || current.key !== key) {
      if (current) {
        visits.push(finishVisit(current, visits.length + 1));
      }
      current = {
        key,
        trial_id: sample.trial_id,
        piece_id: sample.piece_id,
        aoi: sample.aoi,
        start_t_trial_ms: sample.t_trial_ms,
        end_t_trial_ms: sample.t_trial_ms,
        start_t_piece_ms: sample.t_piece_ms,
        end_t_piece_ms: sample.t_piece_ms,
        confidences: [Number(sample.confidence ?? 0)],
      };
    } else {
      current.end_t_trial_ms = sample.t_trial_ms;
      current.end_t_piece_ms = sample.t_piece_ms;
      current.confidences.push(Number(sample.confidence ?? 0));
    }
  }
  if (current) {
    visits.push(finishVisit(current, visits.length + 1));
  }
  return visits;
}

/**
 * Tests whether a point falls inside a rectangle.
 *
 * Requirement links: `FR-AOI-008` and `FR-REPLAY-009`.
 * Inclusive edges make AOI classification deterministic for integer-rounded
 * viewport gaze samples that land exactly on an AOI boundary.
 *
 * @param {number} x X coordinate.
 * @param {number} y Y coordinate.
 * @param {{x: number, y: number, w: number, h: number}} rect Rectangle.
 * @returns {boolean} True when the point is inside.
 */
export function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * Converts an in-progress visit accumulator into a canonical row.
 *
 * Requirement links: `FR-AOI-010`, `FR-AOI-011`, and `FR-ANA-003`.
 * The accumulator retains only confidence values needed for the visit summary,
 * avoiding a second copy of raw gaze samples.
 *
 * @param {Record<string, unknown>} visit Visit accumulator.
 * @param {number} index One-based visit index.
 * @returns {Record<string, unknown>} Canonical `aoi_visits` row.
 */
function finishVisit(visit, index) {
  const sampleCount = visit.confidences.length;
  const duration = Math.max(0, Number(visit.end_t_trial_ms) - Number(visit.start_t_trial_ms));
  return {
    trial_id: visit.trial_id,
    piece_id: visit.piece_id,
    visit_id: `visit_${index}`,
    aoi: visit.aoi,
    start_t_trial_ms: visit.start_t_trial_ms,
    end_t_trial_ms: visit.end_t_trial_ms,
    duration_ms: duration,
    sample_count: sampleCount,
    mean_confidence: visit.confidences.reduce((sum, value) => sum + value, 0) / sampleCount,
    start_t_piece_ms: visit.start_t_piece_ms,
    end_t_piece_ms: visit.end_t_piece_ms,
  };
}
