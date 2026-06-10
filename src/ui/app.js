import { ExportService } from '../export/ExportService.js';
import { JsPsychTetrisTrialRunner } from '../experiment/jspsych-tetris-trial.js';
import {
  brownPrecisionDisplayLabel,
  CALIBRATION_CLICKS_PER_POINT_OPTIONS,
  DEFAULT_CALIBRATION_CLICKS_PER_POINT,
  WebGazerBridge,
} from '../experiment/WebGazerBridge.js';
import { colorForAoi, ReplayController, REPLAY_LEGEND_ITEMS } from '../replay/ReplayController.js';
import { SessionDataStore } from '../data/SessionDataStore.js';
import { AppLogger } from '../logging/AppLogger.js';
import { nowIso } from '../utils/clock.js';

const NAV_ITEMS = [
  ['setup', 'Setup'],
  ['play', 'Play'],
  ['replay', 'Replay'],
  ['analysis', 'Analysis'],
  ['export', 'Export'],
];
const CAMERA_RELEASE_DELAY_MS = 250;

/**
 * Creates the single-page Tetris eye-tracking application.
 *
 * Requirement links: `FR-DEP-003`, `FR-UI-001` through `FR-UI-006`,
 * `FR-EXP-001`, `FR-DATA-009`, `FR-LAB-002`, and `FR-LAB-003`.
 * The UI intentionally follows the MVP workflow directly instead of presenting
 * a marketing page: setup, calibration status, trial, replay, analysis, and
 * export are the first-class views researchers need during pilots.
 *
 * @param {HTMLElement} root Root application element.
 * @returns {{store: SessionDataStore, render: () => void}} App controller.
 */
export function createApp(root) {
  const store = new SessionDataStore();
  const logger = new AppLogger({
    store,
    enabled: false,
    level: 'trace',
  });
  const state = {
    view: routeFromHash(),
    store,
    logger,
    diagnosticsEnabled: false,
    runner: null,
    replay: null,
    replayTrailCount: 5,
    currentTrialId: null,
    status: 'Ready.',
    calibrationStatus: 'Not run.',
    calibrationClicksPerPoint: DEFAULT_CALIBRATION_CLICKS_PER_POINT,
    setupRunning: false,
    webgazerSetupPhase: 'idle',
    cameraDevices: [],
    cameraDeviceEnumerationPending: false,
    cameraDeviceEnumerationComplete: false,
    cameraSelectionInitializationPending: false,
    cameraSelectionInitializationComplete: false,
    selectedCameraDeviceId: '',
    cameraSelectionStatus: 'Camera selection not validated.',
    cameraSelectionPermissionGranted: false,
    cameraPreviewStream: null,
    exportStatus: 'Data and recordings stay local in this browser.',
    participantId: 'pilot_001',
    // Lab sessions should exercise the real jsPsych/WebGazer flow by default.
    // The deterministic mock path remains available for automated tests and
    // demos, but researchers must opt into it explicitly from Setup.
    useMockGaze: false,
    webgazerBridge: new WebGazerBridge({ mode: 'real', logger }),
    debugOverlayEnabled: false,
    debugOverlayTimerId: null,
    postTrialStatus: 'No response submitted.',
    practiceCompleted: false,
    trialTimerId: null,
    trialConfig: {
      trialMode: 'main',
      durationMs: 60_000,
      levelStart: 0,
      fallIntervalMs: 650,
      previewEnabled: true,
      ghostEnabled: true,
    },
  };

  const app = {
    store: state.store,
    logger: state.logger,
    // Browser tests and lab debugging need the current bridge instance because
    // camera changes, mock-mode changes, and click-count changes intentionally
    // replace it. A getter avoids exposing a stale setup gate after those resets.
    get webgazerBridge() {
      return state.webgazerBridge;
    },
    render: () => render(root, state),
  };
  window.addEventListener('hashchange', () => {
    const nextView = routeFromHash();
    if (state.view === 'setup' && nextView !== 'setup') {
      stopCameraPreview(state, 'Camera preview stopped after leaving setup.');
    }
    state.view = nextView;
    render(root, state);
  });
  window.tetrisEyeTrackingApp = app;
  render(root, state);
  recoverBackupOnStartup(root, state);
  return app;
}

/**
 * Renders the current route.
 *
 * Requirement links: `FR-DEP-003`, `FR-UI-001` through `FR-UI-006`,
 * and `FR-UI-009`.
 * The render pass rebuilds view-specific controls because each route binds only
 * the handlers relevant to the current workflow step.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
export function render(root, state) {
  document.body.classList.toggle('play-active', state.view === 'play');
  document.body.classList.toggle('replay-active', state.view === 'replay');
  document.body.classList.toggle('webgazer-setup-active', state.setupRunning);
  setWebGazerSetupPhase(root, state, state.setupRunning ? state.webgazerSetupPhase : 'idle');
  // The app shell uses a left sidebar so the Play view can use the full
  // viewport height for the tall Tetris board instead of losing vertical space
  // to a top navigation bar. Route content lives entirely inside `app-main`.
  root.innerHTML = `
    <div class="app-shell">
      <aside class="app-sidebar" data-testid="app-sidebar">
        <div class="sidebar-brand">
          <div class="eyebrow">HCI Eye Tracking</div>
          <h1>Tetris Study Console</h1>
        </div>
        <nav class="side-nav" aria-label="Primary">
          ${NAV_ITEMS.map(([id, label]) => `
            <a class="${state.view === id ? 'active' : ''}" href="#${id}" data-testid="nav-${id}">${label}</a>
          `).join('')}
        </nav>
      </aside>
      <main class="app-main" data-testid="app-main">${viewMarkup(state)}</main>
    </div>
  `;
  bindView(root, state);
}

/**
 * Resolves the active hash route to a known MVP view.
 *
 * Requirement links: `FR-DEP-003` and `FR-UI-001` through `FR-UI-006`.
 * Unknown hashes fall back to Setup so static hosting can deep-link safely
 * without server-side routing.
 *
 * @returns {string} Route identifier.
 */
function routeFromHash() {
  const route = window.location.hash.replace('#', '');
  return NAV_ITEMS.some(([id]) => id === route) ? route : 'setup';
}

/**
 * Attempts IndexedDB recovery when the SPA boots.
 *
 * Requirement links: `FR-DATA-008`, `FR-ERR-005`, and `FR-LAB-005`.
 * Recovery is opportunistic and schema-validated; invalid or missing backups do
 * not block the classroom workflow.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @returns {Promise<void>} Resolves after recovery attempt.
 */
async function recoverBackupOnStartup(root, state) {
  const result = await state.store.recoverBackup().catch(() => null);
  if (!result?.ok) {
    return;
  }
  state.currentTrialId = state.store.getRows('trials').at(-1)?.trial_id ?? null;
  state.practiceCompleted = state.store.getRows('trials').some((trial) => trial.trial_mode === 'practice');
  state.status = state.currentTrialId
    ? `Recovered IndexedDB backup with ${state.currentTrialId}.`
    : 'Recovered IndexedDB backup.';
  window.tetrisEyeTrackingApp.store = state.store;
  render(root, state);
}

/**
 * Selects markup for the current route.
 *
 * Requirement links: `FR-DEP-003` and `FR-UI-001` through `FR-UI-006`.
 * Route functions are kept pure so tests can render the full app without
 * starting trials, cameras, or downloads.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string} View HTML.
 */
function viewMarkup(state) {
  const views = {
    setup: setupView,
    play: playView,
    replay: replayView,
    analysis: analysisView,
    export: exportView,
  };
  return views[state.view](state);
}

/**
 * Renders participant and WebGazer setup controls.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002` through `FR-EYE-004`,
 * `FR-ERR-001`, `FR-ERR-003`, and `FR-LAB-004`.
 * Mock gaze is visible here because it is a deliberate CI/demo mode, not a
 * hidden fallback during formal real-gaze collection.
 * Real calibration is rendered in a fixed viewport overlay because jsPsych
 * WebGazer calibration and Brown precision targets are viewport-coordinate
 * tasks; mounting those targets inside a scrollable panel would make gaze
 * coordinates ambiguous and can force researchers to scroll during setup.
 * The calibration dropdown controls repeated clicks at each of the fixed 9
 * Brown-style target locations. It does not control target count, because the
 * full corner/edge/center geometry is required for useful calibration coverage.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string} View HTML.
 */
