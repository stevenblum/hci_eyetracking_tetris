import {
  createEmptyTables,
  DICTIONARY_CODE_LOOKUP,
  DICTIONARIES,
  SCHEMA_VERSION,
  WEBGAZER_SAMPLING_INTERVAL_MS,
} from '../constants/schema.js';
import { nowIso } from '../utils/clock.js';
import { tableToCsv } from '../utils/csv.js';
import { rowArrayToObject, rowObjectToArray, validateSessionSchema } from './schemaValidation.js';

const DB_NAME = 'hci-eyetracking-tetris-mvp';
const STORE_NAME = 'sessions';
const BACKUP_KEY = 'latest';

const NUMERIC_CODE_FIELDS = {
  trials: [
    { source: 'condition', target: 'condition_code', dictionary: 'condition' },
    { source: 'trial_mode', target: 'trial_mode_code', dictionary: 'trial_mode' },
    { source: 'end_reason', target: 'end_reason_code', dictionary: 'end_reason' },
  ],
  trial_recordings: [
    { source: 'source', target: 'source_code', dictionary: 'recording_source' },
    { source: 'status', target: 'status_code', dictionary: 'recording_status' },
  ],
  pieces: [
    { source: 'piece_type', target: 'piece_type_code', dictionary: 'piece_type' },
  ],
  gaze_aoi_classifications: [
    { source: 'primary_aoi', target: 'primary_aoi_code', dictionary: 'aoi' },
    { source: 'matching_aois', target: 'matching_aoi_codes', dictionary: 'aoi', list: true },
  ],
  webgazer_runs: [
    { source: 'mode', target: 'mode_code', dictionary: 'webgazer_mode' },
    { source: 'status', target: 'status_code', dictionary: 'webgazer_run_status' },
    { source: 'calibration_mode', target: 'calibration_mode_code', dictionary: 'calibration_mode' },
  ],
  piece_state_events: [
    { source: 'piece_type', target: 'piece_type_code', dictionary: 'piece_type' },
    { source: 'event_source', target: 'event_source_code', dictionary: 'game_event_type' },
  ],
  game_events: [
    { source: 'event_type', target: 'event_type_code', dictionary: 'game_event_type' },
    { source: 'piece_type', target: 'piece_type_code', dictionary: 'piece_type' },
  ],
  aoi_snapshots: [
    { source: 'aoi', target: 'aoi_code', dictionary: 'aoi' },
    { source: 'source', target: 'source_code', dictionary: 'aoi_snapshot_source' },
  ],
  aoi_visits: [
    { source: 'aoi', target: 'aoi_code', dictionary: 'aoi' },
  ],
  piece_summaries: [
    { source: 'piece_type', target: 'piece_type_code', dictionary: 'piece_type' },
  ],
  trial_summaries: [
    { source: 'end_reason', target: 'end_reason_code', dictionary: 'end_reason' },
    { source: 'recording_status', target: 'recording_status_code', dictionary: 'recording_status' },
  ],
};

/**
 * Stores the current experiment session in canonical MVP tables.
 *
 * Requirement links: `FR-DATA-001` through `FR-DATA-011`,
 * `FR-LAB-002` through `FR-LAB-005`, and `FR-ERR-005`.
 * The data store owns schema order, IndexedDB backup, and export conversion so
 * gameplay, replay, and analysis modules cannot silently invent alternate row
 * shapes during rapid MVP refinement.
 */
export class SessionDataStore {
  /**
 * Creates a session store with empty canonical tables.
 *
 * Requirement links: `FR-DATA-001`, `FR-DATA-008`, and `FR-LAB-004`.
 * The constructor keeps media blobs in browser memory while the JSON session
 * remains table-only, matching the separate-media export behavior.
 *
 * @param {{participantId?: string, studyId?: string, appVersion?: string, userAgent?: string}} options Store metadata options.
   */
  constructor(options = {}) {
    this.session = SessionDataStore.createSession(options);
    this.mediaBlobs = new Map();
    this.mediaUrls = new Map();
  }

