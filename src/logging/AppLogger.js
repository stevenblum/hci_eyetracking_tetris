import { nowIso } from '../utils/clock.js';

const DEFAULT_MAX_BUFFER_EVENTS = 500;
const LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * Records structured application diagnostics in memory and the current schema.
 *
 * Requirement links: `FR-ERR-003`, `FR-DATA-001`, `FR-DATA-008`,
 * `FR-LAB-004`, and `FR-LAB-005`.
 * The logger is deliberately small and dependency-free: calibration needs very
 * detailed event traces, but those traces must never be able to interrupt a lab
 * workflow or create a second noncanonical export format.
 */
export class AppLogger {
  /**
   * Creates a structured logger.
   *
   * Requirement links: `FR-ERR-003`, `FR-DATA-001`, and `FR-LAB-004`.
   * `enabled` controls schema writes and console debug output; the in-memory
   * ring buffer remains active so recent severe events are still available for
   * troubleshooting even when detailed diagnostics were not explicitly enabled.
   *
   * @param {{store?: import('../data/SessionDataStore.js').SessionDataStore | null, enabled?: boolean, level?: string, maxBufferEvents?: number, consoleEnabled?: boolean}} options Logger options.
   */
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.enabled = options.enabled ?? false;
    this.level = normalizeLevel(options.level ?? 'debug');
    this.consoleEnabled = options.consoleEnabled ?? true;
    this.maxBufferEvents = options.maxBufferEvents ?? DEFAULT_MAX_BUFFER_EVENTS;
    this.buffer = [];
    this.sequence = 0;
    this.context = {};
    this.phaseStartedAtMs = null;
  }

  /**
   * Rebinds the logger to a new session store.
   *
   * Requirement links: `FR-DATA-001`, `FR-DATA-008`, and `FR-LAB-005`.
   * New sessions replace the store object, so the logger must follow that
   * canonical session instead of continuing to write diagnostic rows into the
   * previous participant's data.
   *
   * @param {import('../data/SessionDataStore.js').SessionDataStore | null} store Current session store.
   */
  setStore(store) {
    this.store = store;
  }

  /**
   * Enables or disables diagnostic table writes.
   *
   * Requirement links: `FR-LAB-004` and `FR-DATA-001`.
   * Detailed WebGazer calibration can generate many rows, so the Setup UI owns
   * this switch and researchers can turn it on only when diagnosing a problem.
   *
   * @param {boolean} enabled Whether detailed diagnostics should be persisted.
   */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  /**
   * Updates context copied onto future log rows.
   *
   * Requirement links: `FR-DATA-001` and `FR-LAB-004`.
   * Context IDs keep calibration, trial, and replay events joinable without
   * forcing each call site to pass session/run IDs repeatedly.
   *
   * @param {{webgazerRunId?: string | null, trialId?: string | null, phase?: string | null, route?: string | null}} context Context fields.
   */
  setContext(context = {}) {
    this.context = {
      ...this.context,
      ...context,
    };
  }

  /**
   * Marks the beginning of a phase for elapsed-time diagnostics.
   *
   * Requirement links: `FR-EYE-003`, `FR-EYE-004`, and `FR-LAB-004`.
   * Calibration failures are often timing-specific, so phase-relative elapsed
   * time is stored beside absolute `performance.now()` timestamps.
   *
   * @param {string} phase Phase name.
   * @param {Record<string, unknown>} [data] Optional phase-start details.
   */
  startPhase(phase, data = {}) {
    this.phaseStartedAtMs = performance.now();
    this.setContext({ phase });
    this.info('webgazer', phase, 'phase_start', `Started ${phase}.`, data);
  }

  /**
   * Writes an error-level diagnostic event.
   *
   * @param {string} category Event category.
   * @param {string} phase Workflow phase.
   * @param {string} action Event action.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [data] Structured event details.
   * @returns {Record<string, unknown>} Stored event object.
   */
  error(category, phase, action, message, data = {}) {
    return this.log('error', category, phase, action, message, data);
  }

  /**
   * Writes a warning-level diagnostic event.
   *
   * @param {string} category Event category.
   * @param {string} phase Workflow phase.
   * @param {string} action Event action.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [data] Structured event details.
   * @returns {Record<string, unknown>} Stored event object.
   */
  warn(category, phase, action, message, data = {}) {
    return this.log('warn', category, phase, action, message, data);
  }

  /**
   * Writes an info-level diagnostic event.
   *
   * @param {string} category Event category.
   * @param {string} phase Workflow phase.
   * @param {string} action Event action.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [data] Structured event details.
   * @returns {Record<string, unknown>} Stored event object.
   */
  info(category, phase, action, message, data = {}) {
    return this.log('info', category, phase, action, message, data);
  }

  /**
   * Writes a debug-level diagnostic event.
   *
   * @param {string} category Event category.
   * @param {string} phase Workflow phase.
   * @param {string} action Event action.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [data] Structured event details.
   * @returns {Record<string, unknown> | null} Stored event object or null when filtered.
   */
  debug(category, phase, action, message, data = {}) {
    return this.log('debug', category, phase, action, message, data);
  }

  /**
   * Writes a trace-level diagnostic event.
   *
   * @param {string} category Event category.
   * @param {string} phase Workflow phase.
   * @param {string} action Event action.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [data] Structured event details.
   * @returns {Record<string, unknown> | null} Stored event object or null when filtered.
   */
  trace(category, phase, action, message, data = {}) {
    return this.log('trace', category, phase, action, message, data);
  }

  /**
   * Writes one structured diagnostic event.
   *
   * Requirement links: `FR-ERR-003`, `FR-DATA-001`, and `FR-LAB-004`.
   * Logging is best-effort: invalid data and store failures are absorbed so
   * diagnostic collection cannot create a new source of calibration failure.
   *
   * @param {'error' | 'warn' | 'info' | 'debug' | 'trace'} level Severity level.
   * @param {string} category Event category.
   * @param {string} phase Workflow phase.
   * @param {string} action Event action.
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [data] Structured event details.
   * @returns {Record<string, unknown> | null} Stored event object or null when filtered.
   */
  log(level, category, phase, action, message, data = {}) {
    const normalizedLevel = normalizeLevel(level);
    if (!this.shouldRecord(normalizedLevel)) {
      return null;
    }
    const performanceMs = performance.now();
    const event = {
      event_id: `diag_${Date.now()}_${this.sequence += 1}`,
      session_id: this.store?.session?.session_id ?? null,
      webgazer_run_id: this.context.webgazerRunId ?? null,
      trial_id: this.context.trialId ?? null,
      timestamp_iso: nowIso(),
      performance_ms: Math.round(performanceMs * 10) / 10,
      elapsed_ms: this.phaseStartedAtMs === null
        ? null
        : Math.round((performanceMs - this.phaseStartedAtMs) * 10) / 10,
      level: normalizedLevel,
      category,
      phase: phase ?? this.context.phase ?? null,
      action,
      message,
      data_json: safeJson(data),
    };
    this.pushBuffer(event);
    this.writeStoreRow(event);
    this.writeConsole(event);
    return event;
  }

  /**
   * Returns recent buffered events.
   *
   * Requirement links: `FR-LAB-004` and `FR-ERR-003`.
   * The Setup UI uses this for a quick summary without reading or parsing the
   * canonical table on every render.
   *
   * @returns {Record<string, unknown>[]} Buffered diagnostic events.
   */
  getBufferedEvents() {
    return [...this.buffer];
  }

  /**
   * Clears the in-memory ring buffer.
   *
   * Requirement links: `FR-LAB-005` and `FR-ERR-003`.
   * This does not remove persisted schema rows; it only resets the short live
   * summary shown in the UI.
   */
  clearBuffer() {
    this.buffer = [];
  }

  /**
   * Decides whether an event should be recorded at the current level.
   *
   * @param {string} level Event severity.
   * @returns {boolean} True when the event should be kept.
   */
  shouldRecord(level) {
    if (!this.enabled && LEVEL_PRIORITY[level] > LEVEL_PRIORITY.warn) {
      return false;
    }
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this.level];
  }

  /**
   * Adds an event to the bounded in-memory ring buffer.
   *
   * @param {Record<string, unknown>} event Diagnostic event.
   */
  pushBuffer(event) {
    this.buffer.push(event);
    while (this.buffer.length > this.maxBufferEvents) {
      this.buffer.shift();
    }
  }

  /**
   * Writes one event into the canonical diagnostics table when enabled.
   *
   * @param {Record<string, unknown>} event Diagnostic event.
   */
  writeStoreRow(event) {
    if (!this.enabled || !this.store) {
      return;
    }
    try {
      this.store.addRow('diagnostic_events', event);
    } catch {
      // Diagnostic writes must never interrupt setup, gameplay, or export.
    }
  }

  /**
   * Mirrors diagnostics to the browser console when useful for live debugging.
   *
   * @param {Record<string, unknown>} event Diagnostic event.
   */
  writeConsole(event) {
    if (!this.consoleEnabled || (!this.enabled && event.level !== 'error' && event.level !== 'warn')) {
      return;
    }
    const method = event.level === 'error'
      ? 'error'
      : event.level === 'warn'
        ? 'warn'
        : 'debug';
    console[method]?.(`[${event.category}:${event.phase}:${event.action}] ${event.message}`, event);
  }
}

/**
 * Converts a level candidate into a supported severity.
 *
 * @param {unknown} level Candidate level.
 * @returns {'error' | 'warn' | 'info' | 'debug' | 'trace'} Normalized level.
 */
function normalizeLevel(level) {
  const candidate = String(level);
  return Object.hasOwn(LEVEL_PRIORITY, candidate) ? candidate : 'debug';
}

/**
 * Serializes diagnostic data without throwing.
 *
 * Requirement links: `FR-ERR-003` and `FR-DATA-001`.
 * Browser camera/WebGazer objects can contain circular references and native
 * handles, so diagnostics store a bounded JSON string rather than arbitrary
 * live objects.
 *
 * @param {unknown} value Candidate data.
 * @returns {string} JSON string safe for the diagnostics table.
 */
function safeJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === 'number' && !Number.isFinite(nestedValue)) {
        return String(nestedValue);
      }
      if (typeof nestedValue === 'function') {
        return '[function]';
      }
      if (nestedValue && typeof nestedValue === 'object') {
        if (seen.has(nestedValue)) {
          return '[circular]';
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  } catch (error) {
    return JSON.stringify({
      serialization_error: error instanceof Error ? error.message : String(error),
    });
  }
}