function setupView(state) {
  const validation = state.store.validate();
  const cameraOptions = cameraDeviceOptions(state);
  const validateNeedsAttention = !state.useMockGaze && !state.cameraSelectionPermissionGranted;
  const calibrationNeedsAttention = !state.useMockGaze
    && state.cameraSelectionPermissionGranted
    && !state.webgazerBridge.hasCompletedSetup();
  const diagnosticRows = state.store.getRows('diagnostic_events');
  const latestDiagnostic = diagnosticRows.at(-1);
  return `
    <section class="workspace setup-stack" data-testid="view-setup">
      <div class="panel setup-session-panel" data-testid="setup-session-panel">
        <h2>Session</h2>
        <div class="setup-session-grid">
          <div class="setup-session-controls">
            <label>
              Participant ID
              <input data-field="participant-id" value="${state.participantId}" autocomplete="off" />
            </label>
            <dl class="facts">
              <div><dt>Session</dt><dd>${state.store.session.session_id}</dd></div>
              <div><dt>Participant</dt><dd>${state.participantId}</dd></div>
              <div><dt>Schema</dt><dd>${validation.ok ? 'Valid current schema' : 'Schema errors'}</dd></div>
            </dl>
          </div>
          <div>
            <h3>Session Steps</h3>
            <ul class="check-list">
              <li>Select or create the participant session</li>
              <li>Choose and validate the camera</li>
              <li>Run Brown-style WebGazer setup</li>
              <li>Complete trial, replay, analysis, and export</li>
            </ul>
          </div>
        </div>
        <div class="button-row">
          <button data-action="new-session">New Session</button>
          <button data-action="recover-backup">Recover Backup</button>
          <button class="danger" data-action="clear-backup">Clear Local Data</button>
        </div>
      </div>
      <div class="panel camera-selection-panel" data-testid="setup-camera-panel">
        <h2>Camera Selection</h2>
        <div class="camera-selection-grid">
          <div class="camera-selection-controls">
            <label>
              Camera
              <select data-field="camera-device" ${state.setupRunning || state.useMockGaze ? 'disabled' : ''}>
                ${cameraOptions.map((device) => `<option value="${device.deviceId}" ${device.deviceId === state.selectedCameraDeviceId ? 'selected' : ''}>${device.label}</option>`).join('')}
              </select>
            </label>
            <p class="status-line" data-testid="camera-selection-status">${state.cameraSelectionStatus}</p>
            <div class="button-row">
              <button class="${validateNeedsAttention ? 'camera-selection-attention' : ''}" data-action="validate-camera-selection" ${state.setupRunning || state.useMockGaze ? 'disabled' : ''}>Validate Camera</button>
              <button data-action="stop-camera-preview" ${state.cameraPreviewStream ? '' : 'disabled'}>Stop Preview</button>
            </div>
          </div>
          <div class="camera-selection-preview">
            <div class="camera-preview-frame" data-testid="camera-preview-frame">
              ${state.cameraPreviewStream
                ? '<video data-testid="camera-preview" autoplay muted playsinline></video>'
                : '<div class="camera-preview-placeholder" data-testid="camera-preview-placeholder">No camera preview</div>'}
            </div>
          </div>
        </div>
      </div>
      <div class="panel" data-testid="setup-calibration-panel">
        <h2>Calibration</h2>
        <label class="inline-check">
          <input type="checkbox" data-field="mock-gaze" ${state.useMockGaze ? 'checked' : ''} />
          Use deterministic mock gaze for tests or demos
        </label>
        <label class="inline-check">
          <input type="checkbox" data-field="diagnostics-enabled" ${state.diagnosticsEnabled ? 'checked' : ''} />
          Enable detailed diagnostics
        </label>
        <label>
          Clicks Per Calibration Point
          <!-- This is sample density, not target count: setup always presents
               the 9 Brown-style calibration positions. -->
          <select data-field="calibration-clicks-per-point" ${state.setupRunning ? 'disabled' : ''}>
            ${CALIBRATION_CLICKS_PER_POINT_OPTIONS.map((count) => `<option value="${count}" ${count === state.calibrationClicksPerPoint ? 'selected' : ''}>${count}</option>`).join('')}
          </select>
        </label>
        <p class="status-line" data-testid="calibration-status">${state.calibrationStatus}</p>
        <dl class="facts compact diagnostics-summary" data-testid="diagnostics-summary">
          <div><dt>Diagnostics</dt><dd>${state.diagnosticsEnabled ? 'Detailed logging on' : 'Detailed logging off'}</dd></div>
          <div><dt>Events</dt><dd>${diagnosticRows.length}</dd></div>
          <div><dt>Latest</dt><dd>${latestDiagnostic ? `${latestDiagnostic.category}/${latestDiagnostic.action}` : 'None'}</dd></div>
        </dl>
        <div class="button-row">
          <button class="${calibrationNeedsAttention ? 'setup-action-attention' : ''}" data-action="calibrate" ${state.setupRunning ? 'disabled' : ''}>Run WebGazer Setup</button>
          <button data-action="download-diagnostics" ${diagnosticRows.length ? '' : 'disabled'}>Download Diagnostics CSV</button>
          <a class="button-link" href="#play">Go To Trial</a>
        </div>
      </div>
      ${state.setupRunning ? `
        <div class="webgazer-calibration-overlay webgazer-phase-${state.webgazerSetupPhase}" data-testid="webgazer-calibration-overlay">
          <div class="webgazer-calibration-status">
            <strong>WebGazer setup</strong>
            <span data-testid="webgazer-overlay-status">${state.calibrationStatus}</span>
            <span class="escape-hint">Press Esc to cancel setup</span>
          </div>
          <div id="webgazer-setup-root" data-testid="webgazer-setup-root"></div>
        </div>
      ` : ''}
    </section>
  `;
}

/**
 * Builds camera dropdown options from enumerated browser devices.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, and `FR-LAB-004`.
 * Setup-load camera initialization tries to unlock the true device list before
 * the researcher validates a specific camera. Generic labels remain as a
 * fallback because browsers can still hide names after denied permission.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {{deviceId: string, label: string}[]} Camera options.
 */
function cameraDeviceOptions(state) {
  if (state.cameraDevices.length > 0) {
    return state.cameraDevices.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    }));
  }
  return [{
    deviceId: '',
    label: state.cameraDeviceEnumerationPending ? 'Detecting cameras...' : 'Default camera',
  }];
}

/**
 * Normalizes the researcher-selected clicks per calibration point.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-003`, and `FR-LAB-004`.
 * The target layout is always Brown's 9 points; this finite dropdown controls
 * how many repeated WebGazer training clicks are collected at each point.
 *
 * @param {number | string | null | undefined} value Selected dropdown value.
 * @returns {number} Supported click count.
 */
function normalizeCalibrationClicksPerPoint(value) {
  const numericValue = Number(value);
  return CALIBRATION_CLICKS_PER_POINT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_CALIBRATION_CLICKS_PER_POINT;
}

/**
 * Enumerates available cameras without requesting permission.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, `FR-ERR-001`, and
 * `FR-LAB-004`.
 * This low-level pass never opens a stream. Setup-load initialization may call
 * it before and after camera permission so the dropdown can move from generic
 * browser entries to real lab camera names as soon as those names are available.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @param {{force?: boolean, preserveSelection?: boolean, renderAfter?: boolean}} [options] Enumeration controls.
 * @returns {Promise<void>} Resolves after device list refresh.
 */
async function refreshCameraDevices(root, state, options = {}) {
  const force = options.force ?? false;
  const preserveSelection = options.preserveSelection ?? true;
  const renderAfter = options.renderAfter ?? true;
  if (state.cameraDeviceEnumerationPending || (state.cameraDeviceEnumerationComplete && !force)) {
    return;
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    state.cameraDevices = [];
    state.cameraDeviceEnumerationComplete = true;
    state.cameraDeviceEnumerationPending = false;
    if (!state.cameraSelectionPermissionGranted) {
      state.cameraSelectionStatus = 'Camera list unavailable; Validate Camera will request the default camera.';
    }
    if (renderAfter && state.view === 'setup') {
      render(root, state);
    }
    return;
  }
  state.cameraDeviceEnumerationPending = true;
  if (!state.cameraSelectionPermissionGranted) {
    state.cameraSelectionStatus = 'Checking available cameras.';
  }
  if (renderAfter && state.view === 'setup') {
    render(root, state);
  }
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
        hasBrowserLabel: Boolean(device.label),
      }));
    const previousSelection = state.selectedCameraDeviceId;
    state.cameraDevices = devices;
    if (devices.length > 0) {
      const selectionStillExists = devices.some((device) => device.deviceId === previousSelection);
      state.selectedCameraDeviceId = preserveSelection && selectionStillExists
        ? previousSelection
        : devices[0].deviceId;
      state.webgazerBridge.setCameraDeviceId(selectedCameraDeviceId(state));
      if (!state.cameraSelectionPermissionGranted) {
        state.cameraSelectionStatus = 'Select a camera, then click Validate Camera.';
      }
    } else {
      state.selectedCameraDeviceId = '';
      state.webgazerBridge.setCameraDeviceId(null);
      state.cameraSelectionStatus = 'No cameras found. Connect a camera and validate again.';
    }
  } catch (error) {
    state.cameraDevices = [];
    state.cameraSelectionStatus = `Camera list unavailable: ${error instanceof Error ? error.message : String(error)}. Validate Camera will request the default camera.`;
  } finally {
    state.cameraDeviceEnumerationPending = false;
    state.cameraDeviceEnumerationComplete = true;
    if (renderAfter && state.view === 'setup') {
      render(root, state);
    }
  }
}

/**
 * Starts camera discovery when the researcher opens the Setup route.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, `FR-LAB-004`, and
 * `FR-PERF-006`.
 * The Setup page should arrive ready for lab use: enumerate devices, select the
 * first available camera, and open its preview automatically. WebGazer itself is
 * not imported here; the heavier eye-tracking runtime is loaded only when the
 * researcher starts the Brown-style setup.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @returns {Promise<void>} Resolves after setup-load camera discovery.
 */