  /**
 * Builds a new canonical session object.
 *
 * Requirement links: `FR-EXP-002`, `FR-DATA-001`, `FR-DATA-003`,
 * `FR-DATA-006`, and `FR-DATA-007`.
 * This static factory is used by tests and import paths to enforce one
 * current schema regardless of how the session enters the app.
   *
   * @param {{participantId?: string, studyId?: string, appVersion?: string, userAgent?: string}} options Metadata options.
   * @returns {{session_id: string, tables: Record<string, {columns: string[], rows: unknown[][]}>}} Session object.
   */
  static createSession(options = {}) {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tables = createEmptyTables();
    const metadataRow = rowObjectToArray('metadata', {
      session_id: sessionId,
      participant_id: options.participantId ?? 'anonymous',
      study_id: options.studyId ?? 'tetris-eye-tracking-mvp',
      created_at: nowIso(),
      app_name: 'Tetris Eye Tracking MVP',
      app_version: options.appVersion ?? '0.1.0',
      schema_version: SCHEMA_VERSION,
      jspsych_version: '8.x',
      webgazer_source: 'jspsych_webgazer_extension',
      webgazer_sampling_interval_ms: WEBGAZER_SAMPLING_INTERVAL_MS,
      user_agent: options.userAgent ?? globalThis.navigator?.userAgent ?? 'test',
    });
    tables.metadata.rows.push(metadataRow);

    for (const [dictionaryName, entries] of Object.entries(DICTIONARIES)) {
      for (const [label, description] of Object.entries(entries)) {
        tables.dictionaries.rows.push(
          rowObjectToArray('dictionaries', {
            dictionary_name: dictionaryName,
            code: DICTIONARY_CODE_LOOKUP[dictionaryName][label],
            label,
            description,
          }),
        );
      }
    }

    return { session_id: sessionId, tables };
  }

  /**
 * Replaces the in-memory session after validating the current schema.
 *
 * Requirement links: `FR-REPLAY-001`, `FR-DATA-002`, and `FR-ERR-005`.
 * Import and IndexedDB recovery call this method so malformed data fails
 * before replay or analysis tries to consume incomplete tables.
   *
   * @param {{session_id: string, tables: Record<string, {columns: string[], rows: unknown[][]}>}} session Imported session.
   * @returns {{ok: boolean, errors: string[]}} Validation result.
   */
  replaceSession(session) {
    const validation = validateSessionSchema(session);
    if (validation.ok) {
      this.session = session;
    }
    return validation;
  }

  /**
 * Returns the current session object.
 *
 * Requirement links: `FR-DATA-001` and `FR-DATA-002`.
 * Callers receive the canonical table object directly because the MVP treats
 * JSON export as the exact in-memory schema, not a transformed copy.
 *
 * @returns {{session_id: string, tables: Record<string, {columns: string[], rows: unknown[][]}>}} Canonical session.
   */
  getSession() {
    return this.session;
  }

  /**
 * Adds an object row to a canonical table and returns the stored object.
 *
 * Requirement links: `FR-DATA-003`, `FR-DATA-006`, and `FR-DATA-007`.
 * Object input keeps call sites readable while the store preserves the compact
 * array representation required by the planning data spec.
   *
   * @param {string} tableName Canonical table name.
   * @param {Record<string, unknown>} row Named row values.
   * @returns {Record<string, unknown>} Stored row as an object.
   */
  addRow(tableName, row) {
    const table = this.session.tables[tableName];
    if (!table) {
      throw new Error(`Unknown canonical table: ${tableName}`);
    }
    table.rows.push(rowObjectToArray(tableName, addNumericCodes(tableName, row)));
    return this.getLastRow(tableName);
  }

  /**
 * Returns all rows in a table as named objects.
 *
 * Requirement links: `FR-REPLAY-001`, `FR-ANA-009`, and `FR-DATA-003`.
 * This conversion lets read-heavy UI and analysis code remain explicit about
 * column names while persisted rows stay compact.
 *
 * @param {string} tableName Canonical table name.
   * @returns {Record<string, unknown>[]} Rows converted to objects.
   */
  getRows(tableName) {
    const table = this.session.tables[tableName];
    if (!table) {
      throw new Error(`Unknown canonical table: ${tableName}`);
    }
    return table.rows.map((row) => rowArrayToObject(tableName, row));
  }

  /**
 * Returns the last row in a table as a named object.
 *
 * Requirement links: `FR-PERF-002` and `FR-AOI-007`.
 * Event adapters use this for the most recent state/AOI row without exposing
 * the underlying row-array structure.
 *
 * @param {string} tableName Canonical table name.
   * @returns {Record<string, unknown> | null} Last row or null.
   */
  getLastRow(tableName) {
    const rows = this.getRows(tableName);
    return rows.at(-1) ?? null;
  }

