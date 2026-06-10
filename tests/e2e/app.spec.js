import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';

async function installMockCameraDevices(page, options = {}) {
  await page.addInitScript((mockOptions) => {
    window.__cameraRequests = [];
    window.__cameraEnumerations = [];
    window.__cameraShouldFail = Boolean(mockOptions.failInitially);
    window.__cameraPermissionGranted = false;
    const devices = [
      { kind: 'videoinput', deviceId: 'camera-1', label: 'Integrated Camera' },
      { kind: 'videoinput', deviceId: 'camera-2', label: 'USB Camera' },
    ];
    const createMockCameraStream = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext('2d')?.fillRect(0, 0, 2, 2);
      return canvas.captureStream ? canvas.captureStream(5) : new MediaStream();
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: () => {
          window.__cameraEnumerations.push({ permissionGranted: window.__cameraPermissionGranted });
          if (mockOptions.hideDevicesUntilPermission && !window.__cameraPermissionGranted) {
            return Promise.resolve([{ kind: 'videoinput', deviceId: 'camera-1', label: '' }]);
          }
          return Promise.resolve(devices.map((device, index) => ({
            ...device,
            label: window.__cameraPermissionGranted ? device.label : `Camera ${index + 1}`,
          })));
        },
        getUserMedia: (constraints) => {
          window.__cameraRequests.push(JSON.parse(JSON.stringify(constraints)));
          if (window.__cameraShouldFail) {
            return Promise.reject(new Error('Permission denied'));
          }
          window.__cameraPermissionGranted = true;
          return Promise.resolve(createMockCameraStream());
        },
      },
    });
  }, options);
}

async function gotoSetup(page) {
  await page.goto('/#setup', { waitUntil: 'domcontentloaded' });
}

test('renders all primary MVP views', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await expect(page.getByTestId('view-setup')).toBeVisible();
  await expect(page.getByTestId('setup-session-panel').getByRole('heading', { name: 'Session', exact: true })).toBeVisible();
  await expect(page.getByTestId('setup-session-panel').getByRole('heading', { name: 'Session Steps' })).toBeVisible();
  await expect(page.getByText('Choose and validate the camera')).toBeVisible();
  await expect(page.getByLabel('Clicks Per Calibration Point')).toHaveValue('5');
  await expect
    .poll(() => page.getByLabel('Clicks Per Calibration Point').locator('option').evaluateAll((options) => options.map((option) => option.value).join(',')))
    .toBe('1,3,5,8,9');
  await expect(page.getByTestId('nav-setup')).toBeVisible();
  await expect(page.getByTestId('nav-home')).toHaveCount(0);
  await expect(page.getByTestId('setup-camera-panel')).toBeVisible();
  await expect(page.getByTestId('setup-calibration-panel')).toBeVisible();
  const sessionPanel = await page.getByTestId('setup-session-panel').boundingBox();
  const cameraPanel = await page.getByTestId('setup-camera-panel').boundingBox();
  const calibrationPanel = await page.getByTestId('setup-calibration-panel').boundingBox();
  expect(sessionPanel).not.toBeNull();
  expect(cameraPanel).not.toBeNull();
  expect(calibrationPanel).not.toBeNull();
  expect(sessionPanel.y).toBeLessThan(cameraPanel.y);
  expect(cameraPanel.y).toBeLessThan(calibrationPanel.y);
  expect(Math.abs(sessionPanel.width - cameraPanel.width)).toBeLessThan(2);
  expect(Math.abs(cameraPanel.width - calibrationPanel.width)).toBeLessThan(2);
  const sidebarBox = await page.getByTestId('app-sidebar').boundingBox();
  expect(sidebarBox.x).toBeLessThan(2);
  expect(sidebarBox.width).toBeGreaterThan(160);
  expect(sidebarBox.height).toBeGreaterThan(850);
  for (const view of ['setup', 'play', 'replay', 'analysis', 'export']) {
    await page.getByTestId(`nav-${view}`).click();
    await expect(page.getByTestId(`view-${view}`)).toBeVisible();
  }
});

