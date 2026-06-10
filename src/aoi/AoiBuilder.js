import { AOI_PRIORITY } from '../constants/schema.js';

/**
 * Builds time-varying AOI rectangles from Tetris state and canvas layout.
 *
 * Requirement links: `FR-AOI-001` through `FR-AOI-007`,
 * `FR-UI-007`, `FR-UI-008`, and `FR-REPLAY-005`.
 * AOIs are recorded in viewport pixel coordinates, matching jsPsych WebGazer
 * gaze `x`/`y` values. Hidden rows are handled by using the internal board top
 * for cell transforms and clipping AOIs to the visible board where needed.
 */
export class AoiBuilder {
  /**
 * Creates a layout/AOI builder.
 *
 * Requirement links: `FR-AOI-007` and `FR-PERF-002`.
 * The layout counter produces stable `layout_id` intervals without storing a
 * new layout row unless the rendered canvas geometry changes.
 *
 * @param {{paddingPx?: number}} options Builder options.
   */
  constructor(options = {}) {
    this.paddingPx = options.paddingPx ?? 4;
    this.lastLayoutKey = null;
    this.layoutCounter = 0;
  }

  /**
 * Captures current canvas and game layout in canonical table shape.
 *
 * Requirement links: `FR-UI-007`, `FR-UI-009`, `FR-AOI-001`,
 * `FR-AOI-007`, and `FR-REPLAY-009`.
 * The transform stores both internal and visible board top coordinates so
 * hidden rows can be converted correctly without moving WebGazer data out of
   * the browser viewport frame. It also scales game-local canvas coordinates to
   * the rendered CSS canvas size, which is required now that the Play view grows
   * the Tetris board beyond its fixed drawing buffer.
   *
   * @param {{canvas: HTMLCanvasElement, state: Record<string, unknown>, trialId: string, tTrialMs: number}} options Layout options.
   * @returns {Record<string, unknown>} Canonical `layout` row object.
   */
  captureLayout(options) {
    const rect = options.canvas.getBoundingClientRect();
    const displayWidth = rect.width || options.canvas.width;
    const displayHeight = rect.height || options.canvas.height;
    const scaleX = displayWidth / options.canvas.width;
    const scaleY = displayHeight / options.canvas.height;
    const layout = options.state.layout;
    const key = JSON.stringify({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(displayWidth),
      h: Math.round(displayHeight),
      layout,
    });
    if (key !== this.lastLayoutKey) {
      this.layoutCounter += 1;
      this.lastLayoutKey = key;
    }
    return {
      layout_id: `layout_${this.layoutCounter}`,
      trial_id: options.trialId,
      captured_at_t_trial_ms: options.tTrialMs,
      canvas_x: Math.round(rect.left),
      canvas_y: Math.round(rect.top),
      canvas_w: Math.round(displayWidth),
      canvas_h: Math.round(displayHeight),
      board_internal_top_px: Math.round(rect.top + layout.boardInternalTopPx * scaleY),
      board_visible_top_px: Math.round(rect.top + layout.boardVisibleTopPx * scaleY),
      board_left_px: Math.round(rect.left + layout.boardLeftPx * scaleX),
      cell_size_px: layout.cellSizePx * Math.min(scaleX, scaleY),
      hidden_rows: layout.hiddenRows,
      internal_board_rows: layout.internalBoardRows,
      visible_board_rows: layout.visibleBoardRows,
      board_cols: layout.boardCols,
      next_box_x: Math.round(rect.left + layout.nextBoxX * scaleX),
      next_box_y: Math.round(rect.top + layout.nextBoxY * scaleY),
      next_box_w: layout.nextBoxW * scaleX,
      next_box_h: layout.nextBoxH * scaleY,
      score_box_x: Math.round(rect.left + layout.scoreBoxX * scaleX),
      score_box_y: Math.round(rect.top + layout.scoreBoxY * scaleY),
      score_box_w: layout.scoreBoxW * scaleX,
      score_box_h: layout.scoreBoxH * scaleY,
    };
  }

