import { AoiBuilder } from '../aoi/AoiBuilder.js';
import { ClassicTetrisAdapter } from '../game/ClassicTetrisAdapter.js';
import { TrialRecorder } from '../recording/TrialRecorder.js';
import { trialTime } from '../utils/clock.js';
import { ClassicTetris, GAME_EVENTS } from '../vendor/classic-tetris-js/classic-tetris.instrumented.js';
import { WebGazerBridge } from './WebGazerBridge.js';
import { WEBGAZER_SAMPLING_INTERVAL_MS } from '../constants/schema.js';

/**
 * Coordinates one jsPsych-style Tetris eye-tracking trial.
 *
 * Requirement links: `FR-EXP-001`, `FR-EXP-003`, `FR-EXP-005`,
 * `FR-EXP-007`, `FR-EXP-008`, `FR-EYE-005`, `FR-DATA-011`,
 * and `FR-PERF-001`.
 * The runner is framework-light on purpose: it provides the custom trial
 * behavior the jsPsych timeline needs while remaining easy to test with mocked
 * gaze and recording APIs.
 */
export class JsPsychTetrisTrialRunner {
  /**
 * Creates a trial runner.
 *
 * Requirement links: `FR-EXP-003`, `FR-GAME-012`, `FR-GAME-013`,
 * `FR-EYE-001`, and `FR-PERF-003A`.
 * The runner composes game, adapter, recorder, and WebGazer bridge rather than
 * letting any one module own the whole experiment lifecycle.
 *
 * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, canvas: HTMLCanvasElement, durationMs?: number, trialMode?: 'practice' | 'main', fallIntervalMs?: number, previewEnabled?: boolean, ghostEnabled?: boolean, gazeMode?: 'mock' | 'real' | 'auto', recordingFps?: number, webgazerBridge?: WebGazerBridge, webgazerDisplayElement?: HTMLElement, onStatus?: (text: string) => void, onComplete?: (trial: Record<string, unknown>) => void}} options Runner options.
   */
  constructor(options) {
    this.store = options.store;
    this.canvas = options.canvas;
    this.durationMs = options.durationMs ?? 90_000;
    this.trialMode = options.trialMode ?? 'main';
    this.fallIntervalMs = options.fallIntervalMs ?? 650;
    this.previewEnabled = options.previewEnabled ?? true;
    this.ghostEnabled = options.ghostEnabled ?? true;
    this.gazeMode = options.gazeMode ?? 'mock';
    this.onStatus = options.onStatus ?? (() => {});
    this.onComplete = options.onComplete ?? (() => {});
    // Trial configuration is passed into the game at construction so the
    // rendered display, emitted state, AOIs, and exported trial metadata all
    // describe the same condition.
    this.game = new ClassicTetris(this.canvas, {
      tickMs: this.fallIntervalMs,
      previewEnabled: this.previewEnabled,
      ghostEnabled: this.ghostEnabled,
    });
    this.adapter = new ClassicTetrisAdapter({
      game: this.game,
      store: this.store,
      canvas: this.canvas,
      aoiBuilder: new AoiBuilder(),
    });
    this.recorder = new TrialRecorder(this.store, { fps: options.recordingFps });
    this.webgazer = options.webgazerBridge ?? new WebGazerBridge({ mode: this.gazeMode });
    this.webgazerDisplayElement = options.webgazerDisplayElement;
    this.timeoutId = null;
    this.finished = false;
    this.finalizeFromGame = this.finalizeFromGame.bind(this);
  }

  /**
 * Starts the formal trial.
 *
 * Requirement links: `FR-EXP-005`, `FR-EXP-007`, `FR-EYE-005`,
 * `FR-EYE-006`, `FR-DATA-011`, `FR-PERF-003`, and `FR-PERF-003A`.
 * Start order is deliberate: create trial metadata, begin canvas recording,
 * then start gaze sampling before gameplay so all streams share the same
 * trial-relative clock.
 *
 * @param {{participantId?: string, levelStart?: number, condition?: string}} options Trial metadata.
   * @returns {Promise<Record<string, unknown>>} Created trial row.
   */
  async start(options = {}) {
    this.finished = false;
    this.game.setStartLevel(options.levelStart ?? 0);
    const trial = this.adapter.startTrial({
      ...options,
      trialMode: this.trialMode,
      durationLimitMs: this.durationMs,
      gazeSamplingIntervalMs: WEBGAZER_SAMPLING_INTERVAL_MS,
    });
    this.trialId = trial.trial_id;
    this.game.on(GAME_EVENTS.GAME_OVER, this.finalizeFromGame);
    this.game.on('trial_end', this.finalizeFromGame);
    const recording = this.recorder.start({
      trialId: this.trialId,
      canvas: this.canvas,
      startTTrialMs: 0,
    });
    this.store.updateFirst(
      'trials',
      (row) => row.trial_id === this.trialId,
      (row) => ({ ...row, recording_id: recording.recording_id }),
    );
    try {
      await this.webgazer.start({
        store: this.store,
        trialId: this.trialId,
        trialStartMs: this.adapter.trialStartMs,
        getCurrentContext: () => this.getCurrentContext(),
        mode: this.gazeMode,
        displayElement: this.webgazerDisplayElement,
      });
    } catch (error) {
      const durationMs = trialTime(this.adapter.trialStartMs);
      const recordingResult = await this.recorder.stop({ endTTrialMs: durationMs });
      const failedTrial = this.adapter.finishTrial({
        endReason: 'webgazer_error',
        durationMs,
        recordingId: recordingResult.row?.recording_id ?? null,
      });
      this.onStatus(`WebGazer unavailable; eye-tracking data cannot be collected for this trial: ${error instanceof Error ? error.message : String(error)}`);
      this.onComplete(failedTrial);
      throw error;
    }
    this.game.start();
    this.timeoutId = setTimeout(() => {
      this.onStatus('Trial timeout reached.');
      this.game.forceStop({ endReason: 'timeout' });
    }, this.durationMs);
    this.onStatus(`Trial ${this.trialId} running.`);
    return trial;
  }