test('mock WebGazer setup creates calibration metadata before play', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);

  await page.getByLabel('Enable detailed diagnostics').check();
  await page.getByLabel('Use deterministic mock gaze for tests or demos').check();
  await page.getByLabel('Clicks Per Calibration Point').selectOption('3');
  await page.getByRole('button', { name: 'Run WebGazer Setup' }).click();
  await expect(page.getByTestId('calibration-status')).toContainText('Brown-style precision 100% (great)');
  await expect(page.getByTestId('calibration-status')).toContainText('27 WebGazer calibration samples trained');
  await expect(page.getByTestId('diagnostics-summary')).toContainText('Detailed logging on');
  await expect(page.getByRole('button', { name: 'Run WebGazer Setup' })).not.toHaveClass(/setup-action-attention/);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs').length))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('diagnostic_events').length))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs')[0].status))
    .toBe('completed');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs')[0].calibration_total_clicks))
    .toBe(27);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs')[0].calibration_clicks_per_point))
    .toBe(3);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(window.tetrisEyeTrackingApp.store.getRows('webgazer_runs')[0].calibration_points).length))
    .toBe(9);

  await page.getByLabel('Clicks Per Calibration Point').selectOption('5');
  await page.getByRole('button', { name: 'Run WebGazer Setup' }).click();
  await expect(page.getByTestId('calibration-status')).toContainText('Brown-style precision 100% (great)');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs').length))
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs')[1].calibration_total_clicks))
    .toBe(45);

  await page.getByTestId('nav-play').click();
  await page.getByRole('button', { name: 'Start Trial' }).click();
  await expect(page.getByTestId('trial-status')).toContainText(/Trial .* running/);
  await page.getByRole('button', { name: 'Quit' }).click();
  await expect(page.getByTestId('trial-status')).toContainText('Trial ended: quit', { timeout: 8_000 });
});

test('failed recalibration blocks trial start after a prior setup completed', async ({ page }) => {
  await installMockCameraDevices(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);

  await page.getByLabel('Use deterministic mock gaze for tests or demos').uncheck();
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  await page.evaluate(() => {
    const bridge = window.tetrisEyeTrackingApp.webgazerBridge;
    let setupAttempt = 0;
    bridge.runSetup = async (options) => {
      setupAttempt += 1;
      const row = options.store.addRow('webgazer_runs', {
        webgazer_run_id: `webgazer_real_recalibration_${setupAttempt}`,
        session_id: options.store.session.session_id,
        participant_id: options.participantId ?? 'anonymous',
        mode: 'real',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        status: setupAttempt === 1 ? 'completed' : 'error',
        setup_completed: setupAttempt === 1,
        camera_load_time_ms: null,
        calibration_mode: 'brown_repeated_click',
        calibration_clicks_per_point: 5,
        calibration_total_clicks: setupAttempt === 1 ? 45 : 0,
        calibration_tracker_ready: setupAttempt === 1,
        calibration_tracker_ready_elapsed_ms: null,
        calibration_tracker_ready_clicks: setupAttempt === 1 ? 45 : 0,
        calibration_regression_sample_count: setupAttempt === 1 ? 45 : 0,
        calibration_regression_samples_by_point: JSON.stringify(setupAttempt === 1 ? [5, 10, 15, 20, 25, 30, 35, 40, 45] : []),
        brown_precision_percent: setupAttempt === 1 ? 88 : null,
        brown_precision_label: setupAttempt === 1 ? 'good' : 'needs_attention',
        brown_precision_sample_count: setupAttempt === 1 ? 50 : 0,
        brown_precision_mean_error_px: null,
        brown_precision_samples_per_sec: null,
        brown_precision_sample_source: setupAttempt === 1 ? 'webgazer_stored_points' : 'unavailable',
        brown_stored_sample_count: setupAttempt === 1 ? 50 : 0,
        brown_direct_sample_count: 0,
        calibration_points: JSON.stringify([[10, 10], [50, 10], [90, 10], [10, 50], [50, 50], [90, 50], [10, 90], [50, 90], [90, 90]]),
        error: setupAttempt === 1 ? null : 'mocked real recalibration failed',
      });
      bridge.setupSummary = setupAttempt === 1 ? row : null;
      return row;
    };
  });
  await page.getByRole('button', { name: 'Run WebGazer Setup' }).click();
  await expect(page.getByTestId('calibration-status')).toContainText('Brown-style precision 88% (good)');
  await page.getByRole('button', { name: 'Run WebGazer Setup' }).click();
  await expect(page.getByTestId('calibration-status')).toContainText('mocked real recalibration failed');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs').length))
    .toBe(2);

  await page.getByTestId('nav-play').click();
  await page.getByRole('button', { name: 'Start Trial' }).click();
  await expect(page.getByTestId('trial-status')).toContainText('Run and complete WebGazer setup before starting a real eye-tracking trial.');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials').length))
    .toBe(0);
});

