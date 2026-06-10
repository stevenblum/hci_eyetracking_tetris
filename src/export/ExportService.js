import { TABLE_SCHEMAS } from '../constants/schema.js';
import { downloadFile } from '../utils/download.js';

const CSV_TABLES = [
  'trial_recordings',
  'webgazer_runs',
  'diagnostic_events',
  'post_trial_responses',
  'pieces',
  'gaze_aoi_classifications',
  'aoi_visits',
  'piece_indexes',
  'piece_summaries',
  'trial_summaries',
];

/**
 * Prepares JSON, CSV, and media exports for the current session.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-004`, `FR-DATA-011`,
 * `FR-ANA-010`, `FR-LAB-002`, and `FR-LAB-003`.
 * The service is intentionally thin: it asks `SessionDataStore` for canonical
 * representations and avoids creating alternate schema-specific export models.
 */
export class ExportService {
  /**
 * Creates an export service.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-004`, and `FR-DATA-011`.
 * The service receives the current store so exports always reflect local
 * browser state and never reach for a backend.
 *
 * @param {import('../data/SessionDataStore.js').SessionDataStore} store Canonical data store.
   */
  constructor(store) {
    this.store = store;
  }

  /**
 * Builds all export artifacts without triggering downloads.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-004`, `FR-DATA-011`,
 * and `FR-ANA-010`.
 * Tests use this method to verify export assembly separately from browser
 * download behavior.
 *
 * @returns {{json: string, csv: Record<string, string>, media: {recordingId: string, fileName: string, blob: Blob}[]}} Export artifacts.
   */
  buildArtifacts() {
    const media = this.store.getRows('trial_recordings')
      .map((recording) => ({
        recordingId: recording.recording_id,
        fileName: recording.file_name,
        blob: this.store.getMediaBlob(recording.recording_id),
      }))
      .filter((recording) => recording.blob);
    return {
      json: this.store.toJson(),
      csv: Object.fromEntries(CSV_TABLES.map((tableName) => [tableName, this.store.toCsv(tableName)])),
      media,
    };
  }

  /**
 * Downloads the canonical JSON session file.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-005`, and `FR-ERR-004`.
 * The full session export is the master artifact and preserves raw gaze rows
 * for later reanalysis.
 *
 * @returns {HTMLAnchorElement} Download anchor.
   */
  downloadJson() {
    return downloadFile(
      this.store.toJson(),
      `${this.store.session.session_id}.json`,
      'application/json',
    );
  }

  /**
 * Downloads a selected canonical CSV table.
 *
 * Requirement links: `FR-DATA-004`, `FR-ANA-010`, and `FR-ERR-004`.
 * Unknown table names fail early so UI bugs cannot create unlabeled CSV files
 * outside the current schema.
 *
 * @param {string} tableName Canonical table name.
   * @returns {HTMLAnchorElement} Download anchor.
   */
  downloadCsv(tableName) {
    if (!TABLE_SCHEMAS[tableName]) {
      throw new Error(`Unknown table: ${tableName}`);
    }
    return downloadFile(
      this.store.toCsv(tableName),
      `${this.store.session.session_id}_${tableName}.csv`,
      'text/csv',
    );
  }

  /**
 * Downloads a recorded trial video.
 *
 * Requirement links: `FR-DATA-011`, `FR-REPLAY-003`, and `FR-ERR-004`.
 * Media export is keyed by `recording_id`, matching the JSON reference instead
 * of relying on playback object URLs.
 *
 * @param {string} recordingId Recording identifier.
   * @returns {HTMLAnchorElement | null} Download anchor or null when no blob exists.
   */
  downloadRecording(recordingId) {
    const row = this.store.getRows('trial_recordings').find((recording) => recording.recording_id === recordingId);
    const blob = row ? this.store.getMediaBlob(recordingId) : null;
    if (!row || !blob) {
      return null;
    }
    return downloadFile(blob, row.file_name, row.mime_type);
  }
}