  /**
 * Updates the first row matching a predicate.
 *
 * Requirement links: `FR-DATA-003`, `FR-EXP-007`, and `FR-EXP-008`.
 * This gives adapter and analysis code a narrow mutation surface without
 * exposing table internals or encouraging ad hoc row shape changes.
   *
   * @param {string} tableName Canonical table name.
   * @param {(row: Record<string, unknown>) => boolean} predicate Row matcher.
   * @param {(row: Record<string, unknown>) => Record<string, unknown>} updater Row updater.
   * @returns {Record<string, unknown> | null} Updated row object when found.
   */
  updateFirst(tableName, predicate, updater) {
    const table = this.session.tables[tableName];
    const rows = this.getRows(tableName);
    const index = rows.findIndex(predicate);
    if (index === -1) {
      return null;
    }
    const updated = addNumericCodes(tableName, updater({ ...rows[index] }));
    table.rows[index] = rowObjectToArray(tableName, updated);
    return updated;
  }

  /**
 * Updates all rows matching a predicate.
 *
 * Requirement links: `FR-AOI-007`, `FR-AOI-010`, and `FR-PERF-002`.
 * AOI interval closing uses this method because multiple snapshots can remain
 * open for the same piece until a state transition creates the next interval.
   *
   * @param {string} tableName Canonical table name.
   * @param {(row: Record<string, unknown>) => boolean} predicate Row matcher.
   * @param {(row: Record<string, unknown>) => Record<string, unknown>} updater Row updater.
   * @returns {number} Number of updated rows.
   */
  updateAll(tableName, predicate, updater) {
    const table = this.session.tables[tableName];
    const rows = this.getRows(tableName);
    let changed = 0;
    rows.forEach((row, index) => {
      if (predicate(row)) {
        table.rows[index] = rowObjectToArray(tableName, addNumericCodes(tableName, updater({ ...row })));
        changed += 1;
      }
    });
    return changed;
  }

  /**
 * Starts a trial row in the canonical `trials` table.
 *
 * Requirement links: `FR-EXP-002`, `FR-EXP-003`, `FR-EXP-007`,
 * `FR-GAME-004`, `FR-EYE-005`, and `FR-DATA-001`.
 * The row records the configured condition at trial start so replay and
 * analysis can interpret AOIs even if UI controls change later.
 *
 * @param {{participantId?: string, condition?: string, trialMode?: string, levelStart?: number, durationLimitMs?: number, fallIntervalMs?: number, boardCols?: number, boardVisibleRows?: number, cellSizePx?: number, previewEnabled?: boolean, ghostEnabled?: boolean, gazeSamplingIntervalMs?: number, startedAt?: string}} options Trial metadata.
   * @returns {Record<string, unknown>} Created trial row.
   */
  startTrial(options = {}) {
    const trialId = `trial_${this.getRows('trials').length + 1}`;
    return this.addRow('trials', {
      trial_id: trialId,
      participant_id: options.participantId ?? this.getRows('metadata')[0].participant_id,
      started_at: options.startedAt ?? nowIso(),
      ended_at: null,
      duration_ms: 0,
      duration_limit_ms: options.durationLimitMs ?? null,
      condition: options.condition ?? 'keyboard_only',
      trial_mode: options.trialMode ?? 'main',
      level_start: options.levelStart ?? 0,
      fall_interval_ms: options.fallIntervalMs ?? null,
      board_cols: options.boardCols ?? null,
      board_visible_rows: options.boardVisibleRows ?? null,
      cell_size_px: options.cellSizePx ?? null,
      preview_enabled: options.previewEnabled ?? true,
      ghost_enabled: options.ghostEnabled ?? true,
      gaze_sampling_interval_ms: options.gazeSamplingIntervalMs ?? WEBGAZER_SAMPLING_INTERVAL_MS,
      end_reason: 'in_progress',
      score: 0,
      lines: 0,
      pieces_count: 0,
      recording_id: null,
    });
  }

  /**
 * Finishes a trial row with end-state metrics.
 *
 * Requirement links: `FR-EXP-005`, `FR-EXP-008`, `FR-ANA-001`,
 * and `FR-DATA-001`.
 * End reasons and summary counters are written once through the store so every
 * export table uses the same controlled trial outcome.
 *
 * @param {string} trialId Trial identifier.
   * @param {{durationMs: number, endReason: string, score: number, lines: number, piecesCount: number, recordingId?: string | null}} summary End-state values.
   * @returns {Record<string, unknown> | null} Updated trial row.
   */
  finishTrial(trialId, summary) {
    return this.updateFirst(
      'trials',
      (row) => row.trial_id === trialId,
      (row) => ({
        ...row,
        ended_at: nowIso(),
        duration_ms: summary.durationMs,
        end_reason: summary.endReason,
        score: summary.score,
        lines: summary.lines,
        pieces_count: summary.piecesCount,
        recording_id: summary.recordingId ?? row.recording_id,
      }),
    );
  }