  /**
 * Pauses gameplay.
 *
 * Requirement links: `FR-GAME-011` and `FR-PERF-001`.
 * Pause is a trial-control action, not an end reason, so recording and gaze
 * streams remain attached.
 */
  pause() {
    this.game.pause();
    this.onStatus('Trial paused.');
  }

  /**
 * Resumes gameplay.
 *
 * Requirement links: `FR-GAME-011` and `FR-PERF-001`.
 * Resuming delegates to the game so the adapter observes the emitted event and
 * can preserve the same event-based log as keyboard controls.
 */
  resume() {
    this.game.resume();
    this.onStatus('Trial running.');
  }

  /**
 * Stops the trial manually.
 *
 * Requirement links: `FR-EXP-008` and `FR-GAME-011`.
 * Manual quit funnels through `forceStop` so the controlled end reason reaches
 * game events, trial metadata, and final analysis consistently.
 */
  quit() {
    this.game.forceStop({ endReason: 'quit' });
  }

  /**
 * Finalizes a game-triggered end.
 *
 * Requirement links: `FR-EXP-005`, `FR-EXP-008`, and `FR-GAME-013`.
 * Game over, timeout, and manual trial-end events use the same finalization
 * path so recording, gaze, and analysis are stopped exactly once.
 *
 * @param {{endReason?: string}} payload Game end payload.
   */
  async finalizeFromGame(payload = {}) {
    await this.finish(payload.endReason ?? 'game_over');
  }

  /**
 * Stops recording/gaze and writes final trial summaries.
 *
 * Requirement links: `FR-EXP-008`, `FR-DATA-008`, `FR-DATA-011`,
 * `FR-ANA-001`, `FR-PERF-006`, and `FR-ERR-005`.
 * Finish stops high-rate streams before analysis so no new gaze rows arrive
 * while AOI visits and summaries are being derived.
 *
 * @param {string} endReason Canonical end reason.
   * @returns {Promise<Record<string, unknown> | null>} Updated trial row.
   */
  async finish(endReason) {
    if (this.finished) {
      return null;
    }
    this.finished = true;
    clearTimeout(this.timeoutId);
    this.webgazer.stop();
    const durationMs = trialTime(this.adapter.trialStartMs);
    const recordingResult = await this.recorder.stop({ endTTrialMs: durationMs });
    const recordingId = recordingResult.row?.recording_id ?? null;
    const trial = this.adapter.finishTrial({
      endReason,
      durationMs,
      recordingId,
    });
    this.game.off(GAME_EVENTS.GAME_OVER, this.finalizeFromGame);
    this.game.off('trial_end', this.finalizeFromGame);
    await this.store.saveBackup().catch(() => {});
    this.onStatus(`Trial ended: ${endReason}.`);
    this.onComplete(trial);
    return trial;
  }

  /**
 * Returns current piece and canvas context for gaze row normalization.
 *
 * Requirement links: `FR-EYE-006`, `FR-EYE-007`, `FR-HCI-002`,
 * and `FR-REPLAY-009`.
 * The WebGazer bridge asks for context at sample time so gaze rows can include
 * the active piece and piece-relative timestamp without the bridge knowing game
 * internals.
 *
 * @returns {{pieceId: string | null, pieceSpawnTTrialMs: number | null, canvasRect: DOMRect}} Context object.
   */
  getCurrentContext() {
    const state = this.game.getExperimentState();
    const piece = this.store
      .getRows('pieces')
      .find((candidate) => candidate.trial_id === this.trialId && candidate.piece_id === state.experimentPieceId);
    return {
      pieceId: state.experimentPieceId ?? null,
      pieceSpawnTTrialMs: piece?.spawn_t_trial_ms ?? null,
      canvasRect: this.canvas.getBoundingClientRect(),
    };
  }
}
