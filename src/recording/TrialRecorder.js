import { DEFAULT_RECORDING_FPS } from '../constants/schema.js';

/**
 * Records the Tetris canvas for replay with gaze/AOI overlays.
 *
 * Requirement links: `FR-DATA-011`, `FR-REPLAY-003`, `FR-REPLAY-010`,
 * `FR-PERF-003A`, and `FR-PERF-004`.
 * The recorder captures only the game canvas stream. This implements the MVP
 * replay decision: video is the visual source of truth, while schema rows only
 * need enough timed AOI/gaze information to draw overlays.
 */
export class TrialRecorder {
  /**
 * Creates a canvas recorder.
 *
 * Requirement links: `FR-DATA-011` and `FR-PERF-003A`.
 * MIME preferences are ordered from richer WebM encodings to the broad fallback
 * so browser capability differences become recording metadata, not app-level
 * branching.
 *
 * @param {import('../data/SessionDataStore.js').SessionDataStore} store Canonical data store.
   * @param {{fps?: number, mimeTypes?: string[]}} options Recording options.
   */
  constructor(store, options = {}) {
    this.store = store;
    this.fps = options.fps ?? DEFAULT_RECORDING_FPS;
    this.mimeTypes = options.mimeTypes ?? [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    this.recording = null;
  }

  /**
 * Starts recording a Tetris canvas.
 *
 * Requirement links: `FR-DATA-011`, `FR-REPLAY-003`, `FR-PERF-003A`,
 * `FR-PERF-004`, and `FR-ERR-004`.
 * Unsupported browsers still receive a `trial_recordings` row so exports and
 * summaries can distinguish missing media from failed trials.
   *
   * @param {{trialId: string, canvas: HTMLCanvasElement, startTTrialMs?: number}} options Recording options.
   * @returns {Record<string, unknown>} Initial recording row.
   */
  start(options) {
    const recordingId = `recording_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const mimeType = this.chooseMimeType();
    const baseRow = {
      recording_id: recordingId,
      trial_id: options.trialId,
      file_name: `${options.trialId}_${recordingId}.webm`,
      mime_type: mimeType ?? 'video/webm',
      source: 'tetris_canvas_capture_stream',
      width_px: options.canvas.width,
      height_px: options.canvas.height,
      target_fps: this.fps,
      start_t_trial_ms: options.startTTrialMs ?? 0,
      end_t_trial_ms: null,
      duration_ms: null,
      video_time_origin_ms: options.startTTrialMs ?? 0,
      status: 'not_started',
      error: null,
    };

    if (!options.canvas.captureStream || !globalThis.MediaRecorder || !mimeType) {
      const row = this.store.addRow('trial_recordings', {
        ...baseRow,
        status: 'unsupported',
        error: 'canvas.captureStream or MediaRecorder is unavailable.',
      });
      this.recording = { row, unsupported: true };
      return row;
    }

    try {
      const stream = options.canvas.captureStream(this.fps);
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) {
          chunks.push(event.data);
        }
      });
      const row = this.store.addRow('trial_recordings', { ...baseRow, status: 'not_started' });
      recorder.start();
      this.recording = { row, recorder, chunks, stream, mimeType };
      return row;
    } catch (error) {
      const row = this.store.addRow('trial_recordings', {
        ...baseRow,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      this.recording = { row, failed: true };
      return row;
    }
  }

  /**
 * Stops the active recording and stores its blob.
 *
 * Requirement links: `FR-DATA-011`, `FR-REPLAY-001`, `FR-REPLAY-009`,
 * and `FR-PERF-006`.
 * The final row records trial-relative duration while the blob stays separate
 * from JSON so replay can use local object URLs and export can save WebM files.
 *
 * @param {{endTTrialMs: number}} options End timing options.
   * @returns {Promise<{row: Record<string, unknown>, blob: Blob | null, url: string | null}>} Final recording result.
   */
  async stop(options) {
    if (!this.recording) {
      return { row: null, blob: null, url: null };
    }
    if (this.recording.unsupported || this.recording.failed || !this.recording.recorder) {
      const row = this.updateRecordingRow(this.recording.row.recording_id, {
        end_t_trial_ms: options.endTTrialMs,
        duration_ms: Math.max(0, options.endTTrialMs - Number(this.recording.row.start_t_trial_ms ?? 0)),
      });
      return { row, blob: null, url: null };
    }

    const { recorder, chunks, stream, mimeType, row } = this.recording;
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        resolve();
      }
    });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    const blob = new Blob(chunks, { type: mimeType });
    const url = this.store.setMediaBlob(row.recording_id, blob);
    const updatedRow = this.updateRecordingRow(row.recording_id, {
      end_t_trial_ms: options.endTTrialMs,
      duration_ms: Math.max(0, options.endTTrialMs - Number(row.start_t_trial_ms ?? 0)),
      status: 'recorded',
      error: null,
    });
    return { row: updatedRow, blob, url };
  }

  /**
 * Chooses the first supported WebM MIME type.
 *
 * Requirement links: `FR-DEP-004`, `FR-DATA-011`, and `FR-ERR-004`.
 * Feature detection happens before `MediaRecorder` construction so unsupported
 * browsers take the explicit metadata path instead of throwing during start.
 *
 * @returns {string | null} Supported MIME type.
   */
  chooseMimeType() {
    if (!globalThis.MediaRecorder) {
      return null;
    }
    return this.mimeTypes.find((type) => MediaRecorder.isTypeSupported?.(type) ?? type === 'video/webm') ?? null;
  }

  /**
 * Updates one `trial_recordings` row.
 *
 * Requirement links: `FR-DATA-011`, `FR-ANA-001`, and `FR-ERR-004`.
 * Updating through the store keeps recording status codes and CSV headers
 * aligned with the canonical schema.
 *
 * @param {string} recordingId Recording identifier.
   * @param {Record<string, unknown>} updates Row updates.
   * @returns {Record<string, unknown> | null} Updated row.
   */
  updateRecordingRow(recordingId, updates) {
    return this.store.updateFirst(
      'trial_recordings',
      (row) => row.recording_id === recordingId,
      (row) => ({ ...row, ...updates }),
    );
  }
}
