import { WEBGAZER_SAMPLING_INTERVAL_MS } from '../constants/schema.js';
import { nowIso } from '../utils/clock.js';
import { pieceTime, trialTime } from '../utils/clock.js';

// Calibration geometry is fixed by design. The researcher-facing dropdown
// changes repeated clicks per target, not the number of target locations,
// because reducing the 9 Brown-style screen positions removed edge/corner
// coverage and caused poor WebGazer precision during lab testing.
const CALIBRATION_POINTS = [
  [10, 10],
  [50, 10],
  [90, 10],
  [10, 50],
  [50, 50],
  [90, 50],
  [10, 90],
  [50, 90],
  [90, 90],
];

export const DEFAULT_CALIBRATION_CLICKS_PER_POINT = 5;
export const CALIBRATION_CLICKS_PER_POINT_OPTIONS = [1, 3, 5, 8, 9];
const BROWN_CALIBRATION_CLICKS_PER_POINT = DEFAULT_CALIBRATION_CLICKS_PER_POINT;
const BROWN_PRECISION_DURATION_MS = 5000;
const BROWN_PRECISION_MAX_SAMPLES = 50;
const CALIBRATION_TRACKER_READY_TIMEOUT_MS = 5000;
const CALIBRATION_TRACKER_READY_POLL_MS = 100;
const WEBGAZER_FACE_TRACKER_WATCHDOG_MS = 750;
const WEBGAZER_FACE_TRACKER_STATUS_MS = 5000;
const WEBGAZER_MEDIAPIPE_FACE_MESH_PATH = '/mediapipe/face_mesh';
// These positions intentionally mirror Brown's demo layout instead of using a
// uniform CSS grid. The top-left target is shifted right so WebGazer's official
// camera preview and face box can remain visible without covering a target.
const BROWN_CALIBRATION_POINT_POSITIONS = {
  '10,10': { top: '70px', left: '340px' },
  '50,10': { top: '70px', left: '50vw' },
  '90,10': { top: '70px', right: '2vw' },
  '10,50': { top: '50vh', left: '2vw' },
  '50,50': { top: '50vh', left: '50vw' },
  '90,50': { top: '50vh', right: '2vw' },
  '10,90': { bottom: '2vw', left: '2vw' },
  '50,90': { bottom: '2vw', left: '50vw' },
  '90,90': { bottom: '2vw', right: '2vw' },
};
const WEBGAZER_CAMERA_SIZE_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 480 },
};
// jsPsych plugin metadata uses numeric ParameterType enum values. Keeping the
// two values needed by the local validator here avoids a static jsPsych import,
// so real WebGazer dependencies still load only when setup starts.
const JSPSYCH_PARAMETER_TYPE = {
  INT: 2,
  FUNCTION: 4,
  OBJECT: 12,
};

/**
 * Normalizes the researcher-selected repeated-click count.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-LAB-004`.
 * The app always uses the full 9-point Brown-like target layout; this setting
 * changes only how many times the participant clicks each point, which controls
 * the number of calibration samples without changing screen coverage.
 *
 * @param {number | string | null | undefined} value Requested clicks per point.
 * @returns {number} Supported click count.
 */
export function normalizeCalibrationClicksPerPoint(value = DEFAULT_CALIBRATION_CLICKS_PER_POINT) {
  const numericValue = Number(value);
  return CALIBRATION_CLICKS_PER_POINT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_CALIBRATION_CLICKS_PER_POINT;
}

/**
 * Runs the Brown-style repeated-click WebGazer calibration.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, `FR-ERR-003`, and
 * `FR-LAB-004`.
 * Brown's example collects repeated samples per point, which gives the
 * regression model more stable click data than jsPsych's default one-click
 * calibration. This plugin deliberately uses WebGazer's native document-level
 * mouse listener, so the regression model receives the same actual click
 * coordinates as the Brown demo instead of a second app-specific target-center
 * calibration method. The target layout always remains the same 9 screen
 * locations; only the repeated-click count changes for shorter or longer runs.
 */
export class BrownRepeatedCalibrationPlugin {
  static info = {
    name: 'brown-repeated-webgazer-calibration',
    parameters: {
      calibration_points: {
        type: JSPSYCH_PARAMETER_TYPE.INT,
        default: CALIBRATION_POINTS,
        array: true,
      },
      clicks_per_point: {
        type: JSPSYCH_PARAMETER_TYPE.INT,
        default: BROWN_CALIBRATION_CLICKS_PER_POINT,
      },
      point_size: {
        type: JSPSYCH_PARAMETER_TYPE.INT,
        default: 14,
      },
      on_progress: {
        type: JSPSYCH_PARAMETER_TYPE.FUNCTION,
        default: null,
      },
      logger: {
        type: JSPSYCH_PARAMETER_TYPE.OBJECT,
        default: null,
      },
    },
  };

  /**
 * Creates a repeated-click calibration plugin.
 *
 * Requirement links: `FR-EYE-001` and `FR-EYE-003`.
 * The plugin uses the initialized jsPsych WebGazer extension rather than a
 * second WebGazer instance so setup and trial sampling share one camera model.
 *
 * @param {Record<string, unknown>} jsPsych jsPsych runtime.
 */
  constructor(jsPsych) {
    this.jsPsych = jsPsych;
  }

  /**
 * Presents all non-center calibration targets, then the center target last.
 *
 * Requirement links: `FR-EYE-003` and `FR-LAB-004`.
 * The center-last behavior mirrors Brown's demo and reduces accidental center
 * clicks before the surrounding screen geometry has been sampled.
 *
 * @param {HTMLElement} displayElement jsPsych display element.
 * @param {Record<string, unknown>} trial Calibration trial parameters.
 */
  trial(displayElement, trial) {
    const extension = this.jsPsych.extensions.webgazer;
    const logger = trial.logger ?? null;
    // Production setup passes the fixed 9-point Brown layout. The plugin keeps
    // the points parameter for unit tests and future controlled experiments, but
    // the app UI must vary only `clicksPerPoint` so sample density changes
    // without changing the calibrated screen geometry.
    const points = Array.isArray(trial.calibration_points) ? trial.calibration_points : CALIBRATION_POINTS;
    const clicksPerPoint = Number(trial.clicks_per_point ?? BROWN_CALIBRATION_CLICKS_PER_POINT);
    const pointSize = Number(trial.point_size ?? this.constructor.info.parameters.point_size.default);
    const centerIndex = findCenterPointIndex(points);
    // Brown's center target is presented last. Keeping that behavior matters for
    // the 9-point layout because outer points train the regression across the
    // visible screen before the central precision target is reused later.
    const hideCenterUntilOuterTargetsComplete = centerIndex >= 0 && points.length > 1;
    const clickCounts = new Array(points.length).fill(0);
    const regressionSamplesByPoint = new Array(points.length).fill(null);
    const completed = new Set();
    const canMeasureReadiness = canCheckCalibrationTrackerReadiness(extension);
    // Some WebGazer/browser combinations visually show the preview before eye
    // features are ready. When the extension exposes readiness, clicks stay
    // disabled briefly so the researcher does not collect 45 UI clicks that add
    // few or no regression samples.
    let calibrationEnabled = !canMeasureReadiness;
    let trackerReady = !canMeasureReadiness;
    let trackerReadyElapsedMs = canMeasureReadiness ? null : 0;
    let trackerReadyClicks = 0;
    let lastRegressionSampleCount = getRegressionSampleCount(extension);

    // The Brown-like setup is intentionally a fresh per-participant calibration:
    // clear old regression data, keep the official preview visible, and start
    // WebGazer's native document click listener. We do not manually call
    // `calibratePoint()` here because the Brown demo trains from actual click
    // coordinates recorded by WebGazer itself.
    extension.resetCalibration?.();
    extension.resume?.();
    extension.showVideo?.();
    extension.showPredictions?.();
    extension.startMouseCalibration?.();
    logDiagnostic(logger, 'info', 'calibration', 'calibration', 'calibration_plugin_start', 'Brown repeated-click calibration started.', {
      points,
      clicks_per_point: clicksPerPoint,
      point_size_px: pointSize,
      center_index: centerIndex,
      can_measure_tracker_readiness: canMeasureReadiness,
      initial_regression_sample_count: lastRegressionSampleCount,
      viewport: viewportDiagnostics(),
    });
    displayElement.innerHTML = `
      <div id="brown-calibration-container" data-testid="brown-calibration-container">
        <canvas id="plotting_canvas" data-testid="plotting-canvas"></canvas>
        <div class="brown-calibration-instructions">
          <strong>Calibration</strong>
          <span>Look at each point and click it ${clicksPerPoint} times.</span>
          <span data-testid="brown-calibration-readiness">${canMeasureReadiness ? 'Warming up WebGazer eye tracking before clicks are recorded.' : 'Calibration ready.'}</span>
        </div>
      </div>
    `;
    const container = displayElement.querySelector('#brown-calibration-container');
    const readinessElement = displayElement.querySelector('[data-testid="brown-calibration-readiness"]');
    sizePlottingCanvas(container.querySelector('#plotting_canvas'));

    const setCalibrationEnabled = (enabled) => {
      calibrationEnabled = enabled;
      for (const button of container.querySelectorAll('.brown-calibration-point')) {
        if (!completed.has(Number(button.dataset.index))) {
          button.disabled = !enabled;
        }
      }
    };

    points.forEach((point, index) => {
      const button = document.createElement('button');
      const countLabel = document.createElement('span');
      button.type = 'button';
      button.className = 'brown-calibration-point';
      button.dataset.index = String(index);
      button.dataset.testid = `brown-calibration-point-${index + 1}`;
      button.style.width = `${pointSize}px`;
      button.style.height = `${pointSize}px`;
      applyBrownCalibrationPointPosition(button, point, 'point');
      button.style.opacity = '0.2';
      button.disabled = !calibrationEnabled;
      countLabel.className = 'brown-calibration-count';
      countLabel.dataset.forIndex = String(index);
      countLabel.dataset.testid = `brown-calibration-count-${index + 1}`;
      applyBrownCalibrationPointPosition(countLabel, point, 'count');
      countLabel.style.setProperty('--calibration-point-size', `${pointSize}px`);
      countLabel.textContent = '0';
      if (hideCenterUntilOuterTargetsComplete && index === centerIndex) {
        // The center is still part of the fixed 9-point set; hiding it only
        // controls ordering so participants cannot finish the center before the
        // surrounding screen has been sampled.
        button.hidden = true;
        button.style.display = 'none';
        countLabel.hidden = true;
        countLabel.style.display = 'none';
      }
      button.addEventListener('click', async (event) => {
        if (!calibrationEnabled) {
          logDiagnostic(logger, 'debug', 'calibration', 'calibration', 'calibration_click_ignored', 'Calibration click ignored because tracker readiness gate is still closed.', {
            point_index: index,
            click_count_for_point: clickCounts[index],
            click: mouseEventDiagnostics(event),
          });
          return;
        }
        const regressionBefore = lastRegressionSampleCount;
        const clickTrackerReady = canMeasureReadiness
          ? await refreshCalibrationTrackerFeatures(extension)
          : true;
        const prediction = typeof extension?.getCurrentPrediction === 'function'
          ? await getCurrentPredictionSafely(extension)
          : null;
        if (clickTrackerReady) {
          trackerReadyClicks += 1;
        }
        clickCounts[index] += 1;
        countLabel.textContent = String(clickCounts[index]);
        button.style.opacity = String(Math.min(1, 0.2 + clickCounts[index] * 0.2));
        trial.on_progress?.({
          completed_points: completed.size,
          total_points: points.length,
          total_clicks: clickCounts.reduce((sum, count) => sum + count, 0),
          tracker_ready_clicks: trackerReadyClicks,
          calibration_regression_sample_count: getRegressionSampleCount(extension),
        });
        const regressionAfter = getRegressionSampleCount(extension);
        const targetRect = button.getBoundingClientRect();
        logDiagnostic(logger, 'debug', 'calibration', 'calibration', 'calibration_point_click', 'Calibration point click recorded.', {
          point_index: index,
          point_number: index + 1,
          click_count_for_point: clickCounts[index],
          total_clicks: clickCounts.reduce((sum, count) => sum + count, 0),
          tracker_ready: clickTrackerReady,
          tracker_ready_clicks: trackerReadyClicks,
          click: mouseEventDiagnostics(event),
          target_rect: domRectDiagnostics(targetRect),
          target_center: {
            x: Math.round((targetRect.left + targetRect.width / 2) * 10) / 10,
            y: Math.round((targetRect.top + targetRect.height / 2) * 10) / 10,
          },
          prediction_probe: predictionDiagnostics(prediction),
          regression_sample_count_before: regressionBefore,
          regression_sample_count_after: regressionAfter,
          regression_sample_count_delta: Number.isFinite(regressionAfter) && Number.isFinite(regressionBefore)
            ? regressionAfter - regressionBefore
            : null,
        });
        lastRegressionSampleCount = regressionAfter;
        if (clickCounts[index] < clicksPerPoint) {
          return;
        }
        completed.add(index);
        button.classList.add('complete');
        button.style.backgroundColor = 'yellow';
        button.disabled = true;
        regressionSamplesByPoint[index] = getRegressionSampleCount(extension);
        logDiagnostic(logger, 'info', 'calibration', 'calibration', 'calibration_point_complete', 'Calibration point completed.', {
          point_index: index,
          point_number: index + 1,
          completed_points: completed.size,
          total_points: points.length,
          total_clicks: clickCounts.reduce((sum, count) => sum + count, 0),
          regression_sample_count: regressionSamplesByPoint[index],
          regression_samples_by_point: regressionSamplesByPoint,
        });
        if (hideCenterUntilOuterTargetsComplete && completed.size === points.length - 1 && !completed.has(centerIndex)) {
          // Reveal the center only after all eight outer points are complete.
          // This preserves the Brown-style 9-target order while still allowing
          // tests to pass smaller custom point arrays into the plugin.
          const centerButton = container.querySelector(`[data-index="${centerIndex}"]`);
          const centerCountLabel = container.querySelector(`[data-for-index="${centerIndex}"]`);
          centerButton.hidden = false;
          centerButton.style.removeProperty('display');
          centerButton.disabled = !calibrationEnabled;
          centerCountLabel.hidden = false;
          centerCountLabel.style.removeProperty('display');
        }
        if (completed.size >= points.length) {
          // Stop the native listener before finishing the jsPsych trial so
          // clicks on the following accuracy-check instructions are not added
          // to the calibration regression.
          extension.stopMouseCalibration?.();
          logDiagnostic(logger, 'info', 'calibration', 'calibration', 'calibration_complete', 'Brown repeated-click calibration completed.', {
            calibration_clicks_per_point: clicksPerPoint,
            calibration_total_clicks: clickCounts.reduce((sum, count) => sum + count, 0),
            calibration_tracker_ready: trackerReady,
            calibration_tracker_ready_elapsed_ms: trackerReadyElapsedMs,
            calibration_tracker_ready_clicks: trackerReadyClicks,
            calibration_regression_sample_count: getRegressionSampleCount(extension),
            calibration_regression_samples_by_point: regressionSamplesByPoint,
            expected_total_clicks: points.length * clicksPerPoint,
          });
          this.jsPsych.finishTrial({
            // Persist both concepts separately: `calibration_points` records the
            // fixed 9-location geometry, while `calibration_clicks_per_point`
            // records the researcher-selected sample density for this run.
            calibration_points: points,
            calibration_clicks_per_point: clicksPerPoint,
            calibration_total_clicks: clickCounts.reduce((sum, count) => sum + count, 0),
            calibration_tracker_ready: trackerReady,
            calibration_tracker_ready_elapsed_ms: trackerReadyElapsedMs,
            calibration_tracker_ready_clicks: trackerReadyClicks,
            calibration_regression_sample_count: getRegressionSampleCount(extension),
            calibration_regression_samples_by_point: regressionSamplesByPoint,
          });
        }
      });
      container.appendChild(button);
      container.appendChild(countLabel);
    });

    if (canMeasureReadiness) {
      waitForCalibrationTrackerReady(extension).then((result) => {
        trackerReady = result.ready;
        trackerReadyElapsedMs = Math.round(result.elapsedMs);
        setCalibrationEnabled(true);
        readinessElement.textContent = result.ready
          ? 'Tracker ready. Continue clicking each point while looking directly at it.'
          : 'Tracker readiness was not confirmed; continue only if the face box was green.';
      });
    }
  }
}

