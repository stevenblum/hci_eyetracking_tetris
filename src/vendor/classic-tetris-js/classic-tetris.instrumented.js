/**
 * Canonical game event labels emitted by the instrumented Tetris fork.
 *
 * Requirement links: `FR-GAME-007`, `FR-GAME-011`, `FR-EXP-008`,
 * `FR-PERF-002`, and `FR-DATA-006`.
 * These labels match schema dictionary values so the adapter can write events
 * without translating third-party names.
 */
export const GAME_EVENTS = {
  GAME_START: 'game_start',
  GAME_OVER: 'game_over',
  GAME_PAUSE: 'pause',
  GAME_RESUME: 'resume',
  PIECE_MOVE_LEFT: 'move_left',
  PIECE_MOVE_RIGHT: 'move_right',
  PIECE_MOVE_DOWN: 'soft_drop',
  PIECE_GRAVITY_DROP: 'gravity_drop',
  PIECE_HARD_DROP: 'hard_drop',
  PIECE_ROTATE_CLOCKWISE: 'rotate_clockwise',
  PIECE_ROTATE_ANTICLOCKWISE: 'rotate_counterclockwise',
  PIECE_LOCK: 'piece_lock',
  NEXT_PIECE: 'piece_spawn',
  LINE_CLEAR: 'line_clear',
  KEYDOWN: 'keydown',
};

/**
 * Tetromino definitions used for rendering, state, and piece-type coding.
 *
 * Requirement links: `FR-GAME-001`, `FR-GAME-005`, and `FR-DATA-006`.
 * Matrices stay local and deterministic so the experiment can derive active
 * cells, ghost cells, and board metrics from the same shape source.
 */
const PIECES = {
  I: {
    color: '#27b7ff',
    matrix: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  },
  J: {
    color: '#356bff',
    matrix: [
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
  },
  L: {
    color: '#ff9b2f',
    matrix: [
      [0, 0, 1],
      [1, 1, 1],
      [0, 0, 0],
    ],
  },
  O: {
    color: '#ffd447',
    matrix: [
      [1, 1],
      [1, 1],
    ],
  },
  S: {
    color: '#4fc16a',
    matrix: [
      [0, 1, 1],
      [1, 1, 0],
      [0, 0, 0],
    ],
  },
  T: {
    color: '#a16bff',
    matrix: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
  },
  Z: {
    color: '#f35d5d',
    matrix: [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 0],
    ],
  },
};

const DEFAULT_KEYS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowDown: 'softDrop',
  ArrowUp: 'rotateClockwise',
  Space: 'hardDrop',
  KeyZ: 'rotateCounterclockwise',
  KeyP: 'pause',
  Escape: 'quit',
};

const SCORE_BY_LINES = [0, 100, 300, 500, 800];

/**
 * Runs a compact, instrumented classic Tetris game on a canvas.
 *
 * Requirement links: `FR-GAME-001` through `FR-GAME-013`,
 * `FR-UI-003`, `FR-UI-007`, `FR-UI-009`, and `FR-PERF-001`.
 * This local fork exposes explicit experiment state, piece IDs, visible/hidden
 * board transforms, and forced stop behavior so the jsPsych trial can collect
 * canonical rows without depending on a third-party package changing internals.
 */
export class ClassicTetris {
  /**
 * Creates a keyboard-only Tetris instance.
 *
 * Requirement links: `FR-GAME-001`, `FR-GAME-003`, `FR-GAME-004`,
 * `FR-GAME-011`, `FR-GAME-012`, and `FR-GAME-013`.
 * Canvas geometry is fixed in game-local pixels; the AOI builder later maps it
 * to the rendered CSS size for gaze alignment.
 *
 * @param {HTMLCanvasElement} canvas Canvas used for gameplay rendering.
   * @param {{boardCols?: number, internalRows?: number, hiddenRows?: number, cellSize?: number, tickMs?: number, previewEnabled?: boolean, ghostEnabled?: boolean, random?: () => number}} options Game options.
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.boardCols = options.boardCols ?? 10;
    this.internalRows = options.internalRows ?? 22;
    this.hiddenRows = options.hiddenRows ?? 2;
    this.visibleRows = this.internalRows - this.hiddenRows;
    this.cellSize = options.cellSize ?? 24;
    this.boardLeft = options.boardLeft ?? 42;
    this.boardVisibleTop = options.boardVisibleTop ?? 44;
    this.boardInternalTop = this.boardVisibleTop - this.hiddenRows * this.cellSize;
    this.nextBox = options.nextBox ?? { x: 322, y: 74, w: 118, h: 118 };
    this.scoreBox = options.scoreBox ?? { x: 318, y: 222, w: 142, h: 120 };
    this.tickMs = options.tickMs ?? 650;
    this.previewEnabled = options.previewEnabled ?? true;
    this.ghostEnabled = options.ghostEnabled ?? true;
    this.random = options.random ?? Math.random;
    this.listeners = new Map();
    this.keys = { ...DEFAULT_KEYS, ...(options.keys ?? {}) };
    this.levelStart = 0;
    this.resetState();
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  /**
 * Registers a game event listener.
 *
 * Requirement links: `FR-GAME-007`, `FR-PERF-002`, and `FR-DATA-001`.
 * The adapter subscribes to these events to create schema rows without polling
 * the full game state every frame.
 *
 * @param {string} eventName Event key from `GAME_EVENTS`.
   * @param {(payload: Record<string, unknown>) => void} listener Listener callback.
   */
  on(eventName, listener) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  /**
 * Removes a game event listener.
 *
 * Requirement links: `FR-PERF-001` and `FR-PERF-002`.
 * Listener removal keeps finalized trials from receiving events from stale game
 * instances.
 *
 * @param {string} eventName Event key from `GAME_EVENTS`.
   * @param {(payload: Record<string, unknown>) => void} listener Listener callback.
   */
  off(eventName, listener) {
    this.listeners.get(eventName)?.delete(listener);
  }

