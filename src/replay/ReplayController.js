/**
 * Legend labels for replay AOI and gaze overlays.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-REPLAY-005`, `FR-UI-008`,
 * and `FR-HCI-005`.
 * The exported constant keeps legend rendering and overlay color mapping on
 * the same AOI vocabulary as the analysis tables.
 */
export const REPLAY_LEGEND_ITEMS = [
  { aoi: 'active_piece', label: 'Falling piece' },
  { aoi: 'landing_zone', label: 'Ghost block' },
  { aoi: 'stack_blocks', label: 'Placed stack' },
  { aoi: 'next_piece', label: 'Next block' },
  { aoi: 'score_panel', label: 'Score' },
  { aoi: 'danger_zone', label: 'Danger zone' },
  { aoi: 'board', label: 'Board' },
  { aoi: 'gaze_point', label: 'Current gaze' },
  { aoi: 'gaze_trail', label: 'Previous gaze trail' },
];

/**
 * Controls replay video and draws gaze/AOI overlays.
 *
 * Requirement links: `FR-REPLAY-001` through `FR-REPLAY-010`,
 * `FR-AOI-007`, `FR-AOI-008`, and `FR-HCI-002`.
 * Replay uses the screen recording as the visual base and maps stored viewport
 * AOI/gaze coordinates into the current video overlay canvas using the trial's
 * captured layout row.
 */
export class ReplayController {
  /**
 * Creates a replay controller.
 *
 * Requirement links: `FR-REPLAY-002`, `FR-REPLAY-006`, and `FR-REPLAY-007`.
 * DOM event listeners live with the controller so the UI only has to create the
 * replay surface and pass current session data.
 *
 * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, video: HTMLVideoElement, overlay: HTMLCanvasElement, scrub?: HTMLInputElement, pieceSelect?: HTMLSelectElement, trailSelect?: HTMLSelectElement, details?: HTMLElement, previousGazeCount?: number}} options Replay DOM options.
   */
  constructor(options) {
    this.store = options.store;
    this.video = options.video;
    this.overlay = options.overlay;
    this.scrub = options.scrub;
    this.pieceSelect = options.pieceSelect;
    this.trailSelect = options.trailSelect;
    this.details = options.details;
    this.previousGazeCount = Number.isFinite(Number(options.previousGazeCount))
      ? Number(options.previousGazeCount)
      : 5;
    this.trialId = null;
    this.animation = null;
    this.handleTimeUpdate = this.handleTimeUpdate.bind(this);
    this.video.addEventListener('timeupdate', this.handleTimeUpdate);
    this.video.addEventListener('loadedmetadata', this.handleTimeUpdate);
    this.scrub?.addEventListener('input', () => {
      this.video.currentTime = Number(this.scrub.value) / 1000;
      this.draw();
    });
    this.pieceSelect?.addEventListener('change', () => this.jumpToPiece(this.pieceSelect.value));
    this.trailSelect?.addEventListener('change', () => {
      this.setPreviousGazeCount(Number(this.trailSelect.value));
    });
  }

  /**
 * Updates the replay gaze trail length.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-EYE-006`, and `FR-UI-008`.
 * The trail is configurable because researchers may want only the current
 * point for timing checks or several prior samples for scan-path inspection.
 *
 * @param {number} count Number of prior gaze samples to retain.
 */
  setPreviousGazeCount(count) {
    const allowed = [0, 1, 3, 5, 10];
    this.previousGazeCount = allowed.includes(Number(count)) ? Number(count) : 5;
    if (this.trailSelect) {
      this.trailSelect.value = String(this.previousGazeCount);
    }
    this.draw();
  }

