/**
 * Returns an ISO timestamp for persisted session metadata.
 *
 * Requirement links: `FR-DATA-001`, `FR-EXP-007`, and `FR-LAB-004`.
 * A helper keeps timestamp formatting consistent across data rows and tests
 * while still using the browser clock expected in lab sessions.
 *
 * @returns {string} Current timestamp in ISO 8601 format.
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Returns a monotonic browser timestamp for trial-relative timing.
 *
 * Requirement links: `FR-EYE-006`, `FR-REPLAY-009`, and `FR-HCI-002`.
 * The app stores trial-relative milliseconds instead of wall-clock offsets for
 * gaze, AOI, game, and replay alignment because MediaRecorder video timelines
 * are relative to capture start rather than calendar time.
 *
 * @returns {number} Monotonic time in milliseconds.
 */
export function nowMs() {
  return performance.now();
}

/**
 * Converts a monotonic timestamp into trial-relative milliseconds.
 *
 * Requirement links: `FR-EYE-006`, `FR-REPLAY-009`, and `FR-PERF-005`.
 * Rounding happens at the timing boundary so high-rate gaze and game-event rows
 * share compact integer timestamps for later synchronization.
 *
 * @param {number} startMs Trial start timestamp from `performance.now()`.
 * @param {number} currentMs Current monotonic timestamp.
 * @returns {number} Rounded milliseconds since trial start.
 */
export function trialTime(startMs, currentMs = nowMs()) {
  return Math.max(0, Math.round(currentMs - startMs));
}

/**
 * Converts an optional piece spawn time into piece-relative milliseconds.
 *
 * Requirement links: `FR-EYE-006`, `FR-HCI-001`, and `FR-HCI-002`.
 * Missing piece context is represented as `null` because gaze may be collected
 * before the first piece exists or after the game is stopped.
 *
 * @param {number | null | undefined} spawnTTrialMs Piece spawn time in trial milliseconds.
 * @param {number} tTrialMs Current trial-relative time.
 * @returns {number | null} Piece-relative time or `null` when no piece is active.
 */
export function pieceTime(spawnTTrialMs, tTrialMs) {
  if (spawnTTrialMs === null || spawnTTrialMs === undefined) {
    return null;
  }
  return Math.max(0, Math.round(tTrialMs - spawnTTrialMs));
}