  /**
 * Sets the starting level for a later trial.
 *
 * Requirement links: `FR-EXP-003` and `FR-EXP-007`.
 * Level is applied at trial start so trial metadata and game speed describe the
 * same configured condition.
 *
 * @param {number} level Non-negative level.
   */
  setStartLevel(level) {
    this.levelStart = Math.max(0, Number(level) || 0);
    this.level = this.levelStart;
  }

  /**
 * Starts a new game and enables keyboard controls.
 *
 * Requirement links: `FR-EXP-005`, `FR-GAME-001`, `FR-GAME-011`,
 * and `FR-PERF-001`.
 * Start resets runtime state and emits `game_start` before the first piece so
 * the adapter has an explicit beginning for event-based logging.
 *
 * @returns {Record<string, unknown>} Initial experiment state.
   */
  start() {
    this.stopLoop();
    this.resetState();
    this.status = 'running';
    this.level = this.levelStart;
    window.addEventListener('keydown', this.handleKeyDown, { passive: false });
    this.emit(GAME_EVENTS.GAME_START, { endReason: null });
    this.spawnPiece();
    this.loop = setInterval(() => this.stepGravity(), this.tickMs);
    this.draw();
    return this.getExperimentState();
  }

  /**
 * Pauses the game without ending the trial.
 *
 * Requirement links: `FR-GAME-011`, `FR-PERF-001`, and `FR-PERF-002`.
 * Pausing stops gravity but emits an event so the trial log records the control
 * action without closing the trial.
 */
  pause() {
    if (this.status !== 'running') {
      return;
    }
    this.status = 'paused';
    this.stopLoop();
    this.emit(GAME_EVENTS.GAME_PAUSE, {});
    this.draw();
  }

  /**
 * Resumes a paused game.
 *
 * Requirement links: `FR-GAME-011`, `FR-PERF-001`, and `FR-PERF-002`.
 * Resume restarts gravity with the configured tick interval and emits a state
 * transition for analysis/replay alignment.
 */
  resume() {
    if (this.status !== 'paused') {
      return;
    }
    this.status = 'running';
    this.loop = setInterval(() => this.stepGravity(), this.tickMs);
    this.emit(GAME_EVENTS.GAME_RESUME, {});
    this.draw();
  }

  /**
 * Toggles between running and paused states.
 *
 * Requirement links: `FR-GAME-011`.
 * The keyboard handler delegates pause toggling here so accepted key logging is
 * separated from state transition behavior.
 */
  togglePlayPause() {
    if (this.status === 'paused') {
      this.resume();
    } else {
      this.pause();
    }
  }

  /**
 * Ends the game as a manual quit.
 *
 * Requirement links: `FR-EXP-008` and `FR-GAME-011`.
 * Manual quit uses the same forced-stop pathway as timeout and experimenter
 * stops so end reasons stay controlled.
 */
  quit() {
    this.forceStop({ endReason: 'quit' });
  }

  /**
 * Ends gameplay immediately with a specific end reason.
 *
 * Requirement links: `FR-EXP-005`, `FR-EXP-008`, `FR-GAME-011`,
 * and `FR-PERF-002`.
 * The adapter depends on this method to distinguish natural game over,
 * timeout, manual quit, and runtime error rows in the canonical `trials`
   * table.
   *
   * @param {{endReason?: string}} options Stop reason.
   */
  forceStop(options = {}) {
    if (this.status === 'ended') {
      return;
    }
    const endReason = options.endReason ?? 'quit';
    this.status = 'ended';
    this.stopLoop();
    window.removeEventListener('keydown', this.handleKeyDown);
    this.endReason = endReason;
    this.emit(endReason === 'game_over' ? GAME_EVENTS.GAME_OVER : 'trial_end', { endReason });
    this.draw();
  }