async function initializeCameraSelectionOnSetup(root, state) {
  state.cameraSelectionInitializationPending = true;
  try {
    await refreshCameraDevices(root, state, { force: !state.cameraDeviceEnumerationComplete });
    if (state.view !== 'setup' || state.useMockGaze || state.setupRunning || state.cameraSelectionPermissionGranted) {
      return;
    }
    if (state.cameraDevices.length === 0 && !state.selectedCameraDeviceId) {
      return;
    }
    state.cameraSelectionStatus = 'Opening first available camera preview.';
    render(root, state);
    const stream = await state.webgazerBridge.openCameraPreview({ deviceId: selectedCameraDeviceId(state) });
    if (state.view !== 'setup' || state.useMockGaze || state.setupRunning) {
      stopStream(stream);
      return;
    }
    const activeDeviceId = stream.getVideoTracks?.()[0]?.getSettings?.().deviceId;
    state.cameraPreviewStream = stream;
    state.cameraSelectionPermissionGranted = true;
    if (!state.selectedCameraDeviceId && activeDeviceId) {
      state.selectedCameraDeviceId = activeDeviceId;
      state.webgazerBridge.setCameraDeviceId(activeDeviceId);
    }
    state.cameraSelectionStatus = 'First available camera selected. Preview active.';
    state.calibrationStatus = 'Camera preview active. Continue with WebGazer setup when ready.';
    render(root, state);
    refreshCameraLabelsInBackground(root, state, stream);
  } catch (error) {
    if (state.setupRunning) {
      return;
    }
    stopCameraPreview(state);
    state.cameraSelectionPermissionGranted = false;
    state.cameraSelectionStatus = `Automatic camera preview failed: ${error instanceof Error ? error.message : String(error)}. Click Validate Camera to try again.`;
  } finally {
    state.cameraSelectionInitializationPending = false;
    state.cameraSelectionInitializationComplete = true;
    if (state.view === 'setup' && !state.setupRunning) {
      render(root, state);
    }
  }
}

/**
 * Stops a temporary camera stream.
 *
 * Requirement links: `FR-EYE-002` and `FR-ERR-001`.
 * Setup-load camera discovery can complete after the researcher navigates away;
 * stopping that orphaned stream prevents an invisible camera capture from
 * staying active.
 *
 * @param {MediaStream} stream Camera stream to stop.
 */
function stopStream(stream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * Returns the selected camera ID in the nullable shape expected by WebGazer.
 *
 * Requirement links: `FR-EYE-002`, `FR-EYE-003`, and `FR-ERR-001`.
 * Empty browser selections intentionally mean "default camera"; non-empty
 * selections become exact `deviceId` constraints so fallback cannot occur.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string | null} Selected camera ID or null for browser default.
 */
function selectedCameraDeviceId(state) {
  return state.selectedCameraDeviceId || null;
}

/**
 * Handles researcher camera changes from the Setup dropdown.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-003`, `FR-EYE-004`,
 * `FR-ERR-001`, and `FR-LAB-004`.
 * A camera change invalidates any completed WebGazer setup because calibration
 * is specific to the physical camera and placement used during setup.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @param {string} nextDeviceId Newly selected browser camera ID.
 * @returns {Promise<void>} Resolves after preview switch attempt.
 */
async function handleCameraDeviceChange(root, state, nextDeviceId) {
  if (nextDeviceId === state.selectedCameraDeviceId) {
    return;
  }
  const requestedDeviceId = nextDeviceId;
  const hadValidatedSetup = state.webgazerBridge.hasValidatedSetup();
  state.selectedCameraDeviceId = nextDeviceId;
  state.webgazerBridge.setCameraDeviceId(selectedCameraDeviceId(state));
  if (hadValidatedSetup) {
    state.calibrationStatus = 'Camera selection changed; run WebGazer setup again before trial.';
  }
  stopCameraPreview(state);
  if (!state.cameraSelectionPermissionGranted) {
    state.cameraSelectionStatus = 'Camera selected. Click Validate Camera to preview and use this camera.';
    render(root, state);
    return;
  }
  state.cameraSelectionStatus = 'Switching camera preview.';
  render(root, state);
  try {
    const stream = await state.webgazerBridge.openCameraPreview({ deviceId: selectedCameraDeviceId(state) });
    if (state.selectedCameraDeviceId !== requestedDeviceId) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }
    state.cameraPreviewStream = stream;
    state.cameraSelectionStatus = 'Camera selected. Preview active.';
    render(root, state);
    refreshCameraLabelsInBackground(root, state, stream);
  } catch (error) {
    stopCameraPreview(state);
    state.cameraSelectionPermissionGranted = false;
    state.cameraSelectionStatus = `Camera selection failed: ${error instanceof Error ? error.message : String(error)}`;
    state.calibrationStatus = 'Selected camera unavailable; choose another camera and validate it.';
    render(root, state);
  }
}

/**
 * Requests permission and opens the selected camera preview.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, `FR-ERR-001`, and
 * `FR-LAB-004`.
 * Validation is treated as a subprocess of camera selection: it proves that the
 * selected device can open before WebGazer calibration claims exclusive use of
 * that same camera.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @returns {Promise<void>} Resolves after validation attempt.
 */
async function validateCameraSelection(root, state) {
  if (state.useMockGaze) {
    state.calibrationStatus = 'Mock Brown-style setup: deterministic fixture path.';
    render(root, state);
    return;
  }
  try {
    await refreshCameraDevices(root, state, { renderAfter: false });
    stopCameraPreview(state);
    state.cameraSelectionStatus = 'Requesting camera permission for selected camera.';
    render(root, state);
    const stream = await state.webgazerBridge.openCameraPreview({ deviceId: selectedCameraDeviceId(state) });
    const activeDeviceId = stream.getVideoTracks?.()[0]?.getSettings?.().deviceId;
    state.cameraPreviewStream = stream;
    state.cameraSelectionPermissionGranted = true;
    if (!state.selectedCameraDeviceId && activeDeviceId) {
      state.selectedCameraDeviceId = activeDeviceId;
      state.webgazerBridge.setCameraDeviceId(activeDeviceId);
    }
    state.cameraSelectionStatus = 'Camera selected. Preview active.';
    state.calibrationStatus = 'Camera selection validated. Continue with WebGazer setup.';
    render(root, state);
    refreshCameraLabelsInBackground(root, state, stream);
  } catch (error) {
    stopCameraPreview(state);
    state.cameraSelectionPermissionGranted = false;
    state.cameraSelectionStatus = `Camera selection failed: ${error instanceof Error ? error.message : String(error)}`;
    state.calibrationStatus = state.cameraSelectionStatus;
    render(root, state);
  }
}

/**
 * Refreshes post-permission camera labels without blocking preview display.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, and `FR-LAB-004`.
 * Some browsers take noticeable time to enumerate labeled devices after
 * permission. The preview is the important immediate feedback, so labels update
 * opportunistically after the selected stream is already visible.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @param {MediaStream} stream Preview stream that should remain active.
 */
function refreshCameraLabelsInBackground(root, state, stream) {
  refreshCameraDevices(root, state, { force: true, preserveSelection: true, renderAfter: false })
    .then(() => {
      if (state.view === 'setup' && state.cameraPreviewStream === stream) {
        render(root, state);
      }
    })
    .catch(() => {});
}

/**
 * Renders the fixed trial surface and trial controls.
 *
 * Requirement links: `FR-UI-003`, `FR-UI-007`, `FR-UI-008`,
 * `FR-UI-009`, `FR-EXP-003`, `FR-EXP-004`, `FR-EXP-006`,
 * and `FR-EXP-007`.
 * Controls are beside the canvas rather than above it so the Tetris board can
 * keep a stable viewport position for AOI classification.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string} View HTML.
 */
function playView(state) {
  return `
    <section class="play-workspace" data-testid="view-play">
      <div class="trial-stage">
        <canvas id="tetris-canvas" width="500" height="620" tabindex="0" aria-label="Tetris game canvas"></canvas>
        <canvas id="debug-overlay" data-testid="debug-overlay" aria-label="Debug gaze and AOI overlay" ${state.debugOverlayEnabled ? '' : 'hidden'}></canvas>
      </div>
      <aside class="trial-controls">
        <h2>Trial Controls</h2>
        <p class="status-line" data-testid="trial-status">${state.status}</p>
        <div class="trial-config" aria-label="Trial configuration">
          <label>
            Trial
            <select data-field="trial-mode">
              <option value="main" ${state.trialConfig.trialMode === 'main' ? 'selected' : ''}>Main</option>
              <option value="practice" ${state.trialConfig.trialMode === 'practice' ? 'selected' : ''}>Practice</option>
            </select>
          </label>
          <label>
            Duration (s)
            <input data-field="duration-seconds" type="number" min="10" max="600" step="5" value="${Math.round(state.trialConfig.durationMs / 1000)}" />
          </label>
          <label>
            Start Level
            <input data-field="level-start" type="number" min="0" max="20" step="1" value="${state.trialConfig.levelStart}" />
          </label>
          <label>
            Fall Interval (ms)
            <input data-field="fall-interval" type="number" min="75" max="1500" step="25" value="${state.trialConfig.fallIntervalMs}" />
          </label>
          <label class="inline-check">
            <input type="checkbox" data-field="preview-enabled" ${state.trialConfig.previewEnabled ? 'checked' : ''} />
            Next preview
          </label>
          <label class="inline-check">
            <input type="checkbox" data-field="ghost-enabled" ${state.trialConfig.ghostEnabled ? 'checked' : ''} />
            Ghost block
          </label>
          <label class="inline-check">
            <input type="checkbox" data-field="debug-overlay-enabled" ${state.debugOverlayEnabled ? 'checked' : ''} />
            Debug overlay
          </label>
        </div>
        <div class="button-stack">
          <button data-action="start-trial">Start Trial</button>
          <button data-action="pause-trial">Pause</button>
          <button data-action="resume-trial">Resume</button>
          <button class="danger" data-action="quit-trial">Quit</button>
        </div>
        <dl class="facts compact">
          <div><dt>Gaze</dt><dd>${state.useMockGaze ? 'Mock' : 'jsPsych WebGazer'}</dd></div>
          <div><dt>Current trial</dt><dd data-testid="current-trial">${state.currentTrialId ?? 'None'}</dd></div>
          <div><dt>Elapsed</dt><dd data-testid="trial-elapsed">0 ms</dd></div>
          <div><dt>Recording</dt><dd data-testid="recording-status">Waiting</dd></div>
        </dl>
        <form class="post-trial-form" data-action="post-trial-response">
          <h3>Post-Trial Ratings</h3>
          <label>
            Workload (1-7)
            <input data-field="post-workload" type="number" min="1" max="7" step="1" value="4" />
          </label>
          <label>
            Difficulty (1-7)
            <input data-field="post-difficulty" type="number" min="1" max="7" step="1" value="4" />
          </label>
          <label>
            Frustration (1-7)
            <input data-field="post-frustration" type="number" min="1" max="7" step="1" value="3" />
          </label>
          <label>
            Strategy
            <textarea data-field="post-strategy" rows="3"></textarea>
          </label>
          <button type="submit">Save Response</button>
          <p class="status-line" data-testid="post-trial-status">${state.postTrialStatus}</p>
        </form>
      </aside>
    </section>
  `;
}