test('setup loads full camera choices before manual validation', async ({ page }) => {
  await installMockCameraDevices(page, { hideDevicesUntilPermission: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);
  await page.getByLabel('Use deterministic mock gaze for tests or demos').uncheck();

  await expect
    .poll(() => page.evaluate(() => window.__cameraRequests.length))
    .toBe(1);
  await expect(page.getByLabel('Camera')).toContainText('Integrated Camera');
  await expect(page.getByLabel('Camera')).toContainText('USB Camera');
  await expect(page.getByLabel('Camera')).toHaveValue('camera-1');
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  await expect(page.getByTestId('camera-selection-status')).toContainText('First available camera selected');
  await expect(page.getByRole('button', { name: 'Validate Camera' })).not.toHaveClass(/camera-selection-attention/);
  await expect(page.getByRole('button', { name: 'Run WebGazer Setup' })).toHaveClass(/setup-action-attention/);
});

test('camera selection reports denial, retries, and switches selected preview', async ({ page }) => {
  await installMockCameraDevices(page, { failInitially: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);
  await page.getByLabel('Use deterministic mock gaze for tests or demos').uncheck();

  await expect(page.getByText('Camera Selection')).toBeVisible();
  await expect(page.getByLabel('Camera')).toHaveValue('camera-1');
  await expect(page.getByRole('button', { name: 'Validate Camera' })).toHaveClass(/camera-selection-attention/);

  await page.getByRole('button', { name: 'Validate Camera' }).click();
  await expect(page.getByTestId('calibration-status')).toContainText('Camera selection failed: Permission denied');

  await page.evaluate(() => {
    window.__cameraShouldFail = false;
  });
  await page.getByRole('button', { name: 'Validate Camera' }).click();
  await expect(page.getByTestId('calibration-status')).toContainText('Camera selection validated');
  await expect(page.getByTestId('camera-selection-status')).toContainText('Camera selected');
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validate Camera' })).not.toHaveClass(/camera-selection-attention/);
  await expect(page.getByRole('button', { name: 'Run WebGazer Setup' })).toHaveClass(/setup-action-attention/);
  await expect(page.getByLabel('Camera')).toContainText('Integrated Camera');

  await page.getByLabel('Camera').selectOption('camera-2');
  await expect(page.getByTestId('camera-selection-status')).toContainText('Camera selected');
  await expect(page.getByLabel('Camera')).toHaveValue('camera-2');
  await expect
    .poll(() => page.evaluate(() => window.__cameraRequests.at(-1)?.video?.deviceId?.exact))
    .toBe('camera-2');

  await page.getByTestId('nav-play').click();
  await page.getByRole('button', { name: 'Start Trial' }).click();
  await expect(page.getByTestId('trial-status')).toContainText('Run and complete WebGazer setup before starting a real eye-tracking trial.');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials').length))
    .toBe(0);
});

test('Brown calibration plugins render and complete in the browser', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);

  await page.evaluate(async () => {
    const {
      BrownRepeatedCalibrationPlugin,
    } = await import('/src/experiment/WebGazerBridge.js');
    window.__brownFinished = [];
    window.__brownGazeCallback = null;
    window.__brownRegressionCount = 0;
    const calibrationClickListener = () => {
      window.__brownRegressionCount += 1;
    };
    const extension = {
      resetCalibration: () => {},
      resume: () => {},
      pause: () => {},
      hidePredictions: () => {},
      hideVideo: () => {},
      showVideo: () => {},
      showPredictions: () => {},
      startMouseCalibration: () => document.addEventListener('click', calibrationClickListener, true),
      stopMouseCalibration: () => document.removeEventListener('click', calibrationClickListener, true),
      getRegressionSampleCount: () => window.__brownRegressionCount,
      calibratePoint: () => {},
      onGazeUpdate: (callback) => {
        window.__brownGazeCallback = callback;
        return () => {};
      },
    };
    const mount = document.createElement('div');
    mount.id = 'brown-test-root';
    document.body.appendChild(mount);
    const calibration = new BrownRepeatedCalibrationPlugin({
      extensions: { webgazer: extension },
      finishTrial: (data) => window.__brownFinished.push({ phase: 'calibration', data }),
    });
    calibration.trial(mount, {
      calibration_points: [[10, 10], [50, 10], [90, 10], [10, 50], [50, 50], [90, 50], [10, 90], [50, 90], [90, 90]],
      clicks_per_point: 5,
      point_size: 20,
    });
  });

  await expect(page.getByTestId('brown-calibration-container')).toBeVisible();
  await expect(page.getByTestId('plotting-canvas')).toBeVisible();
  await expect(page.getByTestId('brown-calibration-point-5')).toBeHidden();
  await expect(page.getByTestId('brown-calibration-count-1')).toHaveText('0');
  await expect(page.getByTestId('brown-calibration-count-5')).toBeHidden();
  await page.getByTestId('brown-calibration-point-1').click();
  await expect(page.getByTestId('brown-calibration-count-1')).toHaveText('1');
  for (let click = 0; click < 4; click += 1) {
    await page.getByTestId('brown-calibration-point-1').click();
  }
  for (const index of [1, 2, 3, 4, 6, 7, 8, 9]) {
    if (index === 1) {
      continue;
    }
    for (let click = 0; click < 5; click += 1) {
      await page.getByTestId(`brown-calibration-point-${index}`).click();
    }
  }
  await expect(page.getByTestId('brown-calibration-point-5')).toBeVisible();
  await expect(page.getByTestId('brown-calibration-count-5')).toBeVisible();
  for (let click = 0; click < 5; click += 1) {
    await page.getByTestId('brown-calibration-point-5').click();
  }
  await expect(page.getByTestId('brown-calibration-count-5')).toHaveText('5');
  await expect
    .poll(() => page.evaluate(() => window.__brownFinished[0]?.data.calibration_total_clicks))
    .toBe(45);
  await expect
    .poll(() => page.evaluate(() => window.__brownFinished[0]?.data.calibration_regression_sample_count))
    .toBe(45);

  await page.evaluate(async () => {
    const { BrownPrecisionCheckPlugin } = await import('/src/experiment/WebGazerBridge.js');
    const mount = document.querySelector('#brown-test-root');
    const stored = [new Array(50), new Array(50)];
    const extension = {
      webgazer: {
        params: { storingPoints: false },
        storePoints: (x, y, index) => {
          stored[0][index] = x;
          stored[1][index] = y;
        },
        getStoredPoints: () => stored,
      },
      resume: () => {},
      pause: () => {},
      showVideo: () => {},
      showPredictions: () => {},
      hidePredictions: () => {},
      getCurrentPrediction: () => Promise.resolve({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }),
    };
    const precision = new BrownPrecisionCheckPlugin({
      extensions: { webgazer: extension },
      finishTrial: (data) => window.__brownFinished.push({ phase: 'precision', data }),
    });
    precision.trial(mount, {
      duration_ms: 50,
      sampling_interval: 34,
      max_samples: 50,
    });
    for (let index = 0; index < 50; index += 1) {
      stored[0][index] = window.innerWidth / 2;
      stored[1][index] = window.innerHeight / 2;
    }
  });
  await expect(page.getByTestId('brown-precision-target')).toBeVisible();
  await expect(page.getByTestId('plotting-canvas')).toBeVisible();
  await expect(page.getByTestId('brown-precision-live-dot')).toBeVisible();
  await expect
    .poll(() => page.locator('.brown-precision-sample-dot').count())
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.__brownFinished.at(-1)?.data.brown_precision_percent))
    .toBe(100);
  await expect
    .poll(() => page.evaluate(() => window.__brownFinished.at(-1)?.data.brown_precision_sample_source))
    .toBe('webgazer_stored_points');
});