/**
 * Runs Brown's center-point precision check after calibration.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, `FR-ERR-003`, and
 * `FR-LAB-004`.
 * This is the primary lab-facing setup quality metric because it matches the
 * Brown demo that researchers can compare against directly.
 */
export class BrownPrecisionCheckPlugin {
  static info = {
    name: 'brown-webgazer-precision-check',
    parameters: {
      duration_ms: {
        type: JSPSYCH_PARAMETER_TYPE.INT,
        default: BROWN_PRECISION_DURATION_MS,
      },
      sampling_interval: {
        type: JSPSYCH_PARAMETER_TYPE.INT,
        default: WEBGAZER_SAMPLING_INTERVAL_MS,
      },
      max_samples: {
        type: JSPSYCH_PARAMETER_TYPE.INT,
        default: BROWN_PRECISION_MAX_SAMPLES,
      },
      logger: {
        type: JSPSYCH_PARAMETER_TYPE.OBJECT,
        default: null,
      },
    },
  };

  /**
 * Creates the Brown precision plugin.
 *
 * Requirement links: `FR-EYE-001` and `FR-EYE-004`.
 * The plugin enables WebGazer's own `storingPoints` ring buffer because
 * Brown's published demo calculates precision from `getStoredPoints()`. It
 * also polls the active jsPsych WebGazer extension directly during the same
 * center check because jsPsych-driven setups can produce usable predictions
 * without WebGazer's animation-loop buffer filling; the diagnostics expose
 * which source was ultimately scored.
 *
 * @param {Record<string, unknown>} jsPsych jsPsych runtime.
 */
  constructor(jsPsych) {
    this.jsPsych = jsPsych;
  }

  /**
 * Presents a center target and scores recent gaze predictions.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * The check always finishes after the requested duration; no-sample runs are
 * saved as needs-attention quality rather than blocking the setup timeline.
 *
 * @param {HTMLElement} displayElement jsPsych display element.
 * @param {Record<string, unknown>} trial Precision trial parameters.
 */
  trial(displayElement, trial) {
    const extension = this.jsPsych.extensions.webgazer;
    const logger = trial.logger ?? null;
    const durationMs = Number(trial.duration_ms ?? BROWN_PRECISION_DURATION_MS);
    const maxSamples = Number(trial.max_samples ?? BROWN_PRECISION_MAX_SAMPLES);
    displayElement.innerHTML = `
      <div id="brown-precision-container" data-testid="brown-precision-container">
        <canvas id="plotting_canvas" data-testid="plotting-canvas"></canvas>
        <div class="brown-precision-sample-layer" data-testid="brown-precision-sample-layer"></div>
        <div class="brown-precision-live-dot" data-testid="brown-precision-live-dot" hidden></div>
        <div class="brown-precision-target" data-testid="brown-precision-target"></div>
        <div class="brown-precision-instructions">
          <strong>Accuracy Check</strong>
          <span>Look at the center point and keep your head still.</span>
        </div>
      </div>
    `;
    const webgazer = getWebGazerRuntime(extension);
    const liveDot = displayElement.querySelector('[data-testid="brown-precision-live-dot"]');
    const sampleLayer = displayElement.querySelector('[data-testid="brown-precision-sample-layer"]');
    const directSamples = [];
    const directSampleSourceCounts = new Map();
    const samplingInterval = Number(trial.sampling_interval ?? WEBGAZER_SAMPLING_INTERVAL_MS);
    const targetCenter = {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
    };
    let polling = false;
    let precisionSampleUnsubscribe = null;
    let extensionSampleIntervalStarted = false;
    let storedPointWriteIndex = 0;
    let appStoredPointCount = 0;
    sizePlottingCanvas(displayElement.querySelector('#plotting_canvas'));
    // Brown's demo scores the last stored WebGazer points. Clear that buffer
    // before every run so a canceled or repeated setup cannot leak stale gaze
    // points into the next participant-facing accuracy score.
    clearBrownStoredPoints(webgazer, maxSamples);
    extension.showVideo?.();
    logDiagnostic(logger, 'info', 'calibration', 'precision', 'precision_start', 'Brown-style center precision check started.', {
      duration_ms: durationMs,
      max_samples: maxSamples,
      sampling_interval_ms: samplingInterval,
      target_center: targetCenter,
      viewport: viewportDiagnostics(),
      plotting_canvas: canvasDiagnostics(displayElement.querySelector('#plotting_canvas')),
      storing_points_before_enable: webgazer?.params?.storingPoints ?? null,
    });

    const recordDirectPrediction = (prediction, source) => {
      const sampleNumber = directSamples.length + 1;
      if (!isFinitePrediction(prediction)) {
        logDiagnostic(logger, 'trace', 'calibration', 'precision', 'precision_sample_missing', 'Precision prediction was unavailable.', {
          sample_index: sampleNumber,
          source,
          prediction: predictionDiagnostics(prediction),
        });
        return false;
      }
      // The precision screen stores app-collected samples in the same rolling
      // 50-point shape as Brown's demo. This keeps the score available when
      // WebGazer's internal drawing loop is quiet but predictions are live.
      const sample = {
        x: Number(prediction.x),
        y: Number(prediction.y),
        t: performance.now(),
      };
      directSamples.push(sample);
      directSampleSourceCounts.set(source, (directSampleSourceCounts.get(source) ?? 0) + 1);
      while (directSamples.length > maxSamples) {
        directSamples.shift();
      }
      const storedPointWritten = writeBrownStoredPrecisionSample(webgazer, sample, storedPointWriteIndex, maxSamples);
      if (storedPointWritten) {
        storedPointWriteIndex = (storedPointWriteIndex + 1) % maxSamples;
        appStoredPointCount += 1;
      }
      const plotted = renderPrecisionSampleVisuals(liveDot, sampleLayer, sample, maxSamples, logger);
      logDiagnostic(logger, 'trace', 'calibration', 'precision', 'precision_sample', 'Precision prediction sampled.', {
        sample_index: sampleNumber,
        source,
        prediction: predictionDiagnostics(prediction),
        scoring: brownSampleScoreDiagnostics(sample, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
        stored_point_written: storedPointWritten,
        app_stored_point_count: appStoredPointCount,
        direct_sample_source_counts: Object.fromEntries(directSampleSourceCounts),
        blue_dot_rendered: plotted,
      });
      return true;
    };

    const collectDirectSample = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        // Stored points are the Brown-compatible source, but direct prediction
        // polling keeps the red live dot and blue sample trail responsive and
        // gives diagnostics when the jsPsych runtime predicts gaze without
        // filling WebGazer's stored-point buffer.
        const result = await getCurrentPredictionFromSources(extension, webgazer);
        recordDirectPrediction(result.prediction, `direct_prediction_poll:${result.source}`);
      } finally {
        polling = false;
      }
    };

    const startPrecisionCollection = async () => {
      try {
        const resumeResult = typeof webgazer?.resume === 'function'
          ? webgazer.resume()
          : extension.resume?.();
        if (resumeResult && typeof resumeResult.then === 'function') {
          await resumeResult;
        }
      } catch {
        // Setup still records unavailable precision if WebGazer cannot resume;
        // throwing here would strand the participant on the accuracy screen.
      }
      extension.showVideo?.();
      extension.showPredictions?.();
      // Match Brown's precision mechanism by letting WebGazer's own animation
      // loop write into `getStoredPoints()` during the five-second center task.
      setBrownPointStorage(webgazer, true);
      if (typeof extension?.onGazeUpdate === 'function') {
        // The jsPsych extension only emits callbacks while its sample interval
        // is running. Subscribing here gives the accuracy check an active stream
        // immediately after calibration rather than relying on the visual
        // prediction dot loop alone.
        precisionSampleUnsubscribe = extension.onGazeUpdate((prediction) => {
          recordDirectPrediction(prediction, 'extension_sample_interval');
        });
      }
      if (typeof extension?.startSampleInterval === 'function') {
        extension.startSampleInterval(
          Number.isFinite(samplingInterval) && samplingInterval > 0
            ? samplingInterval
            : WEBGAZER_SAMPLING_INTERVAL_MS,
        );
        extensionSampleIntervalStarted = true;
      }
      logDiagnostic(logger, 'debug', 'calibration', 'precision', 'precision_storage_enabled', 'Enabled WebGazer stored-point collection.', {
        storing_points_after_enable: webgazer?.params?.storingPoints ?? null,
        extension_sample_interval_started: extensionSampleIntervalStarted,
        webgazer_ready: typeof webgazer?.isReady === 'function' ? webgazer.isReady() : null,
        video: webGazerVideoDiagnostics(),
      });

      // Brown's internal loop draws/stores blue points only when its animation
      // frame is producing predictions. This app-owned sampler makes the center
      // check observable even when that buffer stays empty in the jsPsych runtime.
      void collectDirectSample();
      const directSampleTimer = setInterval(
        () => {
          void collectDirectSample();
          // WebGazer's Brown demo keeps stored scoring points visible while the
          // accuracy check runs. Polling the stored-point buffer here keeps the
          // same researcher feedback even when direct prediction polling is
          // unavailable or slower than WebGazer's internal storage loop.
          renderStoredPrecisionDotsSafely(sampleLayer, webgazer?.getStoredPoints?.(), maxSamples, logger);
        },
        Number.isFinite(samplingInterval) && samplingInterval > 0
          ? samplingInterval
          : WEBGAZER_SAMPLING_INTERVAL_MS,
      );

      setTimeout(() => {
        clearInterval(directSampleTimer);
        if (extensionSampleIntervalStarted) {
          extension.stopSampleInterval?.();
        }
        precisionSampleUnsubscribe?.();
        setBrownPointStorage(webgazer, false);
        extension.hidePredictions?.();
        const viewport = {
          width: window.innerWidth,
          height: window.innerHeight,
          maxSamples,
          durationMs,
        };
        const storedPoints = webgazer?.getStoredPoints?.();
        const storedSummary = summarizeBrownStoredPrecision(storedPoints, viewport);
        const directSummary = summarizeBrownDirectPrecision(directSamples, viewport);
        const summary = chooseBrownPrecisionSummary(storedSummary, directSummary);
        renderStoredPrecisionDotsSafely(sampleLayer, storedPoints, maxSamples, logger);
        logDiagnostic(logger, 'info', 'calibration', 'precision', 'precision_complete', 'Brown-style center precision check completed.', {
          summary,
          stored_summary: storedSummary,
          direct_summary: directSummary,
          stored_points: storedPointDiagnostics(storedPoints, maxSamples),
          direct_samples: sampleSetDiagnostics(directSamples, viewport),
          direct_sample_source_counts: Object.fromEntries(directSampleSourceCounts),
          app_stored_point_count: appStoredPointCount,
          storing_points_after_disable: webgazer?.params?.storingPoints ?? null,
          video: webGazerVideoDiagnostics(),
        });
        this.jsPsych.finishTrial(summary);
      }, durationMs);
    };

    void startPrecisionCollection();
  }
}

/**
 * Estimates timestamped prediction sample rate without failing on sparse data.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, and `FR-ERR-003`.
 * Older helper paths and unit tests still pass timestamped samples through this
 * function; Brown stored points do not include timestamps, so the real setup
 * path uses a duration-based rate instead.
 *
 * @param {{t: number}[][]} samplesByPoint Samples grouped by collection window.
 * @returns {number | null} Estimated samples per second, or null.
 */
function calculateSampleRate(samplesByPoint) {
  const meanIntervals = [];
  for (const pointSamples of samplesByPoint) {
    if (pointSamples.length < 2) {
      continue;
    }
    const intervals = [];
    for (let index = 1; index < pointSamples.length; index += 1) {
      intervals.push(Number(pointSamples[index].t) - Number(pointSamples[index - 1].t));
    }
    const validIntervals = intervals.filter((value) => Number.isFinite(value) && value > 0);
    if (validIntervals.length) {
      meanIntervals.push(validIntervals.reduce((sum, value) => sum + value, 0) / validIntervals.length);
    }
  }
  if (!meanIntervals.length) {
    return null;
  }
  return 1000 / (meanIntervals.reduce((sum, value) => sum + value, 0) / meanIntervals.length);
}

/**
 * Positions calibration points with Brown's viewport geometry.
 *
 * Requirement links: `FR-EYE-003` and `FR-LAB-004`.
 * The top-left point is shifted right of the 320px WebGazer preview just like
 * Brown's demo so the official camera/face box can stay visible without
 * covering the first calibration target.
 *
 * @param {HTMLElement} element Calibration point or count badge.
 * @param {number[]} fallbackPoint Percent fallback when a custom grid is used.
 * @param {'point' | 'count'} role Element role for transform placement.
 */
function applyBrownCalibrationPointPosition(element, fallbackPoint, role) {
  const pointKey = `${Number(fallbackPoint[0])},${Number(fallbackPoint[1])}`;
  const position = BROWN_CALIBRATION_POINT_POSITIONS[pointKey] ?? {
    left: `${fallbackPoint[0]}%`,
    top: `${fallbackPoint[1]}%`,
  };
  for (const property of ['top', 'right', 'bottom', 'left']) {
    element.style[property] = position[property] ?? '';
  }
  element.style.transform = role === 'count'
    ? 'translate(calc(-50% + var(--calibration-point-size, 20px) / 2 - 2px), calc(-50% - var(--calibration-point-size, 20px) / 2 - 8px))'
    : 'translate(-50%, -50%)';
}

/**
 * Sizes the WebGazer plotting canvas to the viewport.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * WebGazer's Brown precision code draws stored prediction points into the
 * hard-coded `#plotting_canvas`; keeping that canvas full-window prevents
 * storage/drawing failures when `webgazer.params.storingPoints` is enabled.
 *
 * @param {HTMLCanvasElement | null} canvas Brown plotting canvas.
 */