/**
 * Renders the recording-based replay view.
 *
 * Requirement links: `FR-UI-004`, `FR-REPLAY-001` through
 * `FR-REPLAY-008`, and `FR-REPLAY-010`.
 * The view expects a video plus canonical rows, preserving the design choice
 * that replay never reconstructs gameplay from random seeds or board frames.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string} View HTML.
 */
function replayView(state) {
  const trials = state.store.getRows('trials');
  const currentTrialId = state.currentTrialId ?? trials.at(-1)?.trial_id ?? '';
  return `
    <section class="workspace replay-layout" data-testid="view-replay">
      <div class="replay-surface">
        <video id="replay-video" controls muted playsinline></video>
        <canvas id="replay-overlay" aria-label="Replay overlay"></canvas>
      </div>
      <aside class="panel replay-controls">
        <h2>Replay</h2>
        <label>
          Trial
          <select data-field="replay-trial">
            ${trials.map((trial) => `<option value="${trial.trial_id}" ${trial.trial_id === currentTrialId ? 'selected' : ''}>${trial.trial_id}</option>`).join('')}
          </select>
        </label>
        <label>
          Piece Jump
          <select id="piece-jump"></select>
        </label>
        <label>
          Previous Gaze Points
          <select data-field="replay-gaze-trail">
            ${[0, 1, 3, 5, 10].map((count) => `<option value="${count}" ${count === state.replayTrailCount ? 'selected' : ''}>${count}</option>`).join('')}
          </select>
        </label>
        <div class="button-row">
          <button data-action="replay-play">Play</button>
          <button data-action="replay-pause">Pause</button>
          <button data-action="replay-restart">Restart</button>
        </div>
        <input id="replay-scrub" type="range" min="0" max="0" value="0" />
        <div class="replay-details" data-testid="replay-piece-details"></div>
        <p class="status-line">${trials.length ? 'Replay overlays use recorded gaze and AOI snapshots.' : 'No trials recorded yet.'}</p>
        ${replayLegendMarkup()}
      </aside>
    </section>
  `;
}

/**
 * Renders summary tables for classroom analysis.
 *
 * Requirement links: `FR-UI-005`, `FR-ANA-001` through `FR-ANA-009`,
 * and `FR-HCI-001` through `FR-HCI-005`.
 * The UI shows recent piece/visit rows to keep the MVP readable while full
 * tables remain available from export.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string} View HTML.
 */
function analysisView(state) {
  const trialSummaries = state.store.getRows('trial_summaries');
  const pieceSummaries = state.store.getRows('piece_summaries').slice(-12);
  const visits = state.store.getRows('aoi_visits').slice(-12);
  return `
    <section class="workspace analysis-grid" data-testid="view-analysis">
      <div class="panel">
        <h2>Trial Quality</h2>
        ${renderTable(trialSummaries, ['trial_id', 'score', 'lines', 'pieces_count', 'observed_sampling_rate_hz', 'median_sample_interval_ms', 'valid_sample_percentage', 'aoi_transition_count', 'webgazer_brown_precision_percent', 'webgazer_brown_precision_label', 'recording_status'])}
      </div>
      <div class="panel">
        <h2>Recent Piece Summaries</h2>
        ${renderTable(pieceSummaries, ['piece_id', 'piece_type', 'duration_ms', 'hci_planning_label', 'hci_sequence_label', 'hci_preview_label', 'hci_feedback_label', 'post_lock_stack_look_delay_ms', 'preview_checks', 'action_count', 'rotation_count', 'holes_created', 'board_height_change', 'bumpiness_change'])}
      </div>
      <div class="panel wide">
        <h2>Recent AOI Visits</h2>
        ${renderTable(visits, ['visit_id', 'piece_id', 'aoi', 'duration_ms', 'sample_count', 'mean_confidence'])}
      </div>
    </section>
  `;
}

/**
 * Renders JSON, CSV, media export, and import controls.
 *
 * Requirement links: `FR-UI-006`, `FR-DATA-002`, `FR-DATA-004`,
 * `FR-DATA-011`, `FR-REPLAY-001`, `FR-ANA-010`, and `FR-ERR-004`.
 * Import is colocated with export so a saved JSON session and matching WebM can
 * be reattached for replay in the same local-only workflow.
 *
 * @param {Record<string, unknown>} state App state.
 * @returns {string} View HTML.
 */
function exportView(state) {
  const validation = state.store.validate();
  const exportTables = ['trial_recordings', 'webgazer_runs', 'diagnostic_events', 'post_trial_responses', 'pieces', 'gaze_aoi_classifications', 'aoi_visits', 'piece_indexes', 'piece_summaries', 'trial_summaries'];
  const recordings = state.store.getRows('trial_recordings').filter((row) => row.status === 'recorded');
  return `
    <section class="workspace two-column" data-testid="view-export">
      <div class="panel">
        <h2>Exports</h2>
        <p class="status-line">${validation.ok ? 'Session validates against the current schema.' : validation.errors.join(' ')}</p>
        <p class="status-line" data-testid="export-status">${state.exportStatus}</p>
        <div class="button-stack">
          <button data-action="download-json">Download JSON</button>
          ${exportTables.map((table) => `<button data-action="download-csv" data-table="${table}">Download ${table} CSV</button>`).join('')}
          ${recordings.map((recording) => `<button data-action="download-recording" data-recording-id="${recording.recording_id}">Download ${recording.file_name}</button>`).join('')}
        </div>
      </div>
      <div class="panel">
        <h2>Import Session</h2>
        <label>
          Session JSON
          <input data-field="import-json" type="file" accept="application/json,.json" />
        </label>
        <label>
          Trial Recording
          <input data-field="import-recording" type="file" accept="video/webm,.webm" />
        </label>
        <button data-action="import-session">Load Imported Session</button>
      </div>
      <div class="panel wide">
        <h2>Canonical Tables</h2>
        <dl class="facts compact">
          ${Object.entries(state.store.session.tables).map(([table, value]) => `<div><dt>${table}</dt><dd>${value.rows.length}</dd></div>`).join('')}
        </dl>
      </div>
    </section>
  `;
}

/**
 * Attaches the validated raw camera stream to the setup preview element.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, and `FR-ERR-001`.
 * The stream itself cannot be represented in HTML, so rerenders create a fresh
 * `<video>` node and this helper reattaches `srcObject`. Calibration stops this
 * raw stream before WebGazer requests and displays its own camera feed.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function syncCameraPreview(root, state) {
  const preview = root.querySelector('[data-testid="camera-preview"]');
  if (!preview || !state.cameraPreviewStream) {
    return;
  }
  try {
    preview.srcObject = state.cameraPreviewStream;
    preview.play?.().catch(() => {});
  } catch {
    state.cameraSelectionStatus = 'Camera stream opened, but this browser could not attach preview video.';
  }
}

/**
 * Stops the setup-page raw camera preview.
 *
 * Requirement links: `FR-UI-002`, `FR-EYE-002`, and `FR-PERF-006`.
 * The preview stream is deliberately separate from the WebGazer stream; closing
 * it before calibration prevents two independent camera consumers from
 * competing while preserving WebGazer's calibrated runtime for formal trials.
 *
 * @param {Record<string, unknown>} state App state.
 * @param {string | null} [message] Optional status message after stopping.
 */
function stopCameraPreview(state, message = null) {
  if (state.cameraPreviewStream?.getTracks) {
    for (const track of state.cameraPreviewStream.getTracks()) {
      track.stop();
    }
  }
  state.cameraPreviewStream = null;
  if (message) {
    state.cameraSelectionStatus = message;
  }
}

/**
 * Gives the browser a short handoff window after stopping the preview stream.
 *
 * Requirement links: `FR-EYE-002`, `FR-EYE-003`, and `FR-ERR-003`.
 * Some webcams and browser drivers keep the physical device busy for a moment
 * after `MediaStreamTrack.stop()`. Waiting before WebGazer opens its own stream
 * reduces the risk of a visible but frozen face-positioning preview.
 *
 * @returns {Promise<void>} Resolves after the release delay.
 */
function waitForCameraHardwareRelease() {
  return new Promise((resolve) => {
    setTimeout(resolve, CAMERA_RELEASE_DELAY_MS);
  });
}

