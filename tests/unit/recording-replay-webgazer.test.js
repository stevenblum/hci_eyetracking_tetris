import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDataStore } from '../../src/data/SessionDataStore.js';
import {
  BrownPrecisionCheckPlugin,
  BrownRepeatedCalibrationPlugin,
  brownPrecisionLabel,
  createWebGazerCameraConstraints,
  DEFAULT_CALIBRATION_CLICKS_PER_POINT,
  normalizeCalibrationClicksPerPoint,
  summarizeBrownPrecision,
  summarizeBrownStoredPrecision,
  WebGazerBridge,
} from '../../src/experiment/WebGazerBridge.js';
import { JsPsychTetrisTrialRunner } from '../../src/experiment/jspsych-tetris-trial.js';
import { ExportService } from '../../src/export/ExportService.js';
import { TrialRecorder } from '../../src/recording/TrialRecorder.js';
import { colorForAoi, ReplayController, REPLAY_LEGEND_ITEMS } from '../../src/replay/ReplayController.js';

describe('recording, replay, webgazer, and export services', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function installMockRealSetupRuntime(bridge, options = {}) {
    const runs = [];
    const runtime = {
      params: { storingPoints: true },
      clearData: vi.fn(),
      stopVideo: vi.fn(),
      end: vi.fn(async () => {}),
      storePoints: vi.fn(),
      getStoredPoints: vi.fn(() => [[], []]),
    };
    const plugins = {
      htmlButton: 'html-button',
      initCamera: 'init-camera',
    };
    bridge.ensureJsPsych = vi.fn(async () => {
      if (bridge.jsPsych && bridge.extension && bridge.plugins) {
        return { plugins: bridge.plugins };
      }
      const runIndex = runs.length;
      const extension = {
        isInitialized: vi.fn(() => true),
        showVideo: vi.fn(),
        showPredictions: vi.fn(),
        hideVideo: vi.fn(),
        hidePredictions: vi.fn(),
        resume: vi.fn(),
        pause: vi.fn(),
        startSampleInterval: vi.fn(),
        stopSampleInterval: vi.fn(),
        stopMouseCalibration: vi.fn(),
        resetCalibration: vi.fn(),
        onGazeUpdate: vi.fn(() => vi.fn()),
      };
      const jsPsych = {
        extensions: { webgazer: extension },
        run: vi.fn(async (timeline) => {
          if (options.shouldFailRun?.(runIndex)) {
            throw new Error(`setup failure ${runIndex + 1}`);
          }
          for (const trial of timeline) {
            trial.on_load?.();
            if (trial.type === 'init-camera') {
              trial.on_finish?.({ load_time: 12 + runIndex });
            }
            if (trial.type.info?.name === 'brown-repeated-webgazer-calibration') {
              const clicksPerPoint = Number(trial.clicks_per_point);
              const totalClicks = trial.calibration_points.length * clicksPerPoint;
              trial.on_finish?.({
                calibration_clicks_per_point: clicksPerPoint,
                calibration_total_clicks: totalClicks,
                calibration_tracker_ready: true,
                calibration_tracker_ready_clicks: totalClicks,
                calibration_regression_sample_count: totalClicks,
                calibration_regression_samples_by_point: trial.calibration_points.map((_, index) => (index + 1) * clicksPerPoint),
              });
            }
            if (trial.type.info?.name === 'brown-webgazer-precision-check') {
              trial.on_finish?.({
                brown_precision_percent: 84 + runIndex,
                brown_precision_label: 'good',
                brown_precision_sample_count: 50,
                brown_precision_mean_error_px: 52 - runIndex,
                brown_precision_samples_per_sec: 10,
                brown_precision_sample_source: 'webgazer_stored_points',
                brown_stored_sample_count: 50,
                brown_direct_sample_count: 0,
              });
            }
          }
        }),
      };
      bridge.extension = extension;
      bridge.plugins = plugins;
      bridge.jsPsych = jsPsych;
      bridge.webgazer = runtime;
      runs.push({ extension, jsPsych, runtime });
      return { plugins };
    });
    return { runs, runtime };
  }

  it('writes unsupported recording metadata when browser media APIs are missing', async () => {
    const store = new SessionDataStore();
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const recorder = new TrialRecorder(store);

    const row = recorder.start({ trialId: 'trial_1', canvas });
    const stopped = await recorder.stop({ endTTrialMs: 250 });

    expect(row.status).toBe('unsupported');
    expect(stopped.row.duration_ms).toBe(250);
    expect(store.getRows('trial_recordings')[0].status).toBe('unsupported');
  });

  it('mock WebGazer sampling produces deterministic canonical gaze rows', async () => {
    const store = new SessionDataStore();
    const bridge = new WebGazerBridge({ mode: 'mock', samplingIntervalMs: 34 });
    await bridge.start({
      store,
      trialId: 'trial_1',
      trialStartMs: performance.now(),
      mode: 'mock',
      getCurrentContext: () => ({
        pieceId: 'piece_1',
        pieceSpawnTTrialMs: 0,
        canvasRect: { left: 10, top: 20, width: 500, height: 620 },
      }),
    });

    vi.advanceTimersByTime(34);
    bridge.stop();

    expect(store.getRows('gaze_samples')[0]).toMatchObject({
      trial_id: 'trial_1',
      piece_id: 'piece_1',
      x: 180,
      y: 280,
      valid: true,
    });
  });

  it('mock WebGazer setup writes Brown calibration and precision metadata', () => {
    const store = new SessionDataStore({ participantId: 'mock-setup' });
    const bridge = new WebGazerBridge({ mode: 'mock', samplingIntervalMs: 34 });

    const row = bridge.runMockSetup({ store, participantId: 'mock-setup' });

    expect(row).toMatchObject({
      mode: 'mock',
      status: 'completed',
      setup_completed: true,
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      calibration_clicks_per_point: 5,
      calibration_total_clicks: 45,
      calibration_tracker_ready: true,
      calibration_tracker_ready_clicks: 45,
      calibration_regression_sample_count: 45,
    });
    expect(row.calibration_clicks_per_point).toBe(DEFAULT_CALIBRATION_CLICKS_PER_POINT);
    expect(JSON.parse(row.calibration_points)).toHaveLength(9);
    expect(store.getRows('webgazer_runs')).toHaveLength(1);
  });

  it('mock WebGazer setup can be repeated and appends setup rows', () => {
    const store = new SessionDataStore({ participantId: 'mock-recalibration' });
    const bridge = new WebGazerBridge({ mode: 'mock', samplingIntervalMs: 34 });

    const firstRow = bridge.runMockSetup({ store, participantId: 'mock-recalibration', calibrationClicksPerPoint: 3 });
    const secondRow = bridge.runMockSetup({ store, participantId: 'mock-recalibration', calibrationClicksPerPoint: 5 });

    expect(store.getRows('webgazer_runs')).toHaveLength(2);
    expect(firstRow.webgazer_run_id).not.toBe(secondRow.webgazer_run_id);
    expect(secondRow.calibration_clicks_per_point).toBe(5);
    expect(secondRow.calibration_total_clicks).toBe(45);
    expect(bridge.setupSummary).toBe(secondRow);
    expect(bridge.hasCompletedSetup()).toBe(true);
  });

  it('normalizes supported repeated-click counts per calibration point', () => {
    expect(normalizeCalibrationClicksPerPoint(1)).toBe(1);
    expect(normalizeCalibrationClicksPerPoint(3)).toBe(3);
    expect(normalizeCalibrationClicksPerPoint(5)).toBe(5);
    expect(normalizeCalibrationClicksPerPoint(8)).toBe(8);
    expect(normalizeCalibrationClicksPerPoint(9)).toBe(9);
    expect(normalizeCalibrationClicksPerPoint('unsupported')).toBe(DEFAULT_CALIBRATION_CLICKS_PER_POINT);
  });

  it('creates exact selected-camera constraints and default-camera constraints', () => {
    expect(createWebGazerCameraConstraints('camera-2')).toEqual({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        deviceId: { exact: 'camera-2' },
      },
      audio: false,
    });
    expect(createWebGazerCameraConstraints()).toEqual({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
      audio: false,
    });
  });

  it('clears completed WebGazer setup when selected camera changes', () => {
    const bridge = new WebGazerBridge({ mode: 'real' });
    bridge.setupSummary = { setup_completed: true };

    bridge.setCameraDeviceId('camera-2');

    expect(bridge.hasCompletedSetup()).toBe(false);
  });

  it('blocks unavailable selected cameras instead of falling back', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(() => Promise.reject(new DOMException('missing camera', 'NotFoundError'))),
      },
    });
    const bridge = new WebGazerBridge({ mode: 'real', cameraDeviceId: 'missing-camera' });

    await expect(bridge.openCameraPreview()).rejects.toThrow('Selected camera is unavailable; choose another camera.');
  });

  it('Brown repeated calibration requires five clicks per point and reveals center last', () => {
    const finishTrial = vi.fn();
    let regressionCount = 0;
    const clickListener = () => {
      regressionCount += 1;
    };
    const extension = {
      resetCalibration: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
      showVideo: vi.fn(),
      hideVideo: vi.fn(),
      startMouseCalibration: vi.fn(() => document.addEventListener('click', clickListener, true)),
      stopMouseCalibration: vi.fn(() => document.removeEventListener('click', clickListener, true)),
      getRegressionSampleCount: vi.fn(() => regressionCount),
      calibratePoint: vi.fn(),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownRepeatedCalibrationPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      calibration_points: [
        [10, 10],
        [50, 10],
        [90, 10],
        [10, 50],
        [50, 50],
        [90, 50],
        [10, 90],
        [50, 90],
        [90, 90],
      ],
      clicks_per_point: 5,
      point_size: 20,
    });
    const center = displayElement.querySelector('[data-testid="brown-calibration-point-5"]');
    const firstCount = displayElement.querySelector('[data-testid="brown-calibration-count-1"]');
    const centerCount = displayElement.querySelector('[data-testid="brown-calibration-count-5"]');
    const clickCalibrationPoint = (point) => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      point.click();
    };
    expect(center.hidden).toBe(true);
    expect(centerCount.hidden).toBe(true);
    expect(firstCount.textContent).toBe('0');
    for (const point of displayElement.querySelectorAll('.brown-calibration-point:not([data-index="4"])')) {
      for (let index = 0; index < 5; index += 1) {
        clickCalibrationPoint(point);
      }
    }
    expect(center.hidden).toBe(false);
    expect(centerCount.hidden).toBe(false);
    expect(firstCount.textContent).toBe('5');
    for (let index = 0; index < 5; index += 1) {
      clickCalibrationPoint(center);
    }
    expect(centerCount.textContent).toBe('5');

    expect(extension.resetCalibration).toHaveBeenCalled();
    expect(extension.startMouseCalibration).toHaveBeenCalled();
    expect(extension.stopMouseCalibration).toHaveBeenCalled();
    expect(extension.showVideo).toHaveBeenCalled();
    expect(extension.showPredictions).toHaveBeenCalled();
    expect(extension.calibratePoint).not.toHaveBeenCalled();
    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      calibration_clicks_per_point: 5,
      calibration_total_clicks: 45,
      calibration_tracker_ready: true,
      calibration_tracker_ready_clicks: 45,
      calibration_regression_sample_count: 45,
    }));
    expect(finishTrial.mock.calls[0][0].calibration_regression_samples_by_point).toEqual(
      expect.arrayContaining([5, 10, 15, 20, 25, 30, 35, 40, 45]),
    );
  });

  it('uses compact Brown calibration points by default', () => {
    const displayElement = document.createElement('div');
    const plugin = new BrownRepeatedCalibrationPlugin({
      extensions: {
        webgazer: {
          resetCalibration: vi.fn(),
          resume: vi.fn(),
          showVideo: vi.fn(),
          showPredictions: vi.fn(),
          startMouseCalibration: vi.fn(),
        },
      },
      finishTrial: vi.fn(),
    });

    plugin.trial(displayElement, {
      calibration_points: [
        [10, 10],
        [50, 50],
      ],
      clicks_per_point: 5,
    });

    const point = displayElement.querySelector('[data-testid="brown-calibration-point-1"]');
    expect(point.style.width).toBe('14px');
    expect(point.style.height).toBe('14px');
  });

  it('keeps a one-point center-only calibration target visible', () => {
    const displayElement = document.createElement('div');
    const plugin = new BrownRepeatedCalibrationPlugin({
      extensions: {
        webgazer: {
          resetCalibration: vi.fn(),
          resume: vi.fn(),
          showVideo: vi.fn(),
          showPredictions: vi.fn(),
          startMouseCalibration: vi.fn(),
        },
      },
      finishTrial: vi.fn(),
    });

    plugin.trial(displayElement, {
      calibration_points: [[50, 50]],
      clicks_per_point: 5,
      point_size: 20,
    });

    const center = displayElement.querySelector('[data-testid="brown-calibration-point-1"]');
    const centerCount = displayElement.querySelector('[data-testid="brown-calibration-count-1"]');
    expect(center.hidden).toBe(false);
    expect(center.style.display).toBe('');
    expect(centerCount.hidden).toBe(false);
    expect(centerCount.style.display).toBe('');
  });

  it('Brown calibration waits for tracker readiness before accepting clicks', async () => {
    let trackerReady = false;
    let regressionCount = 0;
    const clickListener = () => {
      regressionCount += 1;
    };
    const finishTrial = vi.fn();
    const extension = {
      resetCalibration: vi.fn(),
      resume: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
      hideVideo: vi.fn(),
      startMouseCalibration: vi.fn(() => document.addEventListener('click', clickListener, true)),
      stopMouseCalibration: vi.fn(() => document.removeEventListener('click', clickListener, true)),
      getRegressionSampleCount: vi.fn(() => regressionCount),
      calibratePoint: vi.fn(),
      faceDetected: vi.fn(() => trackerReady),
      getCurrentPrediction: vi.fn(() => Promise.resolve(null)),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownRepeatedCalibrationPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      calibration_points: [[10, 10], [50, 50]],
      clicks_per_point: 1,
      point_size: 28,
    });
    const firstPoint = displayElement.querySelector('[data-testid="brown-calibration-point-1"]');
    expect(firstPoint.disabled).toBe(true);
    firstPoint.click();
    expect(extension.calibratePoint).not.toHaveBeenCalled();

    trackerReady = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(firstPoint.disabled).toBe(false);
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    firstPoint.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(extension.calibratePoint).not.toHaveBeenCalled();
    expect(regressionCount).toBe(1);
  });

  it('scores and labels Brown-style center precision', () => {
    expect(summarizeBrownPrecision(
      Array.from({ length: 60 }, (_, index) => ({ x: 500, y: 400, t: index * 34 })),
      { width: 1000, height: 800, maxSamples: 50 },
    )).toMatchObject({
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_precision_sample_count: 50,
      brown_precision_mean_error_px: 0,
    });
    expect(summarizeBrownPrecision(
      [{ x: 500, y: 520, t: 0 }],
      { width: 1000, height: 800, maxSamples: 50 },
    )).toMatchObject({
      brown_precision_percent: 70,
      brown_precision_label: 'fair',
      brown_precision_mean_error_px: 120,
    });
    expect(brownPrecisionLabel(null)).toBe('needs_attention');
    expect(brownPrecisionLabel(79)).toBe('fair');
    expect(brownPrecisionLabel(80)).toBe('good');
    expect(brownPrecisionLabel(90)).toBe('great');
    expect(summarizeBrownStoredPrecision(
      [
        Array.from({ length: 50 }, () => 500),
        Array.from({ length: 50 }, () => 400),
      ],
      { width: 1000, height: 800, maxSamples: 50, durationMs: 5000 },
    )).toMatchObject({
      brown_precision_percent: 100,
      brown_precision_sample_count: 50,
      brown_precision_samples_per_sec: 10,
    });
  });

  it('Brown precision check finishes cleanly without samples', () => {
    const finishTrial = vi.fn();
    const stored = [new Array(50), new Array(50)];
    const extension = {
      webgazer: {
        params: { storingPoints: false },
        storePoints: vi.fn((x, y, index) => {
          stored[0][index] = x;
          stored[1][index] = y;
        }),
        getStoredPoints: vi.fn(() => stored),
      },
      resume: vi.fn(),
      pause: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      duration_ms: 5000,
      sampling_interval: 34,
      max_samples: 50,
    });
    vi.advanceTimersByTime(5000);

    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      brown_precision_percent: null,
      brown_precision_label: 'needs_attention',
      brown_precision_sample_count: 0,
      brown_precision_sample_source: 'unavailable',
      brown_stored_sample_count: 0,
      brown_direct_sample_count: 0,
    }));
    expect(extension.webgazer.params.storingPoints).toBe(false);
    expect(extension.webgazer.storePoints).toHaveBeenCalledWith(Number.NaN, Number.NaN, 0);
    expect(extension.showPredictions).toHaveBeenCalled();
    expect(extension.hidePredictions).toHaveBeenCalled();
  });

  it('Brown precision check reads WebGazer stored points', async () => {
    const finishTrial = vi.fn();
    const stored = [new Array(50), new Array(50)];
    const extension = {
      webgazer: {
        params: { storingPoints: false },
        storePoints: vi.fn((x, y, index) => {
          stored[0][index] = x;
          stored[1][index] = y;
        }),
        getStoredPoints: vi.fn(() => stored),
      },
      resume: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      duration_ms: 100,
      sampling_interval: 34,
      max_samples: 50,
    });
    for (let index = 0; index < 50; index += 1) {
      stored[0][index] = window.innerWidth / 2;
      stored[1][index] = window.innerHeight / 2;
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_precision_sample_source: 'webgazer_stored_points',
      brown_stored_sample_count: 50,
      brown_direct_sample_count: 0,
    }));
    expect(finishTrial.mock.calls[0][0].brown_precision_sample_count).toBeGreaterThan(0);
    expect(displayElement.querySelectorAll('.brown-precision-sample-dot')).toHaveLength(50);
  });

  it('Brown precision check stores app-polled predictions before plotting', async () => {
    const finishTrial = vi.fn();
    const stored = [new Array(50), new Array(50)];
    const extension = {
      webgazer: {
        params: { storingPoints: false },
        storePoints: vi.fn((x, y, index) => {
          stored[0][index] = x;
          stored[1][index] = y;
        }),
        getStoredPoints: vi.fn(() => stored),
      },
      resume: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
      getCurrentPrediction: vi.fn(async () => ({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      duration_ms: 100,
      sampling_interval: 34,
      max_samples: 50,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_precision_sample_source: 'webgazer_stored_points',
    }));
    expect(finishTrial.mock.calls[0][0].brown_stored_sample_count).toBeGreaterThan(0);
    expect(finishTrial.mock.calls[0][0].brown_direct_sample_count).toBeGreaterThan(0);
    expect(extension.webgazer.storePoints).toHaveBeenCalledWith(window.innerWidth / 2, window.innerHeight / 2, 0);
    expect(displayElement.querySelector('[data-testid="brown-precision-live-dot"]').hidden).toBe(false);
    expect(displayElement.querySelectorAll('.brown-precision-sample-dot').length).toBeGreaterThan(0);
  });

  it('Brown precision check starts the WebGazer sample interval after calibration', async () => {
    const finishTrial = vi.fn();
    const unsubscribe = vi.fn();
    let gazeCallback = null;
    const stored = [new Array(50), new Array(50)];
    const extension = {
      webgazer: {
        params: { storingPoints: false },
        storePoints: vi.fn((x, y, index) => {
          stored[0][index] = x;
          stored[1][index] = y;
        }),
        getStoredPoints: vi.fn(() => stored),
      },
      resume: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
      startSampleInterval: vi.fn(),
      stopSampleInterval: vi.fn(),
      onGazeUpdate: vi.fn((callback) => {
        gazeCallback = callback;
        return unsubscribe;
      }),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      duration_ms: 100,
      sampling_interval: 34,
      max_samples: 50,
    });
    gazeCallback({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(extension.startSampleInterval).toHaveBeenCalledWith(34);
    expect(extension.stopSampleInterval).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_stored_sample_count: 1,
      brown_direct_sample_count: 1,
    }));
  });

  it('Brown precision check still stores points when visual plotting fails', async () => {
    const finishTrial = vi.fn();
    const stored = [new Array(50), new Array(50)];
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      if (String(tagName).toLowerCase() === 'span') {
        throw new Error('dot plotting failed');
      }
      return originalCreateElement(tagName, options);
    });
    const extension = {
      webgazer: {
        params: { storingPoints: false },
        storePoints: vi.fn((x, y, index) => {
          stored[0][index] = x;
          stored[1][index] = y;
        }),
        getStoredPoints: vi.fn(() => stored),
      },
      resume: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
      getCurrentPrediction: vi.fn(async () => ({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })),
    };
    const displayElement = document.createElement('div');
    const logger = { warn: vi.fn(), trace: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const plugin = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      duration_ms: 100,
      sampling_interval: 34,
      max_samples: 50,
      logger,
    });
    await vi.advanceTimersByTimeAsync(100);
    createElementSpy.mockRestore();

    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_precision_sample_source: 'webgazer_stored_points',
    }));
    expect(finishTrial.mock.calls[0][0].brown_stored_sample_count).toBeGreaterThan(0);
    expect(displayElement.querySelectorAll('.brown-precision-sample-dot')).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'calibration',
      'precision',
      expect.stringMatching(/precision_.*plot_failed/),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('Brown precision check falls back to direct predictions when no stored buffer exists', async () => {
    const finishTrial = vi.fn();
    const extension = {
      webgazer: {
        params: { storingPoints: false },
      },
      resume: vi.fn(),
      showVideo: vi.fn(),
      showPredictions: vi.fn(),
      hidePredictions: vi.fn(),
      getCurrentPrediction: vi.fn(async () => ({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })),
    };
    const displayElement = document.createElement('div');
    const plugin = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial,
    });

    plugin.trial(displayElement, {
      duration_ms: 100,
      sampling_interval: 34,
      max_samples: 50,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(finishTrial).toHaveBeenCalledWith(expect.objectContaining({
      brown_precision_percent: 100,
      brown_precision_label: 'great',
      brown_precision_sample_source: 'direct_prediction_poll',
      brown_stored_sample_count: 0,
    }));
    expect(finishTrial.mock.calls[0][0].brown_direct_sample_count).toBeGreaterThan(0);
  });

  it('records completed setup from the single Brown-like flow', async () => {
    const store = new SessionDataStore({ participantId: 'brown-setup' });
    const onStatus = vi.fn();
    const onPhase = vi.fn();
    const bridge = new WebGazerBridge({
      mode: 'real',
      samplingIntervalMs: 34,
    });
    const harness = installMockRealSetupRuntime(bridge);

    const row = await bridge.runSetup({
      store,
      participantId: 'brown-setup',
      mode: 'real',
      calibrationClicksPerPoint: 3,
      onStatus,
      onPhase,
    });

    expect(row).toMatchObject({
      mode: 'real',
      status: 'completed',
      setup_completed: true,
      calibration_mode: 'brown_repeated_click',
      calibration_clicks_per_point: 3,
      calibration_total_clicks: 27,
      brown_precision_percent: 84,
      brown_precision_label: 'good',
      brown_precision_sample_count: 50,
      brown_precision_sample_source: 'webgazer_stored_points',
      calibration_regression_sample_count: 27,
      error: null,
    });
    const extension = harness.runs[0].extension;
    expect(JSON.parse(row.calibration_points)).toHaveLength(9);
    expect(JSON.parse(row.calibration_regression_samples_by_point)).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27]);
    expect(extension.showVideo).toHaveBeenCalled();
    expect(extension.hideVideo).toHaveBeenCalled();
    expect(extension.pause).toHaveBeenCalled();
    expect(onPhase).toHaveBeenCalledWith('camera');
    expect(onPhase).toHaveBeenCalledWith('targets');
    expect(onStatus).toHaveBeenCalledWith('Center your face in the WebGazer webcam preview. Continue when the face box turns green.');
    expect(onStatus).toHaveBeenCalledWith('WebGazer setup complete. Brown-style precision 84% (good); 27 of 27 calibration clicks tracker-ready, 27 WebGazer calibration samples trained, 50 scored accuracy samples (WebGazer stored points), 10.0 Brown Hz, 52.0 px Brown mean error.');
    expect(store.getRows('webgazer_runs')).toHaveLength(1);
    await bridge.start({
      store,
      trialId: 'trial_1',
      trialStartMs: performance.now(),
      mode: 'real',
      getCurrentContext: () => ({
        pieceId: 'piece_1',
        pieceSpawnTTrialMs: 0,
        canvasRect: { left: 0, top: 0, width: 500, height: 620 },
      }),
    });
    expect(extension.startSampleInterval).toHaveBeenCalledWith(34);
    bridge.stop();
  });

  it('replaces the active real setup when recalibrating in the same session', async () => {
    const store = new SessionDataStore({ participantId: 'recalibration' });
    const bridge = new WebGazerBridge({ mode: 'real', samplingIntervalMs: 34 });
    const harness = installMockRealSetupRuntime(bridge);

    const firstRow = await bridge.runSetup({
      store,
      participantId: 'recalibration',
      mode: 'real',
      calibrationClicksPerPoint: 3,
    });
    const firstExtension = harness.runs[0].extension;

    const secondRow = await bridge.runSetup({
      store,
      participantId: 'recalibration',
      mode: 'real',
      calibrationClicksPerPoint: 5,
    });

    expect(store.getRows('webgazer_runs')).toHaveLength(2);
    expect(firstRow.webgazer_run_id).not.toBe(secondRow.webgazer_run_id);
    expect(secondRow).toMatchObject({
      status: 'completed',
      setup_completed: true,
      calibration_clicks_per_point: 5,
      calibration_total_clicks: 45,
      brown_precision_percent: 85,
    });
    expect(bridge.setupSummary).toBe(secondRow);
    expect(bridge.hasCompletedSetup()).toBe(true);
    expect(harness.runs).toHaveLength(2);
    expect(harness.runtime.end).toHaveBeenCalledTimes(1);
    expect(harness.runtime.stopVideo).toHaveBeenCalledTimes(1);
    expect(harness.runtime.clearData).toHaveBeenCalled();
    expect(firstExtension.stopMouseCalibration).toHaveBeenCalled();
    expect(firstExtension.hideVideo).toHaveBeenCalled();

    await bridge.start({
      store,
      trialId: 'trial_1',
      trialStartMs: performance.now(),
      mode: 'real',
      getCurrentContext: () => ({
        pieceId: 'piece_1',
        pieceSpawnTTrialMs: 0,
        canvasRect: { left: 0, top: 0, width: 500, height: 620 },
      }),
    });
    expect(harness.runs[1].extension.startSampleInterval).toHaveBeenCalledWith(34);
    bridge.stop();
  });

  it('invalidates the previous active setup when recalibration fails', async () => {
    const store = new SessionDataStore({ participantId: 'failed-recalibration' });
    const bridge = new WebGazerBridge({ mode: 'real', samplingIntervalMs: 34 });
    const failedRuns = new Set();
    installMockRealSetupRuntime(bridge, {
      shouldFailRun: (runIndex) => failedRuns.has(runIndex),
    });

    const firstRow = await bridge.runSetup({
      store,
      participantId: 'failed-recalibration',
      mode: 'real',
    });
    expect(firstRow.status).toBe('completed');
    expect(bridge.hasCompletedSetup()).toBe(true);

    failedRuns.add(1);
    const secondRow = await bridge.runSetup({
      store,
      participantId: 'failed-recalibration',
      mode: 'real',
    });

    expect(store.getRows('webgazer_runs')).toHaveLength(2);
    expect(secondRow).toMatchObject({
      status: 'error',
      setup_completed: false,
      error: 'setup failure 2',
    });
    expect(bridge.setupSummary).toBeNull();
    expect(bridge.hasCompletedSetup()).toBe(false);
    await expect(bridge.start({
      store,
      trialId: 'trial_blocked',
      trialStartMs: performance.now(),
      mode: 'real',
      getCurrentContext: () => ({}),
    })).rejects.toThrow('WebGazer setup must complete before real trial sampling starts.');
  });

  it('real WebGazer sampling uses the jsPsych extension gaze callback', async () => {
    const store = new SessionDataStore();
    const bridge = new WebGazerBridge({ mode: 'real', samplingIntervalMs: 34 });
    let gazeCallback = null;
    const extension = {
      isInitialized: vi.fn(() => true),
      start: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      startSampleInterval: vi.fn(),
      stopSampleInterval: vi.fn(),
      onGazeUpdate: vi.fn((callback) => {
        gazeCallback = callback;
        return vi.fn();
      }),
    };
    bridge.jsPsych = { extensions: { webgazer: extension } };
    bridge.extension = extension;
    bridge.plugins = {};
    bridge.setupSummary = { setup_completed: true };

    await bridge.start({
      store,
      trialId: 'trial_1',
      trialStartMs: performance.now(),
      mode: 'real',
      getCurrentContext: () => ({
        pieceId: 'piece_1',
        pieceSpawnTTrialMs: 0,
        canvasRect: { left: 10, top: 20, width: 500, height: 620 },
      }),
    });
    gazeCallback({ x: 214.4, y: 318.8, t: performance.now() });
    bridge.stop();

    expect(extension.startSampleInterval).toHaveBeenCalledWith(34);
    expect(extension.onGazeUpdate).toHaveBeenCalled();
    expect(store.getRows('gaze_samples')[0]).toMatchObject({
      trial_id: 'trial_1',
      piece_id: 'piece_1',
      x: 214.4,
      y: 318.8,
      valid: true,
    });
  });

  it('real WebGazer sampling polls current predictions when callbacks are silent after calibration', async () => {
    const store = new SessionDataStore();
    const bridge = new WebGazerBridge({ mode: 'real', samplingIntervalMs: 34 });
    const extension = {
      isInitialized: vi.fn(() => true),
      start: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      startSampleInterval: vi.fn(),
      stopSampleInterval: vi.fn(),
      onGazeUpdate: vi.fn(() => vi.fn()),
      getCurrentPrediction: vi.fn(async () => ({
        x: 301.2,
        y: 402.7,
        confidence: 0.81,
      })),
    };
    bridge.jsPsych = { extensions: { webgazer: extension } };
    bridge.extension = extension;
    bridge.plugins = {};
    bridge.setupSummary = { setup_completed: true };

    await bridge.start({
      store,
      trialId: 'trial_1',
      trialStartMs: performance.now(),
      mode: 'real',
      getCurrentContext: () => ({
        pieceId: 'piece_1',
        pieceSpawnTTrialMs: 0,
        canvasRect: { left: 10, top: 20, width: 500, height: 620 },
      }),
    });
    await vi.advanceTimersByTimeAsync(34);
    bridge.stop();

    expect(extension.startSampleInterval).toHaveBeenCalledWith(34);
    expect(extension.getCurrentPrediction).toHaveBeenCalled();
    expect(store.getRows('gaze_samples')[0]).toMatchObject({
      trial_id: 'trial_1',
      piece_id: 'piece_1',
      x: 301.2,
      y: 402.7,
      confidence: 0.81,
      valid: true,
    });
  });

  it('trial runner records webgazer_error when real sampling cannot start', async () => {
    const store = new SessionDataStore();
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 620;
    const failingBridge = {
      start: vi.fn(() => Promise.reject(new Error('extension unavailable'))),
      stop: vi.fn(),
    };
    const onStatus = vi.fn();
    const runner = new JsPsychTetrisTrialRunner({
      store,
      canvas,
      gazeMode: 'real',
      webgazerBridge: failingBridge,
      onStatus,
      onComplete: vi.fn(),
    });

    await expect(runner.start({ participantId: 'p01' })).rejects.toThrow('extension unavailable');

    expect(store.getRows('trials')[0]).toMatchObject({
      end_reason: 'webgazer_error',
    });
    expect(onStatus).toHaveBeenCalledWith(
      'WebGazer unavailable; eye-tracking data cannot be collected for this trial: extension unavailable',
    );
  });

  it('maps replay viewport coordinates into overlay coordinates', () => {
    const store = fixtureReplayStore();
    const video = document.createElement('video');
    const overlay = document.createElement('canvas');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 500, height: 620 }),
    });
    const replay = new ReplayController({ store, video, overlay });

    replay.loadTrial('trial_1');
    const point = replay.mapPoint({ x: 260, y: 330 });

    expect(point).toEqual({ x: 250, y: 310 });
  });

  it('reports replay piece details from synchronized canonical rows', () => {
    const store = fixtureReplayStore();
    const video = document.createElement('video');
    const overlay = document.createElement('canvas');
    const details = document.createElement('div');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 500, height: 620 }),
    });
    const replay = new ReplayController({ store, video, overlay, details });

    replay.loadTrial('trial_1');
    const midPiece = replay.getPieceDetails(200);
    const lockedPiece = replay.getPieceDetails(900);

    expect(midPiece).toMatchObject({
      piece_id: 'piece_1',
      piece_type: 'I',
      elapsed_piece_ms: 200,
      current_aoi: 'board',
      current_action: 'move_left',
      placement_outcome: 'Pending',
    });
    expect(lockedPiece.placement_outcome).toContain('locked col 3, row 18');
    video.currentTime = 0.2;
    replay.draw();
    expect(details.textContent).toContain('piece_1 I');
  });

  it('defines replay legend and color mapping for placed stack AOIs', () => {
    expect(REPLAY_LEGEND_ITEMS).toContainEqual({ aoi: 'stack_blocks', label: 'Placed stack' });
    expect(colorForAoi('stack_blocks')).toContain('126, 211, 132');
  });

  it('lets replay users choose how many previous gaze points stay visible', () => {
    const store = fixtureReplayStore();
    const video = document.createElement('video');
    const overlay = document.createElement('canvas');
    const trailSelect = document.createElement('select');
    for (const count of [0, 1, 3, 5, 10]) {
      trailSelect.append(new Option(String(count), String(count)));
    }
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 500, height: 620 }),
    });
    const replay = new ReplayController({
      store,
      video,
      overlay,
      trailSelect,
      previousGazeCount: 3,
    });

    expect(replay.previousGazeCount).toBe(3);
    trailSelect.value = '10';
    trailSelect.dispatchEvent(new Event('change'));
    expect(replay.previousGazeCount).toBe(10);
    replay.setPreviousGazeCount(2);
    expect(replay.previousGazeCount).toBe(5);
    expect(trailSelect.value).toBe('5');
  });

  it('defines replay legend and color mapping for current gaze and gaze trail', () => {
    expect(REPLAY_LEGEND_ITEMS).toContainEqual({ aoi: 'gaze_point', label: 'Current gaze' });
    expect(REPLAY_LEGEND_ITEMS).toContainEqual({ aoi: 'gaze_trail', label: 'Previous gaze trail' });
    expect(colorForAoi('gaze_point')).toContain('255, 42, 42');
    expect(colorForAoi('gaze_trail')).toContain('45, 126, 255');
  });

  it('builds JSON, CSV, and media artifact lists', () => {
    const store = fixtureReplayStore();
    const service = new ExportService(store);

    const artifacts = service.buildArtifacts();

    expect(JSON.parse(artifacts.json).tables.trials.rows).toHaveLength(1);
    expect(artifacts.csv.pieces).toContain('trial_id,piece_id');
    expect(artifacts.csv.webgazer_runs).toContain('webgazer_run_id');
    expect(artifacts.csv.diagnostic_events).toContain('event_id,session_id');
    expect(artifacts.csv.post_trial_responses).toContain('response_id');
    expect(artifacts.csv.gaze_aoi_classifications).toContain('primary_aoi');
    expect(artifacts.csv.piece_indexes).toContain('gaze_start_index');
  });
});