function sizePlottingCanvas(canvas) {
  if (!canvas) {
    return;
  }
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

/**
 * Writes a logger event without letting diagnostics affect calibration.
 *
 * Requirement links: `FR-ERR-003`, `FR-DATA-001`, and `FR-LAB-004`.
 * WebGazer setup is already fragile across browsers and cameras, so every
 * logging call is guarded at this boundary instead of trusting call sites to
 * handle optional or partially mocked loggers correctly.
 *
 * @param {Record<string, Function> | null | undefined} logger Structured logger.
 * @param {'error' | 'warn' | 'info' | 'debug' | 'trace'} level Log level.
 * @param {string} category Event category.
 * @param {string} phase Setup phase.
 * @param {string} action Event action.
 * @param {string} message Human-readable message.
 * @param {Record<string, unknown>} [data] Structured details.
 */
function logDiagnostic(logger, level, category, phase, action, message, data = {}) {
  try {
    logger?.[level]?.(category, phase, action, message, data);
  } catch {
    // Diagnostics must never alter setup behavior.
  }
}

/**
 * Captures browser and viewport metadata for setup diagnostics.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Accuracy scoring uses viewport coordinates, so every run logs the frame of
 * reference used by calibration points, precision targets, and WebGazer output.
 *
 * @returns {Record<string, unknown>} Viewport diagnostics.
 */
function viewportDiagnostics() {
  return {
    width: globalThis.window?.innerWidth ?? null,
    height: globalThis.window?.innerHeight ?? null,
    device_pixel_ratio: globalThis.window?.devicePixelRatio ?? null,
    screen_width: globalThis.screen?.width ?? null,
    screen_height: globalThis.screen?.height ?? null,
  };
}

/**
 * Captures page-origin metadata relevant to WebGazer permission behavior.
 *
 * @returns {Record<string, unknown>} Origin diagnostics.
 */
function originDiagnostics() {
  const pageLocation = globalThis.location;
  return {
    href: pageLocation?.href ?? null,
    protocol: pageLocation?.protocol ?? null,
    hostname: pageLocation?.hostname ?? null,
    port: pageLocation?.port ?? null,
  };
}

/**
 * Captures browser identity used to compare lab machines.
 *
 * @returns {Record<string, unknown>} Browser diagnostics.
 */
function browserDiagnostics() {
  return {
    user_agent: globalThis.navigator?.userAgent ?? null,
    platform: globalThis.navigator?.platform ?? null,
    language: globalThis.navigator?.language ?? null,
  };
}

/**
 * Summarizes one canvas without storing a live DOM reference.
 *
 * @param {HTMLCanvasElement | null} canvas Canvas element.
 * @returns {Record<string, unknown> | null} Canvas diagnostics.
 */
function canvasDiagnostics(canvas) {
  if (!canvas) {
    return null;
  }
  return {
    width: canvas.width,
    height: canvas.height,
    rect: domRectDiagnostics(canvas.getBoundingClientRect()),
  };
}

/**
 * Summarizes one DOM rectangle for JSON diagnostics.
 *
 * @param {DOMRect | {left?: number, top?: number, width?: number, height?: number, right?: number, bottom?: number} | null} rect DOM rectangle.
 * @returns {Record<string, number | null> | null} Rectangle diagnostics.
 */
function domRectDiagnostics(rect) {
  if (!rect) {
    return null;
  }
  return {
    left: roundedNumber(rect.left),
    top: roundedNumber(rect.top),
    width: roundedNumber(rect.width),
    height: roundedNumber(rect.height),
    right: roundedNumber(rect.right),
    bottom: roundedNumber(rect.bottom),
  };
}

/**
 * Summarizes a mouse click in viewport coordinates.
 *
 * @param {MouseEvent} event Click event.
 * @returns {Record<string, unknown>} Click diagnostics.
 */
function mouseEventDiagnostics(event) {
  return {
    client_x: roundedNumber(event.clientX),
    client_y: roundedNumber(event.clientY),
    screen_x: roundedNumber(event.screenX),
    screen_y: roundedNumber(event.screenY),
    button: event.button,
    buttons: event.buttons,
    is_trusted: event.isTrusted,
  };
}

/**
 * Summarizes a WebGazer prediction without storing eye feature objects.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-005`, and `FR-ERR-003`.
 * The key diagnostic question is whether a prediction is absent, non-finite,
 * finite but offscreen, or plausible in viewport coordinates.
 *
 * @param {Record<string, unknown> | null} prediction WebGazer prediction.
 * @returns {Record<string, unknown>} Prediction diagnostics.
 */
function predictionDiagnostics(prediction) {
  const finite = isFinitePrediction(prediction);
  const x = roundedNumber(prediction?.x);
  const y = roundedNumber(prediction?.y);
  return {
    present: prediction !== null && prediction !== undefined,
    finite,
    x,
    y,
    offscreen: finite
      ? x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight
      : null,
    has_eye_features: Boolean(prediction?.eyeFeatures),
    all_prediction_count: Array.isArray(prediction?.all) ? prediction.all.length : null,
  };
}

/**
 * Computes per-sample Brown scoring diagnostics.
 *
 * @param {{x: number, y: number}} sample Prediction sample.
 * @param {{width: number, height: number}} viewport Viewport dimensions.
 * @returns {Record<string, unknown>} Brown sample scoring fields.
 */
function brownSampleScoreDiagnostics(sample, viewport) {
  const centerX = Number(viewport.width) / 2;
  const centerY = Number(viewport.height) / 2;
  const distance = Math.sqrt((centerX - Number(sample.x)) ** 2 + (centerY - Number(sample.y)) ** 2);
  const halfWindowHeight = Number(viewport.height) / 2;
  const precision = Number.isFinite(halfWindowHeight) && halfWindowHeight > 0
    ? Math.max(0, Math.min(100, 100 - (distance / halfWindowHeight) * 100))
    : null;
  return {
    center_x: roundedNumber(centerX),
    center_y: roundedNumber(centerY),
    distance_px: roundedNumber(distance),
    precision_contribution_percent: roundedNumber(precision),
  };
}

/**
 * Summarizes a set of direct precision samples.
 *
 * @param {{x: number, y: number, t?: number}[]} samples Direct samples.
 * @param {{width: number, height: number, maxSamples?: number}} viewport Viewport.
 * @returns {Record<string, unknown>} Sample set diagnostics.
 */
function sampleSetDiagnostics(samples, viewport) {
  const validSamples = samples.filter((sample) => Number.isFinite(Number(sample.x)) && Number.isFinite(Number(sample.y)));
  return {
    count: samples.length,
    valid_count: validSamples.length,
    first_valid: validSamples.length ? predictionDiagnostics(validSamples[0]) : null,
    last_valid: validSamples.length ? predictionDiagnostics(validSamples.at(-1)) : null,
    summary: summarizeBrownPrecision(validSamples, viewport),
  };
}

/**
 * Summarizes WebGazer's stored-point arrays.
 *
 * @param {unknown} storedPoints WebGazer stored points.
 * @param {number} maxSamples Maximum slots to inspect.
 * @returns {Record<string, unknown>} Stored-point diagnostics.
 */
function storedPointDiagnostics(storedPoints, maxSamples) {
  const xValues = Array.isArray(storedPoints?.[0]) ? storedPoints[0] : [];
  const yValues = Array.isArray(storedPoints?.[1]) ? storedPoints[1] : [];
  const samples = [];
  const length = Math.min(xValues.length, yValues.length, maxSamples);
  for (let index = 0; index < length; index += 1) {
    const sample = { x: Number(xValues[index]), y: Number(yValues[index]) };
    if (isFinitePrediction(sample)) {
      samples.push(sample);
    }
  }
  return {
    slot_count: length,
    finite_count: samples.length,
    first_finite: samples.length ? predictionDiagnostics(samples[0]) : null,
    last_finite: samples.length ? predictionDiagnostics(samples.at(-1)) : null,
  };
}

/**
 * Summarizes a MediaStream and video track settings.
 *
 * @param {MediaStream | null | undefined} stream Camera stream.
 * @returns {Record<string, unknown> | null} Stream diagnostics.
 */
function mediaStreamDiagnostics(stream) {
  if (!stream?.getTracks) {
    return null;
  }
  return {
    id: stream.id ?? null,
    active: stream.active ?? null,
    tracks: stream.getTracks().map((track) => ({
      kind: track.kind,
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      ready_state: track.readyState,
      settings: typeof track.getSettings === 'function' ? track.getSettings() : null,
    })),
  };
}

/**
 * Captures WebGazer's official video element state.
 *
 * @returns {Record<string, unknown> | null} Video diagnostics.
 */
function webGazerVideoDiagnostics() {
  const video = document.querySelector('#webgazerVideoFeed');
  if (!(video instanceof HTMLVideoElement)) {
    return null;
  }
  return {
    ready_state: video.readyState,
    paused: video.paused,
    ended: video.ended,
    current_time: roundedNumber(video.currentTime),
    video_width: video.videoWidth,
    video_height: video.videoHeight,
    rect: domRectDiagnostics(video.getBoundingClientRect()),
    stream: mediaStreamDiagnostics(video.srcObject),
  };
}

/**
 * Captures WebGazer's face feedback box state.
 *
 * @returns {Record<string, unknown> | null} Face feedback diagnostics.
 */
function faceFeedbackDiagnostics() {
  const box = document.querySelector('#webgazerFaceFeedbackBox');
  if (!(box instanceof HTMLElement)) {
    return null;
  }
  return {
    border_color: box.style.borderColor || null,
    display: box.style.display || getComputedStyle(box).display,
    rect: domRectDiagnostics(box.getBoundingClientRect()),
  };
}

/**
 * Captures selected WebGazer runtime settings.
 *
 * @param {Record<string, unknown> & {params?: Record<string, unknown>}} webgazer WebGazer runtime.
 * @returns {Record<string, unknown>} Runtime diagnostics.
 */
function webGazerRuntimeConfigDiagnostics(webgazer) {
  return {
    has_runtime: Boolean(webgazer),
    is_ready: typeof webgazer?.isReady === 'function' ? webgazer.isReady() : null,
    params: {
      camConstraints: webgazer?.params?.camConstraints ?? null,
      faceMeshSolutionPath: webgazer?.params?.faceMeshSolutionPath ?? null,
      storingPoints: webgazer?.params?.storingPoints ?? null,
      showGazeDot: webgazer?.params?.showGazeDot ?? null,
      showVideoPreview: webgazer?.params?.showVideoPreview ?? null,
      applyKalmanFilter: webgazer?.params?.applyKalmanFilter ?? null,
    },
  };
}

/**
 * Converts thrown values into plain diagnostic fields.
 *
 * @param {unknown} error Error-like value.
 * @returns {Record<string, unknown>} Error diagnostics.
 */
function errorDiagnostics(error) {
  return {
    name: error instanceof Error ? error.name : null,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
}

/**
 * Rounds finite numeric values for compact logs.
 *
 * @param {unknown} value Candidate number.
 * @returns {number | null} Rounded number or null.
 */
function roundedNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 10) / 10 : null;
}

/**
 * Moves the app-owned red live gaze dot during the Brown precision check.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * Brown's demo exposes the current prediction with WebGazer's gaze dot. The
 * MVP mirrors that behavior with a local element so researchers can tell
 * whether the active jsPsych extension is producing predictions even when
 * WebGazer's own red dot is hidden, stalled, or outside the jsPsych display.
 *
 * @param {HTMLElement | null} liveDot Red live prediction marker.
 * @param {{x: number, y: number}} sample Current prediction sample.
 */
function renderPrecisionLiveDot(liveDot, sample) {
  if (!liveDot) {
    return;
  }
  liveDot.hidden = false;
  liveDot.style.left = `${Math.round(Number(sample.x))}px`;
  liveDot.style.top = `${Math.round(Number(sample.y))}px`;
}

/**
 * Writes one precision sample into Brown's stored-point buffer without drawing.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, and `FR-LAB-004`.
 * WebGazer's internal storage path calls `drawCoordinates()` before
 * `storePoints()`, so a missing or hidden `plotting_canvas` can prevent
 * samples from reaching `getStoredPoints()`. The MVP explicitly writes the
 * app-polled prediction into the same 50-slot buffer before any plotting call,
 * keeping the accuracy score independent from whether red/blue fixation dots
 * are visible on screen.
 *
 * @param {Record<string, unknown> | null} webgazer WebGazer runtime.
 * @param {{x: number, y: number}} sample Finite prediction sample.
 * @param {number} index Ring-buffer slot to write.
 * @param {number} maxSamples Stored-point buffer size.
 * @returns {boolean} True when the sample was written to a stored-point buffer.
 */
function writeBrownStoredPrecisionSample(webgazer, sample, index, maxSamples) {
  const slot = Number.isFinite(Number(index)) && Number(maxSamples) > 0
    ? Number(index) % Number(maxSamples)
    : 0;
  if (typeof webgazer?.storePoints === 'function') {
    webgazer.storePoints(Number(sample.x), Number(sample.y), slot);
    return true;
  }
  const storedPoints = webgazer?.getStoredPoints?.();
  if (Array.isArray(storedPoints?.[0]) && Array.isArray(storedPoints?.[1])) {
    storedPoints[0][slot] = Number(sample.x);
    storedPoints[1][slot] = Number(sample.y);
    return true;
  }
  return false;
}

/**
 * Draws precision feedback without participating in scoring/storage.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Plotting is intentionally best-effort. The sample has already been stored
 * before this helper runs, so a DOM/CSS/canvas problem can hide the live red dot
 * or blue trail without reducing Brown stored-point sample counts to zero.
 *
 * @param {HTMLElement | null} liveDot Red live prediction marker.
 * @param {HTMLElement | null} sampleLayer Blue sample layer.
 * @param {{x: number, y: number}} sample Prediction sample.
 * @param {number} maxSamples Maximum markers to retain.
 * @param {import('../logging/AppLogger.js').AppLogger | null} logger Structured diagnostics logger.
 * @returns {boolean} True when plotting completed.
 */
function renderPrecisionSampleVisuals(liveDot, sampleLayer, sample, maxSamples, logger) {
  try {
    renderPrecisionLiveDot(liveDot, sample);
    appendPrecisionSampleDot(sampleLayer, sample, maxSamples);
    return true;
  } catch (error) {
    logDiagnostic(logger, 'warn', 'calibration', 'precision', 'precision_plot_failed', 'Precision sample was stored but visual plotting failed.', {
      prediction: predictionDiagnostics(sample),
      error: errorDiagnostics(error),
    });
    return false;
  }
}

/**
 * Adds one retained blue sample marker to the precision overlay.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * The blue points are intentionally kept on-screen during the five-second
 * check because researchers need immediate visual evidence of the sample set
 * being used or considered for the Brown-style precision score.
 *
 * @param {HTMLElement | null} layer Blue sample layer.
 * @param {{x: number, y: number}} sample Prediction sample.
 * @param {number} maxSamples Maximum markers to retain.
 */
function appendPrecisionSampleDot(layer, sample, maxSamples) {
  if (!layer) {
    return;
  }
  const dot = document.createElement('span');
  dot.className = 'brown-precision-sample-dot';
  dot.style.left = `${Math.round(Number(sample.x))}px`;
  dot.style.top = `${Math.round(Number(sample.y))}px`;
  layer.appendChild(dot);
  while (layer.childElementCount > maxSamples) {
    layer.firstElementChild?.remove();
  }
}

/**
 * Replaces diagnostic dots with WebGazer stored points when available.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * If Brown's native stored-point buffer worked, those are the points most
 * comparable to the online demo. Rendering them into the app layer keeps the
 * visible blue points aligned with the scored sample source whenever possible.
 *
 * @param {HTMLElement | null} layer Blue sample layer.
 * @param {unknown} storedPoints WebGazer `getStoredPoints()` return value.
 * @param {number} maxSamples Maximum stored points to render.
 */
function renderStoredPrecisionDots(layer, storedPoints, maxSamples) {
  if (!layer) {
    return;
  }
  const xValues = Array.isArray(storedPoints?.[0]) ? storedPoints[0] : [];
  const yValues = Array.isArray(storedPoints?.[1]) ? storedPoints[1] : [];
  const samples = [];
  const length = Math.min(xValues.length, yValues.length, maxSamples);
  for (let index = 0; index < length; index += 1) {
    const sample = { x: Number(xValues[index]), y: Number(yValues[index]) };
    if (isFinitePrediction(sample)) {
      samples.push(sample);
    }
  }
  if (!samples.length) {
    return;
  }
  layer.innerHTML = '';
  for (const sample of samples) {
    appendPrecisionSampleDot(layer, sample, maxSamples);
  }
}

/**
 * Best-effort renderer for stored precision points.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * This wrapper protects the scoring path from display failures: stored points
 * are read and scored even if the overlay layer is missing, hidden, or cannot
 * create dot elements.
 *
 * @param {HTMLElement | null} layer Blue sample layer.
 * @param {unknown} storedPoints WebGazer `getStoredPoints()` return value.
 * @param {number} maxSamples Maximum stored points to render.
 * @param {import('../logging/AppLogger.js').AppLogger | null} logger Structured diagnostics logger.
 */
function renderStoredPrecisionDotsSafely(layer, storedPoints, maxSamples, logger) {
  try {
    renderStoredPrecisionDots(layer, storedPoints, maxSamples);
  } catch (error) {
    logDiagnostic(logger, 'warn', 'calibration', 'precision', 'precision_stored_plot_failed', 'Stored precision points were available but visual plotting failed.', {
      stored_points: storedPointDiagnostics(storedPoints, maxSamples),
      error: errorDiagnostics(error),
    });
  }
}

/**
 * Returns the WebGazer runtime owned by the jsPsych extension.
 *
 * Requirement links: `FR-EYE-001` and `FR-EYE-004`.
 * jsPsych wraps WebGazer but still stores the runtime on the extension; falling
 * back to `globalThis.webgazer` keeps the Brown plugins testable with simple
 * mocks and matches WebGazer's browser-global demo style.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {Record<string, unknown> | null} WebGazer runtime.
 */
function getWebGazerRuntime(extension) {
  return extension?.webgazer ?? globalThis.webgazer ?? null;
}

/**
 * Reads the current WebGazer regression training sample count.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-LAB-004`.
 * A visually complete repeated-click calibration can still fail if WebGazer
 * had no live eye features during the clicks; this diagnostic exposes the
 * model rows that were actually added to the regression.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {number | null} Number of click samples in the first regression.
 */
function getRegressionSampleCount(extension) {
  if (typeof extension?.getRegressionSampleCount === 'function') {
    return toFiniteNumber(extension.getRegressionSampleCount());
  }
  const regression = getWebGazerRuntime(extension)?.getRegression?.()?.[0];
  const data = regression?.getData?.();
  return Array.isArray(data) ? data.length : null;
}

/**
 * Clears WebGazer's 50-slot Brown stored-point ring buffer.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * Brown does not clear between checks, but this MVP starts each participant
 * setup fresh so a failed or aborted precision check cannot reuse stale points.
 *
 * @param {Record<string, unknown> | null} webgazer WebGazer runtime.
 * @param {number} maxSamples Number of stored slots to clear.
 */
function clearBrownStoredPoints(webgazer, maxSamples) {
  if (typeof webgazer?.storePoints === 'function') {
    for (let index = 0; index < maxSamples; index += 1) {
      webgazer.storePoints(Number.NaN, Number.NaN, index);
    }
    return;
  }
  const storedPoints = webgazer?.getStoredPoints?.();
  if (Array.isArray(storedPoints?.[0]) && Array.isArray(storedPoints?.[1])) {
    storedPoints[0].fill(Number.NaN);
    storedPoints[1].fill(Number.NaN);
  }
}

/**
 * Enables or disables Brown's WebGazer stored-point capture flag.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * The WebGazer loop, not jsPsych, owns prediction storage during the accuracy
 * check; toggling this flag mirrors Brown's `store_points_variable()` helpers.
 *
 * @param {Record<string, unknown> | null} webgazer WebGazer runtime.
 * @param {boolean} enabled Whether WebGazer should store prediction points.
 */
function setBrownPointStorage(webgazer, enabled) {
  if (!webgazer?.params) {
    return;
  }
  webgazer.params.storingPoints = enabled;
}

/**
 * Converts Brown's `[xPast50, yPast50]` arrays into precision samples.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, and `FR-LAB-004`.
 * `getStoredPoints()` does not expose timestamps, so the returned sample rate
 * is the number of finite stored points divided by the five-second check
 * duration rather than the formal trial WebGazer sampling interval.
 *
 * @param {unknown} storedPoints WebGazer `getStoredPoints()` return value.
 * @param {{width: number, height: number, maxSamples?: number, durationMs?: number}} viewport Viewport and timing controls.
 * @returns {{brown_precision_percent: number | null, brown_precision_label: string, brown_precision_sample_count: number, brown_precision_mean_error_px: number | null, brown_precision_samples_per_sec: number | null}} Precision summary.
 */
export function summarizeBrownStoredPrecision(storedPoints, viewport) {
  const xValues = Array.isArray(storedPoints?.[0]) ? storedPoints[0] : [];
  const yValues = Array.isArray(storedPoints?.[1]) ? storedPoints[1] : [];
  const samples = [];
  const length = Math.min(xValues.length, yValues.length, viewport.maxSamples ?? BROWN_PRECISION_MAX_SAMPLES);
  for (let index = 0; index < length; index += 1) {
    samples.push({ x: Number(xValues[index]), y: Number(yValues[index]), t: index });
  }
  const summary = summarizeBrownPrecision(samples, viewport);
  const durationSeconds = Number(viewport.durationMs) > 0 ? Number(viewport.durationMs) / 1000 : null;
  return {
    ...summary,
    brown_precision_samples_per_sec: durationSeconds
      ? Math.round((summary.brown_precision_sample_count / durationSeconds) * 10) / 10
      : null,
  };
}

/**
 * Summarizes directly polled center-check predictions.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, and `FR-LAB-004`.
 * Direct polling uses the same WebGazer model and Brown distance formula as
 * stored points, but it guards against a jsPsych/WebGazer integration failure
 * where `params.storingPoints` remains empty while `getCurrentPrediction()`
 * still returns live gaze estimates.
 *
 * @param {{x: number, y: number, t: number}[]} samples Direct predictions.
 * @param {{width: number, height: number, maxSamples?: number, durationMs?: number}} viewport Viewport and timing controls.
 * @returns {{brown_precision_percent: number | null, brown_precision_label: string, brown_precision_sample_count: number, brown_precision_mean_error_px: number | null, brown_precision_samples_per_sec: number | null}} Precision summary.
 */
function summarizeBrownDirectPrecision(samples, viewport) {
  const summary = summarizeBrownPrecision(samples, viewport);
  const durationSeconds = Number(viewport.durationMs) > 0 ? Number(viewport.durationMs) / 1000 : null;
  return {
    ...summary,
    brown_precision_samples_per_sec: durationSeconds
      ? Math.round((summary.brown_precision_sample_count / durationSeconds) * 10) / 10
      : summary.brown_precision_samples_per_sec,
  };
}

/**
 * Chooses the precision source and preserves both source sample counts.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * The preferred Brown-compatible source is WebGazer's stored-point buffer, but
 * direct prediction polling is a valid fallback when the buffer is empty. The
 * source fields make the setup message actionable instead of collapsing every
 * no-buffer run into an unexplained 0-sample result.
 *
 * @param {Record<string, unknown>} storedSummary Summary from `getStoredPoints()`.
 * @param {Record<string, unknown>} directSummary Summary from direct polling.
 * @returns {Record<string, unknown>} Selected precision summary with diagnostics.
 */
function chooseBrownPrecisionSummary(storedSummary, directSummary) {
  const storedCount = Number(storedSummary.brown_precision_sample_count);
  const directCount = Number(directSummary.brown_precision_sample_count);
  const useStored = Number.isFinite(storedCount) && storedCount > 0;
  const useDirect = !useStored && Number.isFinite(directCount) && directCount > 0;
  const selected = useStored ? storedSummary : useDirect ? directSummary : storedSummary;
  return {
    ...selected,
    brown_precision_sample_source: useStored
      ? 'webgazer_stored_points'
      : useDirect
        ? 'direct_prediction_poll'
        : 'unavailable',
    brown_stored_sample_count: Number.isFinite(storedCount) ? storedCount : 0,
    brown_direct_sample_count: Number.isFinite(directCount) ? directCount : 0,
  };
}

/**
 * Finds the center calibration point in a percent-coordinate grid.
 *
 * Requirement links: `FR-EYE-003` and `FR-LAB-004`.
 * The Brown flow withholds the center point until the surrounding points are
 * calibrated, so the plugin needs a deterministic way to identify it.
 *
 * @param {number[][]} points Calibration points.
 * @returns {number} Index of the center point, or -1 when absent.
 */
function findCenterPointIndex(points) {
  return points.findIndex((point) => Number(point[0]) === 50 && Number(point[1]) === 50);
}

/**
 * Reports whether the active extension can expose tracker readiness.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-ERR-003`.
 * Real WebGazer calibration needs a warm face/eye tracker before clicks are
 * useful; tests and mocks often omit these APIs, so they stay immediately
 * clickable rather than hanging on an unobservable readiness condition.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {boolean} True when readiness can be checked.
 */
function canCheckCalibrationTrackerReadiness(extension) {
  return typeof extension?.faceDetected === 'function' || typeof extension?.getCurrentPrediction === 'function';
}

/**
 * Waits until WebGazer has live tracker features for calibration clicks.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-LAB-004`.
 * `recordScreenPosition()` silently drops calibration clicks when WebGazer is
 * paused or lacks `latestEyeFeatures`; polling the tracker before enabling the
 * dots prevents a visually complete calibration with no training data.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {Promise<{ready: boolean, elapsedMs: number}>} Readiness result.
 */
async function waitForCalibrationTrackerReady(extension) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < CALIBRATION_TRACKER_READY_TIMEOUT_MS) {
    if (await refreshCalibrationTrackerFeatures(extension)) {
      return { ready: true, elapsedMs: performance.now() - startedAt };
    }
    await delay(CALIBRATION_TRACKER_READY_POLL_MS);
  }
  return { ready: false, elapsedMs: performance.now() - startedAt };
}

/**
 * Pulls one prediction frame so WebGazer refreshes `latestEyeFeatures`.
 *
 * Requirement links: `FR-EYE-003` and `FR-ERR-003`.
 * Before any regression data exists, `getCurrentPrediction()` may return null,
 * but the internal call still updates eye features. That is the state required
 * for WebGazer's native document click listener to attach the clicked target to
 * the current eye image.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {Promise<boolean>} True when the tracker appears ready.
 */
async function refreshCalibrationTrackerFeatures(extension) {
  if (!canCheckCalibrationTrackerReadiness(extension)) {
    return true;
  }
  const prediction = await getCurrentPredictionSafely(extension);
  return isCalibrationTrackerReady(extension) || isFinitePrediction(prediction);
}

/**
 * Reads the jsPsych/WebGazer face-readiness flag safely.
 *
 * Requirement links: `FR-EYE-003` and `FR-ERR-003`.
 * Different WebGazer builds can throw while the tracker initializes; setup
 * treats that as "not ready yet" and keeps polling rather than aborting.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {boolean} True when WebGazer reports a detected face/eye track.
 */
function isCalibrationTrackerReady(extension) {
  try {
    return extension?.faceDetected?.() === true;
  } catch {
    return false;
  }
}

/**
 * Calls `getCurrentPrediction()` without letting setup timers fail.
 *
 * Requirement links: `FR-EYE-004` and `FR-ERR-003`.
 * WebGazer returns null during normal warmup and can reject while camera frames
 * are unavailable; calibration treats those as missing samples, not fatal setup
 * errors.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @returns {Promise<Record<string, unknown> | null>} Prediction object or null.
 */
async function getCurrentPredictionSafely(extension) {
  if (typeof extension?.getCurrentPrediction !== 'function') {
    return null;
  }
  try {
    return await extension.getCurrentPrediction();
  } catch {
    return null;
  }
}

/**
 * Reads the best available current prediction from jsPsych and WebGazer.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-005`, and `FR-ERR-003`.
 * Some browser/jsPsych combinations keep the WebGazer runtime responsive while
 * the extension callback stream is quiet. Sampling both layers lets calibration
 * validation and formal trials recover live gaze points from the same camera
 * model before reporting a no-sample condition.
 *
 * @param {Record<string, unknown>} extension jsPsych WebGazer extension.
 * @param {Record<string, unknown> | null} [webgazer] Underlying WebGazer runtime.
 * @returns {Promise<{prediction: Record<string, unknown> | null, source: string}>} Prediction and source label.
 */
async function getCurrentPredictionFromSources(extension, webgazer = getWebGazerRuntime(extension)) {
  const extensionPrediction = await getCurrentPredictionSafely(extension);
  if (isFinitePrediction(extensionPrediction)) {
    return { prediction: extensionPrediction, source: 'extension' };
  }
  const runtimePrediction = webgazer === extension
    ? null
    : await getCurrentPredictionSafely(webgazer);
  if (isFinitePrediction(runtimePrediction)) {
    return { prediction: runtimePrediction, source: 'webgazer_runtime' };
  }
  // Returning the extension's non-finite object, when present, preserves
  // diagnostics about malformed coordinates while still allowing callers to
  // mark the sample invalid instead of treating the frame as invisible.
  return {
    prediction: extensionPrediction ?? runtimePrediction ?? null,
    source: extensionPrediction ? 'extension_unusable' : runtimePrediction ? 'webgazer_runtime_unusable' : 'unavailable',
  };
}

/**
 * Checks whether a WebGazer prediction has usable viewport coordinates.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-006`, and `FR-DATA-005`.
 * Only finite coordinates can be classified against AOIs or scored against
 * Brown precision targets, so null WebGazer frames are filtered at collection time.
 *
 * @param {Record<string, unknown> | null} prediction Candidate prediction.
 * @returns {boolean} True when x/y are finite numbers.
 */
function isFinitePrediction(prediction) {
  return Number.isFinite(Number(prediction?.x)) && Number.isFinite(Number(prediction?.y));
}

/**
 * Waits for a short browser-timer interval.
 *
 * Requirement links: `FR-EYE-003` and `FR-PERF-005`.
 * Calibration readiness polling uses a small delay so setup remains responsive
 * while WebGazer warms after a pause/resume transition.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Summarizes Brown-style center precision.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, and `FR-LAB-004`.
 * Brown's demo uses the last 50 samples, distances them from screen center,
 * scales by half window height, clamps to 0-100, then averages.
 *
 * @param {{x: number, y: number, t: number}[]} samples Raw center-check samples.
 * @param {{width: number, height: number, maxSamples?: number}} viewport Viewport and sample controls.
 * @returns {{brown_precision_percent: number | null, brown_precision_label: string, brown_precision_sample_count: number, brown_precision_mean_error_px: number | null, brown_precision_samples_per_sec: number | null}} Precision summary.
 */
