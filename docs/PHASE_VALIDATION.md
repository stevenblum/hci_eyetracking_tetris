# Phase Validation Notes

Each phase keeps the previous automated tests active and adds focused tests for the new behavior. Manual validation notes are intentionally short because this MVP is expected to refine requirements after real lab use.

## Phase 1: Project Scaffold and Quality Harness

- Automated: Vite app loads, route placeholders render, build succeeds, lint/docstring checks run.
- Manual: Confirm setup, play, replay, analysis, and export views are reachable from the left sidebar.
- Documentation coverage: Exported scaffold modules include JSDoc and `docs/ARCHITECTURE.md` states current MVP constraints.

## Phase 2: Playable Keyboard-Only Tetris

- Automated: Keyboard mapping and stop reasons are unit tested; Playwright drives a short keyboard-only game and checks page scroll remains locked.
- Manual: Confirm arrow keys, rotation, hard drop, pause/resume, quit, and timeout behavior feel usable.
- Documentation coverage: Game and view methods explain keyboard-only formal-trial decisions.

## Phase 3: Game Instrumentation and Adapter

- Automated: Piece IDs, forced stop reasons, event row shapes, and state event rows are unit tested.
- Manual: Run a short trial and inspect JSON export for pieces, state events, and game events.
- Documentation coverage: Adapter methods reference schema rows and end-reason behavior.

## Phase 4: Session Data Store and Schema Export

- Automated: JSON fixture validates, CSV headers match the schema, IndexedDB save/recover/clear works, diagnostic events export, and row widths match column counts.
- Manual: Export JSON/CSV/diagnostics after a short trial and reload from IndexedDB backup.
- Documentation coverage: Store and export methods describe why no migration layer exists and why diagnostics use the current schema.

## Phase 5: jsPsych WebGazer Flow

- Automated: Mock WebGazer rows are deterministic; camera selection, unavailable-device, permission-denied, secure-origin, Brown calibration, Brown precision, and setup-gating paths are covered.
- Manual: Lab webcam validation confirms Camera Selection, selected-camera persistence, selectable clicks per calibration point, WebGazer preview/face box updates, Brown calibration, Brown precision diagnostics, and gaze sample export.
- Documentation coverage: WebGazer bridge documents the jsPsych extension dependency, selected-camera constraints, fixed 9-point Brown-like target layout, variable repeated-click counts, diagnostics, and mock boundary.

## Phase 6: AOI Snapshot Pipeline and Gaze Classification

- Automated: Coordinate transforms, hidden rows, priority, interval boundaries, and visit collapsing are unit tested.
- Manual: Debug overlay matches visible active piece, ghost/landing zone, stack, and next piece.
- Documentation coverage: AOI modules explain coordinate-frame choices and priority rules.

## Phase 7: Trial Recording and Replay

- Automated: Recorder supported/unsupported branches are tested; replay time maps to gaze/AOI timestamps; replay legend, full-height layout, current gaze marker, previous gaze trail, and trail-count control are covered.
- Manual: Record one real trial and confirm video playback, AOI overlays, red current marker, blue prior markers, connecting trail, piece jump, and import replay work.
- Documentation coverage: Recording and replay modules document why video replaces deterministic reconstruction and why replay markers are fixation-like gaze samples rather than true fixation events.

## Phase 8: Analysis View, End-to-End Validation, and Requirement Refinement

- Automated: Full Playwright happy path with mocks, fixture analysis totals, export/import round trip, and browser-matrix checks are tested where the required browsers are installed.
- Manual: Run Camera Selection, Brown calibration, trial, replay, analysis, export/import, and reload previous session before coding the next refinement.
- Documentation coverage: Analysis labels, WebGazer setup metrics, replay overlays, diagnostics, and summaries map back to the current schema only.