function fixtureReplayStore() {
  const store = new SessionDataStore();
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
    recording_id: 'recording_1',
  });
  store.addRow('trial_recordings', {
    recording_id: 'recording_1',
    trial_id: 'trial_1',
    file_name: 'trial_1.webm',
    mime_type: 'video/webm',
    source: 'tetris_canvas_capture_stream',
    width_px: 500,
    height_px: 620,
    target_fps: 30,
    start_t_trial_ms: 0,
    end_t_trial_ms: 1000,
    duration_ms: 1000,
    video_time_origin_ms: 0,
    status: 'unsupported',
    error: null,
  });
  store.addRow('pieces', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    piece_type: 'I',
    piece_index: 1,
    spawn_t_trial_ms: 0,
    lock_t_trial_ms: 800,
    duration_ms: 800,
    spawn_col: 3,
    spawn_row: 0,
    spawn_rotation: 0,
    lock_col: 3,
    lock_row: 18,
    lock_rotation: 0,
    hard_drop_used: true,
    lines_cleared: 0,
    score_delta: 0,
    board_height_before: 0,
    board_height_after: 1,
    holes_before: 0,
    holes_after: 0,
  });
  store.addRow('layout', {
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
  });
  store.addRow('gaze_samples', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    t_trial_ms: 100,
    t_piece_ms: 100,
    x: 260,
    y: 330,
    confidence: 0.9,
    valid: true,
  });
  store.addRow('game_events', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    t_trial_ms: 150,
    t_piece_ms: 150,
    event_type: 'move_left',
    key: 'ArrowLeft',
    piece_type: 'I',
    col: 2,
    row: 0,
    rotation: 0,
    score_after: 0,
    lines_after: 0,
    accepted: true,
    details: '{}',
  });
  store.addRow('aoi_visits', {
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    visit_id: 'visit_1',
    aoi: 'board',
    start_t_trial_ms: 100,
    end_t_trial_ms: 300,
    duration_ms: 200,
    sample_count: 3,
    mean_confidence: 0.9,
    start_t_piece_ms: 100,
    end_t_piece_ms: 300,
  });
  store.addRow('aoi_snapshots', {
    aoi_state_id: 'aoi_1',
    trial_id: 'trial_1',
    piece_id: 'piece_1',
    valid_from_t_trial_ms: 0,
    valid_to_t_trial_ms: 1000,
    valid_from_t_piece_ms: 0,
    valid_to_t_piece_ms: 1000,
    layout_id: 'layout_1',
    aoi: 'board',
    x: 52,
    y: 64,
    w: 240,
    h: 480,
    priority: 10,
    source: 'layout',
    source_state_id: 'state_1',
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
  return store;
}