  /**
 * Applies a keyboard code to the current piece.
 *
 * Requirement links: `FR-GAME-011`, `FR-PERF-002`, and `FR-UI-009`.
 * Every formal key emits a `keydown` event before movement so rejected inputs
 * and pause/quit controls remain visible in the data.
 *
 * @param {KeyboardEvent | {code: string, preventDefault?: () => void}} event Keyboard event.
   * @returns {boolean} True when the key is part of the formal control map.
   */
  handleKeyDown(event) {
    const action = this.keys[event.code];
    if (!action) {
      return false;
    }
    event.preventDefault?.();
    this.emit(GAME_EVENTS.KEYDOWN, {
      key: event.code,
      action,
      accepted: this.status === 'running' || action === 'pause' || action === 'quit',
    });
    if (action === 'pause') {
      this.togglePlayPause();
      return true;
    }
    if (action === 'quit') {
      this.quit();
      return true;
    }
    if (this.status !== 'running') {
      return true;
    }
    const actions = {
      left: () => this.move(-1, 0, GAME_EVENTS.PIECE_MOVE_LEFT),
      right: () => this.move(1, 0, GAME_EVENTS.PIECE_MOVE_RIGHT),
      softDrop: () => this.softDrop(),
      rotateClockwise: () => this.rotate(1, GAME_EVENTS.PIECE_ROTATE_CLOCKWISE),
      rotateCounterclockwise: () => this.rotate(-1, GAME_EVENTS.PIECE_ROTATE_ANTICLOCKWISE),
      hardDrop: () => this.hardDrop(),
    };
    actions[action]?.();
    return true;
  }

  /**
 * Returns the current experiment state in stable field names.
 *
 * Requirement links: `FR-GAME-002`, `FR-GAME-006`, `FR-GAME-008`,
 * `FR-GAME-009`, `FR-AOI-002` through `FR-AOI-007`, and `FR-REPLAY-009`.
 * The adapter consumes this object as the single boundary between gameplay
 * internals and the canonical schema.
 *
 * @returns {Record<string, unknown>} State used by adapter, AOI, replay, and tests.
   */
  getExperimentState() {
    const activeCells = this.getActivePieceCells();
    const ghostCells = this.getGhostPieceCells();
    return {
      status: this.status,
      endReason: this.endReason,
      experimentPieceId: this.experimentPieceId,
      pieceIndex: this.pieceIndex,
      pieceType: this.currentPiece?.type ?? null,
      nextPieceType: this.nextPiece?.type ?? null,
      col: this.currentPosition.col,
      row: this.currentPosition.row,
      rotation: this.currentRotation,
      ghostCol: this.currentPosition.col,
      ghostRow: ghostCells.length ? Math.min(...ghostCells.map((cell) => cell.row)) : null,
      activeCells,
      ghostCells,
      board: this.getFullBoard(),
      visibleBoard: this.getVisibleBoard(),
      score: this.score,
      lines: this.lines,
      level: this.level,
      fallIntervalMs: this.tickMs,
      previewEnabled: this.previewEnabled,
      ghostEnabled: this.ghostEnabled,
      boardMetrics: computeBoardMetrics(this.board, this.hiddenRows),
      layout: this.getLayout(),
    };
  }

  /**
 * Returns current active piece cells in internal board coordinates.
 *
 * Requirement links: `FR-AOI-003`, `FR-GAME-006`, and `FR-HCI-002`.
 * Internal coordinates include hidden rows so spawn movement is represented
 * correctly before AOI clipping removes cells outside the visible board.
 *
 * @returns {{col: number, row: number}[]} Occupied cells for the active piece.
   */
  getActivePieceCells() {
    if (!this.currentPiece) {
      return [];
    }
    return matrixCells(this.currentPiece.matrix).map((cell) => ({
      col: this.currentPosition.col + cell.col,
      row: this.currentPosition.row + cell.row,
    }));
  }

  /**
 * Returns ghost piece cells in internal board coordinates.
 *
 * Requirement links: `FR-GAME-013`, `FR-AOI-004`, and `FR-HCI-004`.
 * The ghost calculation mirrors collision rules, giving landing-zone AOIs the
 * same projected placement the participant sees.
 *
 * @returns {{col: number, row: number}[]} Projected landing cells.
   */
  getGhostPieceCells() {
    if (!this.currentPiece || !this.ghostEnabled) {
      return [];
    }
    let row = this.currentPosition.row;
    while (!this.collides(this.currentPiece.matrix, this.currentPosition.col, row + 1)) {
      row += 1;
    }
    return matrixCells(this.currentPiece.matrix).map((cell) => ({
      col: this.currentPosition.col + cell.col,
      row: row + cell.row,
    }));
  }

