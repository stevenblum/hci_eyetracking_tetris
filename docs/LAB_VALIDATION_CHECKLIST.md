# Lab Validation Checklist

Use this checklist for real WebGazer and recording validation in the lab. Automated tests cover the mock and browser-safe paths; these checks cover webcam, browser permission, calibration quality, and MediaRecorder behavior that CI cannot verify.

## Browser Matrix

Run the full workflow in current stable desktop versions of:

- Chrome
- Edge
- Firefox

Before manual webcam checks, run `npm run test:e2e:installed` to exercise every Playwright browser installed on the lab machine. On CI or a fully provisioned lab machine, run `npm run test:e2e:browser-matrix` after `npx playwright install chromium firefox webkit`.

## Per-Browser Workflow

1. Open the app from the intended static or local build URL.
2. Create a new session and enter a participant ID.
3. Disable deterministic mock gaze in Setup.
4. In **Camera Selection**, confirm the dropdown loads available cameras when Setup opens.
5. Choose the intended camera, click **Validate Camera** if needed, and confirm the preview uses the selected camera.
6. Switch cameras after validation and confirm the preview switches. Switch back to the intended camera before calibration.
7. In **Calibration**, confirm **Clicks Per Calibration Point** defaults to `5` and offers `1`, `3`, `5`, `8`, and `9`.
8. Keep the default `5` clicks per point for standard runs. Use `1` or `3` only for quick troubleshooting, and use `8` or `9` when extra calibration samples are worth the longer setup time.
9. Confirm **Run WebGazer Setup** is highlighted after camera validation and before completed WebGazer setup.
10. Enable detailed diagnostics if this is a troubleshooting or pilot-validation run.
11. Click **Run WebGazer Setup** and complete WebGazer camera positioning using the selected camera. Confirm the WebGazer-owned preview, face box, and face feedback continue updating while the face-positioning screen is open.
12. Complete Brown-style calibration:
   - all 9 calibration target locations
   - selected number of clicks per point
   - center point hidden until the outside points are complete
   - click count visible beside each calibration point
13. Complete the 5-second Brown-style center precision check. Confirm red live prediction points and retained blue scoring points appear during the check when predictions are available.
14. Confirm setup returns to the Setup route with a Brown precision status message and no participant-facing second validation gate.
15. Confirm `webgazer_runs` contains one row with:
   - `mode = real`
   - `setup_completed = true`
   - `status = completed`
   - `calibration_clicks_per_point` equals the selected dropdown value
   - `calibration_total_clicks = 9 * calibration_clicks_per_point`
   - `calibration_tracker_ready = true`
   - `calibration_tracker_ready_clicks` is close to `calibration_total_clicks`
   - `calibration_regression_sample_count` is close to `calibration_total_clicks`
   - `calibration_regression_samples_by_point` increases across all 9 completed points
   - `calibration_points` contains exactly 9 point coordinates
   - `brown_precision_percent` recorded with `brown_precision_label`
   - `brown_precision_sample_count` greater than zero when WebGazer stored usable predictions
   - `brown_precision_mean_error_px` is non-null when stored points are available
   - `brown_precision_samples_per_sec` recorded when samples are available
   - `brown_precision_sample_source` identifies WebGazer stored points or fallback direct predictions
   - `brown_stored_sample_count` and `brown_direct_sample_count` are recorded
16. If Brown precision is below 70 or unavailable, record the selected clicks per calibration point, calibration-ready click count, WebGazer regression sample count, Brown sample count, Hz, mean pixel error, and precision sample source; then rerun setup and confirm a second `webgazer_runs` row is added rather than overwriting the first row.
17. If detailed diagnostics were enabled, confirm `diagnostic_events` includes setup, camera, calibration, precision, and complete/error events. Download Diagnostics CSV if troubleshooting is needed.
18. Run one practice trial, quit or let it time out, and confirm the next trial selector advances to Main.
19. Run one main trial with keyboard controls only.
20. Confirm gameplay remains responsive while gaze collection and canvas recording are active.
21. Confirm `gaze_samples` rows are created with viewport `x`, `y`, `t_trial_ms`, `t_piece_ms`, and `valid` values.
22. Confirm `trial_summaries.observed_sampling_rate_hz` is near the expected 29.4 Hz target for `sampling_interval = 34`.
23. Confirm canvas recording status is `recorded` when MediaRecorder is supported, or `unsupported` with a clear error when unsupported.
24. Open Replay and confirm video playback, scrubber, play/pause/restart, and piece jump controls work.
25. Confirm Replay plots AOI rectangles for active piece, landing zone, placed stack, board, next-piece panel, score/status panel, and danger zone when present.
26. Confirm Replay plots a red current fixation-like gaze marker, blue previous markers, and a connecting trail. Use the **Previous Gaze Points** dropdown to check `0`, `1`, `3`, `5`, and `10`.
27. Confirm the Replay legend includes **Current gaze**, **Previous gaze trail**, **Placed stack**, and the other AOI labels.
28. Open Analysis and confirm trial, piece, AOI visit, and quality tables populate.
29. Export JSON, CSV, Diagnostics CSV when enabled, and WebM artifacts; then import the JSON plus WebM and confirm Replay works from the imported session.

## Manual Result Log

Record one line per browser:

| Date | Browser/version | OS | Camera selection/preview | Clicks per point | Brown precision | Precision source/counts | Regression samples | Observed Hz | Recording status | Replay overlays/import work | Diagnostics notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |
