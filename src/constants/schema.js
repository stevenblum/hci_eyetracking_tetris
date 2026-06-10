/**
 * Names the single current schema used by all MVP exports and imports.
 *
 * Requirement links: `FR-DATA-001`, `FR-DATA-002`, and `FR-DATA-003`.
 * The app deliberately keeps one current schema instead of a migration layer so
 * every module writes the same column-oriented session object.
 */
export const SCHEMA_VERSION = 'mvp-current';

/**
 * Requested jsPsych WebGazer sample interval in milliseconds.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-009`, and `FR-PERF-005`.
 * Keeping the interval in the schema constants makes trial metadata, mock
 * sampling, and real extension setup report the same collection contract.
 */
export const WEBGAZER_SAMPLING_INTERVAL_MS = 34;

/**
 * Target frames per second for canvas-only trial recordings.
 *
 * Requirement links: `FR-DATA-011`, `FR-PERF-003A`, and `FR-PERF-004`.
 * Recording metadata stores this target separately from actual media timing so
 * replay and exports can explain browser support differences.
 */
export const DEFAULT_RECORDING_FPS = 30;

/**
 * Defines canonical column order for every session table.
 *
 * Requirement links: `FR-DATA-001` through `FR-DATA-007`,
 * `FR-EXP-007`, `FR-GAME-005` through `FR-GAME-011`,
 * `FR-AOI-007` through `FR-AOI-011`, `FR-ANA-001` through
 * `FR-ANA-010`, and `FR-HCI-001` through `FR-HCI-005`.
 * Tables are column-oriented to keep large gaze/event exports compact while
 * still allowing object-shaped rows inside application code.
 */