  /**
 * Stores a media blob and creates a replay URL for the browser session.
 *
 * Requirement links: `FR-DATA-011`, `FR-REPLAY-003`, `FR-REPLAY-010`,
 * and `FR-PERF-004`.
 * Blobs are not embedded in JSON because pilots need readable tabular data
 * plus a separate `.webm` artifact for replay.
   *
   * @param {string} recordingId Recording identifier.
   * @param {Blob} blob Video blob.
   * @returns {string} Object URL for local replay.
   */
  setMediaBlob(recordingId, blob) {
    const existingUrl = this.mediaUrls.get(recordingId);
    if (existingUrl) {
      URL.revokeObjectURL(existingUrl);
    }
    this.mediaBlobs.set(recordingId, blob);
    const url = URL.createObjectURL(blob);
    this.mediaUrls.set(recordingId, url);
    return url;
  }

  /**
 * Retrieves a replay URL for a recording.
 *
 * Requirement links: `FR-REPLAY-001` and `FR-REPLAY-003`.
 * URLs are runtime-only object URLs, preserving the local-only schema contract.
 *
 * @param {string} recordingId Recording identifier.
   * @returns {string | null} Object URL when a blob is available.
   */
  getMediaUrl(recordingId) {
    return this.mediaUrls.get(recordingId) ?? null;
  }

  /**
 * Retrieves the raw media blob for export.
 *
 * Requirement links: `FR-DATA-011` and `FR-ANA-010`.
 * Media stays outside the JSON session but remains addressable by
 * `recording_id` for export and replay.
 *
 * @param {string} recordingId Recording identifier.
   * @returns {Blob | null} Video blob when available.
   */
  getMediaBlob(recordingId) {
    return this.mediaBlobs.get(recordingId) ?? null;
  }

  /**
 * Serializes the current session to formatted JSON.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-005`, and `FR-LAB-003`.
 * This returns the local browser session as-is, preserving raw gaze and event
 * rows without uploading or reformatting them.
 *
 * @returns {string} JSON export content.
   */
  toJson() {
    return JSON.stringify(this.session, null, 2);
  }

  /**
 * Builds CSV text for one canonical table.
 *
 * Requirement links: `FR-DATA-004` and `FR-ANA-010`.
 * The store is the only CSV entry point so exported headers always follow
 * `TABLE_SCHEMAS`.
 *
 * @param {string} tableName Canonical table name.
   * @returns {string} CSV content.
   */
  toCsv(tableName) {
    const table = this.session.tables[tableName];
    if (!table) {
      throw new Error(`Unknown canonical table: ${tableName}`);
    }
    return tableToCsv(table);
  }

  /**
 * Validates the current session against the current schema.
 *
 * Requirement links: `FR-DATA-001`, `FR-DATA-003`, and `FR-REPLAY-001`.
 * UI validation and import paths share this check before exposing data to
 * replay, analysis, or export.
 *
 * @returns {{ok: boolean, errors: string[]}} Validation result.
   */
  validate() {
    return validateSessionSchema(this.session);
  }

  /**
 * Writes the latest session backup to IndexedDB.
 *
 * Requirement links: `FR-DATA-008`, `FR-DATA-009`, and `FR-ERR-005`.
 * IndexedDB is a recovery convenience for lab pilots, not a versioned storage
 * contract; imports are still validated against the single current schema.
   *
   * @returns {Promise<void>} Resolves after persistence completes.
   */
  async saveBackup() {
    const db = await openDb();
    await idbPut(db, BACKUP_KEY, this.session);
  }

  /**
 * Recovers the latest IndexedDB backup into memory.
 *
 * Requirement links: `FR-DATA-008` and `FR-ERR-005`.
 * Recovery reuses `replaceSession` so stale or malformed local data cannot
 * silently enter replay or export views.
 *
 * @returns {Promise<null | {ok: boolean, errors: string[]}>} Null when no backup exists, otherwise validation result.
   */
  async recoverBackup() {
    const db = await openDb();
    const session = await idbGet(db, BACKUP_KEY);
    if (!session) {
      return null;
    }
    return this.replaceSession(session);
  }