/**
 * Applies WebGazer setup phase classes without rerendering jsPsych DOM.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, `FR-UI-002`, and
 * `FR-LAB-004`.
 * Calibration targets occupy the 10/50/90 percent grid, so helper UI is
 * phase-aware: it can show the webcam preview during face centering and remove
 * all app-owned overlays while gaze target dots are being presented.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 * @param {'idle' | 'intro' | 'camera' | 'targets' | 'complete'} phase Setup phase.
 */
function setWebGazerSetupPhase(root, state, phase) {
  const phases = ['idle', 'intro', 'camera', 'targets', 'complete'];
  const nextPhase = phases.includes(phase) ? phase : 'intro';
  state.webgazerSetupPhase = nextPhase;
  for (const candidate of phases) {
    document.body.classList.toggle(`webgazer-phase-${candidate}`, candidate === nextPhase);
  }
  const overlay = root.querySelector('[data-testid="webgazer-calibration-overlay"]');
  if (overlay) {
    for (const candidate of phases) {
      overlay.classList.toggle(`webgazer-phase-${candidate}`, candidate === nextPhase);
    }
  }
}

/**
 * Builds the final setup status shown after WebGazer setup closes.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Brown precision failures include diagnostics because a lab researcher needs
 * to know whether calibration quality was low or WebGazer never stored usable
 * gaze estimates before deciding whether to adjust lighting, camera placement,
 * or participant instructions.
 *
 * @param {Record<string, unknown>} row Stored `webgazer_runs` row.
 * @returns {string} Researcher-facing setup result message.
 */
function webGazerSetupResultMessage(row) {
  if (row.setup_completed) {
    const precisionPercent = finiteNumber(row.brown_precision_percent);
    const precision = Number.isFinite(precisionPercent)
      ? `${precisionPercent.toFixed(0)}%`
      : 'unavailable';
    const label = brownPrecisionDisplayLabel(row.brown_precision_label);
    const setupDiagnostics = webGazerSetupDiagnostics(row);
    return `WebGazer setup complete. Brown-style precision ${precision} (${label})${setupDiagnostics}.`;
  }
  return `WebGazer setup ${row.status}: ${row.error ?? 'setup did not complete; run setup again to recalibrate'}.`;
}

/**
 * Formats calibration and Brown precision diagnostics for the setup result.
 *
 * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-LAB-004`.
 * A 0% score is ambiguous without knowing whether calibration clicks had live
 * tracker features, so the setup page exposes that count beside Brown sample
 * count, sample rate, and mean pixel error.
 *
 * @param {Record<string, unknown>} row Stored `webgazer_runs` row.
 * @returns {string} Optional diagnostics suffix.
 */
function webGazerSetupDiagnostics(row) {
  const parts = [];
  const readyClicks = row.calibration_tracker_ready_clicks === null || row.calibration_tracker_ready_clicks === undefined
    ? null
    : Number(row.calibration_tracker_ready_clicks);
  const totalClicks = Number(row.calibration_total_clicks);
  if (Number.isFinite(readyClicks) && Number.isFinite(totalClicks) && totalClicks > 0) {
    parts.push(`${readyClicks} of ${totalClicks} calibration clicks tracker-ready`);
  }
  const regressionSamples = finiteNumber(row.calibration_regression_sample_count);
  if (Number.isFinite(regressionSamples)) {
    parts.push(`${regressionSamples} WebGazer calibration samples trained`);
  }
  const precisionSource = row.brown_precision_sample_source;
  const brownSamples = finiteNumber(row.brown_precision_sample_count);
  if (Number.isFinite(brownSamples)) {
    parts.push(`${brownSamples} scored accuracy samples (${brownPrecisionSampleSourceLabel(precisionSource)})`);
  }
  const storedSamples = finiteNumber(row.brown_stored_sample_count);
  if (Number.isFinite(storedSamples) && precisionSource !== 'webgazer_stored_points' && precisionSource !== 'mock') {
    parts.push(`${storedSamples} WebGazer stored-point samples`);
  }
  const directSamples = finiteNumber(row.brown_direct_sample_count);
  if (Number.isFinite(directSamples) && precisionSource === 'unavailable') {
    parts.push(`${directSamples} direct prediction samples`);
  }
  const brownSamplesPerSec = finiteNumber(row.brown_precision_samples_per_sec);
  if (Number.isFinite(brownSamplesPerSec)) {
    parts.push(`${brownSamplesPerSec.toFixed(1)} Brown Hz`);
  }
  const brownMeanErrorPx = finiteNumber(row.brown_precision_mean_error_px);
  if (Number.isFinite(brownMeanErrorPx)) {
    parts.push(`${brownMeanErrorPx.toFixed(1)} px Brown mean error`);
  }
  return parts.length ? `; ${parts.join(', ')}` : '';
}

/**
 * Labels the precision sample source shown in setup diagnostics.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * Researchers need to distinguish Brown's native stored-point buffer from the
 * app's direct prediction fallback because the two outcomes imply different
 * WebGazer/jsPsych integration problems.
 *
 * @param {unknown} source Stored source code.
 * @returns {string} Researcher-facing source label.
 */
function brownPrecisionSampleSourceLabel(source) {
  return {
    webgazer_stored_points: 'WebGazer stored points',
    direct_prediction_poll: 'direct predictions',
    mock: 'mock',
    unavailable: 'unavailable',
  }[source] ?? 'unknown source';
}

