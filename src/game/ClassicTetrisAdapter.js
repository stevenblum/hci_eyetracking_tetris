import { AoiBuilder } from '../aoi/AoiBuilder.js';
import { AnalysisBuilder } from '../analysis/AnalysisBuilder.js';
import { pieceTime, trialTime } from '../utils/clock.js';
import { GAME_EVENTS } from '../vendor/classic-tetris-js/classic-tetris.instrumented.js';

const LISTENED_EVENTS = [
  GAME_EVENTS.GAME_START,
  GAME_EVENTS.GAME_OVER,
  GAME_EVENTS.GAME_PAUSE,
  GAME_EVENTS.GAME_RESUME,
  GAME_EVENTS.PIECE_MOVE_LEFT,
  GAME_EVENTS.PIECE_MOVE_RIGHT,
  GAME_EVENTS.PIECE_MOVE_DOWN,
  GAME_EVENTS.PIECE_GRAVITY_DROP,
  GAME_EVENTS.PIECE_HARD_DROP,
  GAME_EVENTS.PIECE_ROTATE_CLOCKWISE,
  GAME_EVENTS.PIECE_ROTATE_ANTICLOCKWISE,
  GAME_EVENTS.PIECE_LOCK,
  GAME_EVENTS.NEXT_PIECE,
  GAME_EVENTS.LINE_CLEAR,
  GAME_EVENTS.KEYDOWN,
  'trial_end',
];

/**
 * Converts instrumented Tetris events into canonical experiment rows.
 *
 * Requirement links: `FR-GAME-005` through `FR-GAME-011`,
 * `FR-AOI-007`, `FR-EXP-007`, `FR-EXP-008`, `FR-PERF-002`,
 * and `FR-PERF-006`.
 * The adapter is the boundary between game implementation details and research
 * data. It records one current schema only, closes AOI intervals as the state
 * changes, and preserves end reasons for later analysis.
 */
export class ClassicTetrisAdapter {
  /**
 * Creates an adapter around a Tetris instance and data store.
 *
 * Requirement links: `FR-GAME-001`, `FR-DATA-001`, and `FR-AOI-007`.
 * Counters are kept here rather than in the game so schema identifiers remain
 * owned by the experiment instrumentation layer.
 *
 * @param {{game: import('../vendor/classic-tetris-js/classic-tetris.instrumented.js').ClassicTetris, store: import('../data/SessionDataStore.js').SessionDataStore, canvas: HTMLCanvasElement, aoiBuilder?: AoiBuilder, trialStartMs?: number}} options Adapter options.
   */
  constructor(options) {
    this.game = options.game;
    this.store = options.store;
    this.canvas = options.canvas;
    this.aoiBuilder = options.aoiBuilder ?? new AoiBuilder();
    this.trialStartMs = options.trialStartMs ?? performance.now();
    this.trialId = null;
    this.pieceSpawnTimes = new Map();
    this.pieceMetricsBefore = new Map();
    this.currentLayoutId = null;
    this.stateEventCounter = 0;
    this.aoiStateCounter = 0;
    this.started = false;
    this.handleEvent = this.handleEvent.bind(this);
  }

  /**
 * Starts a canonical trial and attaches event listeners.
 *
 * Requirement links: `FR-EXP-003`, `FR-EXP-007`, `FR-GAME-004`,
 * `FR-GAME-012`, and `FR-GAME-013`.
 * The adapter records trial configuration from the actual game instance so the
 * schema describes the running condition rather than only the requested UI
 * options.
 *
 * @param {{participantId?: string, condition?: string, trialMode?: string, levelStart?: number, durationLimitMs?: number, gazeSamplingIntervalMs?: number}} options Trial metadata.
   * @returns {Record<string, unknown>} Created trial row.
   */
  startTrial(options = {}) {
    const trial = this.store.startTrial({
      ...options,
      fallIntervalMs: this.game.tickMs,
      boardCols: this.game.boardCols,
      boardVisibleRows: this.game.visibleRows,
      cellSizePx: this.game.cellSize,
      previewEnabled: this.game.previewEnabled,
      ghostEnabled: this.game.ghostEnabled,
    });
    this.trialId = trial.trial_id;
    this.started = true;
    this.trialStartMs = performance.now();
    for (const eventName of LISTENED_EVENTS) {
      this.game.on(eventName, this.handleEvent);
    }
    return trial;
  }