  /**
 * Returns a copy of the visible board without hidden rows.
 *
 * Requirement links: `FR-GAME-008`, `FR-AOI-005`, and `FR-AOI-006`.
 * AOI and analysis code use visible rows because participants cannot inspect
 * hidden spawn rows.
 *
 * @returns {(string | null)[][]} Visible board cells.
   */
  getVisibleBoard() {
    return this.board.slice(this.hiddenRows).map((row) => [...row]);
  }

  /**
 * Returns a copy of the full internal board including hidden rows.
 *
 * Requirement links: `FR-GAME-002`, `FR-GAME-008`, and `FR-GAME-009`.
 * Full board state remains available for collision and metrics while exports
 * can still distinguish visible-board AOIs.
 *
 * @returns {(string | null)[][]} Internal board cells.
   */
  getFullBoard() {
    return this.board.map((row) => [...row]);
  }

  /**
 * Returns the canvas layout needed to align game AOIs with gaze coordinates.
 *
 * Requirement links: `FR-UI-007`, `FR-AOI-001`, `FR-AOI-007`,
 * and `FR-REPLAY-009`.
 * Values are canvas-local here because the AOI builder is responsible for
 * mapping them to viewport coordinates at capture time.
 *
 * @returns {Record<string, number>} Layout values in canvas-local pixels.
 */
  getLayout() {
    return {
      boardInternalTopPx: this.boardInternalTop,
      boardVisibleTopPx: this.boardVisibleTop,
      boardLeftPx: this.boardLeft,
      cellSizePx: this.cellSize,
      hiddenRows: this.hiddenRows,
      internalBoardRows: this.internalRows,
      visibleBoardRows: this.visibleRows,
      boardCols: this.boardCols,
      nextBoxX: this.nextBox.x,
      nextBoxY: this.nextBox.y,
      nextBoxW: this.nextBox.w,
      nextBoxH: this.nextBox.h,
      scoreBoxX: this.scoreBox.x,
      scoreBoxY: this.scoreBox.y,
      scoreBoxW: this.scoreBox.w,
      scoreBoxH: this.scoreBox.h,
    };
  }

  /**
   * Resets game-state fields before a trial starts.
   *
   * Requirement links: `FR-GAME-002`, `FR-GAME-005`, and `FR-GAME-008`.
   * Resetting creates a new next piece immediately so the first spawn follows
   * the same piece queue path as every later piece.
   */
  resetState() {
    this.board = Array.from({ length: this.internalRows }, () => Array(this.boardCols).fill(null));
    this.currentPiece = null;
    this.nextPiece = makePiece(this.pickPieceType());
    this.currentPosition = { col: 3, row: 0 };
    this.currentRotation = 0;
    this.experimentPieceId = null;
    this.pieceIndex = 0;
    this.score = 0;
    this.lines = 0;
    this.level = this.levelStart;
    this.status = 'idle';
    this.endReason = null;
    this.loop = null;
  }

  /**
   * Emits an instrumented event with a safe state snapshot.
   *
   * Requirement links: `FR-GAME-007`, `FR-GAME-011`, and `FR-PERF-002`.
   * State is captured at emit time so the adapter can write event and state rows
   * without reading game internals separately for each listener.
   *
   * @param {string} eventName Canonical event label.
   * @param {Record<string, unknown>} payload Event-specific payload.
   */
  emit(eventName, payload) {
    const eventPayload = {
      eventType: eventName,
      state: this.getExperimentStateSafe(),
      ...payload,
    };
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(eventPayload);
    }
    for (const listener of this.listeners.get('*') ?? []) {
      listener(eventPayload);
    }
  }

  /**
   * Returns experiment state even when no active piece exists.
   *
   * Requirement links: `FR-GAME-006`, `FR-GAME-007`, and `FR-EXP-008`.
   * Game start, pause, and end events can occur outside an active piece episode,
   * so event logging still needs a schema-compatible state object.
   *
   * @returns {Record<string, unknown>} State object safe for event emission.
   */
  getExperimentStateSafe() {
    if (!this.currentPiece) {
      return {
        status: this.status,
        endReason: this.endReason,
        experimentPieceId: this.experimentPieceId,
        pieceIndex: this.pieceIndex,
        pieceType: null,
        nextPieceType: this.nextPiece?.type ?? null,
        col: this.currentPosition.col,
        row: this.currentPosition.row,
        rotation: this.currentRotation,
        ghostCol: null,
        ghostRow: null,
        activeCells: [],
        ghostCells: [],
        board: this.getFullBoard(),
        visibleBoard: this.getVisibleBoard(),
        score: this.score,
        lines: this.lines,
        level: this.level,
        fallIntervalMs: this.tickMs,
        previewEnabled: this.previewEnabled,
        ghostEnabled: this.ghostEnabled,
        boardMetrics: computeBoardMetrics(this.board, this.hiddenRows),
        layout: this.getLayout(),
      };
    }
    return this.getExperimentState();
  }

  /**
   * Advances the piece queue and emits the next piece event.
   *
   * Requirement links: `FR-GAME-005`, `FR-GAME-006`, `FR-GAME-012`,
   * and `FR-EXP-005`.
   * Sequential `piece_n` IDs are assigned here because the game is the only
   * place that knows exactly when a piece becomes active.
   */
  spawnPiece() {
    this.currentPiece = this.nextPiece;
    this.nextPiece = makePiece(this.pickPieceType());
    this.currentPosition = { col: Math.floor(this.boardCols / 2) - 2, row: 0 };
    this.currentRotation = 0;
    this.pieceIndex += 1;
    this.experimentPieceId = `piece_${this.pieceIndex}`;
    if (this.collides(this.currentPiece.matrix, this.currentPosition.col, this.currentPosition.row)) {
      this.forceStop({ endReason: 'game_over' });
      return;
    }
    this.emit(GAME_EVENTS.NEXT_PIECE, {});
  }

  /**
   * Advances the active piece by one gravity tick.
   *
   * Requirement links: `FR-GAME-007`, `FR-PERF-001`, and `FR-PERF-002`.
   * Gravity emits the same movement/state pathway as participant actions so
   * AOI intervals update when the piece falls automatically.
   */
  stepGravity() {
    if (this.status !== 'running') {
      return;
    }
    if (!this.move(0, 1, GAME_EVENTS.PIECE_GRAVITY_DROP)) {
      this.lockPiece();
    }
  }

  /**
   * Attempts a piece translation and emits the result.
   *
   * Requirement links: `FR-GAME-007`, `FR-GAME-011`, and `FR-PERF-002`.
   * Rejected moves are emitted with `accepted: false` so input behavior can be
   * analyzed without inferring collisions later.
   *
   * @param {number} deltaCol Column delta.
   * @param {number} deltaRow Row delta.
   * @param {string} eventName Canonical movement event.
   * @returns {boolean} True when the move was accepted.
   */
  move(deltaCol, deltaRow, eventName) {
    const nextCol = this.currentPosition.col + deltaCol;
    const nextRow = this.currentPosition.row + deltaRow;
    const accepted = !this.collides(this.currentPiece.matrix, nextCol, nextRow);
    if (accepted) {
      this.currentPosition = { col: nextCol, row: nextRow };
      this.draw();
    }
    if (eventName) {
      this.emit(eventName, { accepted });
    }
    return accepted;
  }

  /**
   * Applies participant-controlled downward movement.
   *
   * Requirement links: `FR-GAME-007`, `FR-GAME-011`, and `FR-GAME-010`.
   * A blocked soft drop locks the piece through the same outcome path as
   * gravity to keep placement rows consistent.
   */
  softDrop() {
    if (!this.move(0, 1, GAME_EVENTS.PIECE_MOVE_DOWN)) {
      this.lockPiece();
    } else {
      this.score += 1;
    }
  }

  /**
   * Attempts a rotation with small horizontal wall kicks.
   *
   * Requirement links: `FR-GAME-006`, `FR-GAME-007`, and `FR-GAME-011`.
   * The simple kick list keeps rotations usable near walls while still being
   * deterministic and easy to explain in lab validation.
   *
   * @param {number} direction Positive for clockwise, negative for counterclockwise.
   * @param {string} eventName Canonical rotation event.
   * @returns {boolean} True when the rotation was accepted.
   */
  rotate(direction, eventName) {
    const rotated = rotateMatrix(this.currentPiece.matrix, direction);
    const kicks = [0, -1, 1, -2, 2];
    let accepted = false;
    for (const kick of kicks) {
      if (!this.collides(rotated, this.currentPosition.col + kick, this.currentPosition.row)) {
        this.currentPiece = { ...this.currentPiece, matrix: rotated };
        this.currentPosition.col += kick;
        this.currentRotation = (this.currentRotation + (direction > 0 ? 1 : 3)) % 4;
        accepted = true;
        break;
      }
    }
    this.emit(eventName, { accepted });
    this.draw();
    return accepted;
  }

  /**
   * Drops the active piece to its landing row and locks it.
   *
   * Requirement links: `FR-GAME-007`, `FR-GAME-010`, `FR-GAME-011`,
   * and `FR-HCI-002`.
   * Distance is emitted as event detail so action intensity is available without
   * replaying collision checks during analysis.
   */
  hardDrop() {
    let distance = 0;
    while (!this.collides(this.currentPiece.matrix, this.currentPosition.col, this.currentPosition.row + 1)) {
      this.currentPosition.row += 1;
      distance += 1;
    }
    this.score += distance * 2;
    this.emit(GAME_EVENTS.PIECE_HARD_DROP, { accepted: true, distance });
    this.lockPiece({ hardDrop: true });
  }

  /**
   * Commits the active piece to the board and records placement effects.
   *
   * Requirement links: `FR-GAME-008`, `FR-GAME-010`, `FR-GAME-012`,
   * and `FR-ANA-007`.
   * Line clears are emitted before the lock event so the adapter sees score and
   * board metrics that reflect the final placement.
   *
   * @param {{hardDrop?: boolean}} options Placement options.
   */
  lockPiece(options = {}) {
    for (const cell of this.getActivePieceCells()) {
      if (cell.row >= 0 && cell.row < this.internalRows && cell.col >= 0 && cell.col < this.boardCols) {
        this.board[cell.row][cell.col] = this.currentPiece.type;
      }
    }
    const cleared = this.clearLines();
    if (cleared > 0) {
      this.lines += cleared;
      this.score += SCORE_BY_LINES[cleared] * (this.level + 1);
      this.level = this.levelStart + Math.floor(this.lines / 10);
      this.emit(GAME_EVENTS.LINE_CLEAR, { linesCleared: cleared });
    }
    this.emit(GAME_EVENTS.PIECE_LOCK, {
      accepted: true,
      hardDrop: options.hardDrop === true,
      linesCleared: cleared,
    });
    this.spawnPiece();
    this.draw();
  }

  /**
   * Removes completed rows and preserves hidden-row board height.
   *
   * Requirement links: `FR-GAME-008`, `FR-GAME-009`, and `FR-GAME-010`.
   * New empty rows are inserted at the top of the internal board so visible and
   * hidden row transforms remain stable after clears.
   *
   * @returns {number} Number of cleared lines.
   */
  clearLines() {
    let cleared = 0;
    const remainingRows = [];
    for (const row of this.board) {
      if (row.every(Boolean)) {
        cleared += 1;
      } else {
        remainingRows.push(row);
      }
    }
    while (remainingRows.length < this.internalRows) {
      remainingRows.unshift(Array(this.boardCols).fill(null));
    }
    this.board = remainingRows;
    return cleared;
  }

  /**
   * Tests whether a matrix would collide at a position.
   *
   * Requirement links: `FR-GAME-002`, `FR-GAME-006`, and `FR-GAME-013`.
   * Rows above the visible board are allowed during spawn, but side, floor, and
   * occupied-cell collisions block movement.
   *
   * @param {number[][]} matrix Piece matrix.
   * @param {number} col Candidate column.
   * @param {number} row Candidate internal row.
   * @returns {boolean} True when the placement collides.
   */
  collides(matrix, col, row) {
    for (const cell of matrixCells(matrix)) {
      const boardCol = col + cell.col;
      const boardRow = row + cell.row;
      if (boardCol < 0 || boardCol >= this.boardCols || boardRow >= this.internalRows) {
        return true;
      }
      if (boardRow >= 0 && this.board[boardRow][boardCol]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Chooses the next tetromino type.
   *
   * Requirement links: `FR-GAME-005` and `FR-GAME-012`.
   * The random source is injectable so tests can produce deterministic piece
   * episodes while production gameplay remains random.
   *
   * @returns {string} Piece type label.
   */
  pickPieceType() {
    const types = Object.keys(PIECES);
    return types[Math.floor(this.random() * types.length) % types.length];
  }

  /**
   * Stops the gravity timer.
   *
   * Requirement links: `FR-PERF-001` and `FR-EXP-008`.
   * Clearing the loop before resets and end states prevents duplicate gravity
   * events from continuing after pause or trial finalization.
   */
  stopLoop() {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  /**
   * Redraws the full Tetris canvas.
   *
   * Requirement links: `FR-GAME-003`, `FR-UI-003`, and `FR-PERF-001`.
   * Rendering is kept canvas-only so recording can capture the trial stage
   * without webcam or desktop content.
   */
  draw() {
    if (!this.ctx) {
      return;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    drawPanel(this.ctx, this.canvas);
    this.drawBoard();
    this.drawNext();
    this.drawScore();
    if (this.status === 'paused' || this.status === 'ended') {
      this.drawOverlay(this.status === 'paused' ? 'Paused' : this.endReason?.replaceAll('_', ' ') ?? 'Ended');
    }
  }

  /**
   * Draws the visible board, ghost projection, and active piece.
   *
   * Requirement links: `FR-GAME-003`, `FR-GAME-013`, `FR-AOI-003`,
   * and `FR-AOI-004`.
   * Hidden rows are skipped in rendering while their internal coordinates remain
   * available for AOI clipping and collision logic.
   */
  drawBoard() {
    const ctx = this.ctx;
    const boardW = this.boardCols * this.cellSize;
    const boardH = this.visibleRows * this.cellSize;
    ctx.fillStyle = '#111820';
    ctx.fillRect(this.boardLeft - 4, this.boardVisibleTop - 4, boardW + 8, boardH + 8);
    ctx.fillStyle = '#17212b';
    ctx.fillRect(this.boardLeft, this.boardVisibleTop, boardW, boardH);

    for (let row = this.hiddenRows; row < this.internalRows; row += 1) {
      for (let col = 0; col < this.boardCols; col += 1) {
        const value = this.board[row][col];
        if (value) {
          this.drawCell(col, row, PIECES[value].color);
        } else {
          this.drawGridCell(col, row);
        }
      }
    }
    for (const cell of this.getGhostPieceCells()) {
      if (cell.row >= this.hiddenRows) {
        this.drawCell(cell.col, cell.row, 'rgba(255,255,255,0.22)', true);
      }
    }
    for (const cell of this.getActivePieceCells()) {
      if (cell.row >= this.hiddenRows) {
        this.drawCell(cell.col, cell.row, this.currentPiece.color);
      }
    }
  }

  /**
   * Draws one empty visible grid cell.
   *
   * Requirement links: `FR-GAME-003` and `FR-UI-007`.
   * The cell transform matches `getLayout` so visual grid and AOI geometry use
   * the same board origin.
   *
   * @param {number} col Board column.
   * @param {number} internalRow Internal board row.
   */
  drawGridCell(col, internalRow) {
    const x = this.boardLeft + col * this.cellSize;
    const y = this.boardInternalTop + internalRow * this.cellSize;
    this.ctx.strokeStyle = '#23303a';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(x, y, this.cellSize, this.cellSize);
  }

  /**
   * Draws one occupied or ghost cell.
   *
   * Requirement links: `FR-GAME-003`, `FR-GAME-013`, and `FR-UI-003`.
   * Ghost cells use outline-only rendering so they can serve as landing cues
   * without being confused with locked board state.
   *
   * @param {number} col Board column.
   * @param {number} internalRow Internal board row.
   * @param {string} color Fill or stroke color.
   * @param {boolean} outlineOnly True for ghost cells.
   */
  drawCell(col, internalRow, color, outlineOnly = false) {
    const x = this.boardLeft + col * this.cellSize;
    const y = this.boardInternalTop + internalRow * this.cellSize;
    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = outlineOnly ? '#d7edf8' : 'rgba(255,255,255,0.42)';
    this.ctx.lineWidth = outlineOnly ? 2 : 1;
    if (!outlineOnly) {
      this.ctx.fillRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
    }
    this.ctx.strokeRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
  }

  /**
   * Draws the next-piece preview panel.
   *
   * Requirement links: `FR-UI-003`, `FR-GAME-012`, `FR-AOI-001`,
   * and `FR-ANA-005`.
   * Disabled preview still renders a stable panel so the trial layout and AOI
   * coordinate frame do not shift between conditions.
   */
  drawNext() {
    const { x, y, w, h } = this.nextBox;
    this.ctx.fillStyle = '#17212b';
    this.ctx.fillRect(x, y, w, h);
    this.ctx.fillStyle = '#f2f6f8';
    this.ctx.font = '14px system-ui, sans-serif';
    this.ctx.fillText('NEXT', x + 14, y + 24);
    if (!this.previewEnabled) {
      this.ctx.fillStyle = '#9fb0b7';
      this.ctx.fillText('Hidden', x + 14, y + 58);
      return;
    }
    if (!this.nextPiece) {
      return;
    }
    const cells = matrixCells(this.nextPiece.matrix);
    const offsetX = x + 34;
    const offsetY = y + 44;
    for (const cell of cells) {
      this.ctx.fillStyle = this.nextPiece.color;
      this.ctx.fillRect(offsetX + cell.col * 18, offsetY + cell.row * 18, 16, 16);
    }
  }

  /**
   * Draws the score/status panel.
   *
   * Requirement links: `FR-UI-003`, `FR-AOI-001`, and `FR-ANA-001`.
   * The panel has a fixed layout box so score AOIs remain stable during trials.
   */
  drawScore() {
    const { x, y, w, h } = this.scoreBox;
    this.ctx.fillStyle = '#17212b';
    this.ctx.fillRect(x, y, w, h);
    this.ctx.fillStyle = '#f2f6f8';
    this.ctx.font = '14px system-ui, sans-serif';
    this.ctx.fillText(`Score ${this.score}`, x + 14, y + 30);
    this.ctx.fillText(`Lines ${this.lines}`, x + 14, y + 60);
    this.ctx.fillText(`Level ${this.level}`, x + 14, y + 90);
  }

  /**
   * Draws pause/end labels over the game canvas.
   *
   * Requirement links: `FR-UI-003`, `FR-EXP-008`, and `FR-REPLAY-003`.
   * Overlay text becomes part of the trial canvas recording, making pause and
   * end-state context visible during replay without extra reconstruction.
   *
   * @param {string} label Overlay label.
   */
  drawOverlay(label) {
    this.ctx.fillStyle = 'rgba(5, 10, 14, 0.68)';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '700 26px system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(label, this.canvas.width / 2, this.canvas.height / 2);
    this.ctx.textAlign = 'start';
  }
}

/**
 * Computes stack shape metrics from the internal board.
 *
 * Requirement links: `FR-GAME-009`, `FR-GAME-010`, `FR-ANA-007`,
 * and `FR-HCI-004`.
 * Metrics ignore the two hidden rows for height while still treating occupied
 * hidden cells as a game-over risk handled by gameplay itself. Aggregate
 * height and bumpiness are included because analysis needs more than max stack
 * height to relate gaze planning to placement quality.
 *
 * @param {(string | null)[][]} board Internal board.
 * @param {number} hiddenRows Hidden row count.
 * @returns {{height: number, aggregateHeight: number, bumpiness: number, holes: number}} Board metrics.
 */
export function computeBoardMetrics(board, hiddenRows = 2) {
  let highestOccupied = board.length;
  let holes = 0;
  const columnHeights = [];
  for (let col = 0; col < board[0].length; col += 1) {
    let seenBlock = false;
    let columnHighest = board.length;
    for (let row = hiddenRows; row < board.length; row += 1) {
      if (board[row][col]) {
        seenBlock = true;
        highestOccupied = Math.min(highestOccupied, row);
        columnHighest = Math.min(columnHighest, row);
      } else if (seenBlock) {
        holes += 1;
      }
    }
    columnHeights.push(columnHighest === board.length ? 0 : board.length - columnHighest);
  }
  const aggregateHeight = columnHeights.reduce((sum, height) => sum + height, 0);
  const bumpiness = columnHeights
    .slice(1)
    .reduce((sum, height, index) => sum + Math.abs(height - columnHeights[index]), 0);
  return {
    height: highestOccupied === board.length ? 0 : board.length - highestOccupied,
    aggregateHeight,
    bumpiness,
    holes,
  };
}

/**
 * Converts a piece matrix to occupied cell coordinates.
 *
 * Requirement links: `FR-GAME-006`, `FR-AOI-003`, and `FR-AOI-004`.
 * Matrix cells are relative to the piece origin so callers can map them into
 * board coordinates for rendering, collision, active AOIs, and ghost AOIs.
 *
 * @param {number[][]} matrix Piece matrix.
 * @returns {{col: number, row: number}[]} Occupied cell coordinates.
 */
function matrixCells(matrix) {
  const cells = [];
  matrix.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (value) {
        cells.push({ col: colIndex, row: rowIndex });
      }
    });
  });
  return cells;
}