/**
 * Converts a setup value into a finite number without treating null as zero.
 *
 * Requirement links: `FR-EYE-004`, `FR-ERR-003`, and `FR-LAB-004`.
 * `Number(null)` returns zero in JavaScript, which would make unavailable
 * Brown precision look like a measured 0% result on the Setup page.
 *
 * @param {unknown} value Candidate setup value.
 * @returns {number | null} Finite number or null.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * Binds handlers for the currently rendered route.
 *
 * Requirement links: `FR-EXP-001`, `FR-DATA-008`, `FR-DATA-010`,
 * `FR-LAB-005`, `FR-ERR-001`, and `FR-ERR-003`.
 * Binding after each render keeps handlers scoped to visible controls and makes
 * the static SPA simple to test.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function bindView(root, state) {
  syncCameraPreview(root, state);
  if (
    state.view === 'setup'
    && !state.useMockGaze
    && !state.cameraSelectionInitializationPending
    && !state.cameraSelectionInitializationComplete
  ) {
    initializeCameraSelectionOnSetup(root, state).catch((error) => {
      state.cameraSelectionInitializationPending = false;
      state.cameraSelectionInitializationComplete = true;
      state.cameraSelectionStatus = `Camera list unavailable: ${error instanceof Error ? error.message : String(error)}`;
      render(root, state);
    });
  }

  root.querySelector('[data-action="new-session"]')?.addEventListener('click', () => {
    stopCameraPreview(state);
    state.store = new SessionDataStore({ participantId: state.participantId });
    state.logger.setStore(state.store);
    state.logger.clearBuffer();
    state.logger.setEnabled(state.diagnosticsEnabled);
    state.webgazerBridge = new WebGazerBridge({ mode: state.useMockGaze ? 'mock' : 'real', logger: state.logger });
    state.webgazerBridge.setCameraDeviceId(selectedCameraDeviceId(state));
    window.tetrisEyeTrackingApp.store = state.store;
    window.tetrisEyeTrackingApp.logger = state.logger;
    state.currentTrialId = null;
    state.practiceCompleted = false;
    state.cameraSelectionPermissionGranted = false;
    state.cameraSelectionStatus = state.useMockGaze
      ? 'Camera selection disabled while mock gaze is selected.'
      : 'Camera selection not validated.';
    state.calibrationStatus = 'Not run.';
    state.status = 'New session ready.';
    render(root, state);
  });

  root.querySelector('[data-action="recover-backup"]')?.addEventListener('click', async () => {
    const result = await state.store.recoverBackup().catch((error) => ({ ok: false, errors: [error.message] }));
    state.status = result ? (result.ok ? 'Recovered IndexedDB backup.' : result.errors.join(' ')) : 'No backup found.';
    render(root, state);
  });

  root.querySelector('[data-action="clear-backup"]')?.addEventListener('click', async () => {
    await state.store.clearBackup().catch(() => {});
    state.status = 'Local backup cleared.';
    render(root, state);
  });

  root.querySelector('[data-field="participant-id"]')?.addEventListener('input', (event) => {
    state.participantId = event.target.value.trim() || 'anonymous';
  });

  root.querySelector('[data-field="diagnostics-enabled"]')?.addEventListener('change', (event) => {
    state.diagnosticsEnabled = event.target.checked;
    state.logger.setEnabled(state.diagnosticsEnabled);
    state.webgazerBridge.setLogger(state.logger);
    state.logger.info('ui', 'setup', 'diagnostics_toggle', state.diagnosticsEnabled ? 'Detailed diagnostics enabled.' : 'Detailed diagnostics disabled.', {
      enabled: state.diagnosticsEnabled,
    });
    render(root, state);
  });

  root.querySelector('[data-field="calibration-clicks-per-point"]')?.addEventListener('change', (event) => {
    const selectedCount = normalizeCalibrationClicksPerPoint(event.target.value);
    state.calibrationClicksPerPoint = selectedCount;
    // Changing the repeated-click count invalidates the in-memory WebGazer setup
    // gate. Recreating the bridge is a deliberate hard reset so a formal trial
    // cannot reuse a camera model calibrated with a different sample density.
    state.webgazerBridge = new WebGazerBridge({ mode: state.useMockGaze ? 'mock' : 'real', logger: state.logger });
    state.webgazerBridge.setCameraDeviceId(selectedCameraDeviceId(state));
    state.calibrationStatus = `Calibration clicks per point set to ${selectedCount}. Run WebGazer setup before starting a trial.`;
    render(root, state);
  });

  root.querySelector('[data-field="mock-gaze"]')?.addEventListener('change', (event) => {
    state.useMockGaze = event.target.checked;
    state.webgazerBridge = new WebGazerBridge({ mode: state.useMockGaze ? 'mock' : 'real', logger: state.logger });
    state.webgazerBridge.setCameraDeviceId(selectedCameraDeviceId(state));
    if (state.useMockGaze) {
      stopCameraPreview(state, 'Camera preview stopped because mock gaze is selected.');
      state.cameraSelectionPermissionGranted = false;
      state.cameraSelectionStatus = 'Camera selection disabled while mock gaze is selected.';
      render(root, state);
    } else {
      state.cameraSelectionPermissionGranted = false;
      state.cameraSelectionStatus = 'Select a camera, then click Validate Camera.';
      state.cameraSelectionInitializationComplete = false;
      render(root, state);
    }
  });

  root.querySelector('[data-field="camera-device"]')?.addEventListener('change', (event) => {
    handleCameraDeviceChange(root, state, event.target.value).catch((error) => {
      stopCameraPreview(state);
      state.cameraSelectionPermissionGranted = false;
      state.cameraSelectionStatus = `Camera selection failed: ${error instanceof Error ? error.message : String(error)}`;
      state.calibrationStatus = state.cameraSelectionStatus;
      render(root, state);
    });
  });

  root.querySelector('[data-action="calibrate"]')?.addEventListener('click', async () => {
    if (!state.useMockGaze && !state.cameraSelectionPermissionGranted) {
      state.cameraSelectionStatus = 'Validate camera selection before running WebGazer setup.';
      state.calibrationStatus = state.cameraSelectionStatus;
      render(root, state);
      return;
    }
    const replacingCompletedSetup = state.webgazerBridge.hasCompletedSetup();
    state.webgazerBridge.setCameraDeviceId(selectedCameraDeviceId(state));
    stopCameraPreview(state, 'Camera preview stopped while WebGazer owns the selected camera.');
    state.calibrationStatus = state.useMockGaze
      ? 'Running mock WebGazer setup.'
      : (replacingCompletedSetup
        ? 'Starting new WebGazer calibration; previous calibration will be replaced for future trials.'
        : 'Starting jsPsych WebGazer setup.');
    state.setupRunning = !state.useMockGaze;
    state.webgazerSetupPhase = state.useMockGaze ? 'idle' : 'intro';
    render(root, state);
    const statusLine = root.querySelector('[data-testid="calibration-status"]');
    const overlayStatusLine = root.querySelector('[data-testid="webgazer-overlay-status"]');
    const setupRoot = root.querySelector('[data-testid="webgazer-setup-root"]');
    const handleSetupEscape = (event) => {
      if (event.key !== 'Escape' || !state.setupRunning) {
        return;
      }
      event.preventDefault();
      state.calibrationStatus = 'Canceling WebGazer setup.';
      if (statusLine) {
        statusLine.textContent = state.calibrationStatus;
      }
      if (overlayStatusLine) {
        overlayStatusLine.textContent = state.calibrationStatus;
      }
      state.webgazerBridge.abortSetup();
    };
    window.addEventListener('keydown', handleSetupEscape);
    try {
      if (!state.useMockGaze) {
        await waitForCameraHardwareRelease();
      }
      const row = await state.webgazerBridge.runSetup({
        // Real WebGazer setup owns this dedicated mount while the surrounding
        // Setup controls remain visible. Re-rendering during jsPsych trials would
        // destroy the plugin DOM, so progress updates write directly to the
        // status line until the setup promise resolves.
        displayElement: setupRoot ?? root.querySelector('[data-testid="app-main"]'),
        store: state.store,
        participantId: state.participantId,
        mode: state.useMockGaze ? 'mock' : 'real',
        cameraDeviceId: selectedCameraDeviceId(state),
        // This value means repeated clicks at each of the 9 fixed calibration
        // targets. The bridge exports it separately from `calibration_points`
        // so later analysis can distinguish coverage from sample density.
        calibrationClicksPerPoint: state.calibrationClicksPerPoint,
        logger: state.logger,
        onStatus: (message) => {
          state.calibrationStatus = message;
          if (statusLine) {
            statusLine.textContent = message;
          }
          if (overlayStatusLine) {
            overlayStatusLine.textContent = message;
          }
        },
        onPhase: (phase) => {
          setWebGazerSetupPhase(root, state, phase);
        },
      });
      state.calibrationStatus = webGazerSetupResultMessage(row);
    } finally {
      window.removeEventListener('keydown', handleSetupEscape);
      state.setupRunning = false;
      state.webgazerSetupPhase = 'idle';
      render(root, state);
    }
  });

  root.querySelector('[data-action="stop-camera-preview"]')?.addEventListener('click', () => {
    stopCameraPreview(state, 'Camera preview stopped.');
    render(root, state);
  });

  root.querySelector('[data-action="validate-camera-selection"]')?.addEventListener('click', () => {
    validateCameraSelection(root, state).catch((error) => {
      stopCameraPreview(state);
      state.cameraSelectionPermissionGranted = false;
      state.cameraSelectionStatus = `Camera selection failed: ${error instanceof Error ? error.message : String(error)}`;
      state.calibrationStatus = state.cameraSelectionStatus;
      render(root, state);
    });
  });

  root.querySelector('[data-action="download-diagnostics"]')?.addEventListener('click', () => {
    try {
      new ExportService(state.store).downloadCsv('diagnostic_events');
      state.calibrationStatus = 'Diagnostics CSV export started.';
      render(root, state);
    } catch (error) {
      state.calibrationStatus = `Diagnostics export failed: ${error instanceof Error ? error.message : String(error)}`;
      render(root, state);
    }
  });

  bindTrialControls(root, state);
  bindReplay(root, state);
  bindExport(root, state);
}

/**
 * Binds the Play view's trial lifecycle controls.
 *
 * Requirement links: `FR-EXP-003` through `FR-EXP-008`,
 * `FR-EYE-004`, `FR-GAME-011`, `FR-DATA-011`, and `FR-ERR-002`.
 * Real gaze trials are gated on in-memory setup completion so a recovered
 * historical row cannot accidentally authorize a new webcam trial. Brown
 * precision is displayed as a quality diagnostic.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function bindTrialControls(root, state) {
  const canvas = root.querySelector('#tetris-canvas');
  if (!canvas) {
    return;
  }
  bindTrialConfig(root, state);
  bindPostTrialControls(root, state);
  updateDebugOverlayVisibility(root, state);

  root.querySelector('[data-action="start-trial"]')?.addEventListener('click', async () => {
    clearTrialTimer(state);
    stopDebugOverlay(state);
    if (!state.useMockGaze && !state.webgazerBridge.hasCompletedSetup()) {
      state.status = 'Run and complete WebGazer setup before starting a real eye-tracking trial.';
      root.querySelector('[data-testid="trial-status"]').textContent = state.status;
      root.querySelector('[data-testid="recording-status"]').textContent = 'Waiting';
      return;
    }
    state.runner = new JsPsychTetrisTrialRunner({
      store: state.store,
      canvas,
      durationMs: state.trialConfig.durationMs,
      trialMode: state.trialConfig.trialMode,
      fallIntervalMs: state.trialConfig.fallIntervalMs,
      previewEnabled: state.trialConfig.previewEnabled,
      ghostEnabled: state.trialConfig.ghostEnabled,
      gazeMode: state.useMockGaze ? 'mock' : 'real',
      webgazerBridge: state.webgazerBridge,
      webgazerDisplayElement: root.querySelector('[data-testid="app-main"]'),
      onStatus: (text) => {
        state.status = text;
        root.querySelector('[data-testid="trial-status"]').textContent = text;
      },
      onComplete: (trial) => {
        clearTrialTimer(state);
        stopDebugOverlay(state);
        drawDebugOverlay(root, state);
        state.currentTrialId = trial?.trial_id ?? state.currentTrialId;
        if (trial?.trial_mode === 'practice') {
          // Practice trials are optional, but once one completes the UI advances
          // to the main condition so classroom demos naturally follow the
          // practice-before-data-collection workflow from the requirements.
          state.practiceCompleted = true;
          state.trialConfig.trialMode = 'main';
          const modeSelect = root.querySelector('[data-field="trial-mode"]');
          if (modeSelect) {
            modeSelect.value = 'main';
          }
        }
        state.status = trial?.trial_mode === 'practice'
          ? `Trial ended: ${trial.end_reason}. Completed ${state.currentTrialId}. Next trial set to main.`
          : `Trial ended: ${trial?.end_reason ?? 'unknown'}. Completed ${state.currentTrialId}.`;
        root.querySelector('[data-testid="trial-status"]').textContent = state.status;
        root.querySelector('[data-testid="current-trial"]').textContent = state.currentTrialId ?? 'None';
        root.querySelector('[data-testid="recording-status"]').textContent = trial?.recording_id ? 'Recorded' : 'Unavailable';
      },
    });
    try {
      root.querySelector('[data-testid="recording-status"]').textContent = 'Starting';
      const trial = await state.runner.start({
        participantId: state.participantId,
        levelStart: state.trialConfig.levelStart,
        condition: `${state.trialConfig.trialMode}_keyboard_only`,
      });
      state.currentTrialId = trial.trial_id;
      root.querySelector('[data-testid="current-trial"]').textContent = state.currentTrialId;
      root.querySelector('[data-testid="recording-status"]').textContent = 'Recording';
      startTrialTimer(root, state);
      startDebugOverlay(root, state);
      canvas.focus();
    } catch (error) {
      clearTrialTimer(state);
      state.status = `Trial start failed: ${error instanceof Error ? error.message : String(error)}`;
      root.querySelector('[data-testid="trial-status"]').textContent = state.status;
      root.querySelector('[data-testid="recording-status"]').textContent = 'Unavailable';
    }
  });

  root.querySelector('[data-action="pause-trial"]')?.addEventListener('click', () => state.runner?.pause());
  root.querySelector('[data-action="resume-trial"]')?.addEventListener('click', () => {
    state.runner?.resume();
    canvas.focus();
  });
  root.querySelector('[data-action="quit-trial"]')?.addEventListener('click', () => state.runner?.quit());
}

/**
 * Binds post-trial questionnaire persistence.
 *
 * Requirement links: `FR-EXP-006`, `FR-DATA-001`, and `FR-DATA-008`.
 * A response is upserted by trial so students can correct ratings without
 * creating duplicate survey rows for the same trial.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function bindPostTrialControls(root, state) {
  root.querySelector('[data-action="post-trial-response"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const trialId = state.currentTrialId ?? state.store.getRows('trials').at(-1)?.trial_id;
    const trial = trialId ? state.store.getRows('trials').find((row) => row.trial_id === trialId) : null;
    const status = root.querySelector('[data-testid="post-trial-status"]');
    if (!trial) {
      state.postTrialStatus = 'No completed trial is available.';
      status.textContent = state.postTrialStatus;
      return;
    }
    const response = {
      response_id: `response_${state.store.getRows('post_trial_responses').length + 1}`,
      trial_id: trial.trial_id,
      participant_id: trial.participant_id,
      submitted_at: nowIso(),
      workload_rating: boundedRating(root.querySelector('[data-field="post-workload"]').value),
      difficulty_rating: boundedRating(root.querySelector('[data-field="post-difficulty"]').value),
      frustration_rating: boundedRating(root.querySelector('[data-field="post-frustration"]').value),
      strategy_text: root.querySelector('[data-field="post-strategy"]').value.trim(),
    };
    const existing = state.store.updateFirst(
      'post_trial_responses',
      (row) => row.trial_id === trial.trial_id,
      (row) => ({ ...response, response_id: row.response_id }),
    );
    if (!existing) {
      state.store.addRow('post_trial_responses', response);
    }
    state.postTrialStatus = `Saved response for ${trial.trial_id}.`;
    status.textContent = state.postTrialStatus;
    state.store.saveBackup().catch(() => {});
  });
}

/**
 * Normalizes a post-trial Likert rating.
 *
 * Requirement links: `FR-EXP-006` and `FR-DATA-001`.
 * Null is used for missing or invalid input so exported survey rows do not
 * invent ratings.
 *
 * @param {unknown} value Raw form value.
 * @returns {number | null} Integer rating from 1 to 7, or null.
 */