  /**
 * Detaches event listeners after the formal trial ends.
 *
 * Requirement links: `FR-PERF-001` and `FR-PERF-002`.
 * Removing listeners prevents stale game instances from writing duplicate rows
 * after a trial has been finalized.
 */
  detach() {
    for (const eventName of LISTENED_EVENTS) {
      this.game.off(eventName, this.handleEvent);
    }
  }

  /**
 * Handles a single instrumented game event.
 *
 * Requirement links: `FR-GAME-007`, `FR-GAME-011`, `FR-AOI-007`,
 * `FR-PERF-002`, and `FR-PERF-006`.
 * Each game event updates at most the canonical rows needed for that moment:
 * raw game events, state snapshots, piece lifecycle rows, and AOI intervals.
   *
   * @param {Record<string, unknown>} payload Instrumented Tetris event payload.
   */
  handleEvent(payload) {
    if (!this.started || !this.trialId) {
      return;
    }
    const state = payload.state ?? this.game.getExperimentState();
    const tTrialMs = trialTime(this.trialStartMs);
    const spawnTime = this.pieceSpawnTimes.get(state.experimentPieceId);
    const tPieceMs = pieceTime(spawnTime, tTrialMs);

    if (payload.eventType === GAME_EVENTS.NEXT_PIECE) {
      this.recordPieceSpawn(state, tTrialMs);
    }

    this.recordGameEvent(payload, state, tTrialMs, tPieceMs);

    if (state.experimentPieceId) {
      this.recordStateEvent(payload.eventType, state, tTrialMs);
      if (payload.eventType === GAME_EVENTS.PIECE_LOCK) {
        this.closeOpenAois(tTrialMs, state.experimentPieceId);
        this.recordPieceLock(payload, state, tTrialMs);
        return;
      }
      this.captureAois(state, tTrialMs);
    }
  }

  /**
 * Finishes the current trial, closes intervals, and writes summaries.
 *
 * Requirement links: `FR-EXP-005`, `FR-EXP-008`, `FR-ANA-001`,
 * `FR-ANA-002`, `FR-AOI-010`, and `FR-PERF-006`.
 * Finishing owns the transition from event logging to deferred analysis so
 * derived rows are based on closed AOI intervals and final trial metadata.
 *
 * @param {{endReason: string, recordingId?: string | null, durationMs?: number}} options End-state options.
   * @returns {Record<string, unknown> | null} Updated trial row.
   */
  finishTrial(options) {
    if (!this.trialId) {
      return null;
    }
    const state = this.game.getExperimentState();
    const durationMs = options.durationMs ?? trialTime(this.trialStartMs);
    this.closeOpenAois(durationMs);
    const updatedTrial = this.store.finishTrial(this.trialId, {
      durationMs,
      endReason: options.endReason,
      score: state.score,
      lines: state.lines,
      piecesCount: this.store.getRows('pieces').filter((piece) => piece.trial_id === this.trialId).length,
      recordingId: options.recordingId ?? null,
    });
    const analysis = new AnalysisBuilder(this.store);
    analysis.buildForTrial(this.trialId);
    this.detach();
    this.started = false;
    return updatedTrial;
  }

  /**
 * Records a new piece lifecycle row.
 *
 * Requirement links: `FR-GAME-005`, `FR-GAME-006`, `FR-GAME-009`,
 * `FR-GAME-012`, and `FR-HCI-001`.
 * Before-placement board metrics are captured at spawn so later summaries can
 * connect visual planning to the outcome of the same piece episode.
 *
 * @param {Record<string, unknown>} state Experiment state after spawn.
   * @param {number} tTrialMs Trial time.
   */
  recordPieceSpawn(state, tTrialMs) {
    const metrics = normalizedBoardMetrics(state.boardMetrics);
    this.pieceSpawnTimes.set(state.experimentPieceId, tTrialMs);
    this.pieceMetricsBefore.set(state.experimentPieceId, metrics);
    this.store.addRow('pieces', {
      trial_id: this.trialId,
      piece_id: state.experimentPieceId,
      piece_type: state.pieceType,
      piece_index: state.pieceIndex,
      spawn_t_trial_ms: tTrialMs,
      lock_t_trial_ms: null,
      duration_ms: null,
      spawn_col: state.col,
      spawn_row: state.row,
      spawn_rotation: state.rotation,
      lock_col: null,
      lock_row: null,
      lock_rotation: null,
      hard_drop_used: false,
      lines_cleared: 0,
      score_delta: 0,
      board_height_before: metrics.height,
      board_height_after: null,
      aggregate_height_before: metrics.aggregateHeight,
      aggregate_height_after: null,
      bumpiness_before: metrics.bumpiness,
      bumpiness_after: null,
      holes_before: metrics.holes,
      holes_after: null,
    });
  }