  /**
 * Builds AOIs for the current state interval.
 *
 * Requirement links: `FR-AOI-001` through `FR-AOI-007`,
 * `FR-GAME-012`, `FR-GAME-013`, and `FR-UI-008`.
 * The output intentionally favors a small set of interpretable HCI areas over
 * many micro-AOIs so early pilots can validate whether the categories are
   * useful before investing in more detailed classification.
   *
   * @param {{state: Record<string, unknown>, layout: Record<string, unknown>}} options AOI options.
   * @returns {{aoi: string, x: number, y: number, w: number, h: number, priority: number, source: string}[]} AOI rectangles.
   */
  buildAois(options) {
    const { state, layout } = options;
    const board = {
      x: layout.board_left_px,
      y: layout.board_visible_top_px,
      w: layout.board_cols * layout.cell_size_px,
      h: layout.visible_board_rows * layout.cell_size_px,
    };
    const aois = [
      makeAoi('board', board, 'layout'),
      makeAoi(
        'score_panel',
        {
          x: layout.score_box_x,
          y: layout.score_box_y,
          w: layout.score_box_w,
          h: layout.score_box_h,
        },
        'layout',
      ),
      makeAoi(
        'danger_zone',
        {
          x: board.x,
          y: board.y,
          w: board.w,
          h: Math.min(board.h, layout.cell_size_px * 4),
        },
        'derived_board_top',
      ),
    ];

    if (state.previewEnabled !== false) {
      aois.push(makeAoi(
        'next_piece',
        {
          x: layout.next_box_x,
          y: layout.next_box_y,
          w: layout.next_box_w,
          h: layout.next_box_h,
        },
        'layout',
      ));
    }

    const activeBox = this.cellsToBox(state.activeCells ?? [], layout);
    if (activeBox) {
      aois.push(makeAoi('active_piece', activeBox, 'active_piece_cells'));
    }

    const ghostBox = this.cellsToBox(state.ghostCells ?? [], layout);
    if (ghostBox) {
      aois.push(makeAoi('landing_zone', ghostBox, 'ghost_piece_cells'));
    }

    const stackBox = this.stackBlocksBox(state.visibleBoard ?? [], layout);
    if (stackBox) {
      aois.push(makeAoi('stack_blocks', stackBox, 'visible_board_stack'));
    }

    return aois.map((aoi) => ({
      ...aoi,
      x: Math.round(aoi.x),
      y: Math.round(aoi.y),
      w: Math.round(aoi.w),
      h: Math.round(aoi.h),
    }));
  }

  /**
 * Converts internal board cells into a clipped viewport rectangle.
 *
 * Requirement links: `FR-AOI-003`, `FR-AOI-004`, and `FR-UI-007`.
 * Hidden rows are transformed with `board_internal_top_px`, then clipped to
 * the visible board because participants cannot see hidden cells.
   *
   * @param {{col: number, row: number}[]} cells Internal board cells.
   * @param {Record<string, number>} layout Canonical layout row.
   * @returns {{x: number, y: number, w: number, h: number} | null} Viewport rectangle.
   */
  cellsToBox(cells, layout) {
    const visibleCells = cells.filter((cell) => cell.row >= layout.hidden_rows);
    if (visibleCells.length === 0) {
      return null;
    }
    const minCol = Math.min(...visibleCells.map((cell) => cell.col));
    const maxCol = Math.max(...visibleCells.map((cell) => cell.col));
    const minRow = Math.min(...visibleCells.map((cell) => cell.row));
    const maxRow = Math.max(...visibleCells.map((cell) => cell.row));
    const rawBox = {
      x: layout.board_left_px + minCol * layout.cell_size_px - this.paddingPx,
      y: layout.board_internal_top_px + minRow * layout.cell_size_px - this.paddingPx,
      w: (maxCol - minCol + 1) * layout.cell_size_px + this.paddingPx * 2,
      h: (maxRow - minRow + 1) * layout.cell_size_px + this.paddingPx * 2,
    };
    return clipToBoard(rawBox, layout);
  }

  /**
 * Creates one AOI covering the placed block stack.
 *
 * Requirement links: `FR-AOI-005`, `FR-AOI-011`, and `FR-HCI-004`.
 * The replay only needs one interpretable placed-stack region, so this spans
 * the full board width from the highest occupied visible row to the board
   * bottom instead of drawing individual locked-piece regions.
   *
   * @param {(string | null)[][]} visibleBoard Board without hidden rows.
   * @param {Record<string, number>} layout Canonical layout row.
   * @returns {{x: number, y: number, w: number, h: number} | null} Placed stack rectangle.
   */
  stackBlocksBox(visibleBoard, layout) {
    const rows = [];
    for (let row = 0; row < visibleBoard.length; row += 1) {
      if (visibleBoard[row].some(Boolean)) {
        rows.push(row);
      }
    }
    if (rows.length === 0) {
      return null;
    }
    const top = Math.min(...rows);
    return {
      x: layout.board_left_px,
      y: layout.board_visible_top_px + top * layout.cell_size_px,
      w: layout.board_cols * layout.cell_size_px,
      h: (visibleBoard.length - top) * layout.cell_size_px,
    };
  }
}

/**
 * Converts a visible cell coordinate into viewport pixel coordinates.
 *
 * Requirement links: `FR-AOI-003`, `FR-AOI-004`, and `FR-REPLAY-009`.
 * Tests use this helper to validate hidden-row transforms independently from
 * full AOI generation.
 *
 * @param {{col: number, row: number}} cell Internal board cell.
 * @param {Record<string, number>} layout Canonical layout row.
 * @returns {{x: number, y: number}} Top-left viewport coordinate.
 */
export function cellToViewport(cell, layout) {
  return {
    x: layout.board_left_px + cell.col * layout.cell_size_px,
    y: layout.board_internal_top_px + cell.row * layout.cell_size_px,
  };
}

/**
 * Adds schema-facing AOI metadata to a rectangle.
 *
 * Requirement links: `FR-AOI-007`, `FR-AOI-009`, and `FR-DATA-006`.
 * Priority is attached when the AOI is created so classification and replay do
 * not need to duplicate category-specific ordering rules.
 *
 * @param {string} aoi AOI label.
 * @param {{x: number, y: number, w: number, h: number}} rect Viewport rectangle.
 * @param {string} source AOI snapshot source label.
 * @returns {{aoi: string, x: number, y: number, w: number, h: number, priority: number, source: string}} AOI metadata.
 */
function makeAoi(aoi, rect, source) {
  return {
    aoi,
    ...rect,
    priority: AOI_PRIORITY[aoi] ?? 0,
    source,
  };
}

/**
 * Clips a dynamic AOI to the visible board.
 *
 * Requirement links: `FR-AOI-003`, `FR-AOI-004`, and `FR-UI-007`.
 * Clipping prevents hidden spawn cells from creating invisible gaze targets and
 * keeps replay overlays aligned with what the participant actually saw.
 *
 * @param {{x: number, y: number, w: number, h: number}} rect Candidate rectangle.
 * @param {Record<string, number>} layout Canonical layout row.
 * @returns {{x: number, y: number, w: number, h: number} | null} Clipped rectangle.
 */
function clipToBoard(rect, layout) {
  const board = {
    x: layout.board_left_px,
    y: layout.board_visible_top_px,
    w: layout.board_cols * layout.cell_size_px,
    h: layout.visible_board_rows * layout.cell_size_px,
  };
  const x1 = Math.max(rect.x, board.x);
  const y1 = Math.max(rect.y, board.y);
  const x2 = Math.min(rect.x + rect.w, board.x + board.w);
  const y2 = Math.min(rect.y + rect.h, board.y + board.h);
  if (x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