function boundedRating(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(7, Math.max(1, Math.round(parsed)));
}

/**
 * Binds trial-configuration controls.
 *
 * Requirement links: `FR-EXP-003`, `FR-EXP-004`, `FR-EXP-007`,
 * `FR-GAME-012`, and `FR-GAME-013`.
 * Config changes update state immediately; the runner later copies that state
 * into trial metadata at start time.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function bindTrialConfig(root, state) {
  const setNumber = (selector, key, multiplier, fallback) => {
    root.querySelector(selector)?.addEventListener('input', (event) => {
      const parsed = Number(event.target.value);
      state.trialConfig[key] = Number.isFinite(parsed) ? parsed * multiplier : fallback;
    });
  };
  root.querySelector('[data-field="trial-mode"]')?.addEventListener('change', (event) => {
    state.trialConfig.trialMode = event.target.value;
  });
  setNumber('[data-field="duration-seconds"]', 'durationMs', 1000, 60_000);
  setNumber('[data-field="level-start"]', 'levelStart', 1, 0);
  setNumber('[data-field="fall-interval"]', 'fallIntervalMs', 1, 650);
  root.querySelector('[data-field="preview-enabled"]')?.addEventListener('change', (event) => {
    state.trialConfig.previewEnabled = event.target.checked;
  });
  root.querySelector('[data-field="ghost-enabled"]')?.addEventListener('change', (event) => {
    state.trialConfig.ghostEnabled = event.target.checked;
  });
  root.querySelector('[data-field="debug-overlay-enabled"]')?.addEventListener('change', (event) => {
    state.debugOverlayEnabled = event.target.checked;
    updateDebugOverlayVisibility(root, state);
    if (state.debugOverlayEnabled) {
      startDebugOverlay(root, state);
    } else {
      stopDebugOverlay(state);
    }
  });
}

/**
 * Starts the visible elapsed-time counter for active trials.
 *
 * Requirement links: `FR-UI-003`, `FR-EXP-005`, and `FR-REPLAY-009`.
 * The display uses the runner's trial start clock, matching the timestamps
 * stored with gaze, AOI, and game-event rows.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function startTrialTimer(root, state) {
  const elapsed = root.querySelector('[data-testid="trial-elapsed"]');
  const updateElapsed = () => {
    if (!elapsed || !state.runner?.adapter?.trialStartMs) {
      return;
    }
    elapsed.textContent = `${Math.max(0, Math.round(performance.now() - state.runner.adapter.trialStartMs))} ms`;
  };
  updateElapsed();
  state.trialTimerId = setInterval(updateElapsed, 250);
}

/**
 * Stops the visible elapsed-time counter.
 *
 * Requirement links: `FR-PERF-001` and `FR-EXP-008`.
 * Clearing the timer during completion and failure paths prevents stale UI
 * updates after a trial has ended.
 *
 * @param {Record<string, unknown>} state App state.
 */
function clearTrialTimer(state) {
  if (state.trialTimerId) {
    clearInterval(state.trialTimerId);
    state.trialTimerId = null;
  }
}

/**
 * Shows or hides the live debug overlay.
 *
 * Requirement links: `FR-UI-008` and `FR-EYE-010`.
 * The overlay is opt-in because live gaze visualization can influence formal
 * participant behavior.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function updateDebugOverlayVisibility(root, state) {
  const overlay = root.querySelector('#debug-overlay');
  if (!overlay) {
    return;
  }
  overlay.hidden = !state.debugOverlayEnabled;
  if (!state.debugOverlayEnabled) {
    overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
  }
}

/**
 * Starts periodic debug overlay drawing.
 *
 * Requirement links: `FR-UI-008`, `FR-EYE-010`, and `FR-PERF-001`.
 * The overlay updates at a modest rate so debugging does not compete heavily
 * with gameplay, recording, or gaze sampling.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function startDebugOverlay(root, state) {
  if (!state.debugOverlayEnabled || state.debugOverlayTimerId) {
    return;
  }
  drawDebugOverlay(root, state);
  state.debugOverlayTimerId = setInterval(() => drawDebugOverlay(root, state), 100);
}

/**
 * Stops periodic debug overlay drawing.
 *
 * Requirement links: `FR-UI-008` and `FR-PERF-001`.
 * Stopping the interval keeps inactive views from drawing against detached
 * canvas elements.
 *
 * @param {Record<string, unknown>} state App state.
 */
function stopDebugOverlay(state) {
  if (state.debugOverlayTimerId) {
    clearInterval(state.debugOverlayTimerId);
    state.debugOverlayTimerId = null;
  }
}

/**
 * Draws current AOI and latest gaze debug overlays on the Play view.
 *
 * Requirement links: `FR-UI-008`, `FR-EYE-010`, `FR-AOI-007`,
 * `FR-AOI-008`, and `FR-REPLAY-009`.
 * The debug overlay reuses the same layout-based mapping as replay so lab
 * validation can catch coordinate drift before exports are trusted.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function drawDebugOverlay(root, state) {
  const overlay = root.querySelector('#debug-overlay');
  if (!overlay || !state.debugOverlayEnabled || !state.currentTrialId) {
    return;
  }
  const rect = overlay.getBoundingClientRect();
  overlay.width = Math.max(1, Math.round(rect.width || 500));
  overlay.height = Math.max(1, Math.round(rect.height || 620));
  const ctx = overlay.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const tTrialMs = state.runner?.adapter?.trialStartMs
    ? Math.max(0, Math.round(performance.now() - state.runner.adapter.trialStartMs))
    : Number(state.store.getRows('gaze_samples').filter((row) => row.trial_id === state.currentTrialId).at(-1)?.t_trial_ms ?? 0);
  const activeAois = state.store
    .getRows('aoi_snapshots')
    .filter((row) => row.trial_id === state.currentTrialId)
    .filter((row) => tTrialMs >= Number(row.valid_from_t_trial_ms))
    .filter((row) => row.valid_to_t_trial_ms === null || tTrialMs < Number(row.valid_to_t_trial_ms));
  for (const aoi of activeAois) {
    const mapped = mapDebugRect(aoi, state, overlay);
    ctx.strokeStyle = colorForAoi(aoi.aoi);
    ctx.lineWidth = aoi.aoi === 'active_piece' ? 3 : 1.5;
    ctx.strokeRect(mapped.x, mapped.y, mapped.w, mapped.h);
  }
  const sample = state.store
    .getRows('gaze_samples')
    .filter((row) => row.trial_id === state.currentTrialId && row.valid)
    .sort((left, right) => Number(right.t_trial_ms) - Number(left.t_trial_ms))[0];
  if (sample) {
    const point = mapDebugPoint(sample, state, overlay);
    ctx.beginPath();
    ctx.fillStyle = colorForAoi('gaze_point');
    ctx.strokeStyle = 'rgba(18, 24, 30, 0.92)';
    ctx.lineWidth = 2;
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Maps stored viewport coordinates into the debug overlay.
 *
 * Requirement links: `FR-UI-008`, `FR-AOI-007`, and `FR-REPLAY-009`.
 * The transform matches replay mapping, but uses the current Play overlay size
 * instead of recorded-video size.
 *
 * @param {{x: number, y: number}} point Viewport point.
 * @param {Record<string, unknown>} state App state.
 * @param {HTMLCanvasElement} overlay Debug overlay canvas.
 * @returns {{x: number, y: number}} Overlay point.
 */