  /**
 * Records a game event row.
 *
 * Requirement links: `FR-GAME-007`, `FR-GAME-011`, `FR-PERF-002`,
 * and `FR-DATA-006`.
 * Raw event rows preserve accepted/rejected keyboard actions and compact JSON
 * details without forcing every event type into a wider schema.
 *
 * @param {Record<string, unknown>} payload Instrumented event payload.
   * @param {Record<string, unknown>} state Current experiment state.
   * @param {number} tTrialMs Trial time.
   * @param {number | null} tPieceMs Piece time.
   */
  recordGameEvent(payload, state, tTrialMs, tPieceMs) {
    this.store.addRow('game_events', {
      trial_id: this.trialId,
      piece_id: state.experimentPieceId,
      t_trial_ms: tTrialMs,
      t_piece_ms: tPieceMs,
      event_type: payload.eventType,
      key: payload.key ?? null,
      piece_type: state.pieceType,
      col: state.col,
      row: state.row,
      rotation: state.rotation,
      score_after: state.score,
      lines_after: state.lines,
      accepted: payload.accepted ?? true,
      details: JSON.stringify({
        action: payload.action ?? null,
        endReason: payload.endReason ?? null,
        linesCleared: payload.linesCleared ?? null,
        distance: payload.distance ?? null,
      }),
    });
  }

  /**
 * Records a piece state event for AOI and replay alignment.
 *
 * Requirement links: `FR-GAME-006`, `FR-GAME-007`, `FR-AOI-007`,
 * `FR-REPLAY-009`, and `FR-HCI-002`.
 * State rows are event-based, not frame-based, so gameplay stays responsive
 * while replay and analysis still have each piece transition.
 *
 * @param {string} eventSource Source event label.
   * @param {Record<string, unknown>} state Current experiment state.
   * @param {number} tTrialMs Trial time.
   */
  recordStateEvent(eventSource, state, tTrialMs) {
    const spawnTime = this.pieceSpawnTimes.get(state.experimentPieceId);
    const metrics = normalizedBoardMetrics(state.boardMetrics);
    this.stateEventCounter += 1;
    this.store.addRow('piece_state_events', {
      trial_id: this.trialId,
      piece_id: state.experimentPieceId,
      t_trial_ms: tTrialMs,
      t_piece_ms: pieceTime(spawnTime, tTrialMs),
      state_event_id: `state_${this.stateEventCounter}`,
      piece_type: state.pieceType,
      col: state.col,
      row: state.row,
      rotation: state.rotation,
      ghost_col: state.ghostCol,
      ghost_row: state.ghostRow,
      score: state.score,
      lines: state.lines,
      board_height: metrics.height,
      board_aggregate_height: metrics.aggregateHeight,
      board_bumpiness: metrics.bumpiness,
      holes: metrics.holes,
      event_source: eventSource,
    });
  }

  /**
 * Records the lock time and outcome metrics for a piece.
 *
 * Requirement links: `FR-GAME-010`, `FR-ANA-007`, and `FR-HCI-002`.
 * Lock updates complete the piece episode with outcome metrics while retaining
 * the spawn-time baseline captured in `recordPieceSpawn`.
 *
 * @param {Record<string, unknown>} payload Lock event payload.
   * @param {Record<string, unknown>} state State at lock event.
   * @param {number} tTrialMs Trial time.
   */
  recordPieceLock(payload, state, tTrialMs) {
    const spawnTime = this.pieceSpawnTimes.get(state.experimentPieceId) ?? tTrialMs;
    const metricsBefore = normalizedBoardMetrics(this.pieceMetricsBefore.get(state.experimentPieceId));
    const metricsAfter = normalizedBoardMetrics(state.boardMetrics);
    this.store.updateFirst(
      'pieces',
      (piece) => piece.trial_id === this.trialId && piece.piece_id === state.experimentPieceId,
      (piece) => ({
        ...piece,
        lock_t_trial_ms: tTrialMs,
        duration_ms: Math.max(0, tTrialMs - spawnTime),
        lock_col: state.col,
        lock_row: state.row,
        lock_rotation: state.rotation,
        hard_drop_used: payload.hardDrop === true || piece.hard_drop_used === true,
        lines_cleared: payload.linesCleared ?? 0,
        score_delta: Math.max(0, state.score - Number(piece.score_delta ?? 0)),
        board_height_before: metricsBefore.height,
        board_height_after: metricsAfter.height,
        aggregate_height_before: metricsBefore.aggregateHeight,
        aggregate_height_after: metricsAfter.aggregateHeight,
        bumpiness_before: metricsBefore.bumpiness,
        bumpiness_after: metricsAfter.bumpiness,
        holes_before: metricsBefore.holes,
        holes_after: metricsAfter.holes,
      }),
    );
  }

