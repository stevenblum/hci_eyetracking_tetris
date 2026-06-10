import { AoiClassifier, buildAoiVisits } from '../aoi/AoiClassifier.js';

const POST_LOCK_EVALUATION_WINDOW_MS = 750;
const ACTION_EVENTS = ['move_left', 'move_right', 'soft_drop', 'hard_drop', 'rotate_clockwise', 'rotate_counterclockwise'];
const ROTATION_EVENTS = ['rotate_clockwise', 'rotate_counterclockwise'];
const HORIZONTAL_EVENTS = ['move_left', 'move_right'];

/**
 * Builds derived AOI visits and summary tables from canonical raw rows.
 *
 * Requirement links: `FR-ANA-001` through `FR-ANA-010`,
 * `FR-HCI-001` through `FR-HCI-005`, `FR-AOI-010`, `FR-AOI-011`,
 * `FR-EYE-009`, and `FR-PERF-006`.
 * Analysis runs after each trial so the UI and exports always reflect the
 * current schema state without maintaining separate analysis versions.
 */
export class AnalysisBuilder {
  /**
 * Creates an analysis builder.
 *
 * Requirement links: `FR-AOI-008`, `FR-AOI-010`, and `FR-ANA-009`.
 * A classifier can be injected for tests, but production analysis uses the
 * current priority-based AOI classifier.
 *
 * @param {import('../data/SessionDataStore.js').SessionDataStore} store Canonical data store.
   * @param {{classifier?: AoiClassifier}} options Analysis options.
   */
  constructor(store, options = {}) {
    this.store = store;
    this.classifier = options.classifier ?? new AoiClassifier();
  }

  /**
 * Rebuilds analysis rows for one trial.
 *
 * Requirement links: `FR-AOI-010`, `FR-AOI-011`, `FR-ANA-001`,
 * `FR-ANA-002`, `FR-ANA-009`, `FR-HCI-001`, and `FR-PERF-006`.
 * Existing rows for the trial are removed before rebuilding because the MVP
 * has one current analysis definition and no historical compatibility layer.
   *
   * @param {string} trialId Trial identifier.
   * @returns {{visits: Record<string, unknown>[], pieceSummaries: Record<string, unknown>[], trialSummary: Record<string, unknown> | null}} Built analysis rows.
   */
  buildForTrial(trialId) {
    this.removeTrialRows(trialId);
    const gaze = this.store.getRows('gaze_samples').filter((row) => row.trial_id === trialId);
    const snapshots = this.store.getRows('aoi_snapshots').filter((row) => row.trial_id === trialId);
    const classified = this.classifier.classifySamples(gaze, snapshots);
    this.storeClassifications(classified);
    const visits = buildAoiVisits(classified);
    for (const visit of visits) {
      this.store.addRow('aoi_visits', visit);
    }

    const pieceSummaries = this.buildPieceSummaries(trialId, visits);
    for (const summary of pieceSummaries) {
      this.store.addRow('piece_summaries', summary);
    }

    const pieceIndexes = this.buildPieceIndexes(trialId);
    for (const indexRow of pieceIndexes) {
      this.store.addRow('piece_indexes', indexRow);
    }

    const trialSummary = this.buildTrialSummary(trialId, visits);
    if (trialSummary) {
      this.store.addRow('trial_summaries', trialSummary);
    }
    return { visits, pieceSummaries, trialSummary };
  }

  /**
 * Removes derived analysis rows for a trial.
 *
 * Requirement links: `FR-DATA-001`, `FR-ANA-009`, and `FR-PERF-006`.
 * Only derived tables are cleared; raw gaze, game events, and AOI snapshots
 * remain preserved for reanalysis.
 *
 * @param {string} trialId Trial identifier.
   */
  removeTrialRows(trialId) {
    for (const tableName of ['gaze_aoi_classifications', 'aoi_visits', 'piece_summaries', 'piece_indexes', 'trial_summaries']) {
      const table = this.store.session.tables[tableName];
      const rows = this.store.getRows(tableName).filter((row) => row.trial_id !== trialId);
      table.rows = rows.map((row) => table.columns.map((column) => row[column] ?? null));
    }
  }