export const TABLE_SCHEMAS = {
  metadata: [
    'session_id',
    'participant_id',
    'study_id',
    'created_at',
    'app_name',
    'app_version',
    'schema_version',
    'jspsych_version',
    'webgazer_source',
    'webgazer_sampling_interval_ms',
    'user_agent',
  ],
  dictionaries: [
    'dictionary_name',
    'code',
    'label',
    'description',
  ],
  layout: [
    'layout_id',
    'trial_id',
    'captured_at_t_trial_ms',
    'canvas_x',
    'canvas_y',
    'canvas_w',
    'canvas_h',
    'board_internal_top_px',
    'board_visible_top_px',
    'board_left_px',
    'cell_size_px',
    'hidden_rows',
    'internal_board_rows',
    'visible_board_rows',
    'board_cols',
    'next_box_x',
    'next_box_y',
    'next_box_w',
    'next_box_h',
    'score_box_x',
    'score_box_y',
    'score_box_w',
    'score_box_h',
  ],
  trials: [
    'trial_id',
    'participant_id',
    'started_at',
    'ended_at',
    'duration_ms',
    'duration_limit_ms',
    'condition',
    'condition_code',
    'trial_mode',
    'trial_mode_code',
    'level_start',
    'fall_interval_ms',
    'board_cols',
    'board_visible_rows',
    'cell_size_px',
    'preview_enabled',
    'ghost_enabled',
    'gaze_sampling_interval_ms',
    'end_reason',
    'end_reason_code',
    'score',
    'lines',
    'pieces_count',
    'recording_id',
  ],
  trial_recordings: [
    'recording_id',
    'trial_id',
    'file_name',
    'mime_type',
    'source',
    'source_code',
    'width_px',
    'height_px',
    'target_fps',
    'start_t_trial_ms',
    'end_t_trial_ms',
    'duration_ms',
    'video_time_origin_ms',
    'status',
    'status_code',
    'error',
  ],
  pieces: [
    'trial_id',
    'piece_id',
    'piece_type',
    'piece_type_code',
    'piece_index',
    'spawn_t_trial_ms',
    'lock_t_trial_ms',
    'duration_ms',
    'spawn_col',
    'spawn_row',
    'spawn_rotation',
    'lock_col',
    'lock_row',
    'lock_rotation',
    'hard_drop_used',
    'lines_cleared',
    'score_delta',
    'board_height_before',
    'board_height_after',
    'aggregate_height_before',
    'aggregate_height_after',
    'bumpiness_before',
    'bumpiness_after',
    'holes_before',
    'holes_after',
  ],
  gaze_samples: [
    'trial_id',
    'piece_id',
    't_trial_ms',
    't_piece_ms',
    'x',
    'y',
    'confidence',
    'valid',
  ],
  gaze_aoi_classifications: [
    'trial_id',
    'piece_id',
    't_trial_ms',
    't_piece_ms',
    'primary_aoi',
    'primary_aoi_code',
    'primary_aoi_state_id',
    'matching_aois',
    'matching_aoi_codes',
    'matching_aoi_state_ids',
    'matching_priorities',
  ],
  webgazer_runs: [
    'webgazer_run_id',
    'session_id',
    'participant_id',
    'mode',
    'mode_code',
    'started_at',
    'ended_at',
    'status',
    'status_code',
    'setup_completed',
    'camera_load_time_ms',
    'calibration_mode',
    'calibration_mode_code',
    'calibration_clicks_per_point',
    'calibration_total_clicks',
    'calibration_tracker_ready',
    'calibration_tracker_ready_elapsed_ms',
    'calibration_tracker_ready_clicks',
    'calibration_regression_sample_count',
    'calibration_regression_samples_by_point',
    'brown_precision_percent',
    'brown_precision_label',
    'brown_precision_sample_count',
    'brown_precision_mean_error_px',
    'brown_precision_samples_per_sec',
    'brown_precision_sample_source',
    'brown_stored_sample_count',
    'brown_direct_sample_count',
    'calibration_points',
    'error',
  ],
  diagnostic_events: [
    'event_id',
    'session_id',
    'webgazer_run_id',
    'trial_id',
    'timestamp_iso',
    'performance_ms',
    'elapsed_ms',
    'level',
    'category',
    'phase',
    'action',
    'message',
    'data_json',
  ],
  post_trial_responses: [
    'response_id',
    'trial_id',
    'participant_id',
    'submitted_at',
    'workload_rating',
    'difficulty_rating',
    'frustration_rating',
    'strategy_text',
  ],
  piece_state_events: [
    'trial_id',
    'piece_id',
    't_trial_ms',
    't_piece_ms',
    'state_event_id',
    'piece_type',
    'piece_type_code',
    'col',
    'row',
    'rotation',
    'ghost_col',
    'ghost_row',
    'score',
    'lines',
    'board_height',
    'board_aggregate_height',
    'board_bumpiness',
    'holes',
    'event_source',
    'event_source_code',
  ],
  game_events: [
    'trial_id',
    'piece_id',
    't_trial_ms',
    't_piece_ms',
    'event_type',
    'event_type_code',
    'key',
    'piece_type',
    'piece_type_code',
    'col',
    'row',
    'rotation',
    'score_after',
    'lines_after',
    'accepted',
    'details',
  ],
  aoi_snapshots: [
    'aoi_state_id',
    'trial_id',
    'piece_id',
    'valid_from_t_trial_ms',
    'valid_to_t_trial_ms',
    'valid_from_t_piece_ms',
    'valid_to_t_piece_ms',
    'layout_id',
    'aoi',
    'aoi_code',
    'x',
    'y',
    'w',
    'h',
    'priority',
    'source',
    'source_code',
    'source_state_id',
  ],
  aoi_visits: [
    'trial_id',
    'piece_id',
    'visit_id',
    'aoi',
    'aoi_code',
    'start_t_trial_ms',
    'end_t_trial_ms',
    'duration_ms',
    'sample_count',
    'mean_confidence',
    'start_t_piece_ms',
    'end_t_piece_ms',
  ],
  piece_indexes: [
    'trial_id',
    'piece_id',
    'gaze_start_index',
    'gaze_end_index',
    'gaze_count',
    'game_event_start_index',
    'game_event_end_index',
    'game_event_count',
    'state_event_start_index',
    'state_event_end_index',
    'state_event_count',
    'aoi_visit_start_index',
    'aoi_visit_end_index',
    'aoi_visit_count',
  ],
  piece_summaries: [
    'trial_id',
    'piece_id',
    'piece_type',
    'piece_type_code',
    'duration_ms',
    'first_action_t_piece_ms',
    'first_rotation_t_piece_ms',
    'first_active_piece_look_t_piece_ms',
    'first_stack_look_t_piece_ms',
    'first_landing_zone_look_t_piece_ms',
    'first_next_piece_look_t_piece_ms',
    'landing_zone_dwell_ms',
    'active_piece_dwell_ms',
    'stack_dwell_ms',
    'next_piece_dwell_ms',
    'landing_zone_dwell_percent',
    'active_piece_dwell_percent',
    'stack_dwell_percent',
    'next_piece_dwell_percent',
    'aoi_visit_count',
    'aoi_transition_count',
    'aoi_transition_counts',
    'aoi_sequence',
    'expected_aoi_sequence',
    'observed_expected_aoi_sequence',
    'missing_expected_aois',
    'expected_sequence_match',
    'looked_landing_before_first_action',
    'looked_stack_before_first_action',
    'post_lock_stack_look_t_trial_ms',
    'post_lock_stack_look_delay_ms',
    'post_lock_evaluation_window_ms',
    'post_lock_stack_evaluation_seen',
    'hci_planning_label',
    'hci_sequence_label',
    'hci_preview_label',
    'hci_feedback_label',
    'preview_checks',
    'action_count',
    'rotation_count',
    'horizontal_move_count',
    'soft_drop_count',
    'hard_drop_count',
    'holes_before',
    'holes_after',
    'holes_created',
    'board_height_before',
    'board_height_after',
    'board_height_change',
    'aggregate_height_before',
    'aggregate_height_after',
    'aggregate_height_change',
    'bumpiness_before',
    'bumpiness_after',
    'bumpiness_change',
  ],
  trial_summaries: [
    'trial_id',
    'duration_ms',
    'score',
    'lines',
    'pieces_count',
    'end_reason',
    'end_reason_code',
    'observed_sampling_rate_hz',
    'median_sample_interval_ms',
    'valid_sample_percentage',
    'webgazer_brown_precision_percent',
    'webgazer_brown_precision_label',
    'webgazer_brown_precision_sample_count',
    'webgazer_brown_precision_mean_error_px',
    'total_gaze_samples',
    'total_aoi_visits',
    'aoi_dwell_ms',
    'aoi_dwell_percent',
    'aoi_transition_count',
    'aoi_transition_counts',
    'aoi_sequence',
    'recording_status',
    'recording_status_code',
  ],
};

