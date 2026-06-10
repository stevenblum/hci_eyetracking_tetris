# Functional Requirements Audit

Last reviewed: 2026-06-05

This audit maps the planning requirements to the current MVP implementation. It is intentionally conservative: a requirement is not marked fully covered if it still depends on manual lab validation, a future UI refinement, or a broader analysis feature. Test evidence is mapped in `docs/REQUIREMENTS_TEST_TRACEABILITY.md`.

## Covered by Current Code and Automated Tests

- Static browser app: Vite single-page app with relative build assets for GitHub Pages-style static hosting (`FR-DEP-001`, `FR-DEP-002`, `FR-DEP-003`, `FR-DEP-005`).
- Core views: the combined Setup/session route, Play, Replay, Analysis, and Export render through the left-sidebar shell (`FR-UI-001`, `FR-UI-002`, `FR-UI-003`, `FR-UI-004`, `FR-UI-005`, `FR-UI-006`).
- Stable play layout: desktop trials use a full-height play surface with no document scroll, CSS-scaled Tetris canvas, and AOI capture scaled from rendered canvas bounds (`FR-UI-007`, `FR-UI-009`).
- Debug overlay: formal trials default to no live overlay, but researchers can enable a play-screen debug overlay showing current gaze and AOI rectangles (`FR-UI-008`, `FR-EYE-010`).
- Experiment flow: camera selection, Brown-style WebGazer camera positioning, variable clicks per calibration point, precision, practice trial, main trial, post-trial response, replay, analysis, and export are organized through the single-page workflow. WebGazer setup runs through one jsPsych timeline with no separate ROI validation gate, and the Tetris task runs through the custom jsPsych-style trial runner (`FR-EXP-001`, `FR-EXP-004`).
- Trial configuration: trial mode, duration limit, start level, fall interval, preview enabled, and ghost enabled are configured through the Play panel and stored in trial rows; completing a practice trial advances the next trial selection to main (`FR-EXP-003`, `FR-EXP-007`).
- Main trial execution and end reasons: timed, game-over, quit, recording, and WebGazer error paths are represented by controlled end/status fields (`FR-EXP-005`, `FR-EXP-008`).
- Post-trial questions: workload, difficulty, frustration, and strategy responses can be saved per trial and exported in the current schema (`FR-EXP-006`).
- Tetris instrumentation: browser canvas Tetris, 10x20 visible board, hidden rows, sequential piece IDs, piece state events, keyboard input events, board metrics including height, holes, aggregate height, and bumpiness, next preview, and optional ghost projection are implemented (`FR-GAME-001` through `FR-GAME-013`).
- WebGazer bridge: real mode uses jsPsych's WebGazer extension APIs, exact selected-camera constraints, WebGazer-owned face feedback, Brown repeated-click calibration with fixed 9 target locations and selectable 1/3/5/8/9 clicks per point, Brown precision metrics, and extension-callback sampling at 34 ms. CI tests cover deterministic mock setup/sampling and real-path browser-safe behavior (`FR-EYE-001`, `FR-EYE-005`, `FR-EYE-006`, `FR-EYE-007`, `FR-EYE-008`, `FR-EYE-009`).
- AOI pipeline: static board/next/score AOIs, active piece, landing zone, danger zone, one full-width placed-stack AOI, interval snapshots, priority classification, all-overlap classification rows, AOI visits, and piece-level AOI summaries are implemented (`FR-AOI-001` through `FR-AOI-011`).
- Data/export: one current in-memory schema, column-oriented JSON tables, numeric code columns for repeated labels, JSON export, CSV exports, raw gaze preservation, dictionaries, IndexedDB backup/recovery/clear, local-only storage, and recording metadata/media export are implemented (`FR-DATA-001` through `FR-DATA-011`).
- Replay MVP: active-session replay and imported-session replay from JSON plus a separate WebM file are supported. The replay plots recorded video playback, timeline scrub, play/pause/restart controls, a red current fixation-like gaze marker, blue previous fixation-like markers, a connecting gaze trail, AOI rectangles for active piece, landing zone, placed stack, next-piece panel, score/status panel, danger zone, and board, a replay legend, piece jump navigation, synchronized piece details, and recording-based replay (`FR-REPLAY-001` through `FR-REPLAY-010`).
- Analysis MVP: trial summaries, piece summaries, AOI visits, dwell times/percentages, AOI transitions/sequences, action counts, preview-use measures, planning-before-action measures, performance linkage fields for lines, holes, height, aggregate height, and bumpiness, and gaze quality metrics are displayed/exported (`FR-ANA-001` through `FR-ANA-010`).
- HCI interpretation data: piece summaries include expected-vs-observed AOI sequence comparisons, first active-piece look, first stack look, first landing-zone look, first action, first rotation, post-lock feedback looks, before-action planning flags, and compact student-facing labels for planning, sequence, preview, and feedback (`FR-HCI-001` through `FR-HCI-005`).
- Performance/data handling: event-based game logging, raw gaze storage, canvas-only recording, no webcam video storage, rounded sample values where generated by the bridge, deferred post-trial analysis, and piece-indexed row ranges are implemented (`FR-PERF-002`, `FR-PERF-003`, `FR-PERF-003A`, `FR-PERF-004`, `FR-PERF-005`, `FR-PERF-006`, `FR-PERF-007`).
- Lab mode: data remains local, export/import status discloses local storage, no automatic upload exists, session/participant identifiers are used, and local data can be cleared (`FR-LAB-001` through `FR-LAB-005`).
- Diagnostics: optional detailed logging records camera selection, WebGazer setup, calibration clicks, face tracking, precision samples, setup errors, and recent diagnostic summaries in the current `diagnostic_events` schema table.
- Export errors: JSON, CSV, recording, and import failures update the export status line for the researcher (`FR-ERR-004`).
- Session recovery: the app attempts to recover the latest valid IndexedDB backup on reload and still keeps manual recovery available (`FR-ERR-005`).

## Partial or Manual Coverage

- Browser matrix (`FR-DEP-004`): `npm run test:e2e` runs the default Playwright suite, `npm run test:e2e:installed` runs every installed Playwright browser, and `npm run test:e2e:browser-matrix` runs Chromium, Firefox, and WebKit when installed. Chrome/Edge/Firefox with real webcam and recording support still require the manual checks in `docs/LAB_VALIDATION_CHECKLIST.md`.
- Setup guidance and errors (`FR-EYE-002`, `FR-EYE-003`, `FR-EYE-004`, `FR-ERR-001`, `FR-ERR-002`, `FR-ERR-003`): the Setup route loads camera choices, validates selected camera streams, lets the researcher choose 1, 3, 5, 8, or 9 clicks per calibration point, runs the jsPsych WebGazer setup path across all 9 target locations, stores Brown precision metrics, stores calibration regression diagnostics, supports recalibration messaging, and writes error rows. Real webcam permission, face tracking, calibration quality, and precision must still be verified with `docs/LAB_VALIDATION_CHECKLIST.md`.
- Smooth gameplay (`FR-PERF-001`): automated e2e covers a short keyboard trial while gaze and recording paths are active, but perceived smoothness with a real webcam still requires the manual lab checks in `docs/LAB_VALIDATION_CHECKLIST.md`.

## Next Implementation Priorities

1. Run `docs/LAB_VALIDATION_CHECKLIST.md` in Chrome, Edge, and Firefox with a real webcam and record browser-specific results.
2. Use replay sessions from real participants to decide whether true fixation detection is needed beyond the current fixation-like gaze markers.