  /**
 * Stores per-sample AOI classification rows.
 *
 * Requirement links: `FR-AOI-008`, `FR-AOI-009`, `FR-DATA-005`,
 * and `FR-DATA-006`.
 * The classifier keeps raw gaze untouched; this table records the analysis
 * decision plus every overlapping AOI match so priority choices can be audited
   * later without recomputing geometry.
   *
   * @param {Record<string, unknown>[]} classified Classified gaze rows.
   */
  storeClassifications(classified) {
    for (const sample of classified) {
      this.store.addRow('gaze_aoi_classifications', {
        trial_id: sample.trial_id,
        piece_id: sample.piece_id,
        t_trial_ms: sample.t_trial_ms,
        t_piece_ms: sample.t_piece_ms,
        primary_aoi: sample.aoi,
        primary_aoi_state_id: sample.aoi_state_id,
        matching_aois: JSON.stringify(sample.matching_aois ?? []),
        matching_aoi_state_ids: JSON.stringify(sample.matching_aoi_state_ids ?? []),
        matching_priorities: JSON.stringify(sample.matching_priorities ?? []),
      });
    }
  }

  /**
 * Builds per-piece summary rows.
 *
 * Requirement links: `FR-ANA-002` through `FR-ANA-007`,
 * `FR-HCI-001` through `FR-HCI-005`, and `FR-PERF-007`.
 * These summaries map directly to classroom-facing questions: when did the
 * participant act, did they inspect the landing zone, and did they preview the
   * next piece before locking the current one.
   *
   * @param {string} trialId Trial identifier.
   * @param {Record<string, unknown>[]} visits AOI visit rows.
   * @returns {Record<string, unknown>[]} Piece summary rows.
   */
  buildPieceSummaries(trialId, visits) {
    const trial = this.store.getRows('trials').find((row) => row.trial_id === trialId) ?? {};
    const expectedSequence = expectedAoiSequence(trial);
    const pieces = this.store.getRows('pieces').filter((piece) => piece.trial_id === trialId);
    const events = this.store.getRows('game_events').filter((event) => event.trial_id === trialId);
    const allVisits = sortVisits(visits, 'start_t_trial_ms');
    return pieces.map((piece) => {
      const pieceVisits = visits.filter((visit) => visit.piece_id === piece.piece_id);
      const sortedPieceVisits = sortVisits(pieceVisits, 'start_t_piece_ms');
      const pieceEvents = events.filter((event) => event.piece_id === piece.piece_id);
      const actionEvents = pieceEvents.filter((event) => ACTION_EVENTS.includes(event.event_type));
      const firstAction = actionEvents
        .filter((event) => event.piece_id === piece.piece_id)
        .sort((left, right) => Number(left.t_piece_ms) - Number(right.t_piece_ms))[0];
      const firstRotation = pieceEvents
        .filter((event) => ROTATION_EVENTS.includes(event.event_type))
        .sort((left, right) => Number(left.t_piece_ms) - Number(right.t_piece_ms))[0];
      const dwellTotal = totalDwell(pieceVisits);
      const transitionCounts = buildTransitionCounts(sortedPieceVisits);
      const expectedComparison = compareExpectedSequence(sortedPieceVisits, expectedSequence);
      const landingFirstLook = firstVisitTime(pieceVisits, 'landing_zone');
      const stackFirstLook = firstVisitTime(pieceVisits, 'stack_blocks');
      const postLockStackLook = firstPostLockStackLook(piece, allVisits);
      const postLockDelay = postLockStackLook === null || piece.lock_t_trial_ms === null
        ? null
        : Math.max(0, Number(postLockStackLook) - Number(piece.lock_t_trial_ms));
      // These derived labels keep HCI interpretation near the measurements
      // they summarize, so exports can be used directly in class discussion
      // without a separate concept-mapping pass.
      const planningLabel = planningInterpretation({
        landingFirstLook,
        stackFirstLook,
        firstActionMs: firstAction?.t_piece_ms,
      });
      const sequenceLabel = sequenceInterpretation(expectedComparison);
      const previewCount = pieceVisits.filter((visit) => visit.aoi === 'next_piece').length;
      return {
        trial_id: trialId,
        piece_id: piece.piece_id,
        piece_type: piece.piece_type,
        duration_ms: piece.duration_ms,
        first_action_t_piece_ms: firstAction?.t_piece_ms ?? null,
        first_rotation_t_piece_ms: firstRotation?.t_piece_ms ?? null,
        first_active_piece_look_t_piece_ms: firstVisitTime(pieceVisits, 'active_piece'),
        first_stack_look_t_piece_ms: stackFirstLook,
        first_landing_zone_look_t_piece_ms: landingFirstLook,
        first_next_piece_look_t_piece_ms: firstVisitTime(pieceVisits, 'next_piece'),
        landing_zone_dwell_ms: dwell(pieceVisits, 'landing_zone'),
        active_piece_dwell_ms: dwell(pieceVisits, 'active_piece'),
        stack_dwell_ms: dwell(pieceVisits, 'stack_blocks'),
        next_piece_dwell_ms: dwell(pieceVisits, 'next_piece'),
        landing_zone_dwell_percent: dwellPercent(pieceVisits, 'landing_zone', dwellTotal),
        active_piece_dwell_percent: dwellPercent(pieceVisits, 'active_piece', dwellTotal),
        stack_dwell_percent: dwellPercent(pieceVisits, 'stack_blocks', dwellTotal),
        next_piece_dwell_percent: dwellPercent(pieceVisits, 'next_piece', dwellTotal),
        aoi_visit_count: pieceVisits.length,
        aoi_transition_count: Math.max(0, sortedPieceVisits.length - 1),
        aoi_transition_counts: JSON.stringify(transitionCounts),
        aoi_sequence: JSON.stringify(sortedPieceVisits.map((visit) => visit.aoi)),
        expected_aoi_sequence: JSON.stringify(expectedSequence),
        observed_expected_aoi_sequence: JSON.stringify(expectedComparison.observedExpected),
        missing_expected_aois: JSON.stringify(expectedComparison.missing),
        expected_sequence_match: expectedComparison.matches,
        looked_landing_before_first_action: beforeAction(landingFirstLook, firstAction?.t_piece_ms),
        looked_stack_before_first_action: beforeAction(stackFirstLook, firstAction?.t_piece_ms),
        post_lock_stack_look_t_trial_ms: postLockStackLook,
        post_lock_stack_look_delay_ms: postLockDelay,
        post_lock_evaluation_window_ms: POST_LOCK_EVALUATION_WINDOW_MS,
        post_lock_stack_evaluation_seen: postLockStackLook !== null,
        hci_planning_label: planningLabel,
        hci_sequence_label: sequenceLabel,
        hci_preview_label: previewCount > 0 ? 'preview checked' : 'preview not checked',
        hci_feedback_label: postLockStackLook !== null ? 'feedback look observed' : 'no feedback look',
        preview_checks: previewCount,
        action_count: actionEvents.length,
        rotation_count: pieceEvents.filter((event) => ROTATION_EVENTS.includes(event.event_type)).length,
        horizontal_move_count: pieceEvents.filter((event) => HORIZONTAL_EVENTS.includes(event.event_type)).length,
        soft_drop_count: pieceEvents.filter((event) => event.event_type === 'soft_drop').length,
        hard_drop_count: pieceEvents.filter((event) => event.event_type === 'hard_drop').length,
        holes_before: piece.holes_before,
        holes_after: piece.holes_after,
        holes_created: numericDelta(piece.holes_after, piece.holes_before),
        board_height_before: piece.board_height_before,
        board_height_after: piece.board_height_after,
        board_height_change: numericDelta(piece.board_height_after, piece.board_height_before),
        aggregate_height_before: piece.aggregate_height_before,
        aggregate_height_after: piece.aggregate_height_after,
        aggregate_height_change: numericDelta(piece.aggregate_height_after, piece.aggregate_height_before),
        bumpiness_before: piece.bumpiness_before,
        bumpiness_after: piece.bumpiness_after,
        bumpiness_change: numericDelta(piece.bumpiness_after, piece.bumpiness_before),
      };
    });
  }