  /**
 * Clears the latest IndexedDB backup.
 *
 * Requirement links: `FR-DATA-010` and `FR-LAB-005`.
 * Clearing only the backup matches the local-only pilot workflow while leaving
 * the active in-memory session available until the page is closed or replaced.
 *
 * @returns {Promise<void>} Resolves after backup deletion completes.
   */
  async clearBackup() {
    const db = await openDb();
    await idbDelete(db, BACKUP_KEY);
  }
}

/**
 * Adds numeric categorical codes to one row from the current dictionary map.
 *
 * Requirement links: `FR-DATA-006` and `FR-DATA-007`.
 * Call sites continue writing readable labels because that is easier to audit
 * during pilots. The store derives paired code columns at the schema boundary
 * so exports stay compact without letting each module choose its own coding.
 *
 * @param {string} tableName Canonical table name.
 * @param {Record<string, unknown>} row Row before schema serialization.
 * @returns {Record<string, unknown>} Row with any configured numeric code fields.
 */
function addNumericCodes(tableName, row) {
  const normalized = { ...row };
  for (const field of NUMERIC_CODE_FIELDS[tableName] ?? []) {
    if (field.list) {
      normalized[field.target] = JSON.stringify(
        toLabelList(normalized[field.source])
          .map((label) => lookupCode(field.dictionary, label))
          .filter((code) => code !== null),
      );
    } else {
      normalized[field.target] = lookupCode(field.dictionary, normalized[field.source]);
    }
  }
  return normalized;
}

/**
 * Looks up a one-based categorical code for a label.
 *
 * Requirement links: `FR-DATA-006` and `FR-DATA-007`.
 * Unknown or null values intentionally become `null` rather than inventing an
 * "other" code during MVP pilots; that makes missing dictionary coverage easy
 * to spot in exported rows.
 *
 * @param {string} dictionaryName Dictionary namespace.
 * @param {unknown} label Readable categorical value.
 * @returns {number | null} Numeric dictionary code when known.
 */
function lookupCode(dictionaryName, label) {
  if (label === null || label === undefined) {
    return null;
  }
  return DICTIONARY_CODE_LOOKUP[dictionaryName]?.[String(label)] ?? null;
}

/**
 * Parses a list-valued label field.
 *
 * Requirement links: `FR-AOI-009`, `FR-DATA-006`, and `FR-DATA-007`.
 * AOI overlap fields are stored as JSON strings to keep table cells scalar, so
 * code derivation accepts either the raw array from tests or the serialized
 * form used by analysis rows.
 *
 * @param {unknown} value Possible array or JSON array string.
 * @returns {string[]} Label list.
 */
function toLabelList(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Opens the application IndexedDB database.
 *
 * Requirement links: `FR-DATA-008`, `FR-DATA-009`, and `FR-ERR-005`.
 * The wrapper keeps IndexedDB ceremony out of `SessionDataStore` methods and
 * uses a single object store because MVP backup only needs the latest session.
 *
 * @returns {Promise<IDBDatabase>} Open database handle.
 */
function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is unavailable in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Writes a value into the session backup object store.
 *
 * Requirement links: `FR-DATA-008` and `FR-ERR-005`.
 * This helper intentionally stores one current backup key instead of a history
 * of sessions to keep local pilot recovery simple.
 *
 * @param {IDBDatabase} db Database handle.
 * @param {string} key Backup key.
 * @param {unknown} value Value to store.
 * @returns {Promise<void>} Resolves after transaction completes.
 */
function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Reads a value from the session backup object store.
 *
 * Requirement links: `FR-DATA-008` and `FR-ERR-005`.
 * Reads return the raw stored value so schema validation remains centralized in
 * `recoverBackup`.
 *
 * @param {IDBDatabase} db Database handle.
 * @param {string} key Backup key.
 * @returns {Promise<unknown>} Stored value or undefined.
 */
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Deletes a value from the session backup object store.
 *
 * Requirement links: `FR-DATA-010` and `FR-LAB-005`.
 * Deleting by key keeps the local-data clear path scoped to the MVP backup
 * store without touching unrelated browser storage.
 *
 * @param {IDBDatabase} db Database handle.
 * @param {string} key Backup key.
 * @returns {Promise<void>} Resolves after transaction completes.
 */
function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