/**
 * Human-readable labels for numeric code columns in repeated categorical data.
 *
 * Requirement links: `FR-DATA-006` and `FR-DATA-007`.
 * The dictionaries live beside table schemas so labels and numeric codes remain
 * synchronized for exports, replay legends, and classroom analysis.
 */
export const DICTIONARIES = {
  condition: {
    keyboard_only: 'Formal keyboard-only Tetris condition.',
    practice_keyboard_only: 'Practice keyboard-only Tetris condition.',
    main_keyboard_only: 'Main keyboard-only Tetris condition.',
  },
  trial_mode: {
    practice: 'Practice trial used before formal data collection.',
    main: 'Main trial used for formal analysis.',
  },
  end_reason: {
    game_over: 'Natural Tetris game over.',
    quit: 'Participant or researcher ended the trial manually.',
    timeout: 'Trial ended because the configured maximum duration elapsed.',
    error: 'Trial stopped because an unrecoverable runtime error occurred.',
    webcam_denied: 'Trial stopped before gameplay because webcam permission was denied.',
    webgazer_unavailable: 'Trial stopped before gameplay because the jsPsych WebGazer extension was unavailable.',
    webgazer_error: 'Trial stopped because jsPsych WebGazer setup or sampling failed.',
  },
  piece_type: {
    I: 'Straight tetromino.',
    J: 'J tetromino.',
    L: 'L tetromino.',
    O: 'Square tetromino.',
    S: 'S tetromino.',
    T: 'T tetromino.',
    Z: 'Z tetromino.',
  },
  game_event_type: {
    game_start: 'Tetris game instance started.',
    trial_start: 'Formal Tetris trial started.',
    trial_end: 'Formal Tetris trial ended.',
    keydown: 'Keyboard input observed by the trial.',
    move_left: 'Piece moved left.',
    move_right: 'Piece moved right.',
    soft_drop: 'Piece moved down by participant input.',
    gravity_drop: 'Piece moved down by automatic gravity.',
    hard_drop: 'Piece hard dropped.',
    rotate_clockwise: 'Piece rotated clockwise.',
    rotate_counterclockwise: 'Piece rotated counterclockwise.',
    piece_spawn: 'New active piece spawned.',
    piece_lock: 'Piece locked into the board.',
    line_clear: 'One or more lines cleared.',
    pause: 'Gameplay paused.',
    resume: 'Gameplay resumed.',
    game_over: 'Game over reached.',
    timeout: 'Trial timeout reached.',
  },
  event_source: {
    game_event: 'State snapshot generated from an emitted game event.',
    trial_start: 'State snapshot generated at trial start.',
    trial_end: 'State snapshot generated at trial end.',
    forced_stop: 'State snapshot generated from a forced trial stop.',
  },
  aoi: {
    board: 'Full visible board.',
    active_piece: 'Current falling piece.',
    landing_zone: 'Ghost or expected landing area.',
    stack_blocks: 'Placed block stack from highest occupied row to the board bottom.',
    next_piece: 'Next-piece preview.',
    score_panel: 'Score and line counters.',
    danger_zone: 'Top visible board rows where game-over risk is high.',
    outside: 'Valid gaze sample outside known AOIs.',
    invalid: 'Invalid gaze sample.',
  },
  aoi_snapshot_source: {
    layout: 'AOI generated from the current game layout.',
    derived_board_top: 'Danger-zone AOI derived from the visible board top rows.',
    active_piece_cells: 'Active-piece AOI derived from current piece cells.',
    ghost_piece_cells: 'Landing-zone AOI derived from ghost piece cells.',
    visible_board_stack: 'Placed-stack AOI derived from occupied visible board rows.',
  },
  recording_status: {
    recorded: 'Recording completed and has a media blob.',
    unsupported: 'Browser did not support canvas recording.',
    failed: 'Recording attempted but failed.',
    not_started: 'Recording was not started.',
  },
  recording_source: {
    tetris_canvas_capture_stream: 'Recording captured from the Tetris canvas stream.',
  },
  webgazer_mode: {
    mock: 'Deterministic mock WebGazer path for automated tests and demos.',
    real: 'Real jsPsych WebGazer path for lab collection.',
  },
  webgazer_run_status: {
    completed: 'WebGazer setup completed; quality metrics should be reviewed before trial collection.',
    error: 'WebGazer setup failed before Brown-style setup completed.',
  },
  calibration_mode: {
    brown_repeated_click: 'Participant clicked each calibration point repeatedly using the Brown WebGazer calibration flow.',
    mock: 'Deterministic calibration path used for automated tests.',
  },
};