  /**
 * Builds row ranges for fast piece-indexed table access.
 *
 * Requirement links: `FR-HCI-001`, `FR-HCI-002`, and `FR-PERF-007`.
 * These ranges are intentionally derived after analysis so they point at the
 * final current-schema rows for gaze samples, events, and AOI visits.
   *
   * @param {string} trialId Trial identifier.
   * @returns {Record<string, unknown>[]} Piece index rows.
   */
  buildPieceIndexes(trialId) {
    const pieces = this.store.getRows('pieces').filter((piece) => piece.trial_id === trialId);
    const tableRows = {
      gaze: this.store.getRows('gaze_samples'),
      game: this.store.getRows('game_events'),
      state: this.store.getRows('piece_state_events'),
      visits: this.store.getRows('aoi_visits'),
    };
    return pieces.map((piece) => {
      const gazeRange = rowRange(tableRows.gaze, trialId, piece.piece_id);
      const gameRange = rowRange(tableRows.game, trialId, piece.piece_id);
      const stateRange = rowRange(tableRows.state, trialId, piece.piece_id);
      const visitRange = rowRange(tableRows.visits, trialId, piece.piece_id);
      return {
        trial_id: trialId,
        piece_id: piece.piece_id,
        gaze_start_index: gazeRange.start,
        gaze_end_index: gazeRange.end,
        gaze_count: gazeRange.count,
        game_event_start_index: gameRange.start,
        game_event_end_index: gameRange.end,
        game_event_count: gameRange.count,
        state_event_start_index: stateRange.start,
        state_event_end_index: stateRange.end,
        state_event_count: stateRange.count,
        aoi_visit_start_index: visitRange.start,
        aoi_visit_end_index: visitRange.end,
        aoi_visit_count: visitRange.count,
      };
    });
  }