  /**
 * Loads a trial into the replay surface.
 *
 * Requirement links: `FR-REPLAY-001`, `FR-REPLAY-003`, and `FR-DATA-011`.
 * A missing object URL leaves the video blank but still allows imported JSON
 * metadata to populate controls and details when media is unavailable.
 *
 * @param {string} trialId Trial identifier.
   * @returns {Record<string, unknown> | null} Recording row when available.
   */
  loadTrial(trialId) {
    this.trialId = trialId;
    const trial = this.store.getRows('trials').find((row) => row.trial_id === trialId);
    const recording = trial?.recording_id
      ? this.store.getRows('trial_recordings').find((row) => row.recording_id === trial.recording_id)
      : null;
    const url = recording ? this.store.getMediaUrl(recording.recording_id) : null;
    if (url) {
      this.video.src = url;
    } else {
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.populatePieces();
    this.resizeOverlay();
    this.draw();
    return recording ?? null;
  }

  /**
 * Jumps video playback to a piece spawn timestamp.
 *
 * Requirement links: `FR-REPLAY-006` and `FR-HCI-002`.
 * Piece navigation uses stored spawn time rather than game reconstruction,
 * preserving the recording-based replay design.
 *
 * @param {string} pieceId Piece identifier.
   */
  jumpToPiece(pieceId) {
    const piece = this.store
      .getRows('pieces')
      .find((row) => row.trial_id === this.trialId && row.piece_id === pieceId);
    if (!piece) {
      return;
    }
    this.video.currentTime = Number(piece.spawn_t_trial_ms ?? 0) / 1000;
    this.draw();
  }

  /**
 * Draws the overlay at the current video time.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-REPLAY-005`,
 * `FR-REPLAY-007`, and `FR-REPLAY-009`.
 * Video time is converted to trial-relative milliseconds once, then shared by
 * AOI, gaze, scrub, and details updates.
 */
  draw() {
    this.resizeOverlay();
    const ctx = this.overlay.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.trialId) {
      return;
    }
    const tTrialMs = Math.round((this.video.currentTime || 0) * 1000);
    this.drawAois(ctx, tTrialMs);
    this.drawGaze(ctx, tTrialMs);
    this.updateDetails(tTrialMs);
    if (this.scrub) {
      this.scrub.value = String(tTrialMs);
      this.scrub.max = String(Math.max(tTrialMs, Math.round((this.video.duration || 0) * 1000)));
    }
  }

  /**
 * Handles video timeline updates.
 *
 * Requirement links: `FR-REPLAY-002` and `FR-REPLAY-009`.
 * The browser's media clock drives overlay redraws so the replay stays
 * synchronized during native controls as well as custom controls.
 */
  handleTimeUpdate() {
    this.draw();
  }