  /**
 * Captures and stores AOI rectangles for the current state interval.
 *
 * Requirement links: `FR-AOI-001` through `FR-AOI-007`,
 * `FR-UI-007`, `FR-REPLAY-005`, and `FR-REPLAY-009`.
 * Layout rows are written only when geometry changes; AOI snapshots are written
 * on state transitions so gaze classification can use interval validity later.
 *
 * @param {Record<string, unknown>} state Current experiment state.
   * @param {number} tTrialMs Trial time.
   */
  captureAois(state, tTrialMs) {
    const spawnTime = this.pieceSpawnTimes.get(state.experimentPieceId);
    const tPieceMs = pieceTime(spawnTime, tTrialMs);
    const layout = this.aoiBuilder.captureLayout({
      canvas: this.canvas,
      state,
      trialId: this.trialId,
      tTrialMs,
    });
    if (layout.layout_id !== this.currentLayoutId) {
      this.currentLayoutId = layout.layout_id;
      this.store.addRow('layout', layout);
    }
    this.closeOpenAois(tTrialMs, state.experimentPieceId);
    const sourceState = this.store.getLastRow('piece_state_events');
    const aois = this.aoiBuilder.buildAois({ state, layout });
    for (const aoi of aois) {
      this.aoiStateCounter += 1;
      this.store.addRow('aoi_snapshots', {
        aoi_state_id: `aoi_state_${this.aoiStateCounter}`,
        trial_id: this.trialId,
        piece_id: state.experimentPieceId,
        valid_from_t_trial_ms: tTrialMs,
        valid_to_t_trial_ms: null,
        valid_from_t_piece_ms: tPieceMs,
        valid_to_t_piece_ms: null,
        layout_id: layout.layout_id,
        aoi: aoi.aoi,
        x: aoi.x,
        y: aoi.y,
        w: aoi.w,
        h: aoi.h,
        priority: aoi.priority,
        source: aoi.source,
        source_state_id: sourceState?.state_event_id ?? null,
      });
    }
  }

  /**
 * Closes currently open AOI intervals.
 *
 * Requirement links: `FR-AOI-007`, `FR-AOI-010`, and `FR-REPLAY-009`.
 * Open intervals use `null` end times while active, then receive trial- and
 * piece-relative end times when the next state or trial end occurs.
 *
 * @param {number} closeTTrialMs Trial time used as interval end.
   * @param {string | null} pieceId Optional piece filter.
   */
  closeOpenAois(closeTTrialMs, pieceId = null) {
    this.store.updateAll(
      'aoi_snapshots',
      (row) => row.trial_id === this.trialId && row.valid_to_t_trial_ms === null && (!pieceId || row.piece_id === pieceId),
      (row) => ({
        ...row,
        valid_to_t_trial_ms: closeTTrialMs,
        valid_to_t_piece_ms:
          row.valid_from_t_piece_ms === null ? null : Math.max(row.valid_from_t_piece_ms, closeTTrialMs - row.valid_from_t_trial_ms + row.valid_from_t_piece_ms),
      }),
    );
  }
}

/**
 * Normalizes optional board metrics to the current schema's numeric fields.
 *
 * Requirement links: `FR-GAME-009`, `FR-GAME-010`, and `FR-ANA-007`.
 * Older partial state objects in tests can omit aggregate height or bumpiness;
 * this helper prevents those omissions from creating inconsistent row shapes.
 *
 * @param {Record<string, unknown>} metrics Raw game board metrics.
 * @returns {{height: number, aggregateHeight: number, bumpiness: number, holes: number}} Normalized metrics.
 */
function normalizedBoardMetrics(metrics = {}) {
  return {
    height: Number(metrics.height ?? 0),
    aggregateHeight: Number(metrics.aggregateHeight ?? 0),
    bumpiness: Number(metrics.bumpiness ?? 0),
    holes: Number(metrics.holes ?? 0),
  };
}