/**
 * Maps each dictionary string label to its one-based numeric code.
 *
 * Requirement links: `FR-DATA-006` and `FR-DATA-007`.
 * The current MVP stores readable labels and numeric code columns together so
 * pilot exports remain inspectable while still satisfying compact analysis
 * requirements for repeated categorical fields.
 */
export const DICTIONARY_CODE_LOOKUP = Object.fromEntries(
  Object.entries(DICTIONARIES).map(([dictionaryName, entries]) => [
    dictionaryName,
    Object.fromEntries(Object.keys(entries).map((label, index) => [label, index + 1])),
  ]),
);

export const REQUIRED_TABLES = Object.keys(TABLE_SCHEMAS);

/**
 * AOI priority used when gaze intersects overlapping rectangles.
 *
 * Requirement links: `FR-AOI-008` and `FR-AOI-009`.
 * More task-specific AOIs outrank broad static regions so active-piece and
 * landing-zone looks are not hidden by the full-board AOI.
 */
export const AOI_PRIORITY = {
  active_piece: 100,
  landing_zone: 90,
  danger_zone: 80,
  stack_blocks: 70,
  next_piece: 60,
  score_panel: 50,
  board: 10,
};

/**
 * Creates empty canonical tables for the current MVP schema.
 *
 * Requirement links: `FR-DATA-001`, `FR-DATA-002`, and `FR-DATA-003`.
 * The MVP deliberately has one mutable current schema instead of migrations or
 * legacy compatibility paths, so all application modules call this helper when
 * they need a new session shape.
 *
 * @returns {Record<string, {columns: string[], rows: unknown[][]}>} Empty tables keyed by table name.
 */
export function createEmptyTables() {
  return Object.fromEntries(
    Object.entries(TABLE_SCHEMAS).map(([tableName, columns]) => [
      tableName,
      { columns: [...columns], rows: [] },
    ]),
  );
}