  /**
 * Builds a trial-level summary row.
 *
 * Requirement links: `FR-ANA-001`, `FR-ANA-003`, `FR-ANA-004`,
 * `FR-ANA-008`, `FR-EYE-009`, and `FR-REPLAY-009`.
 * Sampling-rate and dwell metrics are computed from canonical raw/derived
 * rows so trial quality can be inspected before exporting data.
 *
 * @param {string} trialId Trial identifier.
   * @param {Record<string, unknown>[]} visits AOI visit rows.
   * @returns {Record<string, unknown> | null} Trial summary row.
   */
  buildTrialSummary(trialId, visits) {
    const trial = this.store.getRows('trials').find((row) => row.trial_id === trialId);
    if (!trial) {
      return null;
    }
    const gaze = this.store.getRows('gaze_samples').filter((row) => row.trial_id === trialId);
    const validCount = gaze.filter((row) => row.valid).length;
    const durationSeconds = Math.max(Number(trial.duration_ms || 0) / 1000, 0.001);
    const sortedGazeTimes = gaze
      .map((row) => Number(row.t_trial_ms))
      .sort((left, right) => left - right)
      .filter(Number.isFinite);
    const sampleIntervals = sortedGazeTimes
      .slice(1)
      .map((tTrialMs, index) => tTrialMs - sortedGazeTimes[index])
      .filter((interval) => Number.isFinite(interval) && interval >= 0);
    const webgazerRun = this.store.getRows('webgazer_runs').at(-1) ?? null;
    const recording = trial.recording_id
      ? this.store.getRows('trial_recordings').find((row) => row.recording_id === trial.recording_id)
      : null;
    const sortedVisits = sortVisits(visits, 'start_t_trial_ms');
    const dwellByAoi = buildDwellByAoi(visits);
    const dwellTotal = totalDwell(visits);
    return {
      trial_id: trialId,
      duration_ms: trial.duration_ms,
      score: trial.score,
      lines: trial.lines,
      pieces_count: trial.pieces_count,
      end_reason: trial.end_reason,
      observed_sampling_rate_hz: Math.round((gaze.length / durationSeconds) * 10) / 10,
      median_sample_interval_ms: median(sampleIntervals),
      valid_sample_percentage: gaze.length ? Math.round((validCount / gaze.length) * 1000) / 10 : 0,
      webgazer_brown_precision_percent: webgazerRun?.brown_precision_percent ?? null,
      webgazer_brown_precision_label: webgazerRun?.brown_precision_label ?? null,
      webgazer_brown_precision_sample_count: webgazerRun?.brown_precision_sample_count ?? null,
      webgazer_brown_precision_mean_error_px: webgazerRun?.brown_precision_mean_error_px ?? null,
      total_gaze_samples: gaze.length,
      total_aoi_visits: visits.length,
      aoi_dwell_ms: JSON.stringify(dwellByAoi),
      aoi_dwell_percent: JSON.stringify(percentMap(dwellByAoi, dwellTotal)),
      aoi_transition_count: Math.max(0, sortedVisits.length - 1),
      aoi_transition_counts: JSON.stringify(buildTransitionCounts(sortedVisits)),
      aoi_sequence: JSON.stringify(sortedVisits.map((visit) => visit.aoi)),
      recording_status: recording?.status ?? 'not_started',
    };
  }
}