export function summarizeBrownPrecision(samples, viewport) {
  const maxSamples = viewport.maxSamples ?? BROWN_PRECISION_MAX_SAMPLES;
  const validSamples = samples
    .filter((sample) => Number.isFinite(Number(sample.x)) && Number.isFinite(Number(sample.y)))
    .slice(-maxSamples);
  const centerX = Number(viewport.width) / 2;
  const centerY = Number(viewport.height) / 2;
  const halfWindowHeight = Number(viewport.height) / 2;
  const distances = validSamples
    .map((sample) => Math.sqrt((centerX - Number(sample.x)) ** 2 + (centerY - Number(sample.y)) ** 2))
    .filter(Number.isFinite);
  const precisionValues = distances.map((distance) => {
    if (!Number.isFinite(halfWindowHeight) || halfWindowHeight <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, 100 - (distance / halfWindowHeight) * 100));
  });
  const precision = precisionValues.length
    ? Math.round(precisionValues.reduce((sum, value) => sum + value, 0) / precisionValues.length)
    : null;
  return {
    brown_precision_percent: precision,
    brown_precision_label: brownPrecisionLabel(precision),
    brown_precision_sample_count: validSamples.length,
    brown_precision_mean_error_px: mean(distances),
    brown_precision_samples_per_sec: calculateSampleRate([validSamples]),
  };
}

/**
 * Labels Brown-style precision for researcher interpretation.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * These labels are advisory only; no threshold blocks Play in the MVP.
 *
 * @param {number | null} precisionPercent Brown precision percent.
 * @returns {'needs_attention' | 'fair' | 'good' | 'great'} Quality label.
 */
export function brownPrecisionLabel(precisionPercent) {
  if (!Number.isFinite(precisionPercent) || precisionPercent < 70) {
    return 'needs_attention';
  }
  if (precisionPercent < 80) {
    return 'fair';
  }
  if (precisionPercent < 90) {
    return 'good';
  }
  return 'great';
}

/**
 * Converts Brown precision labels into setup-page copy.
 *
 * Requirement links: `FR-EYE-004` and `FR-LAB-004`.
 * Stored labels stay machine-friendly while the UI/status text uses plain
 * researcher-facing language.
 *
 * @param {string} label Stored Brown precision label.
 * @returns {string} Display label.
 */
export function brownPrecisionDisplayLabel(label) {
  return {
    needs_attention: 'needs attention',
    fair: 'fair',
    good: 'good',
    great: 'great',
  }[label] ?? 'needs attention';
}

/**
 * Bridges jsPsych WebGazer sampling into canonical `gaze_samples` rows.
 *
 * Requirement links: `FR-EYE-001` through `FR-EYE-010`,
 * `FR-UI-002`, `FR-ERR-001` through `FR-ERR-003`, `FR-DATA-005`,
 * and `FR-PERF-005`.
 * Automated tests use deterministic mock gaze because CI cannot rely on a
 * webcam. The real path loads jsPsych and the jsPsych WebGazer extension at
 * runtime and keeps all WebGazer ownership inside that extension boundary.
 */
export class WebGazerBridge {
  /**
 * Creates a gaze bridge.
 *
 * Requirement links: `FR-EYE-001`, `FR-EYE-004`, and `FR-EYE-005`.
 * The bridge stores setup state in memory because a real trial must use the
 * currently initialized jsPsych extension, not just an old setup row.
 *
 * @param {{samplingIntervalMs?: number, mode?: 'auto' | 'mock' | 'real', cameraDeviceId?: string | null}} options Bridge options.
   */
  constructor(options = {}) {
    this.samplingIntervalMs = options.samplingIntervalMs ?? WEBGAZER_SAMPLING_INTERVAL_MS;
    this.mode = options.mode ?? 'auto';
    this.interval = null;
    this.sampleIndex = 0;
    this.status = 'idle';
    this.lastError = null;
    this.jsPsych = options.jsPsych ?? null;
    this.extension = options.extension ?? null;
    this.unsubscribeGaze = null;
    this.realSamplingRunId = null;
    this.lastRealCallbackAtMs = null;
    this.setupSummary = null;
    this.setupAbortRequested = false;
    this.cameraDeviceId = options.cameraDeviceId ?? null;
    this.webgazer = null;
    this.webgazerModulesPromise = null;
    this.logger = options.logger ?? null;
  }

  /**
 * Replaces the structured diagnostics logger used by setup and sampling.
 *
 * Requirement links: `FR-ERR-003`, `FR-DATA-001`, and `FR-LAB-004`.
 * The UI owns the current session store, so the bridge accepts logger updates
 * whenever the researcher starts a new session or toggles detailed diagnostics.
 *
 * @param {import('../logging/AppLogger.js').AppLogger | null} logger Structured logger.
 */
  setLogger(logger) {
    this.logger = logger;
  }

  /**
 * Imports and caches the WebGazer/jsPsych dependency modules.
 *
 * Requirement links: `FR-DEP-002` and `FR-PERF-006`.
 * Dynamic import caching keeps repeated setup attempts responsive while
 * preserving the design choice that WebGazer loads only after the researcher
 * starts the setup workflow.
 *
 * @returns {Promise<unknown[]>} Imported dependency modules.
   */
  async importJsPsychWebGazerModules() {
    if (!this.webgazerModulesPromise) {
      this.webgazerModulesPromise = Promise.all([
        import('jspsych'),
        import('@jspsych/extension-webgazer'),
        import('@jspsych/plugin-webgazer-init-camera'),
        import('@jspsych/plugin-html-button-response'),
        import('webgazer'),
      ]);
    }
    return this.webgazerModulesPromise;
  }

  /**
 * Loads jsPsych and its WebGazer extension.
 *
 * Requirement links: `FR-EYE-001`, `FR-DEP-002`, and `FR-ERR-002`.
 * This dynamic import makes the dependency explicit while allowing tests to
 * run without touching camera APIs.
   *
   * @returns {Promise<{initJsPsych: Function, extensionType: unknown, plugins: Record<string, unknown>, webgazer: unknown}>} jsPsych primitives.
   */
  async loadJsPsychWebGazer() {
    const [
      jsPsychModule,
      webgazerModule,
      initCameraModule,
      htmlButtonModule,
      webgazerLibraryModule,
    ] = await this.importJsPsychWebGazerModules();
    const extensionType =
      webgazerModule.WebgazerExtension ??
      webgazerModule.WebGazerExtension ??
      webgazerModule.default ??
      webgazerModule.jsPsychExtensionWebgazer;
    if (!extensionType || !jsPsychModule.initJsPsych) {
      throw new Error('jsPsych WebGazer extension is unavailable.');
    }
    const webgazer = webgazerLibraryModule.default ?? globalThis.webgazer;
    if (!webgazer) {
      throw new Error('webgazer.js did not load.');
    }
    configureWebGazerRuntime(webgazer, this.cameraDeviceId);
    this.webgazer = webgazer;
    globalThis.webgazer = webgazer;
    logDiagnostic(this.logger, 'debug', 'webgazer', 'setup', 'webgazer_configured', 'Configured WebGazer runtime.', {
      camera_device_id: this.cameraDeviceId,
      constraints: createWebGazerCameraConstraints(this.cameraDeviceId),
      config: webGazerRuntimeConfigDiagnostics(webgazer),
    });
    return {
      initJsPsych: jsPsychModule.initJsPsych,
      extensionType,
      plugins: {
        initCamera: initCameraModule.default,
        htmlButton: htmlButtonModule.default,
      },
      webgazer,
    };
  }

  /**
 * Runs a minimal camera permission check.
 *
 * Requirement links: `FR-EYE-002`, `FR-ERR-001`, and `FR-UI-002`.
 * The setup view can call this before the full jsPsych timeline to distinguish
 * camera denial from later Brown setup failures.
 *
 * @returns {Promise<boolean>} True when a camera stream can be opened.
   */
  async checkCameraPermission(options = {}) {
    const stream = await this.openCameraPreview(options);
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  }

