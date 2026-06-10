import { describe, expect, it } from 'vitest';
import { SessionDataStore } from '../../src/data/SessionDataStore.js';
import { ClassicTetrisAdapter } from '../../src/game/ClassicTetrisAdapter.js';
import { mapKeyboardCode } from '../../src/game/keyboard.js';
import { ClassicTetris, computeBoardMetrics } from '../../src/vendor/classic-tetris-js/classic-tetris.instrumented.js';

describe('keyboard-only Tetris instrumentation', () => {
  it('maps only formal keyboard controls', () => {
    expect(mapKeyboardCode('ArrowLeft')).toBe('move_left');
    expect(mapKeyboardCode('Space')).toBe('hard_drop');
    expect(mapKeyboardCode('KeyA')).toBeNull();
  });

  it('assigns experiment piece IDs and exposes visible/full board state', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const game = new ClassicTetris(canvas, { random: () => 0 });

    game.start();
    const state = game.getExperimentState();

    expect(state.experimentPieceId).toBe('piece_1');
    expect(state.visibleBoard).toHaveLength(20);
    expect(state.board).toHaveLength(22);
    expect(state.boardMetrics).toMatchObject({
      height: 0,
      aggregateHeight: 0,
      bumpiness: 0,
      holes: 0,
    });
    game.forceStop({ endReason: 'quit' });
  });

  it('computes max height, aggregate height, bumpiness, and holes from the visible board', () => {
    const board = Array.from({ length: 22 }, () => Array(10).fill(null));
    board[21][0] = 'I';
    board[20][1] = 'T';
    board[21][1] = 'T';
    board[19][2] = 'L';
    board[21][2] = 'L';

    expect(computeBoardMetrics(board, 2)).toEqual({
      height: 3,
      aggregateHeight: 6,
      bumpiness: 5,
      holes: 1,
    });
  });

  it('writes game, piece, state, AOI, and summary rows for a short forced trial', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const store = new SessionDataStore({ participantId: 'adapter-pilot' });
    const game = new ClassicTetris(canvas, { random: () => 0, tickMs: 10 });
    const adapter = new ClassicTetrisAdapter({ game, store, canvas });

    const trial = adapter.startTrial({ participantId: 'adapter-pilot' });
    game.start();
    game.handleKeyDown({ code: 'ArrowLeft', preventDefault() {} });
    game.handleKeyDown({ code: 'ArrowUp', preventDefault() {} });
    game.handleKeyDown({ code: 'Space', preventDefault() {} });
    const pieceOneActiveAois = store
      .getRows('aoi_snapshots')
      .filter((row) => row.piece_id === 'piece_1' && row.aoi === 'active_piece');
    const pieceTwoStackAois = store
      .getRows('aoi_snapshots')
      .filter((row) => row.piece_id === 'piece_2' && row.aoi === 'stack_blocks');
    expect(pieceOneActiveAois.length).toBeGreaterThan(0);
    expect(pieceOneActiveAois.every((row) => row.valid_to_t_trial_ms !== null)).toBe(true);
    expect(pieceTwoStackAois).toHaveLength(1);
    game.forceStop({ endReason: 'timeout' });
    adapter.finishTrial({ endReason: 'timeout', durationMs: 500, recordingId: null });

    expect(store.getRows('pieces')[0].piece_id).toBe('piece_1');
    expect(store.getRows('pieces')[0].aggregate_height_before).toBe(0);
    expect(store.getRows('pieces')[0].bumpiness_before).toBe(0);
    expect(store.getRows('game_events').map((row) => row.event_type)).toContain('hard_drop');
    expect(store.getRows('piece_state_events').length).toBeGreaterThan(0);
    expect(store.getRows('aoi_snapshots').length).toBeGreaterThan(0);
    expect(store.getRows('trials')[0]).toMatchObject({
      trial_id: trial.trial_id,
      end_reason: 'timeout',
    });
    expect(store.getRows('trial_summaries')[0].end_reason).toBe('timeout');
  });

  it('records automatic gravity as AOI state updates while the piece falls', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const store = new SessionDataStore({ participantId: 'gravity-pilot' });
    const game = new ClassicTetris(canvas, { random: () => 0, tickMs: 10 });
    const adapter = new ClassicTetrisAdapter({ game, store, canvas });

    adapter.startTrial({ participantId: 'gravity-pilot' });
    game.start();
    game.stepGravity();

    const gravityState = store
      .getRows('piece_state_events')
      .find((row) => row.event_source === 'gravity_drop');
    const activeAoi = store
      .getRows('aoi_snapshots')
      .find((row) => row.piece_id === 'piece_1' && row.aoi === 'active_piece');

    expect(gravityState).toMatchObject({
      piece_id: 'piece_1',
      row: 1,
    });
    expect(activeAoi).toBeTruthy();

    game.forceStop({ endReason: 'quit' });
    adapter.finishTrial({ endReason: 'quit', durationMs: 250, recordingId: null });
  });

  it('records configured trial metadata and suppresses AOIs for disabled features', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const store = new SessionDataStore({ participantId: 'config-pilot' });
    const game = new ClassicTetris(canvas, {
      random: () => 0,
      tickMs: 125,
      previewEnabled: false,
      ghostEnabled: false,
    });
    const adapter = new ClassicTetrisAdapter({ game, store, canvas });

    adapter.startTrial({
      participantId: 'config-pilot',
      trialMode: 'practice',
      durationLimitMs: 45_000,
      levelStart: 3,
      condition: 'practice_keyboard_only',
      gazeSamplingIntervalMs: 34,
    });
    game.start();

    const trial = store.getRows('trials')[0];
    const state = game.getExperimentState();
    const aois = store.getRows('aoi_snapshots').map((row) => row.aoi);

    expect(trial).toMatchObject({
      trial_mode: 'practice',
      duration_limit_ms: 45_000,
      fall_interval_ms: 125,
      level_start: 3,
      preview_enabled: false,
      ghost_enabled: false,
      board_cols: 10,
      board_visible_rows: 20,
      cell_size_px: 24,
      gaze_sampling_interval_ms: 34,
    });
    expect(state.ghostCells).toEqual([]);
    expect(aois).not.toContain('next_piece');
    expect(aois).not.toContain('landing_zone');

    game.forceStop({ endReason: 'quit' });
    adapter.finishTrial({ endReason: 'quit', durationMs: 250, recordingId: null });
  });

  it('records game_over as a controlled trial end reason', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const store = new SessionDataStore({ participantId: 'gameover-pilot' });
    const game = new ClassicTetris(canvas, { random: () => 0, tickMs: 10 });
    const adapter = new ClassicTetrisAdapter({ game, store, canvas });

    adapter.startTrial({ participantId: 'gameover-pilot' });
    game.start();
    game.forceStop({ endReason: 'game_over' });
    adapter.finishTrial({ endReason: 'game_over', durationMs: 250, recordingId: null });

    expect(store.getRows('trials')[0]).toMatchObject({
      end_reason: 'game_over',
      end_reason_code: 1,
    });
    expect(store.getRows('trial_summaries')[0]).toMatchObject({
      end_reason: 'game_over',
      end_reason_code: 1,
    });
  });
});
