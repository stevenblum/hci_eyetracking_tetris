# Tetris Eye-Tracking MVP Architecture

This project is a static Vite + vanilla JavaScript browser application. It keeps one current schema and intentionally avoids migrations, legacy compatibility paths, and alternate architectures during MVP development.

## User-Facing Flow

1. The app shell uses a fixed left sidebar and a route-based main panel for Setup, Play, Replay, Analysis, and Export.
2. Setup combines session controls, camera selection, detailed diagnostics, and Brown-style WebGazer setup in one workflow.
3. Camera Selection enumerates available cameras, validates the selected camera stream, shows a preview, and stores the selected `deviceId` for WebGazer setup and trial sampling.
4. WebGazer setup runs through one Brown-like jsPsych timeline: camera positioning, 9 calibration target locations, a researcher-selected repeated-click count of 1, 3, 5, 8, or 9 clicks per point, center point last, and a 5-second center precision check.
5. Play runs keyboard-only Tetris trials with a fixed, no-scroll layout so viewport gaze coordinates and AOI rectangles remain aligned.
6. Replay uses the recorded game video as the visual source of truth, then overlays AOIs, a red current fixation-like gaze marker, blue previous markers, and a connecting gaze trail.
7. Analysis and Export read the same current session object; all data and media stay local to the browser unless the researcher downloads files.

## Runtime Components

1. `SessionDataStore` creates canonical in-memory tables, stores media object URLs, validates imports, and writes IndexedDB backups.
2. `AppLogger` writes optional structured diagnostics into `diagnostic_events` and mirrors useful messages to the console.
3. `WebGazerBridge` owns jsPsych/WebGazer setup, camera constraints, Brown precision metrics, mock setup for tests, and trial gaze sampling at 34 ms.
4. `JsPsychTetrisTrialRunner` coordinates the formal trial lifecycle and connects the game, gaze collection, recording, and post-trial analysis.
5. `ClassicTetris` renders the local instrumented Tetris game to a canvas.
6. `ClassicTetrisAdapter` converts game callbacks into pieces, piece state events, keyboard game events, AOI snapshots, and trial rows.
7. `AoiBuilder` captures static and dynamic AOI rectangles in the same viewport coordinate frame as gaze.
8. `AoiClassifier` and `AnalysisBuilder` produce gaze classifications, AOI visits, piece summaries, and trial summaries after each trial.
9. `TrialRecorder` captures the game canvas/stage with `canvas.captureStream()` and `MediaRecorder` when the browser supports it.
10. `ReplayController` synchronizes video time, gaze samples, AOI snapshots, piece rows, and detail panels using trial-relative timestamps.
11. `ExportService` exports JSON, CSV tables, diagnostic events, and available WebM media artifacts.

## Documentation Standard

Every exported function/class has JSDoc explaining intent, requirement/schema mapping, and important design choices. Public class methods are covered by lint, and non-trivial internal helpers are documented where the reason for the implementation would not be obvious from the code alone.

## MVP Constraints

- Keyboard-only formal trials.
- jsPsych WebGazer sampling interval is fixed at 34 ms.
- WebGazer setup is Brown-style, uses visible WebGazer-owned camera feedback, always uses the full 9 calibration target locations that produced usable Brown precision in lab testing, and defaults to 5 clicks per point.
- Trial recordings capture only the Tetris canvas/stage, never webcam video or the desktop.
- Replay plots fixation-like gaze markers from gaze samples; it does not yet compute true fixation events.
- Replay is based on recorded video plus gaze/AOI overlays, not deterministic game reconstruction.
- Calibration data is not saved across participants.
- The schema may be refined, but only as the single current schema.