test('real WebGazer setup opens a fixed no-scroll calibration surface', async ({ page }) => {
  await installMockCameraDevices(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);

  await page.getByLabel('Use deterministic mock gaze for tests or demos').uncheck();
  await expect(page.getByLabel('Camera')).toHaveValue('camera-1');
  await page.getByLabel('Camera').selectOption('camera-2');
  await page.getByRole('button', { name: 'Validate Camera' }).click();
  await expect(page.getByTestId('camera-selection-status')).toContainText('Camera selected');
  await page.getByRole('button', { name: 'Run WebGazer Setup' }).click();

  await expect(page.getByTestId('webgazer-calibration-overlay')).toBeVisible();
  await expect(page.getByTestId('calibration-status')).toContainText('Click Start camera setup');
  await expect(page.getByTestId('webgazer-overlay-status')).toContainText('Click Start camera setup');
  await expect
    .poll(() => page.evaluate(() => window.__cameraRequests.some((request) => request.video?.deviceId?.exact === 'camera-2')))
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Start camera setup' })).toBeVisible();
  const overlayBox = await page.getByTestId('webgazer-calibration-overlay').boundingBox();
  const rootBox = await page.getByTestId('webgazer-setup-root').boundingBox();
  expect(Math.round(overlayBox.width)).toBe(1280);
  expect(Math.round(overlayBox.height)).toBe(900);
  expect(Math.round(rootBox.width)).toBe(1280);
  expect(Math.round(rootBox.height)).toBe(900);
  await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('webgazer-calibration-overlay')).toBeHidden();
  await expect(page.getByTestId('calibration-status')).toContainText('Setup aborted by researcher');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('webgazer_runs').at(-1)?.status))
    .toBe('error');
});

