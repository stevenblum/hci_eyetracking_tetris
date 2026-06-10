import { describe, expect, it } from 'vitest';
import { AoiBuilder, cellToViewport } from '../../src/aoi/AoiBuilder.js';
import { AoiClassifier, buildAoiVisits } from '../../src/aoi/AoiClassifier.js';
import { AnalysisBuilder } from '../../src/analysis/AnalysisBuilder.js';
import { SessionDataStore } from '../../src/data/SessionDataStore.js';

const layout = {
  layout_id: 'layout_1',
  trial_id: 'trial_1',
  captured_at_t_trial_ms: 0,
  canvas_x: 10,
  canvas_y: 20,
  canvas_w: 500,
  canvas_h: 620,
  board_internal_top_px: 16,
  board_visible_top_px: 64,
  board_left_px: 52,
  cell_size_px: 24,
  hidden_rows: 2,
  internal_board_rows: 22,
  visible_board_rows: 20,
  board_cols: 10,
  next_box_x: 332,
  next_box_y: 94,
  next_box_w: 118,
  next_box_h: 118,
  score_box_x: 328,
  score_box_y: 242,
  score_box_w: 142,
  score_box_h: 120,
};

const localGameLayout = {
  boardInternalTopPx: -4,
  boardVisibleTopPx: 44,
  boardLeftPx: 42,
  cellSizePx: 24,
  hiddenRows: 2,
  internalBoardRows: 22,
  visibleBoardRows: 20,
  boardCols: 10,
  nextBoxX: 322,
  nextBoxY: 74,
  nextBoxW: 118,
  nextBoxH: 118,
  scoreBoxX: 318,
  scoreBoxY: 222,
  scoreBoxW: 142,
  scoreBoxH: 120,
};