/**
 * Sums dwell duration for one AOI label.
 *
 * Requirement links: `FR-ANA-003` and `FR-AOI-011`.
 * The helper is intentionally label-based because AOI dictionaries remain the
 * stable analysis vocabulary for both piece and trial summaries.
 *
 * @param {Record<string, unknown>[]} visits AOI visit rows.
 * @param {string} aoi AOI label.
 * @returns {number} Total dwell in milliseconds.
 */
function dwell(visits, aoi) {
  return visits
    .filter((visit) => visit.aoi === aoi)
    .reduce((sum, visit) => sum + Number(visit.duration_ms ?? 0), 0);
}

/**
 * Computes a before/after metric delta for piece performance linkage.
 *
 * Requirement links: `FR-ANA-007` and `FR-GAME-009`.
 * Null is preserved when a piece has not locked yet or fixture data omit a
 * metric, which keeps summaries honest during partial trials.
 *
 * @param {unknown} after Metric value after placement.
 * @param {unknown} before Metric value before placement.
 * @returns {number | null} Numeric delta or null when unavailable.
 */
function numericDelta(after, before) {
  if (after === null || after === undefined || before === null || before === undefined) {
    return null;
  }
  const parsedAfter = Number(after);
  const parsedBefore = Number(before);
  if (!Number.isFinite(parsedAfter) || !Number.isFinite(parsedBefore)) {
    return null;
  }
  return parsedAfter - parsedBefore;
}

/**
 * Computes total AOI dwell across a visit list.
 *
 * Requirement links: `FR-ANA-003` and `FR-ANA-004`.
 * The total becomes the denominator for percentage dwell fields and keeps the
 * calculation independent of raw sample counts.
 *
 * @param {Record<string, unknown>[]} visits AOI visit rows.
 * @returns {number} Total dwell in milliseconds.
 */
function totalDwell(visits) {
  return visits.reduce((sum, visit) => sum + Number(visit.duration_ms ?? 0), 0);
}

/**
 * Computes one AOI's percentage of total dwell.
 *
 * Requirement links: `FR-ANA-003` and `FR-AOI-011`.
 * Returning zero for no dwell avoids `NaN` in CSV exports and keeps missing
 * gaze data explicit through sample-quality fields instead.
 *
 * @param {Record<string, unknown>[]} visits AOI visit rows.
 * @param {string} aoi AOI label.
 * @param {number} total Total dwell denominator.
 * @returns {number} Percentage rounded to one decimal.
 */
function dwellPercent(visits, aoi, total) {
  if (!total) {
    return 0;
  }
  return round1((dwell(visits, aoi) / total) * 100);
}

/**
 * Tests whether a look occurred before or at the first action.
 *
 * Requirement links: `FR-ANA-006` and `FR-HCI-004`.
 * Missing gaze or action data becomes `false` so the summary label does not
 * imply planning evidence where no timestamp exists.
 *
 * @param {unknown} firstLookMs First look timestamp.
 * @param {unknown} firstActionMs First action timestamp.
 * @returns {boolean} True when the look preceded the action.
 */
function beforeAction(firstLookMs, firstActionMs) {
  if (firstLookMs === null || firstLookMs === undefined || firstActionMs === null || firstActionMs === undefined) {
    return false;
  }
  return Number(firstLookMs) <= Number(firstActionMs);
}

/**
 * Finds the first piece-relative visit timestamp for an AOI.
 *
 * Requirement links: `FR-ANA-002`, `FR-ANA-005`, `FR-ANA-006`,
 * and `FR-HCI-004`.
 * Piece-relative timestamps make repeated falling-piece episodes comparable
 * even when pieces spawn at different trial times.
 *
 * @param {Record<string, unknown>[]} visits AOI visit rows.
 * @param {string} aoi AOI label.
 * @returns {number | null} First piece-relative timestamp.
 */
function firstVisitTime(visits, aoi) {
  const visit = visits
    .filter((candidate) => candidate.aoi === aoi)
    .sort((left, right) => Number(left.start_t_piece_ms) - Number(right.start_t_piece_ms))[0];
  return visit?.start_t_piece_ms ?? null;
}

/**
 * Sorts AOI visits by an explicit timestamp field.
 *
 * Requirement links: `FR-ANA-004`, `FR-HCI-002`, and `FR-REPLAY-009`.
 * The caller chooses trial-relative or piece-relative ordering based on the
 * summary table being built.
 *
 * @param {Record<string, unknown>[]} visits AOI visit rows.
 * @param {string} timeField Timestamp field name.
 * @returns {Record<string, unknown>[]} Sorted visits.
 */