  /**
 * Resizes the overlay canvas to match the visible replay element.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-REPLAY-005`, and `FR-UI-007`.
 * Overlay backing pixels follow the rendered video area so viewport-coordinate
 * mapping remains stable across responsive layouts.
 */
  resizeOverlay() {
    const rect = this.overlay.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || this.video.clientWidth || 500));
    const height = Math.max(1, Math.round(rect.height || this.video.clientHeight || 620));
    if (this.overlay.width !== width || this.overlay.height !== height) {
      this.overlay.width = width;
      this.overlay.height = height;
    }
  }

  /**
 * Draws AOI rectangles active at the replay timestamp.
 *
 * Requirement links: `FR-REPLAY-005`, `FR-AOI-007`, and `FR-AOI-009`.
 * Lower-priority broad AOIs are drawn first so task-specific rectangles remain
 * visible on top.
 *
 * @param {CanvasRenderingContext2D} ctx Overlay context.
   * @param {number} tTrialMs Trial timestamp.
   */
  drawAois(ctx, tTrialMs) {
    const active = this.store
      .getRows('aoi_snapshots')
      .filter((row) => row.trial_id === this.trialId)
      .filter((row) => tTrialMs >= row.valid_from_t_trial_ms)
      .filter((row) => row.valid_to_t_trial_ms === null || tTrialMs < row.valid_to_t_trial_ms)
      .sort((left, right) => Number(left.priority) - Number(right.priority));
    for (const snapshot of active) {
      const rect = this.mapRect(snapshot);
      ctx.strokeStyle = colorForAoi(snapshot.aoi);
      ctx.lineWidth = snapshot.aoi === 'active_piece' ? 3 : 1.5;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = colorForAoi(snapshot.aoi, 0.08);
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /**
 * Draws the current gaze sample and configurable previous-sample trail.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-EYE-006`, `FR-EYE-007`,
 * and `FR-EYE-008`.
 * The app does not yet derive fixation events, so replay uses the latest valid
 * gaze sample at or before the video timestamp as the current fixation-like
 * marker and draws the selected number of prior valid samples as a scan trail.
 *
 * @param {CanvasRenderingContext2D} ctx Overlay context.
   * @param {number} tTrialMs Trial timestamp.
   */
  drawGaze(ctx, tTrialMs) {
    const samples = this.store
      .getRows('gaze_samples')
      .filter((row) => row.trial_id === this.trialId && row.valid)
      .filter((row) => Number(row.t_trial_ms) <= tTrialMs)
      .sort((left, right) => Number(left.t_trial_ms) - Number(right.t_trial_ms));
    if (!samples.length) {
      return;
    }
    const current = samples.at(-1);
    const previous = samples.slice(
      Math.max(0, samples.length - 1 - this.previousGazeCount),
      Math.max(0, samples.length - 1),
    );
    const trailPoints = previous.map((sample) => this.mapPoint(sample));
    const currentPoint = this.mapPoint(current);
    this.drawGazeTrail(ctx, [...trailPoints, currentPoint]);
    trailPoints.forEach((point) => drawReplayGazePoint(ctx, point, {
      fill: colorForAoi('gaze_trail', 0.86),
      radius: 5.5,
      stroke: 'rgba(8, 13, 18, 0.78)',
      lineWidth: 1.5,
    }));
    drawReplayGazePoint(ctx, currentPoint, {
      fill: colorForAoi('gaze_point', 0.95),
      radius: 8,
      stroke: 'rgba(255, 255, 255, 0.92)',
      lineWidth: 2,
    });
  }

  /**
 * Draws the connecting line through replay gaze trail points.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-EYE-006`, and `FR-HCI-002`.
 * Connecting prior samples makes scan movement visible without introducing a
 * separate fixation-detection algorithm during this MVP pass.
 *
 * @param {CanvasRenderingContext2D} ctx Overlay context.
 * @param {{x: number, y: number}[]} points Trail points from oldest to newest.
 */
  drawGazeTrail(ctx, points) {
    if (points.length < 2) {
      return;
    }
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.strokeStyle = colorForAoi('gaze_trail', 0.68);
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /**
 * Maps a viewport gaze point into replay overlay coordinates.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-REPLAY-009`, and `FR-AOI-007`.
 * Gaze and AOIs are stored in browser viewport pixels, so replay subtracts the
 * captured canvas origin and scales to the current video overlay.
 *
 * @param {{x: number, y: number}} point Viewport point.
   * @returns {{x: number, y: number}} Overlay point.
   */
  mapPoint(point) {
    const layout = this.getReferenceLayout();
    if (!layout) {
      return { x: point.x, y: point.y };
    }
    return {
      x: ((point.x - layout.canvas_x) / layout.canvas_w) * this.overlay.width,
      y: ((point.y - layout.canvas_y) / layout.canvas_h) * this.overlay.height,
    };
  }

  /**
 * Maps a viewport AOI rectangle into replay overlay coordinates.
 *
 * Requirement links: `FR-REPLAY-005` and `FR-REPLAY-009`.
 * Mapping both corners keeps scaled rectangles accurate even when the replay
 * surface uses a different CSS size from the original trial canvas.
 *
 * @param {{x: number, y: number, w: number, h: number}} rect Viewport rectangle.
   * @returns {{x: number, y: number, w: number, h: number}} Overlay rectangle.
   */
  mapRect(rect) {
    const topLeft = this.mapPoint({ x: rect.x, y: rect.y });
    const bottomRight = this.mapPoint({ x: rect.x + rect.w, y: rect.y + rect.h });
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
  }

  /**
 * Returns the first layout row for coordinate normalization.
 *
 * Requirement links: `FR-AOI-007` and `FR-REPLAY-009`.
 * The MVP assumes the play layout is stable during a trial; if later pilots
 * need moving layouts, this can become timestamp-aware.
 *
 * @returns {Record<string, unknown> | null} Layout row.
   */
  getReferenceLayout() {
    return this.store.getRows('layout').find((row) => row.trial_id === this.trialId) ?? null;
  }

  /**
 * Populates piece jump navigation.
 *
 * Requirement links: `FR-REPLAY-006`, `FR-HCI-001`, and `FR-HCI-002`.
 * The select is built from canonical `pieces` rows so imported sessions and
 * active sessions use the same navigation behavior.
 */
  populatePieces() {
    if (!this.pieceSelect) {
      return;
    }
    const pieces = this.store.getRows('pieces').filter((row) => row.trial_id === this.trialId);
    this.pieceSelect.innerHTML = pieces
      .map((piece) => `<option value="${piece.piece_id}">${piece.piece_index}: ${piece.piece_type}</option>`)
      .join('');
  }

  /**
 * Returns synchronized replay details for the current timestamp.
 *
 * Requirement links: `FR-REPLAY-007`, `FR-REPLAY-008`,
 * `FR-REPLAY-009`, and `FR-HCI-002`.
 * This supports participant self-review without reconstructing gameplay:
 * piece, gaze AOI, action, and outcome are all read from canonical rows
   * already aligned to the trial-relative recording clock.
   *
   * @param {number} tTrialMs Trial timestamp.
   * @returns {Record<string, unknown>} Current replay details.
   */
  getPieceDetails(tTrialMs) {
    const piece = this.currentPieceAt(tTrialMs);
    if (!piece) {
      return {
        piece_id: 'None',
        piece_type: '',
        elapsed_piece_ms: '',
        current_aoi: '',
        current_action: '',
        placement_outcome: '',
      };
    }
    const visit = this.store
      .getRows('aoi_visits')
      .filter((row) => row.trial_id === this.trialId && row.piece_id === piece.piece_id)
      .find((row) => tTrialMs >= Number(row.start_t_trial_ms) && tTrialMs <= Number(row.end_t_trial_ms));
    const action = this.store
      .getRows('game_events')
      .filter((row) => row.trial_id === this.trialId && row.piece_id === piece.piece_id)
      .filter((row) => Number(row.t_trial_ms) <= tTrialMs)
      .sort((left, right) => Number(right.t_trial_ms) - Number(left.t_trial_ms))[0];
    const elapsedPieceMs = Math.max(0, tTrialMs - Number(piece.spawn_t_trial_ms ?? tTrialMs));
    return {
      piece_id: piece.piece_id,
      piece_type: piece.piece_type,
      elapsed_piece_ms: elapsedPieceMs,
      current_aoi: visit?.aoi ?? '',
      current_action: action?.event_type ?? '',
      placement_outcome: placementOutcome(piece, tTrialMs),
    };
  }

  /**
 * Updates the replay details panel when present.
 *
 * Requirement links: `FR-REPLAY-007`, `FR-REPLAY-008`, and `FR-HCI-005`.
 * Details are rendered from escaped canonical values because imported sessions
 * can contain participant-entered text or file-provided JSON.
 *
 * @param {number} tTrialMs Trial timestamp.
   */
  updateDetails(tTrialMs) {
    if (!this.details) {
      return;
    }
    const details = this.getPieceDetails(tTrialMs);
    this.details.innerHTML = `
      <dl class="facts compact">
        <div><dt>Piece</dt><dd>${escapeHtml(details.piece_id)} ${escapeHtml(details.piece_type)}</dd></div>
        <div><dt>Elapsed</dt><dd>${formatDetail(details.elapsed_piece_ms, ' ms')}</dd></div>
        <div><dt>AOI</dt><dd>${escapeHtml(details.current_aoi || 'None')}</dd></div>
        <div><dt>Action</dt><dd>${escapeHtml(details.current_action || 'None')}</dd></div>
        <div><dt>Outcome</dt><dd>${escapeHtml(details.placement_outcome || 'Pending')}</dd></div>
      </dl>
    `;
  }

  /**
 * Finds the piece episode active at a replay timestamp.
 *
 * Requirement links: `FR-HCI-001`, `FR-HCI-002`, and `FR-REPLAY-006`.
 * If no piece is currently active, the nearest previous piece remains useful
 * for explaining post-lock outcome details during replay.
 *
 * @param {number} tTrialMs Trial timestamp.
   * @returns {Record<string, unknown> | null} Active or most recent piece.
   */
  currentPieceAt(tTrialMs) {
    const pieces = this.store.getRows('pieces').filter((row) => row.trial_id === this.trialId);
    return pieces.find((piece) => {
      const spawn = Number(piece.spawn_t_trial_ms ?? 0);
      const lock = piece.lock_t_trial_ms === null || piece.lock_t_trial_ms === undefined
        ? Number.POSITIVE_INFINITY
        : Number(piece.lock_t_trial_ms);
      return tTrialMs >= spawn && tTrialMs <= lock;
    }) ?? pieces
      .filter((piece) => Number(piece.spawn_t_trial_ms ?? 0) <= tTrialMs)
      .sort((left, right) => Number(right.spawn_t_trial_ms ?? 0) - Number(left.spawn_t_trial_ms ?? 0))[0] ?? null;
  }
}

/**
 * Returns the replay overlay color for an AOI label.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-REPLAY-005`, and `FR-UI-008`.
 * The legend and canvas drawing share this mapping so color meanings stay
 * aligned as the MVP AOI categories change.
 *
 * @param {string} aoi AOI label.
 * @param {number} alpha CSS alpha value.
 * @returns {string} CSS rgba color.
 */
export function colorForAoi(aoi, alpha = 0.88) {
  const colors = {
    active_piece: `rgba(255, 235, 59, ${alpha})`,
    landing_zone: `rgba(100, 221, 230, ${alpha})`,
    stack_blocks: `rgba(126, 211, 132, ${alpha})`,
    next_piece: `rgba(255, 159, 67, ${alpha})`,
    score_panel: `rgba(210, 180, 255, ${alpha})`,
    danger_zone: `rgba(255, 82, 82, ${alpha})`,
    board: `rgba(220, 230, 240, ${alpha})`,
    gaze_point: `rgba(255, 42, 42, ${alpha})`,
    gaze_trail: `rgba(45, 126, 255, ${alpha})`,
  };
  return colors[aoi] ?? `rgba(255, 255, 255, ${alpha})`;
}

/**
 * Draws one replay gaze marker.
 *
 * Requirement links: `FR-REPLAY-004` and `FR-EYE-006`.
 * Current and prior samples share marker geometry but use different colors and
 * sizes, so this helper keeps the red current point and blue trail consistent.
 *
 * @param {CanvasRenderingContext2D} ctx Overlay context.
 * @param {{x: number, y: number}} point Overlay point.
 * @param {{fill: string, radius: number, stroke: string, lineWidth: number}} style Marker style.
 */
function drawReplayGazePoint(ctx, point, style) {
  ctx.beginPath();
  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.lineWidth;
  ctx.arc(point.x, point.y, style.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/**
 * Formats a piece placement outcome for the replay details panel.
 *
 * Requirement links: `FR-REPLAY-007`, `FR-GAME-010`, and `FR-ANA-007`.
 * Outcomes remain pending until the replay time reaches lock time so the
 * details panel mirrors the participant's temporal experience.
 *
 * @param {Record<string, unknown>} piece Piece row.
 * @param {number} tTrialMs Trial timestamp.
 * @returns {string} Outcome text.
 */
function placementOutcome(piece, tTrialMs) {
  if (piece.lock_t_trial_ms === null || piece.lock_t_trial_ms === undefined || tTrialMs < Number(piece.lock_t_trial_ms)) {
    return 'Pending';
  }
  return `locked col ${piece.lock_col}, row ${piece.lock_row}; lines ${piece.lines_cleared}; holes ${piece.holes_before}->${piece.holes_after}`;
}

/**
 * Formats optional replay detail values.
 *
 * Requirement links: `FR-REPLAY-007` and `FR-HCI-005`.
 * Empty values stay empty rather than rendering `null` so the panel remains
 * readable while still escaping any present value.
 *
 * @param {unknown} value Detail value.
 * @param {string} suffix Optional suffix.
 * @returns {string} Escaped detail text.
 */
function formatDetail(value, suffix = '') {
  if (value === '' || value === null || value === undefined) {
    return '';
  }
  return `${escapeHtml(String(value))}${suffix}`;
}

/**
 * Escapes text inserted into replay details markup.
 *
 * Requirement links: `FR-REPLAY-001` and `FR-LAB-001`.
 * Imported session files are local but still untrusted DOM input, so details
 * rendering escapes canonical values before inserting them as HTML.
 *
 * @param {unknown} value Value to escape.
 * @returns {string} Escaped HTML text.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