describe('AOI pipeline', () => {
  it('transforms hidden-row internal cells into viewport coordinates', () => {
    expect(cellToViewport({ col: 0, row: 2 }, layout)).toEqual({ x: 52, y: 64 });
    expect(cellToViewport({ col: 0, row: 0 }, layout)).toEqual({ x: 52, y: 16 });
  });

  it('builds active piece and landing-zone AOIs with hidden rows clipped', () => {
    const builder = new AoiBuilder({ paddingPx: 0 });
    const aois = builder.buildAois({
      layout,
      state: {
        activeCells: [
          { col: 3, row: 1 },
          { col: 4, row: 1 },
          { col: 3, row: 2 },
          { col: 4, row: 2 },
        ],
        ghostCells: [
          { col: 3, row: 20 },
          { col: 4, row: 20 },
          { col: 3, row: 21 },
          { col: 4, row: 21 },
        ],
        visibleBoard: Array.from({ length: 20 }, () => Array(10).fill(null)),
      },
    });

    expect(aois.find((aoi) => aoi.aoi === 'active_piece')).toMatchObject({
      x: 124,
      y: 64,
      w: 48,
      h: 24,
    });
    expect(aois.find((aoi) => aoi.aoi === 'landing_zone')).toBeTruthy();
  });

  it('scales captured canvas layout when the Tetris board is CSS-enlarged', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 100,
        top: 50,
        width: 750,
        height: 930,
        right: 850,
        bottom: 980,
      }),
    });

    const captured = new AoiBuilder().captureLayout({
      canvas,
      state: { layout: localGameLayout },
      trialId: 'trial_1',
      tTrialMs: 0,
    });

    expect(captured).toMatchObject({
      canvas_x: 100,
      canvas_y: 50,
      canvas_w: 750,
      canvas_h: 930,
      board_internal_top_px: 44,
      board_visible_top_px: 116,
      board_left_px: 163,
      next_box_x: 583,
      next_box_y: 161,
      score_box_x: 577,
      score_box_y: 383,
    });
    expect(captured.cell_size_px).toBe(36);
    expect(captured.next_box_w).toBe(177);
    expect(captured.next_box_h).toBe(177);
    expect(captured.score_box_w).toBe(213);
    expect(captured.score_box_h).toBe(180);
  });

  it('builds one full-width placed-stack AOI from highest occupied row to board bottom', () => {
    const builder = new AoiBuilder({ paddingPx: 0 });
    const visibleBoard = Array.from({ length: 20 }, () => Array(10).fill(null));
    visibleBoard[17][4] = 'T';
    visibleBoard[19][7] = 'I';

    const aois = builder.buildAois({
      layout,
      state: {
        activeCells: [],
        ghostCells: [],
        visibleBoard,
      },
    });

    expect(aois.filter((aoi) => aoi.aoi === 'stack_blocks')).toHaveLength(1);
    expect(aois.find((aoi) => aoi.aoi === 'stack_blocks')).toMatchObject({
      x: 52,
      y: 472,
      w: 240,
      h: 72,
    });
  });

  it('uses priority to resolve overlapping AOIs', () => {
    const classifier = new AoiClassifier();
    const sample = {
      trial_id: 'trial_1',
      piece_id: 'piece_1',
      t_trial_ms: 50,
      t_piece_ms: 50,
      x: 130,
      y: 70,
      confidence: 0.9,
      valid: true,
    };
    const snapshots = [
      {
        aoi_state_id: 'aoi_board',
        trial_id: 'trial_1',
        piece_id: 'piece_1',
        valid_from_t_trial_ms: 0,
        valid_to_t_trial_ms: 100,
        aoi: 'board',
        x: 52,
        y: 64,
        w: 240,
        h: 480,
        priority: 10,
      },
      {
        aoi_state_id: 'aoi_piece',
        trial_id: 'trial_1',
        piece_id: 'piece_1',
        valid_from_t_trial_ms: 0,
        valid_to_t_trial_ms: 100,
        aoi: 'active_piece',
        x: 124,
        y: 64,
        w: 48,
        h: 24,
        priority: 100,
      },
    ];

    const classified = classifier.classifySample(sample, snapshots);

    expect(classified.aoi).toBe('active_piece');
    expect(classified.matching_aois).toEqual(['active_piece', 'board']);
    expect(classified.matching_aoi_state_ids).toEqual(['aoi_piece', 'aoi_board']);
  });

  it('collapses consecutive classified samples into visits', () => {
    const visits = buildAoiVisits([
      baseSample('active_piece', 0),
      baseSample('active_piece', 34),
      baseSample('landing_zone', 68),
    ]);

    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      aoi: 'active_piece',
      duration_ms: 34,
      sample_count: 2,
    });
  });

  it('uses stack_blocks visits for piece-level stack dwell summaries', () => {
    const store = new SessionDataStore();
    seedAnalysisFixture(store);
    new AnalysisBuilder(store).buildForTrial('trial_1');

    expect(store.getRows('aoi_visits')[0]).toMatchObject({
      aoi: 'stack_blocks',
      duration_ms: 34,
    });
    expect(store.getRows('piece_summaries')[0].stack_dwell_ms).toBe(68);
    const classifications = store.getRows('gaze_aoi_classifications');
    expect(classifications).toHaveLength(8);
    expect(classifications[4]).toMatchObject({
      primary_aoi: 'landing_zone',
    });
    expect(JSON.parse(classifications[4].matching_aois)).toEqual(['landing_zone', 'stack_blocks']);
    expect(store.getRows('piece_summaries')[0]).toMatchObject({
      first_rotation_t_piece_ms: 250,
      landing_zone_dwell_percent: 25,
      stack_dwell_percent: 50,
      aoi_transition_count: 3,
      looked_stack_before_first_action: true,
      looked_landing_before_first_action: false,
      post_lock_stack_look_t_trial_ms: 920,
      post_lock_stack_look_delay_ms: 20,
      post_lock_stack_evaluation_seen: true,
      hci_planning_label: 'planning before action',
      hci_sequence_label: 'expected scan incomplete',
      hci_preview_label: 'preview checked',
      hci_feedback_label: 'feedback look observed',
      action_count: 2,
      rotation_count: 1,
      horizontal_move_count: 1,
      soft_drop_count: 0,
      hard_drop_count: 0,
      holes_created: 1,
      board_height_change: 2,
      aggregate_height_change: 6,
      bumpiness_change: 5,
    });
    expect(JSON.parse(store.getRows('piece_summaries')[0].aoi_sequence)).toEqual([
      'stack_blocks',
      'next_piece',
      'landing_zone',
      'stack_blocks',
    ]);
    expect(JSON.parse(store.getRows('piece_summaries')[0].aoi_transition_counts)).toEqual({
      'landing_zone->stack_blocks': 1,
      'next_piece->landing_zone': 1,
      'stack_blocks->next_piece': 1,
    });
    expect(store.getRows('piece_summaries')[0]).toMatchObject({
      expected_sequence_match: false,
    });
    expect(JSON.parse(store.getRows('piece_summaries')[0].expected_aoi_sequence)).toEqual([
      'active_piece',
      'landing_zone',
      'stack_blocks',
      'next_piece',
    ]);
    expect(JSON.parse(store.getRows('piece_summaries')[0].observed_expected_aoi_sequence)).toEqual([
      'stack_blocks',
      'next_piece',
      'landing_zone',
    ]);
    expect(JSON.parse(store.getRows('piece_summaries')[0].missing_expected_aois)).toEqual(['active_piece']);
    expect(store.getRows('trial_summaries')[0].aoi_transition_count).toBe(3);
    expect(JSON.parse(store.getRows('trial_summaries')[0].aoi_dwell_percent)).toMatchObject({
      landing_zone: 25,
      next_piece: 25,
      stack_blocks: 50,
    });
    expect(store.getRows('piece_indexes')[0]).toMatchObject({
      piece_id: 'piece_1',
      gaze_start_index: 0,
      gaze_end_index: 7,
      gaze_count: 8,
      game_event_start_index: 0,
      game_event_end_index: 1,
      game_event_count: 2,
      aoi_visit_start_index: 0,
      aoi_visit_end_index: 3,
      aoi_visit_count: 4,
    });
  });
});