function mapDebugPoint(point, state, overlay) {
  const layout = state.store.getRows('layout').find((row) => row.trial_id === state.currentTrialId);
  if (!layout) {
    return { x: point.x, y: point.y };
  }
  return {
    x: ((point.x - layout.canvas_x) / layout.canvas_w) * overlay.width,
    y: ((point.y - layout.canvas_y) / layout.canvas_h) * overlay.height,
  };
}

/**
 * Maps a stored AOI rectangle into the debug overlay.
 *
 * Requirement links: `FR-UI-008`, `FR-AOI-007`, and `FR-AOI-008`.
 * Mapping through corner points keeps debug rectangles consistent with replay
 * when the canvas is CSS-scaled.
 *
 * @param {{x: number, y: number, w: number, h: number}} rect Viewport rectangle.
 * @param {Record<string, unknown>} state App state.
 * @param {HTMLCanvasElement} overlay Debug overlay canvas.
 * @returns {{x: number, y: number, w: number, h: number}} Overlay rectangle.
 */
function mapDebugRect(rect, state, overlay) {
  const topLeft = mapDebugPoint({ x: rect.x, y: rect.y }, state, overlay);
  const bottomRight = mapDebugPoint({ x: rect.x + rect.w, y: rect.y + rect.h }, state, overlay);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: bottomRight.x - topLeft.x,
    h: bottomRight.y - topLeft.y,
  };
}

/**
 * Binds replay controls for the rendered replay view.
 *
 * Requirement links: `FR-REPLAY-001` through `FR-REPLAY-007`,
 * and `FR-REPLAY-009`.
 * The controller is recreated per render so imported sessions, recovered
 * sessions, and newly completed trials all use the current store state.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function bindReplay(root, state) {
  const video = root.querySelector('#replay-video');
  const overlay = root.querySelector('#replay-overlay');
  if (!video || !overlay) {
    return;
  }
  const trialSelect = root.querySelector('[data-field="replay-trial"]');
  const trailSelect = root.querySelector('[data-field="replay-gaze-trail"]');
  const trialId = trialSelect?.value || state.currentTrialId || state.store.getRows('trials').at(-1)?.trial_id;
  state.replay = new ReplayController({
    store: state.store,
    video,
    overlay,
    scrub: root.querySelector('#replay-scrub'),
    pieceSelect: root.querySelector('#piece-jump'),
    trailSelect,
    details: root.querySelector('[data-testid="replay-piece-details"]'),
    previousGazeCount: state.replayTrailCount,
  });
  if (trialId) {
    state.replay.loadTrial(trialId);
  }
  root.querySelector('[data-action="replay-play"]')?.addEventListener('click', () => video.play());
  root.querySelector('[data-action="replay-pause"]')?.addEventListener('click', () => video.pause());
  root.querySelector('[data-action="replay-restart"]')?.addEventListener('click', () => {
    video.currentTime = 0;
    state.replay.draw();
  });
  trialSelect?.addEventListener('change', (event) => {
    state.currentTrialId = event.target.value;
    state.replay.loadTrial(state.currentTrialId);
  });
  trailSelect?.addEventListener('change', (event) => {
    state.replayTrailCount = Number(event.target.value);
  });
}

/**
 * Binds export and import controls.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-004`, `FR-DATA-011`,
 * `FR-REPLAY-001`, `FR-ANA-010`, and `FR-ERR-004`.
 * Error messages are written into the export status line because downloads can
 * fail from browser policies even when artifact generation succeeds.
 *
 * @param {HTMLElement} root Root element.
 * @param {Record<string, unknown>} state App state.
 */
function bindExport(root, state) {
  const service = new ExportService(state.store);
  const status = root.querySelector('[data-testid="export-status"]');
  const setStatus = (message) => {
    state.exportStatus = message;
    if (status) {
      status.textContent = message;
    }
  };
  root.querySelector('[data-action="download-json"]')?.addEventListener('click', () => {
    try {
      service.downloadJson();
      setStatus('JSON export started.');
    } catch (error) {
      setStatus(`JSON export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  root.querySelectorAll('[data-action="download-csv"]').forEach((button) => {
    button.addEventListener('click', () => {
      try {
        service.downloadCsv(button.dataset.table);
        setStatus(`${button.dataset.table} CSV export started.`);
      } catch (error) {
        setStatus(`CSV export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
  root.querySelectorAll('[data-action="download-recording"]').forEach((button) => {
    button.addEventListener('click', () => {
      try {
        const anchor = service.downloadRecording(button.dataset.recordingId);
        setStatus(anchor ? 'Recording export started.' : 'Recording export failed: media blob unavailable.');
      } catch (error) {
        setStatus(`Recording export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
  root.querySelector('[data-action="import-session"]')?.addEventListener('click', async () => {
    const jsonFile = root.querySelector('[data-field="import-json"]')?.files?.[0];
    const recordingFile = root.querySelector('[data-field="import-recording"]')?.files?.[0];
    if (!jsonFile) {
      setStatus('Import failed: choose a session JSON file.');
      return;
    }
    try {
      const session = JSON.parse(await jsonFile.text());
      const result = state.store.replaceSession(session);
      if (!result.ok) {
        setStatus(`Import failed: ${result.errors.join(' ')}`);
        return;
      }
      attachImportedRecording(state.store, recordingFile);
      state.currentTrialId = state.store.getRows('trials').at(-1)?.trial_id ?? null;
      window.tetrisEyeTrackingApp.store = state.store;
      state.exportStatus = recordingFile
        ? 'Imported session JSON and attached recording file.'
        : 'Imported session JSON without a recording file.';
      render(root, state);
    } catch (error) {
      setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Attaches an imported WebM blob to the best matching recording row.
 *
 * Requirement links: `FR-REPLAY-001`, `FR-DATA-011`, and `FR-REPLAY-003`.
 * Matching by filename first preserves the JSON media reference; falling back
 * to the first row keeps small pilot imports usable when filenames were changed.
 *
 * @param {SessionDataStore} store Canonical data store.
 * @param {File | null | undefined} recordingFile Imported recording file.
 * @returns {string | null} Object URL or null.
 */
function attachImportedRecording(store, recordingFile) {
  if (!recordingFile) {
    return null;
  }
  const recordings = store.getRows('trial_recordings');
  const recording = recordings.find((row) => row.file_name === recordingFile.name) ?? recordings[0];
  if (!recording) {
    return null;
  }
  return store.setMediaBlob(recording.recording_id, recordingFile);
}

/**
 * Renders a compact table from selected row fields.
 *
 * Requirement links: `FR-ANA-009`, `FR-UI-005`, and `FR-DATA-004`.
 * The analysis view uses selected columns for readability while the export view
 * provides full CSV tables.
 *
 * @param {Record<string, unknown>[]} rows Row objects.
 * @param {string[]} columns Columns to display.
 * @returns {string} Table markup.
 */
function renderTable(rows, columns) {
  if (!rows.length) {
    return '<p class="empty">No rows yet.</p>';
  }
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((column) => `<th>${label(column)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>${columns.map((column) => `<td>${formatCell(row[column])}</td>`).join('')}</tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Renders the replay overlay legend.
 *
 * Requirement links: `FR-REPLAY-004`, `FR-REPLAY-005`, and `FR-UI-008`.
 * Legend colors are generated from the same helper used by canvas drawing so
 * labels, swatches, and overlays stay synchronized.
 *
 * @returns {string} Legend markup.
 */
function replayLegendMarkup() {
  return `
    <div class="replay-legend" data-testid="replay-legend">
      <h3>Overlay Legend</h3>
      <div class="legend-items">
        ${REPLAY_LEGEND_ITEMS.map((item) => `
          <div class="legend-item">
            <span class="legend-swatch ${item.aoi === 'gaze_point' || item.aoi === 'gaze_trail' ? 'gaze-swatch' : ''}" style="--legend-color: ${colorForAoi(item.aoi)}"></span>
            <span>${item.label}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Converts a schema column name into compact display text.
 *
 * Requirement links: `FR-ANA-009` and `FR-HCI-005`.
 * Labels are derived from schema columns so analysis tables remain aligned with
 * exported CSV headers.
 *
 * @param {string} column Column name.
 * @returns {string} Display label.
 */
function label(column) {
  return column.replaceAll('_', ' ');
}

/**
 * Formats a table cell for display.
 *
 * Requirement links: `FR-ANA-009` and `FR-DATA-004`.
 * Numeric values keep reasonable precision in the UI while CSV exports retain
 * the underlying stored values.
 *
 * @param {unknown} value Cell value.
 * @returns {string} Display text.
 */
function formatCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}