test('recovers the latest IndexedDB backup on reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await page.evaluate(async () => {
    const trial = window.tetrisEyeTrackingApp.store.startTrial({ participantId: 'recover-pilot' });
    window.tetrisEyeTrackingApp.store.finishTrial(trial.trial_id, {
      durationMs: 123,
      endReason: 'quit',
      score: 0,
      lines: 0,
      piecesCount: 0,
      recordingId: null,
    });
    await window.tetrisEyeTrackingApp.store.saveBackup();
  });
  await page.reload();

  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials').length))
    .toBe(1);
  await page.getByTestId('nav-play').click();
  await expect(page.getByTestId('current-trial')).toContainText('trial_1');
});

test('runs a short keyboard-only trial and keeps the play view fixed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSetup(page);
  await page.getByLabel('Use deterministic mock gaze for tests or demos').check();
  await page.getByTestId('nav-play').click();
  await expect(page.getByTestId('view-play')).toBeVisible();
  await expect(page.getByText('Trial Controls')).toBeVisible();
  const canvasBox = await page.locator('#tetris-canvas').boundingBox();
  expect(canvasBox.width).toBeGreaterThan(500);
  expect(canvasBox.height).toBeGreaterThan(620);
  await expect(page.getByTestId('debug-overlay')).toBeHidden();

  await page.locator('[data-field="trial-mode"]').selectOption('practice');
  await page.getByLabel('Duration (s)').fill('10');
  await page.getByLabel('Start Level').fill('2');
  await page.getByLabel('Fall Interval (ms)').fill('125');
  await page.getByLabel('Next preview').uncheck();
  await page.getByLabel('Ghost block').uncheck();
  await page.getByLabel('Debug overlay').check();
  await expect(page.getByTestId('debug-overlay')).toBeVisible();
  await page.getByRole('button', { name: 'Start Trial' }).click();
  await page.waitForTimeout(120);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Quit' }).click();

  await expect(page.getByTestId('trial-status')).toContainText('Trial ended: quit', { timeout: 8_000 });
  await expect(page.getByTestId('trial-status')).toContainText('Next trial set to main');
  await expect(page.locator('[data-field="trial-mode"]')).toHaveValue('main');
  await expect(page.getByTestId('recording-status')).toContainText(/Recorded|Unavailable/);
  await page.getByLabel('Workload (1-7)').fill('5');
  await page.getByLabel('Difficulty (1-7)').fill('6');
  await page.getByLabel('Frustration (1-7)').fill('2');
  await page.getByLabel('Strategy').fill('looked for a flat landing area');
  await page.getByRole('button', { name: 'Save Response' }).click();
  await expect(page.getByTestId('post-trial-status')).toContainText('Saved response for trial_1.');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('post_trial_responses')[0].strategy_text))
    .toBe('looked for a flat landing area');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].trial_mode))
    .toBe('practice');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].condition_code))
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].trial_mode_code))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].end_reason_code))
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].fall_interval_ms))
    .toBe(125);
  expect(await page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].preview_enabled)).toBe(false);
  expect(await page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials')[0].ghost_enabled)).toBe(false);
  expect(await page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('aoi_snapshots').some((row) => row.aoi === 'landing_zone'))).toBe(false);
  expect(await page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('gaze_aoi_classifications').length)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1))
    .toBe(true);

  await page.getByTestId('nav-replay').click();
  await expect(page.locator('#replay-video')).toBeVisible();
  await expect(page.locator('#replay-overlay')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();
  await expect(page.getByTestId('replay-piece-details')).toContainText('Piece');
  await expect(page.getByTestId('replay-legend')).toBeVisible();
  await expect(page.getByText('Placed stack')).toBeVisible();
  await expect(page.getByText('Current gaze')).toBeVisible();
  await expect(page.getByText('Previous gaze trail')).toBeVisible();
  await expect(page.getByLabel('Previous Gaze Points')).toHaveValue('5');
  await page.getByLabel('Previous Gaze Points').selectOption('10');
  await expect(page.getByLabel('Previous Gaze Points')).toHaveValue('10');
  const replaySurface = await page.locator('.replay-surface').boundingBox();
  const replayOverlay = await page.locator('#replay-overlay').boundingBox();
  expect(replaySurface?.height ?? 0).toBeGreaterThan(800);
  expect(replayOverlay?.height ?? 0).toBeGreaterThan(620);

  await page.getByTestId('nav-analysis').click();
  await expect(page.getByText('Trial Quality')).toBeVisible();
  await expect(page.getByText('trial_1', { exact: false })).toBeVisible();

  await page.getByTestId('nav-export').click();
  await expect(page.getByText('Session validates against the current schema.')).toBeVisible();
  const exportedJson = await page.evaluate(() => window.tetrisEyeTrackingApp.store.toJson());
  const recordingFileName = await page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trial_recordings')[0].file_name);
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = () => {
      throw new Error('download blocked');
    };
  });
  await page.getByRole('button', { name: 'Download JSON' }).click();
  await expect(page.getByTestId('export-status')).toContainText('JSON export failed: download blocked');

  await page.getByTestId('nav-setup').click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await page.getByTestId('nav-export').click();
  await page.locator('[data-field="import-json"]').setInputFiles({
    name: 'session.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportedJson),
  });
  await page.locator('[data-field="import-recording"]').setInputFiles({
    name: recordingFileName,
    mimeType: 'video/webm',
    buffer: Buffer.from('mock-webm'),
  });
  await page.getByRole('button', { name: 'Load Imported Session' }).click();
  await expect(page.getByTestId('export-status')).toContainText('Imported session JSON and attached recording file.');
  await expect
    .poll(() => page.evaluate(() => window.tetrisEyeTrackingApp.store.getRows('trials').length))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => {
      const recording = window.tetrisEyeTrackingApp.store.getRows('trial_recordings')[0];
      return Boolean(window.tetrisEyeTrackingApp.store.getMediaUrl(recording.recording_id));
    }))
    .toBe(true);
});