  /**
 * Opens a camera stream using the same constraints WebGazer uses.
 *
 * Requirement links: `FR-EYE-002`, `FR-ERR-001`, and `FR-UI-002`.
 * The setup preview must test the same camera shape requested by WebGazer
 * setup; otherwise a generic browser permission check can pass while the real
 * tracker later fails with stricter constraints.
 *
 * @returns {Promise<MediaStream>} Active camera stream for the setup preview.
   */
  async openCameraPreview(options = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera APIs are unavailable.');
    }
    const deviceId = options.deviceId ?? this.cameraDeviceId;
    const constraints = createWebGazerCameraConstraints(deviceId);
    logDiagnostic(this.logger, 'debug', 'camera', 'camera_selection', 'camera_preview_request', 'Requesting selected camera preview stream.', {
      camera_device_id: deviceId ?? null,
      constraints,
    });
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      logDiagnostic(this.logger, 'info', 'camera', 'camera_selection', 'camera_preview_opened', 'Camera preview stream opened.', {
        camera_device_id: deviceId ?? null,
        stream: mediaStreamDiagnostics(stream),
      });
      return stream;
    } catch (error) {
      logDiagnostic(this.logger, 'warn', 'camera', 'camera_selection', 'camera_preview_failed', 'Camera preview stream failed.', {
        camera_device_id: deviceId ?? null,
        error: errorDiagnostics(error),
      });
      throw normalizeCameraError(error, deviceId);
    }
  }

  /**
 * Stores the camera device that WebGazer should use.
 *
 * Requirement links: `FR-EYE-001`, `FR-EYE-003`, `FR-EYE-004`, and
 * `FR-ERR-003`.
 * Changing cameras invalidates a prior calibration because the completed
 * WebGazer runtime no longer corresponds to the selected physical device.
 *
 * @param {string | null | undefined} deviceId Browser `videoinput.deviceId`.
 */
  setCameraDeviceId(deviceId) {
    const normalizedDeviceId = deviceId || null;
    if (normalizedDeviceId !== this.cameraDeviceId) {
      this.setupSummary = null;
      this.cameraDeviceId = normalizedDeviceId;
      this.resetRuntimeForCameraChange();
    }
    configureWebGazerRuntime(this.webgazer ?? globalThis.webgazer, this.cameraDeviceId);
  }

  /**
 * Clears initialized jsPsych/WebGazer objects after a camera switch.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, `FR-PERF-006`, and
 * `FR-ERR-003`.
 * WebGazer binds its media stream during initialization, so changing the
 * selected camera must force the next setup run to initialize from fresh
 * constraints instead of reusing an extension tied to the previous device.
 */
  resetRuntimeForCameraChange() {
    void this.resetRuntimeForSetup({ reason: 'camera_change' });
  }

  /**
 * Clears any initialized WebGazer/jsPsych runtime before a new setup run.
 *
 * Requirement links: `FR-EYE-002`, `FR-EYE-003`, `FR-EYE-004`, and
 * `FR-ERR-003`.
 * WebGazer's built-in `end()` removes DOM nodes but leaves camera shutdown to
 * callers, so setup explicitly stops the WebGazer-owned stream before creating
 * a new jsPsych extension. This prevents frozen face overlays caused by stale
 * video tracks from prior setup attempts.
 */
  async resetRuntimeForSetup(options = {}) {
    const logger = options.logger ?? this.logger;
    const reason = options.reason ?? 'setup';
    const extension = this.extension;
    const webgazer = this.webgazer ?? getWebGazerRuntime(extension);
    logDiagnostic(logger, 'info', 'webgazer', 'setup', 'recalibration_reset_start', 'Resetting WebGazer runtime before setup.', {
      reason,
      had_jspsych: Boolean(this.jsPsych),
      had_extension: Boolean(extension),
      had_webgazer: Boolean(webgazer),
      config: webGazerRuntimeConfigDiagnostics(webgazer),
    });
    this.stop();
    cleanupWebGazerCall(logger, reason, 'stop_mouse_calibration', () => extension?.stopMouseCalibration?.());
    cleanupWebGazerCall(logger, reason, 'hide_predictions', () => extension?.hidePredictions?.());
    cleanupWebGazerCall(logger, reason, 'hide_video', () => extension?.hideVideo?.());
    cleanupWebGazerCall(logger, reason, 'disable_stored_points', () => setBrownPointStorage(webgazer, false));
    cleanupWebGazerCall(logger, reason, 'clear_brown_stored_points', () => clearBrownStoredPoints(webgazer, BROWN_PRECISION_MAX_SAMPLES));
    cleanupWebGazerCall(logger, reason, 'reset_extension_calibration', () => extension?.resetCalibration?.());
    cleanupWebGazerCall(logger, reason, 'clear_webgazer_data', () => webgazer?.clearData?.());
    stopWebGazerVideoSafely(webgazer, logger, reason);
    try {
      const endResult = webgazer?.end?.();
      if (endResult && typeof endResult.then === 'function') {
        await endResult;
      }
    } catch (error) {
      logDiagnostic(logger, 'warn', 'webgazer', 'setup', 'recalibration_reset_cleanup_failed', 'WebGazer cleanup call failed during setup reset.', {
        reason,
        cleanup_action: 'end_webgazer',
        error: errorDiagnostics(error),
      });
    }
    this.unsubscribeGaze = null;
    this.extension = null;
    this.jsPsych = null;
    this.plugins = null;
    this.webgazer = null;
    logDiagnostic(logger, 'info', 'webgazer', 'setup', 'recalibration_reset_complete', 'WebGazer runtime reset completed before setup.', {
      reason,
      had_webgazer: Boolean(webgazer),
    });
  }

  /**
 * Clears the in-memory setup gate without changing camera selection.
 *
 * Requirement links: `FR-EYE-004` and `FR-ERR-003`.
 * The UI calls this when the selected camera changes after setup so a real
 * trial cannot start with gaze calibration from a different camera.
 */
  clearValidatedSetup() {
    this.setupSummary = null;
  }

  /**
 * Starts collecting gaze rows.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-006`, `FR-EYE-007`,
 * `FR-EYE-008`, `FR-DATA-005`, and `FR-PERF-005`.
 * The mock path follows a repeatable scan across the game canvas so tests can
 * assert AOI classification without relying on random coordinates.
   *
   * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, trialId: string, trialStartMs: number, getCurrentContext: () => {pieceId?: string | null, pieceSpawnTTrialMs?: number | null, canvasRect?: DOMRect | {left: number, top: number, width: number, height: number}}, mode?: 'mock' | 'real'}} options Sampling options.
   * @returns {Promise<void>} Resolves after sampling starts.
   */
  async start(options) {
    this.stop();
    this.status = 'starting';
    this.sampleIndex = 0;
    const mode = options.mode ?? this.mode;
    if (mode === 'real') {
      await this.startReal(options);
      return;
    }
    if (mode === 'auto') {
      try {
        await this.startReal(options);
        return;
      } catch (error) {
        this.lastError = error;
        this.startMock(options);
        return;
      }
    }
    this.startMock(options);
  }

  /**
 * Starts deterministic mock gaze sampling.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-006`, `FR-EYE-007`,
 * and `FR-PERF-003`.
 * Mock mode exercises the same canonical gaze table as real mode while keeping
 * CI and classroom demos independent of webcam hardware.
 *
 * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, trialId: string, trialStartMs: number, getCurrentContext: Function}} options Sampling options.
   */
  startMock(options) {
    this.status = 'mock';
    this.interval = setInterval(() => this.writeMockSample(options), this.samplingIntervalMs);
  }

  /**
 * Starts real jsPsych WebGazer sampling when the lab browser supports it.
 *
 * Requirement links: `FR-EYE-001`, `FR-EYE-004`, `FR-EYE-005`,
 * `FR-EYE-008`, `FR-ERR-002`, and `FR-ERR-003`.
 * The MVP initializes the extension and then records periodic predictions
 * exposed by the WebGazer runtime owned by the jsPsych extension. If the
   * extension cannot initialize, callers receive a `webgazer_unavailable` path.
   *
   * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, trialId: string, trialStartMs: number, getCurrentContext: Function}} options Sampling options.
   * @returns {Promise<void>} Resolves after real sampling starts.
   */
  async startReal(options) {
    if (!this.hasCompletedSetup()) {
      throw new Error('WebGazer setup must complete before real trial sampling starts.');
    }
    await this.ensureJsPsych({ displayElement: options.displayElement });
    if (!this.extension.isInitialized()) {
      await this.extension.start();
    }
    this.extension.resume();
    this.realSamplingRunId = Symbol('real-webgazer-sampling');
    this.lastRealCallbackAtMs = null;
    this.status = 'real';
    if (typeof this.extension.onGazeUpdate === 'function') {
      this.unsubscribeGaze = this.extension.onGazeUpdate((prediction) => {
        this.lastRealCallbackAtMs = performance.now();
        this.writeRealPredictionSample(options, prediction, 'extension_callback');
      });
    } else {
      logDiagnostic(this.logger, 'warn', 'webgazer', 'trial', 'trial_gaze_callback_unavailable', 'jsPsych WebGazer did not expose onGazeUpdate; using direct prediction polling only.', {
        trial_id: options.trialId,
      });
    }
    this.extension.startSampleInterval?.(this.samplingIntervalMs);
    this.startRealPollingFallback(options, this.realSamplingRunId);
  }

  /**
 * Starts a direct-prediction fallback for real WebGazer trials.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-008`, `FR-ERR-003`,
 * and `FR-PERF-005`.
 * The jsPsych callback stream is the preferred path because it is the official
 * extension API, but some post-calibration browser states leave callbacks quiet
 * while `getCurrentPrediction()` still works. This interval writes only when
 * recent callbacks are absent, preserving the target sampling cadence without
 * creating a second full-rate stream during normal operation.
 *
 * @param {{trialId: string}} options Sampling options.
 * @param {symbol} samplingRunId Token that identifies the active real run.
 */
  startRealPollingFallback(options, samplingRunId) {
    this.interval = setInterval(() => {
      void this.writePolledRealSample(options, samplingRunId);
    }, this.samplingIntervalMs);
  }

  /**
 * Polls WebGazer directly when extension callbacks are silent.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-006`, `FR-EYE-008`,
 * `FR-DATA-005`, and `FR-ERR-003`.
 * The run token prevents an async prediction from writing a late sample after
 * the trial has stopped or a new trial has replaced the old bridge state.
 *
 * @param {{trialId: string, store: import('../data/SessionDataStore.js').SessionDataStore, trialStartMs: number, getCurrentContext: Function}} options Sampling options.
 * @param {symbol} samplingRunId Token that identifies the active real run.
 * @returns {Promise<void>} Resolves after the optional poll writes a sample.
 */
  async writePolledRealSample(options, samplingRunId) {
    if (this.realSamplingRunId !== samplingRunId || this.status !== 'real') {
      return;
    }
    const callbackFreshWindowMs = Math.max(this.samplingIntervalMs * 1.5, this.samplingIntervalMs + 10);
    if (this.lastRealCallbackAtMs !== null && performance.now() - this.lastRealCallbackAtMs <= callbackFreshWindowMs) {
      return;
    }
    const result = await getCurrentPredictionFromSources(this.extension, this.webgazer ?? getWebGazerRuntime(this.extension));
    if (this.realSamplingRunId !== samplingRunId || this.status !== 'real') {
      return;
    }
    if (!result.prediction) {
      logDiagnostic(this.logger, 'trace', 'webgazer', 'trial', 'trial_gaze_poll_missing', 'Direct trial prediction poll returned no gaze point.', {
        trial_id: options.trialId,
        source: result.source,
      });
      return;
    }
    this.writeRealPredictionSample(options, result.prediction, `poll:${result.source}`);
  }

  /**
 * Writes one real WebGazer prediction to the canonical gaze table.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-006`, `FR-EYE-007`,
 * and `FR-DATA-005`.
 * Both callback and polling sources pass through this method so validity,
 * diagnostics, and viewport-coordinate assumptions remain identical.
 *
 * @param {{trialId: string, store: import('../data/SessionDataStore.js').SessionDataStore, trialStartMs: number, getCurrentContext: Function}} options Sampling options.
 * @param {Record<string, unknown> | null} prediction WebGazer prediction.
 * @param {string} source Source label for diagnostics.
 * @returns {boolean} True when a prediction row was written.
 */
  writeRealPredictionSample(options, prediction, source) {
    if (!prediction) {
      return false;
    }
    const x = Number(prediction.x);
    const y = Number(prediction.y);
    const valid = Number.isFinite(x) && Number.isFinite(y);
    this.writeSample(options, {
      x: valid ? x : null,
      y: valid ? y : null,
      confidence: prediction.confidence ?? null,
      valid,
    });
    logDiagnostic(this.logger, 'trace', 'webgazer', 'trial', 'trial_gaze_sample', 'Real WebGazer trial sample written.', {
      trial_id: options.trialId,
      source,
      prediction: predictionDiagnostics(prediction),
      valid,
    });
    return true;
  }

  /**
 * Stops gaze sampling.
 *
 * Requirement links: `FR-PERF-001`, `FR-PERF-006`, and `FR-EXP-008`.
 * Both mock intervals and real extension callbacks are torn down here so no
 * late gaze rows are written after trial finalization starts.
 */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.unsubscribeGaze) {
      this.unsubscribeGaze();
      this.unsubscribeGaze = null;
    }
    this.realSamplingRunId = null;
    this.lastRealCallbackAtMs = null;
    this.extension?.stopSampleInterval?.();
    this.extension?.pause?.();
    this.status = this.status === 'idle' ? 'idle' : 'stopped';
  }

  /**
 * Aborts an active setup timeline after an Escape key press.
 *
 * Requirement links: `FR-ERR-003`, `FR-UI-002`, and `FR-LAB-004`.
 * jsPsych owns the active calibration DOM, so the app asks jsPsych to finish
 * the current trial and abort the timeline instead of only hiding the overlay.
 * The surrounding setup handler records the abort as a current-schema error row.
 */
  abortSetup() {
    this.setupAbortRequested = true;
    this.stop();
    this.extension?.stopMouseCalibration?.();
    this.extension?.hidePredictions?.();
    this.extension?.hideVideo?.();
    try {
      this.jsPsych?.abortExperiment?.('', { aborted: true });
    } catch {
      this.jsPsych?.finishTrial?.({ aborted: true });
    }
  }

  /**
 * Reports whether the current in-memory WebGazer setup completed.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-ERR-003`.
 * Real trials depend on the initialized jsPsych WebGazer extension from the
 * same page session, so persisted historical setup rows are not enough to
 * authorize sampling after a reload or new session. Brown precision is a
 * quality diagnostic, not a hard trial gate.
   *
   * @returns {boolean} True after a completed real or mock setup run.
   */
  hasCompletedSetup() {
    return this.setupSummary?.setup_completed === true;
  }

  /**
 * Backward-compatible alias for callers that still use the old gate name.
 *
 * Requirement links: `FR-EYE-004` and `FR-ERR-003`.
 * The behavior now means "setup completed" because Brown precision quality
 * should not block calibrated Tetris trials during MVP piloting.
 *
 * @returns {boolean} True after setup completed.
 */
  hasValidatedSetup() {
    return this.hasCompletedSetup();
  }

  /**
 * Runs camera initialization, Brown calibration, and Brown precision through jsPsych.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-001` through `FR-EYE-004`,
 * `FR-ERR-001`, `FR-ERR-003`, and `FR-DATA-001`.
 * Setup owns the participant-facing WebGazer workflow. Trials later reuse the
 * same initialized extension so formal gaze samples are collected only after
   * Brown-style setup has run in the lab browser.
   *
   * @param {{displayElement?: HTMLElement, store: import('../data/SessionDataStore.js').SessionDataStore, participantId?: string, mode?: 'mock' | 'real', cameraDeviceId?: string | null, calibrationClicksPerPoint?: number, onStatus?: (message: string) => void, onPhase?: (phase: 'idle' | 'intro' | 'camera' | 'targets' | 'complete') => void}} options Setup options.
   * @returns {Promise<Record<string, unknown>>} Stored `webgazer_runs` row.
   */
  async runSetup(options) {
    const mode = options.mode ?? this.mode;
    const logger = options.logger ?? this.logger;
    this.logger = logger;
    if (mode === 'mock') {
      return this.runMockSetup(options);
    }
    const replacingCompletedSetup = this.hasCompletedSetup();
    this.setupAbortRequested = false;
    this.cameraDeviceId = options.cameraDeviceId ?? this.cameraDeviceId ?? null;
    this.setupSummary = null;
    await this.resetRuntimeForSetup({
      logger,
      reason: replacingCompletedSetup ? 'recalibration' : 'setup',
    });
    const startedAt = nowIso();
    const runId = `webgazer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Keep the target locations fixed at Brown's 9-point layout. The setup UI
    // only controls repeated clicks per point, because that gives researchers a
    // speed/quality tradeoff without changing the spatial coverage recorded in
    // `calibration_points`.
    const calibrationPoints = CALIBRATION_POINTS;
    const calibrationClicksPerPoint = normalizeCalibrationClicksPerPoint(options.calibrationClicksPerPoint);
    const expectedCalibrationClicks = calibrationPoints.length * calibrationClicksPerPoint;
    logger?.setContext?.({
      webgazerRunId: runId,
      trialId: null,
      phase: 'setup',
    });
    logger?.startPhase?.('setup', {
      mode: 'real',
      participant_id: options.participantId ?? 'anonymous',
      camera_device_id: this.cameraDeviceId,
      calibration_point_count: calibrationPoints.length,
      calibration_clicks_per_point: calibrationClicksPerPoint,
    });
    logDiagnostic(logger, 'info', 'webgazer', 'setup', 'setup_start', 'Starting real WebGazer setup.', {
      webgazer_run_id: runId,
      participant_id: options.participantId ?? 'anonymous',
      camera_device_id: this.cameraDeviceId,
      calibration_point_count: calibrationPoints.length,
      calibration_clicks_per_point: calibrationClicksPerPoint,
      calibration_points: calibrationPoints,
      origin: originDiagnostics(),
      browser: browserDiagnostics(),
      viewport: viewportDiagnostics(),
    });
    options.onStatus?.('Loading jsPsych WebGazer setup.');
    try {
      assertWebGazerSupportedOrigin();
      const { plugins } = await this.ensureJsPsych({ displayElement: options.displayElement });
      prepareWebGazerForNewSetup(this.webgazer ?? getWebGazerRuntime(this.extension), this.extension, logger);
      const setupResults = [];
      let stopFaceTrackerWatchdog = null;
      // The setup timeline stays inside the bridge because `FR-EYE-001` requires
      // gaze ownership to remain with jsPsych's WebGazer extension; the app only
      // stores Brown calibration and precision summaries.
      const timeline = [
        {
          type: plugins.htmlButton,
          stimulus: '<h2>Webcam Eye Tracking Setup</h2><p>Keep your head still and follow the calibration points. Data stays local in this browser.</p>',
          choices: ['Start camera setup'],
          on_load: () => {
            logger?.startPhase?.('intro', { webgazer_run_id: runId });
            options.onPhase?.('intro');
          },
          on_finish: () => options.onStatus?.('Starting WebGazer camera tracker. Wait for the face box to turn green, then click Continue.'),
        },
        {
          type: plugins.initCamera,
          instructions: '<p>Position your face in the webcam preview. Continue when the face box is green.</p>',
          button_text: 'Continue',
          on_load: () => {
            logger?.startPhase?.('camera', { webgazer_run_id: runId });
            options.onPhase?.('camera');
            options.onStatus?.('Center your face in the WebGazer webcam preview. Continue when the face box turns green.');
            this.showWebGazerPreview();
            logDiagnostic(logger, 'info', 'webgazer', 'camera', 'camera_phase_loaded', 'WebGazer camera-positioning phase loaded.', {
              video: webGazerVideoDiagnostics(),
              face_feedback: faceFeedbackDiagnostics(),
            });
            stopFaceTrackerWatchdog?.();
            stopFaceTrackerWatchdog = this.startFaceTrackerWatchdog(options.onStatus, logger);
          },
          on_finish: (data) => {
            stopFaceTrackerWatchdog?.();
            stopFaceTrackerWatchdog = null;
            logDiagnostic(logger, 'info', 'webgazer', 'camera', 'camera_phase_complete', 'WebGazer camera-positioning phase completed.', {
              load_time_ms: data?.load_time ?? null,
              video: webGazerVideoDiagnostics(),
              face_feedback: faceFeedbackDiagnostics(),
            });
            setupResults.push({ phase: 'camera', data });
          },
        },
        {
          type: plugins.htmlButton,
          // The wording intentionally says "9 calibration dots" plus "N times"
          // so participants understand the dropdown affects repetitions, not the
          // number of dots they should expect to see.
          stimulus: `<h2>Calibration</h2><p>Click each of the ${calibrationPoints.length} calibration dots ${calibrationClicksPerPoint} ${calibrationClicksPerPoint === 1 ? 'time' : 'times'} while looking directly at it. The center point appears after the outside points are complete.</p>`,
          choices: ['Start calibration'],
          on_load: () => {
            logger?.startPhase?.('calibration_intro', { webgazer_run_id: runId });
            options.onPhase?.('intro');
            this.showWebGazerPreview();
          },
          on_finish: () => options.onStatus?.(`Running Brown-style calibration. Click each visible dot ${calibrationClicksPerPoint} ${calibrationClicksPerPoint === 1 ? 'time' : 'times'}.`),
        },
        {
          type: BrownRepeatedCalibrationPlugin,
          // Pass both fields separately so the plugin and exported schema preserve
          // the distinction between fixed geometry and selected sample density.
          calibration_points: calibrationPoints,
          clicks_per_point: calibrationClicksPerPoint,
          logger,
          on_load: () => {
            logger?.startPhase?.('calibration', { webgazer_run_id: runId });
            options.onPhase?.('targets');
            this.showWebGazerPreview();
          },
          on_progress: (progress) => {
            const regressionCount = Number.isFinite(Number(progress.calibration_regression_sample_count))
              ? `; ${Number(progress.calibration_regression_sample_count)} WebGazer samples trained`
              : '';
            options.onStatus?.(`Brown-style calibration: ${progress.total_clicks} of ${expectedCalibrationClicks} clicks recorded across ${calibrationPoints.length} points at ${calibrationClicksPerPoint} ${calibrationClicksPerPoint === 1 ? 'click' : 'clicks'} per point${regressionCount}.`);
          },
          on_finish: (data) => setupResults.push({ phase: 'calibration', data }),
        },
        {
          type: plugins.htmlButton,
          stimulus: '<h2>Accuracy Check</h2><p>Look at the center point and keep your head still for five seconds.</p>',
          choices: ['Start accuracy check'],
          on_load: () => {
            logger?.startPhase?.('precision_intro', { webgazer_run_id: runId });
            options.onPhase?.('intro');
            this.extension?.hidePredictions?.();
            this.showWebGazerPreview();
          },
          on_finish: () => options.onStatus?.('Running Brown-style center accuracy check.'),
        },
        {
          type: BrownPrecisionCheckPlugin,
          duration_ms: BROWN_PRECISION_DURATION_MS,
          sampling_interval: this.samplingIntervalMs,
          max_samples: BROWN_PRECISION_MAX_SAMPLES,
          logger,
          on_load: () => {
            logger?.startPhase?.('precision', { webgazer_run_id: runId });
            options.onPhase?.('targets');
            options.onStatus?.('Look at the center dot for the Brown-style accuracy check.');
            this.showWebGazerPreview();
          },
          on_finish: (data) => setupResults.push({ phase: 'brown_precision', data }),
        },
        {
          type: plugins.htmlButton,
          stimulus: '<h2>Setup Complete</h2><p>The Tetris trial can now collect calibrated WebGazer samples.</p>',
          choices: ['Return to setup'],
          on_load: () => {
            logger?.startPhase?.('complete', { webgazer_run_id: runId });
            options.onPhase?.('complete');
            this.extension?.pause?.();
            this.extension?.hideVideo?.();
          },
        },
      ];
      options.onPhase?.('intro');
      options.onStatus?.('Click Start camera setup in the WebGazer setup workflow below.');
      try {
        await this.jsPsych.run(timeline);
      } finally {
        stopFaceTrackerWatchdog?.();
      }
      if (this.setupAbortRequested) {
        throw new Error('Setup aborted by researcher.');
      }
      const summary = summarizeSetupResults(setupResults);
      // `webgazer_runs` is the source of truth for replay/analysis quality. The
      // fixed 9-point geometry and variable click count are both exported so a
      // later lab review can interpret a low Brown score in context.
      const row = options.store.addRow('webgazer_runs', {
        webgazer_run_id: runId,
        session_id: options.store.session.session_id,
        participant_id: options.participantId ?? 'anonymous',
        mode: 'real',
        started_at: startedAt,
        ended_at: nowIso(),
        status: 'completed',
        setup_completed: true,
        camera_load_time_ms: summary.cameraLoadTimeMs,
        calibration_mode: 'brown_repeated_click',
        calibration_clicks_per_point: summary.calibrationClicksPerPoint,
        calibration_total_clicks: summary.calibrationTotalClicks,
        calibration_tracker_ready: summary.calibrationTrackerReady,
        calibration_tracker_ready_elapsed_ms: summary.calibrationTrackerReadyElapsedMs,
        calibration_tracker_ready_clicks: summary.calibrationTrackerReadyClicks,
        calibration_regression_sample_count: summary.calibrationRegressionSampleCount,
        calibration_regression_samples_by_point: JSON.stringify(summary.calibrationRegressionSamplesByPoint),
        brown_precision_percent: summary.brownPrecisionPercent,
        brown_precision_label: summary.brownPrecisionLabel,
        brown_precision_sample_count: summary.brownPrecisionSampleCount,
        brown_precision_mean_error_px: summary.brownPrecisionMeanErrorPx,
        brown_precision_samples_per_sec: summary.brownPrecisionSamplesPerSec,
        brown_precision_sample_source: summary.brownPrecisionSampleSource,
        brown_stored_sample_count: summary.brownStoredSampleCount,
        brown_direct_sample_count: summary.brownDirectSampleCount,
        calibration_points: JSON.stringify(calibrationPoints),
        error: null,
      });
      this.setupSummary = row;
      options.onStatus?.(webGazerSetupCompleteStatus(summary));
      logDiagnostic(logger, 'info', 'webgazer', 'complete', 'setup_complete', 'Real WebGazer setup completed.', {
        webgazer_run_id: runId,
        summary,
        row,
      });
      return row;
    } catch (error) {
      this.extension?.hidePredictions?.();
      this.extension?.hideVideo?.();
      logDiagnostic(logger, 'error', 'webgazer', 'setup', 'setup_error', 'Real WebGazer setup failed.', {
        webgazer_run_id: runId,
        error: errorDiagnostics(error),
      });
      const row = options.store.addRow('webgazer_runs', {
        webgazer_run_id: runId,
        session_id: options.store.session.session_id,
        participant_id: options.participantId ?? 'anonymous',
        mode: 'real',
        started_at: startedAt,
        ended_at: nowIso(),
        status: 'error',
        setup_completed: false,
        camera_load_time_ms: null,
        calibration_mode: 'brown_repeated_click',
        calibration_clicks_per_point: calibrationClicksPerPoint,
        calibration_total_clicks: 0,
        calibration_tracker_ready: false,
        calibration_tracker_ready_elapsed_ms: null,
        calibration_tracker_ready_clicks: 0,
        calibration_regression_sample_count: 0,
        calibration_regression_samples_by_point: JSON.stringify([]),
        brown_precision_percent: null,
        brown_precision_label: 'needs_attention',
        brown_precision_sample_count: 0,
        brown_precision_mean_error_px: null,
        brown_precision_samples_per_sec: null,
        brown_precision_sample_source: 'unavailable',
        brown_stored_sample_count: 0,
        brown_direct_sample_count: 0,
        calibration_points: JSON.stringify(calibrationPoints),
        error: error instanceof Error ? error.message : String(error),
      });
      this.lastError = error;
      options.onStatus?.(`WebGazer setup failed: ${row.error}`);
      return row;
    }
  }

  /**
 * Shows WebGazer's own preview during face-centering setup.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-UI-002`.
 * The raw camera preview on the setup page is stopped before calibration so
 * the formal workflow uses the same selected, WebGazer-owned video feed, face
 * overlay, and feedback box that drive gaze prediction.
 */
  showWebGazerPreview() {
    this.extension?.showVideo?.();
  }

  /**
 * Keeps WebGazer's face-positioning loop alive during camera setup.
 *
 * Requirement links: `FR-EYE-003`, `FR-ERR-003`, and `FR-LAB-004`.
 * The jsPsych init-camera plugin resumes WebGazer once, but browser camera
 * handoff after the app preview can leave the face overlay visually present
 * while the prediction loop is paused. This watchdog repeatedly resumes the
 * runtime during the face-positioning step and updates the status line if the
 * tracker still has not reported a live face after a few seconds.
 *
 * @param {(message: string) => void} [onStatus] Optional setup status callback.
 * @param {import('../logging/AppLogger.js').AppLogger | null} [logger] Structured diagnostics logger.
 * @returns {() => void} Cleanup callback for the active setup phase.
 */
  startFaceTrackerWatchdog(onStatus, logger = this.logger) {
    const startedAt = performance.now();
    let statusReported = false;
    let lastVideoTime = null;
    const timerId = setInterval(() => {
      this.showWebGazerPreview();
      this.extension?.resume?.()?.catch?.(() => {});
      const video = document.querySelector('#webgazerVideoFeed');
      if (video instanceof HTMLVideoElement) {
        video.play?.().catch?.(() => {});
        const currentVideoTime = Number(video.currentTime);
        if (Number.isFinite(currentVideoTime) && currentVideoTime !== lastVideoTime) {
          lastVideoTime = currentVideoTime;
        }
      }
      logDiagnostic(logger, 'trace', 'webgazer', 'camera', 'face_tracker_watchdog', 'Face tracker watchdog snapshot.', {
        elapsed_ms: Math.round(performance.now() - startedAt),
        face_detected: isCalibrationTrackerReady(this.extension),
        video: webGazerVideoDiagnostics(),
        face_feedback: faceFeedbackDiagnostics(),
      });
      if (!statusReported && performance.now() - startedAt > WEBGAZER_FACE_TRACKER_STATUS_MS && !isCalibrationTrackerReady(this.extension)) {
        statusReported = true;
        onStatus?.('WebGazer camera preview is open but face tracking is still warming. Keep your face centered; press Esc and rerun setup if the face box remains frozen.');
        logDiagnostic(logger, 'warn', 'webgazer', 'camera', 'face_tracker_slow', 'Face tracker did not report ready during the expected warmup window.', {
          elapsed_ms: Math.round(performance.now() - startedAt),
          video: webGazerVideoDiagnostics(),
          face_feedback: faceFeedbackDiagnostics(),
        });
      }
    }, WEBGAZER_FACE_TRACKER_WATCHDOG_MS);
    return () => {
      clearInterval(timerId);
    };
  }

  /**
 * Creates a deterministic setup row for automated tests and classroom demos.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, `FR-EYE-009`,
 * and `FR-DATA-007`.
 * The mock setup writes the same `webgazer_runs` schema row as real setup so
 * trial gating and analysis quality fields are tested without a webcam.
 *
 * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, participantId?: string, calibrationClicksPerPoint?: number, onStatus?: (message: string) => void}} options Setup options.
   * @returns {Record<string, unknown>} Stored setup row.
   */
  runMockSetup(options) {
    const logger = options.logger ?? this.logger;
    // Mock setup mirrors the real schema contract: always 9 Brown-style target
    // locations, with the selected click count changing the synthetic training
    // sample total. That keeps tests from encoding a separate mock-only
    // calibration standard.
    const calibrationPoints = CALIBRATION_POINTS;
    const calibrationClicksPerPoint = normalizeCalibrationClicksPerPoint(options.calibrationClicksPerPoint);
    const calibrationTotalClicks = calibrationPoints.length * calibrationClicksPerPoint;
    logDiagnostic(logger, 'info', 'webgazer', 'mock_setup', 'mock_setup_start', 'Mock WebGazer setup started.', {
      participant_id: options.participantId ?? 'anonymous',
      calibration_point_count: calibrationPoints.length,
      calibration_clicks_per_point: calibrationClicksPerPoint,
      calibration_points: calibrationPoints,
    });
    const row = options.store.addRow('webgazer_runs', {
      webgazer_run_id: `webgazer_mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      session_id: options.store.session.session_id,
      participant_id: options.participantId ?? 'anonymous',
      mode: 'mock',
      started_at: nowIso(),
      ended_at: nowIso(),
      status: 'completed',
      setup_completed: true,
      camera_load_time_ms: 0,
      calibration_mode: 'mock',
      calibration_clicks_per_point: calibrationClicksPerPoint,
      calibration_total_clicks: calibrationTotalClicks,
      calibration_tracker_ready: true,
      calibration_tracker_ready_elapsed_ms: 0,
      calibration_tracker_ready_clicks: calibrationTotalClicks,
      calibration_regression_sample_count: calibrationTotalClicks,
      calibration_regression_samples_by_point: JSON.stringify(
        calibrationPoints.map((_, index) => (index + 1) * calibrationClicksPerPoint),
      ),
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_precision_sample_count: BROWN_PRECISION_MAX_SAMPLES,
      brown_precision_mean_error_px: 0,
      brown_precision_samples_per_sec: BROWN_PRECISION_MAX_SAMPLES / (BROWN_PRECISION_DURATION_MS / 1000),
      brown_precision_sample_source: 'mock',
      brown_stored_sample_count: BROWN_PRECISION_MAX_SAMPLES,
      brown_direct_sample_count: 0,
      calibration_points: JSON.stringify(calibrationPoints),
      error: null,
    });
    this.setupSummary = row;
    options.onStatus?.('Mock WebGazer Brown-style setup complete.');
    logDiagnostic(logger, 'info', 'webgazer', 'mock_setup', 'mock_setup_complete', 'Mock WebGazer setup completed.', {
      row,
    });
    return row;
  }

  /**
 * Initializes jsPsych with the WebGazer extension once.
 *
 * Requirement links: `FR-EYE-001`, `FR-EYE-005`, and `FR-PERF-005`.
 * The extension is configured to round predictions and use the schema sampling
 * interval so real gaze rows match exported timing and coordinate expectations.
 *
 * @param {{displayElement?: HTMLElement}} options jsPsych display options.
   * @returns {Promise<{plugins: Record<string, unknown>}>} Loaded plugin references.
   */
  async ensureJsPsych(options = {}) {
    if (this.jsPsych && this.extension && this.plugins) {
      return { plugins: this.plugins };
    }
    const { initJsPsych, extensionType, plugins, webgazer } = await this.loadJsPsychWebGazer();
    this.plugins = plugins;
    this.jsPsych = initJsPsych({
      display_element: options.displayElement ?? document.body,
      extensions: [
        {
          type: extensionType,
          params: {
            auto_initialize: false,
            round_predictions: true,
            sampling_interval: this.samplingIntervalMs,
            webgazer,
          },
        },
      ],
    });
    this.extension = this.jsPsych.extensions.webgazer;
    if (!this.extension) {
      throw new Error('jsPsych WebGazer extension did not register.');
    }
    return { plugins };
  }

  /**
 * Writes one deterministic mock sample.
 *
 * Requirement links: `FR-EYE-006`, `FR-EYE-007`, `FR-EYE-008`,
 * `FR-AOI-008`, and `FR-PERF-005`.
 * The scan positions intentionally touch board, stack, preview, and upper-board
 * areas so automated trials exercise the downstream AOI pipeline.
 *
 * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, trialId: string, trialStartMs: number, getCurrentContext: Function}} options Sampling options.
   */
  writeMockSample(options) {
    const context = options.getCurrentContext();
    const rect = context.canvasRect ?? { left: 0, top: 0, width: 500, height: 600 };
    const positions = [
      [0.34, 0.42],
      [0.42, 0.78],
      [0.76, 0.22],
      [0.40, 0.18],
      [0.22, 0.62],
    ];
    const [rx, ry] = positions[this.sampleIndex % positions.length];
    this.sampleIndex += 1;
    this.writeSample(options, {
      x: Math.round(rect.left + rect.width * rx),
      y: Math.round(rect.top + rect.height * ry),
      confidence: 0.92,
      valid: true,
    });
  }

  /**
 * Writes one canonical gaze sample.
 *
 * Requirement links: `FR-EYE-005`, `FR-EYE-006`, `FR-EYE-007`,
 * `FR-EYE-008`, `FR-DATA-005`, and `FR-HCI-002`.
 * The row stores both trial-relative and piece-relative time so later replay
 * and piece-episode analysis can use the same raw sample table.
 *
 * @param {{store: import('../data/SessionDataStore.js').SessionDataStore, trialId: string, trialStartMs: number, getCurrentContext: Function}} options Sampling options.
   * @param {{x: number, y: number, confidence: number, valid: boolean}} sample Gaze sample.
   */
  writeSample(options, sample) {
    const context = options.getCurrentContext();
    const tTrialMs = trialTime(options.trialStartMs);
    options.store.addRow('gaze_samples', {
      trial_id: options.trialId,
      piece_id: context.pieceId ?? null,
      t_trial_ms: tTrialMs,
      t_piece_ms: pieceTime(context.pieceSpawnTTrialMs, tTrialMs),
      x: sample.x,
      y: sample.y,
      confidence: sample.confidence,
      valid: sample.valid,
    });
  }
}

/**
 * Normalizes Brown-style WebGazer setup output into schema summary fields.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, `FR-ANA-008`,
 * and `FR-ERR-003`.
 * jsPsych plugin payloads vary by phase, so this helper extracts only Brown
 * calibration/precision measures and leaves unavailable values as `null`.
 *
 * @param {{phase: string, data: Record<string, unknown>}[]} results Setup phase payloads.
 * @returns {Record<string, unknown>} Setup summary values.
 */
function summarizeSetupResults(results) {
  const camera = results.find((result) => result.phase === 'camera')?.data ?? {};
  const calibration = results.find((result) => result.phase === 'calibration')?.data ?? {};
  const brownPrecision = results.find((result) => result.phase === 'brown_precision')?.data ?? {};
  return {
    cameraLoadTimeMs: camera.load_time ?? null,
    calibrationClicksPerPoint: calibration.calibration_clicks_per_point ?? BROWN_CALIBRATION_CLICKS_PER_POINT,
    calibrationTotalClicks: calibration.calibration_total_clicks ?? 0,
    calibrationTrackerReady: calibration.calibration_tracker_ready ?? null,
    calibrationTrackerReadyElapsedMs: toFiniteNumber(calibration.calibration_tracker_ready_elapsed_ms),
    calibrationTrackerReadyClicks: toFiniteNumber(calibration.calibration_tracker_ready_clicks),
    calibrationRegressionSampleCount: toFiniteNumber(calibration.calibration_regression_sample_count),
    calibrationRegressionSamplesByPoint: Array.isArray(calibration.calibration_regression_samples_by_point)
      ? calibration.calibration_regression_samples_by_point.map(toFiniteNumber)
      : [],
    brownPrecisionPercent: toFiniteNumber(brownPrecision.brown_precision_percent),
    brownPrecisionLabel: brownPrecision.brown_precision_label ?? 'needs_attention',
    brownPrecisionSampleCount: toFiniteNumber(brownPrecision.brown_precision_sample_count) ?? 0,
    brownPrecisionMeanErrorPx: toFiniteNumber(brownPrecision.brown_precision_mean_error_px),
    brownPrecisionSamplesPerSec: toFiniteNumber(brownPrecision.brown_precision_samples_per_sec),
    brownPrecisionSampleSource: brownPrecision.brown_precision_sample_source ?? 'unavailable',
    brownStoredSampleCount: toFiniteNumber(brownPrecision.brown_stored_sample_count) ?? 0,
    brownDirectSampleCount: toFiniteNumber(brownPrecision.brown_direct_sample_count) ?? 0,
  };
}

/**
 * Builds the completed setup status shown after the Brown flow.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Brown precision is the only setup quality message in the MVP because the app
 * now mirrors Brown's single calibration/accuracy workflow.
 *
 * @param {Record<string, unknown>} summary Setup summary values.
 * @returns {string} Researcher-facing setup status.
 */
function webGazerSetupCompleteStatus(summary) {
  const precision = Number.isFinite(summary.brownPrecisionPercent)
    ? `${Number(summary.brownPrecisionPercent).toFixed(0)}%`
    : 'unavailable';
  const label = brownPrecisionDisplayLabel(summary.brownPrecisionLabel);
  const diagnostics = webGazerSetupDiagnostics(summary);
  return `WebGazer setup complete. Brown-style precision ${precision} (${label})${diagnostics}.`;
}

/**
 * Formats setup-quality diagnostics beyond the headline precision value.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Calibration-ready click count distinguishes bad gaze geometry from the more
 * basic failure where WebGazer never had live eye features during calibration.
 *
 * @param {Record<string, unknown>} summary Setup summary values.
 * @returns {string} Optional diagnostics suffix.
 */
function webGazerSetupDiagnostics(summary) {
  const parts = [];
  const readyClicks = summary.calibrationTrackerReadyClicks === null || summary.calibrationTrackerReadyClicks === undefined
    ? null
    : Number(summary.calibrationTrackerReadyClicks);
  const totalClicks = Number(summary.calibrationTotalClicks);
  if (Number.isFinite(readyClicks) && Number.isFinite(totalClicks) && totalClicks > 0) {
    parts.push(`${readyClicks} of ${totalClicks} calibration clicks tracker-ready`);
  }
  const regressionSamples = Number(summary.calibrationRegressionSampleCount);
  if (Number.isFinite(regressionSamples)) {
    parts.push(`${regressionSamples} WebGazer calibration samples trained`);
  }
  const precisionSource = summary.brownPrecisionSampleSource;
  const sampleCount = Number(summary.brownPrecisionSampleCount);
  if (Number.isFinite(sampleCount)) {
    parts.push(`${sampleCount} scored accuracy samples (${brownPrecisionSampleSourceDisplayLabel(precisionSource)})`);
  }
  const storedSamples = Number(summary.brownStoredSampleCount);
  if (Number.isFinite(storedSamples) && precisionSource !== 'webgazer_stored_points' && precisionSource !== 'mock') {
    parts.push(`${storedSamples} WebGazer stored-point samples`);
  }
  const directSamples = Number(summary.brownDirectSampleCount);
  if (Number.isFinite(directSamples) && precisionSource === 'unavailable') {
    parts.push(`${directSamples} direct prediction samples`);
  }
  const samplesPerSec = Number(summary.brownPrecisionSamplesPerSec);
  if (Number.isFinite(samplesPerSec)) {
    parts.push(`${samplesPerSec.toFixed(1)} Brown Hz`);
  }
  const meanErrorPx = Number(summary.brownPrecisionMeanErrorPx);
  if (Number.isFinite(meanErrorPx)) {
    parts.push(`${meanErrorPx.toFixed(1)} px Brown mean error`);
  }
  return parts.length ? `; ${parts.join(', ')}` : '';
}

/**
 * Converts precision sample-source codes into setup status labels.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Brown-compatible stored points and direct prediction fallback imply
 * different integration states, so the run-complete status keeps that source
 * visible beside the score.
 *
 * @param {unknown} source Stored precision sample source.
 * @returns {string} Researcher-facing source label.
 */
function brownPrecisionSampleSourceDisplayLabel(source) {
  return {
    webgazer_stored_points: 'WebGazer stored points',
    direct_prediction_poll: 'direct predictions',
    mock: 'mock',
    unavailable: 'unavailable',
  }[source] ?? 'unknown source';
}

/**
 * Applies project-specific WebGazer runtime configuration before `begin()`.
 *
 * Requirement links: `FR-EYE-001`, `FR-DEP-002`, `FR-ERR-001`, and
 * `FR-ERR-002`.
 * WebGazer 3.5.3 expects MediaPipe FaceMesh WASM/model files at a public URL.
 * Vite does not automatically serve package assets from `node_modules`, so the
 * app vendors those files under `public/mediapipe/face_mesh` and points the
 * tracker at that stable path. The camera constraints are also shared with the
 * setup-page preflight so “Validate Camera” checks the same stream shape that
 * WebGazer will request during calibration. Ridge regression and Kalman
 * filtering match the Brown demo behavior while `saveDataAcrossSessions(false)`
 * keeps calibration data participant-local to the current setup run.
 *
 * @param {Record<string, unknown> & {params?: Record<string, unknown>}} webgazer WebGazer runtime object.
 */
function configureWebGazerRuntime(webgazer, cameraDeviceId = null) {
  if (!webgazer) {
    return;
  }
  try {
    webgazer.setRegression?.('ridge');
    webgazer.applyKalmanFilter?.(true);
    webgazer.saveDataAcrossSessions?.(false);
  } catch {
    // Some mocked or older WebGazer builds expose only part of the fluent
    // runtime API; setup can still proceed with the available primitives.
  }
  if (!webgazer.params) {
    return;
  }
  webgazer.params.faceMeshSolutionPath = WEBGAZER_MEDIAPIPE_FACE_MESH_PATH;
  webgazer.params.camConstraints = createWebGazerCameraConstraints(cameraDeviceId);
}

/**
 * Clears per-run WebGazer state after a fresh runtime has been created.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-ERR-003`.
 * Recalibration should replace the previous model, not add to it. The bridge
 * already recreates jsPsych/WebGazer objects before setup; this helper also
 * clears stored Brown precision points and regression data on the new singleton
 * because WebGazer's module instance can outlive jsPsych extension instances.
 *
 * @param {Record<string, unknown> | null | undefined} webgazer WebGazer runtime.
 * @param {Record<string, unknown> | null | undefined} extension jsPsych WebGazer extension.
 * @param {import('../logging/AppLogger.js').AppLogger | null} logger Structured diagnostics logger.
 */
function prepareWebGazerForNewSetup(webgazer, extension, logger) {
  cleanupWebGazerCall(logger, 'setup', 'disable_stored_points_after_init', () => setBrownPointStorage(webgazer, false));
  cleanupWebGazerCall(logger, 'setup', 'clear_brown_stored_points_after_init', () => clearBrownStoredPoints(webgazer, BROWN_PRECISION_MAX_SAMPLES));
  cleanupWebGazerCall(logger, 'setup', 'reset_extension_calibration_after_init', () => extension?.resetCalibration?.());
  cleanupWebGazerCall(logger, 'setup', 'clear_webgazer_data_after_init', () => webgazer?.clearData?.());
  logDiagnostic(logger, 'debug', 'webgazer', 'setup', 'webgazer_prepared_for_setup', 'Prepared WebGazer runtime for a fresh setup run.', {
    config: webGazerRuntimeConfigDiagnostics(webgazer),
  });
}

/**
 * Runs one optional WebGazer cleanup function with structured diagnostics.
 *
 * Requirement links: `FR-ERR-003` and `FR-PERF-006`.
 * Browser/WebGazer builds expose different cleanup APIs. Reset should try every
 * available cleanup action, log failures, and still drop stale references so a
 * new calibration can proceed.
 *
 * @param {import('../logging/AppLogger.js').AppLogger | null | undefined} logger Structured diagnostics logger.
 * @param {string} reason Reset reason.
 * @param {string} action Cleanup action label.
 * @param {() => unknown} callback Optional cleanup call.
 */
function cleanupWebGazerCall(logger, reason, action, callback) {
  try {
    const result = callback();
    result?.catch?.((error) => {
      logDiagnostic(logger, 'warn', 'webgazer', 'setup', 'recalibration_reset_cleanup_failed', 'Async WebGazer cleanup call failed during setup reset.', {
        reason,
        cleanup_action: action,
        error: errorDiagnostics(error),
      });
    });
  } catch (error) {
    logDiagnostic(logger, 'warn', 'webgazer', 'setup', 'recalibration_reset_cleanup_failed', 'WebGazer cleanup call failed during setup reset.', {
      reason,
      cleanup_action: action,
      error: errorDiagnostics(error),
    });
  }
}

/**
 * Stops WebGazer's internal camera stream if one exists.
 *
 * Requirement links: `FR-EYE-002`, `FR-EYE-003`, and `FR-ERR-003`.
 * WebGazer 3.5.3 intentionally leaves `stopVideo()` commented out inside
 * `end()`. Calling it separately during setup reset prevents the next
 * calibration run from sharing hardware with an old, paused stream.
 *
 * @param {Record<string, unknown> | null | undefined} webgazer WebGazer runtime.
 * @param {import('../logging/AppLogger.js').AppLogger | null | undefined} logger Structured diagnostics logger.
 * @param {string} reason Reset reason.
 */
function stopWebGazerVideoSafely(webgazer, logger = null, reason = 'setup') {
  try {
    webgazer?.stopVideo?.();
  } catch (error) {
    logDiagnostic(logger, 'warn', 'webgazer', 'setup', 'recalibration_reset_cleanup_failed', 'WebGazer video stop failed during setup reset.', {
      reason,
      cleanup_action: 'stop_video',
      error: errorDiagnostics(error),
    });
    // A not-yet-started WebGazer instance has no video stream or overlay nodes.
    // Reset should still continue because those missing pieces are harmless.
  }
}

/**
 * Creates WebGazer camera constraints for preview, setup, and sampling.
 *
 * Requirement links: `FR-EYE-001`, `FR-EYE-002`, `FR-EYE-003`, and
 * `FR-ERR-001`.
 * A selected camera must use an exact `deviceId` so the browser cannot silently
 * fall back to a different device during calibration or formal gaze sampling.
 *
 * @param {string | null | undefined} cameraDeviceId Selected browser camera ID.
 * @returns {MediaStreamConstraints} Constraints for `getUserMedia`.
 */
export function createWebGazerCameraConstraints(cameraDeviceId = null) {
  const video = { ...WEBGAZER_CAMERA_SIZE_CONSTRAINTS };
  if (cameraDeviceId) {
    video.deviceId = { exact: cameraDeviceId };
  } else {
    video.facingMode = 'user';
  }
  return { video, audio: false };
}

/**
 * Converts selected-camera stream failures into actionable setup errors.
 *
 * Requirement links: `FR-ERR-001`, `FR-ERR-003`, and `FR-LAB-004`.
 * When a specific camera is selected, unavailable-device errors must block and
 * ask the researcher to choose another camera instead of allowing browser
 * fallback to an unvalidated device.
 *
 * @param {unknown} error Browser camera error.
 * @param {string | null | undefined} cameraDeviceId Selected camera ID.
 * @returns {Error} Normalized error.
 */
function normalizeCameraError(error, cameraDeviceId = null) {
  const errorName = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (cameraDeviceId && ['AbortError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(errorName)) {
    return new Error(`Selected camera is unavailable; choose another camera. ${errorMessage}`.trim());
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Fails early when the page origin is incompatible with WebGazer setup.
 *
 * Requirement links: `FR-EYE-001`, `FR-ERR-001`, and `FR-ERR-003`.
 * Browser camera permission may succeed on `127.0.0.1`, but WebGazer's own
 * runtime check expects HTTPS or the literal `localhost` hostname. Surfacing a
 * project-specific message here keeps the setup page actionable during lab
 * pilots instead of exposing WebGazer's generic secure-origin error.
 */
function assertWebGazerSupportedOrigin() {
  const pageLocation = globalThis.location;
  if (!pageLocation) {
    return;
  }
  const { hostname, href, protocol, port } = pageLocation;
  if (protocol === 'https:' || hostname === 'localhost') {
    return;
  }
  if (protocol === 'http:' && (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]')) {
    const localPort = port ? `:${port}` : '';
    throw new Error(`Open this app at http://localhost${localPort}/ before running WebGazer setup. WebGazer rejects ${href} even though camera permission can pass there.`);
  }
  throw new Error(`WebGazer setup requires HTTPS or localhost. Current origin is ${href}.`);
}

/**
 * Converts a stored setup value into a finite number without null coercion.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * `Number(null)` is `0`, which previously made missing Brown samples display
 * as a real 0% score; this helper preserves unavailable values as `null`.
 *
 * @param {unknown} value Candidate numeric value.
 * @returns {number | null} Finite number or null.
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * Computes a one-decimal mean for Brown precision summaries.
 *
 * Requirement links: `FR-EYE-004`, `FR-EYE-009`, and `FR-ANA-008`.
 * Returning `null` for empty inputs distinguishes unavailable Brown data
 * from a real zero-error result.
 *
 * @param {number[]} values Numeric values.
 * @returns {number | null} Rounded mean.
 */
function mean(values) {
  if (!values.length) {
    return null;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}