function sortVisits(visits, timeField) {
  return [...visits].sort((left, right) => Number(left[timeField] ?? 0) - Number(right[timeField] ?? 0));
}

/**
 * Builds a trial-level dwell map keyed by AOI label.
 *
 * Requirement links: `FR-ANA-003` and `FR-ANA-009`.
 * The map is serialized into one cell so CSV exports keep a compact
 * trial-summary row while preserving all AOI categories observed in the trial.
 *
 * @param {Record<string, unknown>[]} visits AOI visit rows.
 * @returns {Record<string, number>} Dwell milliseconds by AOI.
 */
function buildDwellByAoi(visits) {
  return visits.reduce((accumulator, visit) => {
    accumulator[visit.aoi] = (accumulator[visit.aoi] ?? 0) + Number(visit.duration_ms ?? 0);
    return accumulator;
  }, {});
}

/**
 * Converts a dwell map into percentages.
 *
 * Requirement links: `FR-ANA-003` and `FR-DATA-004`.
 * The function preserves the observed AOI keys even when total dwell is zero,
 * which keeps CSV headers and JSON cells easy to compare across trials.
 *
 * @param {Record<string, number>} dwellByAoi Dwell milliseconds by AOI.
 * @param {number} total Total dwell denominator.
 * @returns {Record<string, number>} Percent dwell by AOI.
 */
function percentMap(dwellByAoi, total) {
  if (!total) {
    return Object.fromEntries(Object.keys(dwellByAoi).map((aoi) => [aoi, 0]));
  }
  return Object.fromEntries(
    Object.entries(dwellByAoi).map(([aoi, duration]) => [aoi, round1((duration / total) * 100)]),
  );
}

/**
 * Counts ordered AOI transitions.
 *
 * Requirement links: `FR-ANA-004` and `FR-HCI-003`.
 * Consecutive visit labels are used instead of fixation algorithms so the MVP
 * sequence measure stays transparent during classroom validation.
 *
 * @param {Record<string, unknown>[]} visits Ordered AOI visit rows.
 * @returns {Record<string, number>} Transition counts keyed as `from->to`.
 */