/**
 * Rotates a matrix clockwise or counterclockwise.
 *
 * Requirement links: `FR-GAME-006`, `FR-GAME-007`, and `FR-GAME-011`.
 * Rotation is pure and returns a new matrix so collision checks can evaluate
 * candidate orientations before mutating the active piece.
 *
 * @param {number[][]} matrix Piece matrix.
 * @param {number} direction Positive for clockwise, negative for counterclockwise.
 * @returns {number[][]} Rotated matrix.
 */
function rotateMatrix(matrix, direction) {
  const size = matrix.length;
  const rotated = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (direction > 0) {
        rotated[col][size - row - 1] = matrix[row][col];
      } else {
        rotated[size - col - 1][row] = matrix[row][col];
      }
    }
  }
  return rotated;
}

/**
 * Creates a mutable piece instance from an immutable piece definition.
 *
 * Requirement links: `FR-GAME-005`, `FR-GAME-006`, and `FR-GAME-012`.
 * Matrices are deep-copied so rotations on the active piece do not mutate the
 * shared tetromino definitions used for future spawns.
 *
 * @param {string} type Piece type label.
 * @returns {{type: string, color: string, matrix: number[][]}} Piece instance.
 */
function makePiece(type) {
  return {
    type,
    color: PIECES[type].color,
    matrix: PIECES[type].matrix.map((row) => [...row]),
  };
}

/**
 * Draws the static trial panel background.
 *
 * Requirement links: `FR-UI-003`, `FR-UI-007`, and `FR-PERF-003A`.
 * The panel is drawn into the same canvas as the board so recordings capture a
 * complete trial stage without relying on DOM composition.
 *
 * @param {CanvasRenderingContext2D} ctx Canvas context.
 * @param {HTMLCanvasElement} canvas Tetris canvas.
 */
function drawPanel(ctx, canvas) {
  ctx.fillStyle = '#0b1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f2f6f8';
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.fillText('Tetris Eye Tracking Trial', 36, 26);
}
