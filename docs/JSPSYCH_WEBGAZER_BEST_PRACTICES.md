# jsPsych and WebGazer Best Practices

This document captures implementation practices learned while building the Tetris eye-tracking MVP. It is written for future maintainers who need to adjust calibration, trial gaze collection, replay, or lab validation without re-learning the same browser and WebGazer constraints.

## Setup Architecture

- Keep jsPsych and WebGazer isolated behind a bridge module. The rest of the app should ask for setup status and gaze rows, not manipulate WebGazer directly.
- Use one real setup path. Avoid parallel calibration flows because they create confusing metrics and make lab troubleshooting harder.
- Keep a deterministic mock path for automated tests, but make real WebGazer the default for lab use.
- Store setup output in a single current schema row such as `webgazer_runs`; do not add versioned or alternate schema shapes during MVP development.
- Treat setup quality metrics as researcher feedback during the MVP. The current app allows Play after `setup_completed = true` rather than blocking on a precision threshold.

## Camera Selection

- Enumerate cameras when Setup opens so researchers can choose before permission or validation steps.
- Browser labels may be generic before permission; enumerate again after permission to get human-readable labels.
- Validate the selected camera with `getUserMedia()` before WebGazer setup when possible, and show a preview so the researcher can confirm the device.
- Pass the selected camera to WebGazer using exact constraints: `deviceId: { exact: selectedCameraDeviceId }`.
- Do not silently fall back to another camera if the selected camera fails. Block setup and ask the researcher to choose another camera.
- Stop preview streams when switching cameras, starting WebGazer setup, changing sessions, or leaving the setup workflow. Shared camera streams can freeze or confuse WebGazer.

## Secure Origin

- Run real WebGazer setup on HTTPS or the literal `localhost` hostname.
- Do not rely on `127.0.0.1` for local WebGazer setup. Browser camera permission may pass there while WebGazer rejects the origin.
- Surface an app-specific error message when the origin is incompatible so researchers know exactly which URL to open.

## Brown-Style WebGazer Setup

- Keep WebGazer's official camera preview and face feedback visible during face positioning, calibration, and precision checks.
- Use WebGazer/native click calibration behavior for calibration clicks instead of recording target centers manually.
- Always use the full 9 calibration target locations: 4 corners, 4 edge points, and the center point last.
- Let researchers choose how many times each point must be clicked: `1`, `3`, `5`, `8`, or `9`. The MVP defaults to `5`.
- Use lower click counts only for quick troubleshooting. Fewer clicks produce fewer calibration samples and can reduce Brown precision.
- Hide the center point until the 8 outside points are complete.
- Show click counts near each target so researchers can see calibration progress without guessing.
- Clear old WebGazer calibration data before each participant setup run. This avoids cross-participant contamination.
- Use ridge regression and Kalman filtering to match the Brown demo behavior.
- Serve MediaPipe FaceMesh assets from a stable public path, such as `public/mediapipe/face_mesh`, because Vite does not automatically expose package assets from `node_modules`.

## Precision and Accuracy Metrics

- Use a Brown-style center precision check as the primary setup quality metric.
- During the center check, show live prediction points and retained scoring points when predictions are available. This makes failures easier to diagnose visually.
- Prefer WebGazer stored points when available, but record a direct-prediction fallback count so no-sample failures are distinguishable from poor precision.
- Store and display sample count, samples per second, mean pixel error, precision label, precision source, stored sample count, and direct sample count.
- Display unavailable precision as unavailable, not `0%`, when no usable samples exist.
- Do not hard-block Play on low precision during the MVP. Low quality should prompt recalibration and be recorded for later analysis.

## Trial Gaze Sampling

- Collect formal trial gaze through the jsPsych WebGazer extension at `sampling_interval: 34` ms.
- Normalize each sample into viewport `x` and `y`, trial-relative time, optional piece-relative time, confidence when available, and a validity flag.
- Keep formal trials keyboard-only so gaze, actions, and game state are easier to interpret.
- Avoid showing a live gaze dot during formal data collection unless it is part of the study design. Keep live gaze display for debug mode and replay.

## Coordinate Frames and AOIs

- Store gaze coordinates in browser viewport pixels.
- Capture layout and AOI rectangles in the same viewport coordinate frame as gaze.
- When the Tetris canvas is CSS-scaled, multiply game-local coordinates by rendered scale factors from `getBoundingClientRect()`.
- Keep the trial layout fixed and no-scroll during active trials. Scrolling invalidates the gaze-to-AOI coordinate mapping.
- Use interval-based AOI snapshots for replay and classification. Dynamic AOIs should close at state transitions.
- Use one placed-stack AOI from the highest occupied visible row to the bottom of the board. Do not create separate AOIs for every locked block unless future analysis requires it.

## Replay Interpretation

- Treat the recorded game video as the visual source of truth. Do not require deterministic Tetris reconstruction for replay.
- Plot the current fixation-like gaze marker as a red dot and configurable previous markers as blue dots connected by a line.
- Be explicit that these are fixation-like markers derived from gaze samples. The MVP does not compute true fixation events.
- Plot AOI rectangles from stored snapshots, including active piece, landing zone, placed stack, next-piece panel, score/status panel, danger zone, and board.
- Keep the replay legend synchronized with the same color mapping used by the canvas overlay.

## Diagnostics and Troubleshooting

- Add structured diagnostics for camera preview requests, setup start, origin/browser metadata, face tracking, calibration clicks, regression sample counts, precision samples, setup completion, and setup errors.
- Include `session_id`, `participant_id`, `webgazer_run_id`, and when relevant `trial_id` so diagnostics can be joined back to exported rows.
- Diagnostics must never change setup or trial behavior. Logging failures should be swallowed and reported only when useful.
- Keep a downloadable Diagnostics CSV for lab troubleshooting.
- When calibration quality is poor, inspect:
  - calibration-ready click count
  - `calibration_regression_sample_count`
  - `calibration_regression_samples_by_point`
  - `brown_precision_sample_count`
  - `brown_precision_sample_source`
  - `brown_stored_sample_count`
  - `brown_direct_sample_count`
  - video and face-feedback diagnostics

## Lab Workflow

1. Open the app over HTTPS or `http://localhost`.
2. Create a new session and confirm the participant ID.
3. Choose the camera in Camera Selection and validate the preview.
4. Keep the default 5 clicks per point for standard runs. Use fewer clicks for quick troubleshooting or more clicks when extra calibration samples are worth the setup time.
5. Run Brown-style WebGazer setup with the selected camera.
6. Review Brown precision, sample counts, clicks per point, and regression diagnostics.
7. Rerun setup if precision is low, unavailable, or face tracking looked unstable.
8. Run one practice trial, then one main keyboard-only trial.
9. Inspect Replay for video playback, gaze markers, gaze trail, AOIs, legend, and piece navigation.
10. Inspect Analysis for trial, piece, AOI visit, and quality tables.
11. Export JSON, CSV, diagnostics when enabled, and WebM media; then import JSON plus WebM to verify replay portability.

## Current MVP Limits

- Replay plots fixation-like gaze markers from gaze samples, not true fixation events.
- Webcam video is never recorded or exported.
- Calibration data is not saved across participants.
- Real webcam behavior still requires manual lab validation in Chrome, Edge, and Firefox.