function buildTransitionCounts(visits) {
  const counts = {};
  for (let index = 1; index < visits.length; index += 1) {
    const key = `${visits[index - 1].aoi}->${visits[index].aoi}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Computes contiguous row-range metadata for a piece.
 *
 * Requirement links: `FR-PERF-007`, `FR-HCI-001`, and `FR-HCI-002`.
 * Ranges are stored as indexes into current table order so piece-centered
 * analysis can find related gaze, event, state, and visit rows quickly.
 *
 * @param {Record<string, unknown>[]} rows Table rows.
 * @param {string} trialId Trial identifier.
 * @param {string} pieceId Piece identifier.
 * @returns {{start: number | null, end: number | null, count: number}} Row range.
 */
function rowRange(rows, trialId, pieceId) {
  const indexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.trial_id === trialId && row.piece_id === pieceId)
    .map(({ index }) => index);
  if (!indexes.length) {
    return { start: null, end: null, count: 0 };
  }
  return {
    start: Math.min(...indexes),
    end: Math.max(...indexes),
    count: indexes.length,
  };
}

/**
 * Builds the expected AOI sequence for the active trial condition.
 *
 * Requirement links: `FR-HCI-003`, `FR-GAME-012`, and `FR-GAME-013`.
 * Disabled preview or ghost features are removed from the expected sequence so
 * HCI labels do not penalize a participant for unavailable AOIs.
 *
 * @param {Record<string, unknown>} trial Trial row.
 * @returns {string[]} Expected AOI labels.
 */
function expectedAoiSequence(trial) {
  const sequence = ['active_piece'];
  if (trial.ghost_enabled !== false) {
    sequence.push('landing_zone');
  }
  sequence.push('stack_blocks');
  if (trial.preview_enabled !== false) {
    sequence.push('next_piece');
  }
  return sequence;
}

/**
 * Compares observed AOI visits with the condition-specific expected sequence.
 *
 * Requirement links: `FR-HCI-003` and `FR-HCI-005`.
 * The comparison tracks missing expected AOIs separately from order mismatch so
 * student-facing labels can distinguish incomplete scanning from a different
 * scan strategy.
 *
 * @param {Record<string, unknown>[]} visits Ordered piece AOI visits.
 * @param {string[]} expectedSequence Expected AOI labels.
 * @returns {{observedExpected: string[], missing: string[], matches: boolean}} Sequence comparison.
 */
function compareExpectedSequence(visits, expectedSequence) {
  const observedExpected = [];
  for (const visit of visits) {
    if (expectedSequence.includes(visit.aoi) && !observedExpected.includes(visit.aoi)) {
      observedExpected.push(visit.aoi);
    }
  }
  let cursor = 0;
  for (const aoi of observedExpected) {
    if (aoi === expectedSequence[cursor]) {
      cursor += 1;
    }
  }
  return {
    observedExpected,
    missing: expectedSequence.filter((aoi) => !observedExpected.includes(aoi)),
    matches: cursor === expectedSequence.length,
  };
}

/**
 * Finds the first stack look shortly after a piece locks.
 *
 * Requirement links: `FR-HCI-004`, `FR-HCI-005`, and `FR-ANA-007`.
 * The fixed window captures feedback/evaluation looks without letting much
 * later planning for a new piece count as post-lock feedback.
 *
 * @param {Record<string, unknown>} piece Piece row.
 * @param {Record<string, unknown>[]} allVisits Trial AOI visits sorted by trial time.
 * @returns {number | null} Trial-relative timestamp of the feedback look.
 */
function firstPostLockStackLook(piece, allVisits) {
  if (piece.lock_t_trial_ms === null || piece.lock_t_trial_ms === undefined) {
    return null;
  }
  const lockTime = Number(piece.lock_t_trial_ms);
  const endTime = lockTime + POST_LOCK_EVALUATION_WINDOW_MS;
  const visit = allVisits.find((candidate) => (
    candidate.aoi === 'stack_blocks' &&
    Number(candidate.start_t_trial_ms) >= lockTime &&
    Number(candidate.start_t_trial_ms) <= endTime
  ));
  return visit?.start_t_trial_ms ?? null;
}

/**
 * Produces the student-facing planning label for a piece.
 *
 * Requirement links: `FR-ANA-006`, `FR-HCI-004`, and `FR-HCI-005`.
 * The label compresses first-look and first-action timing into a readable HCI
 * interpretation while the raw timestamps remain in the same summary row.
 *
 * @param {{landingFirstLook: unknown, stackFirstLook: unknown, firstActionMs: unknown}} options Timing inputs.
 * @returns {string} Planning interpretation label.
 */
function planningInterpretation(options) {
  const lookedBeforeAction = beforeAction(options.landingFirstLook, options.firstActionMs) ||
    beforeAction(options.stackFirstLook, options.firstActionMs);
  if (lookedBeforeAction) {
    return 'planning before action';
  }
  if (options.firstActionMs !== null && options.firstActionMs !== undefined) {
    return 'action before planning look';
  }
  return 'no action observed';
}

/**
 * Produces the student-facing scan-sequence label.
 *
 * Requirement links: `FR-HCI-003` and `FR-HCI-005`.
 * The label is derived from structured comparison data so exports can support
 * both quick classroom reading and deeper analysis.
 *
 * @param {{missing: string[], matches: boolean}} expectedComparison Expected sequence comparison.
 * @returns {string} Sequence interpretation label.
 */
function sequenceInterpretation(expectedComparison) {
  if (expectedComparison.matches) {
    return 'expected scan matched';
  }
  if (expectedComparison.missing.length > 0) {
    return 'expected scan incomplete';
  }
  return 'expected scan out of order';
}

/**
 * Rounds a summary metric to one decimal place.
 *
 * Requirement links: `FR-PERF-005`, `FR-ANA-003`, and `FR-ANA-008`.
 * One-decimal reporting keeps CSV summaries compact while preserving enough
 * precision for classroom discussion.
 *
 * @param {number} value Numeric value.
 * @returns {number} Rounded value.
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Computes a rounded median for sample-interval reporting.
 *
 * Requirement links: `FR-EYE-009` and `FR-ANA-008`.
 * Median interval is less sensitive to occasional browser scheduling delays
 * than a mean interval during gaze collection.
 *
 * @param {number[]} values Numeric values.
 * @returns {number | null} Rounded median or null.
 */
function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return Math.round(sorted[middle]);
}