function baseSample(aoi, t) {
  return {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    t_trial_ms: t,
    t_piece_ms: t,
    x: 100,
    y: 100,
    confidence: 0.9,
    valid: true,
    aoi,
  };
}

function seedAnalysisFixture(store) {
  store.addRow('trials', {
    trial_id: 'trial_1',
    participant_id: 'p01',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1000,
    condition: 'keyboard_only',
    level_start: 0,
    end_reason: 'quit',
    score: 0,
    lines: 0,
    pieces_count: 1,
    recording_id: null,
  });
  store.addRow('pieces', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    piece_type: 'T',
    piece_index: 1,
    spawn_t_trial_ms: 0,
    lock_t_trial_ms: 900,
    duration_ms: 900,
    spawn_col: 3,
    spawn_row: 0,
    spawn_rotation: 0,
    lock_col: 4,
    lock_row: 18,
    lock_rotation: 0,
    hard_drop_used: false,
    lines_cleared: 0,
    score_delta: 0,
    board_height_before: 0,
    board_height_after: 2,
    aggregate_height_before: 0,
    aggregate_height_after: 6,
    bumpiness_before: 0,
    bumpiness_after: 5,
    holes_before: 0,
    holes_after: 1,
  });
  for (const sample of [
    { tTrialMs: 100, x: 100, y: 500 },
    { tTrialMs: 134, x: 100, y: 500 },
    { tTrialMs: 200, x: 380, y: 120 },
    { tTrialMs: 234, x: 380, y: 120 },
    { tTrialMs: 300, x: 140, y: 520 },
    { tTrialMs: 334, x: 140, y: 520 },
    { tTrialMs: 920, x: 100, y: 500 },
    { tTrialMs: 954, x: 100, y: 500 },
  ]) {
    store.addRow('gaze_samples', {
      trial_id: 'trial_1',
      piece_id: 'piece_1',
      t_trial_ms: sample.tTrialMs,
      t_piece_ms: sample.tTrialMs,
      x: sample.x,
      y: sample.y,
      confidence: 0.9,
      valid: true,
    });
  }
  store.addRow('game_events', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    t_trial_ms: 250,
    t_piece_ms: 250,
    event_type: 'rotate_clockwise',
    key: 'ArrowUp',
    piece_type: 'T',
    col: 3,
    row: 4,
    rotation: 1,
    score_after: 0,
    lines_after: 0,
    accepted: true,
    details: '{}',
  });
  store.addRow('game_events', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    t_trial_ms: 260,
    t_piece_ms: 260,
    event_type: 'move_left',
    key: 'ArrowLeft',
    piece_type: 'T',
    col: 2,
    row: 4,
    rotation: 1,
    score_after: 0,
    lines_after: 0,
    accepted: true,
    details: '{}',
  });
  store.addRow('aoi_snapshots', {
    aoi_state_id: 'aoi_stack',
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    valid_from_t_trial_ms: 0,
    valid_to_t_trial_ms: 1000,
    valid_from_t_piece_ms: 0,
    valid_to_t_piece_ms: 1000,
    layout_id: 'layout_1',
    aoi: 'stack_blocks',
    x: 52,
    y: 472,
    w: 240,
    h: 72,
    priority: 70,
    source: 'visible_board_stack',
    source_state_id: 'state_1',
  });
  store.addRow('aoi_snapshots', {
    aoi_state_id: 'aoi_next',
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    valid_from_t_trial_ms: 0,
    valid_to_t_trial_ms: 1000,
    valid_from_t_piece_ms: 0,
    valid_to_t_piece_ms: 1000,
    layout_id: 'layout_1',
    aoi: 'next_piece',
    x: 332,
    y: 94,
    w: 118,
    h: 118,
    priority: 60,
    source: 'layout',
    source_state_id: 'state_1',
  });
  store.addRow('aoi_snapshots', {
    aoi_state_id: 'aoi_landing',
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    valid_from_t_trial_ms: 0,
    valid_to_t_trial_ms: 1000,
    valid_from_t_piece_ms: 0,
    valid_to_t_piece_ms: 1000,
    layout_id: 'layout_1',
    aoi: 'landing_zone',
    x: 120,
    y: 500,
    w: 48,
    h: 48,
    priority: 90,
    source: 'ghost_piece_cells',
    source_state_id: 'state_1',
  });
}
