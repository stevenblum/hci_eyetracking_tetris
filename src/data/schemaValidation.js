import { REQUIRED_TABLES, TABLE_SCHEMAS } from '../constants/schema.js';

/**
 * Validates the canonical session table structure.
 *
 * Requirement links: `FR-DATA-001`, `FR-DATA-002`, `FR-DATA-003`,
 * `FR-REPLAY-001`, and `FR-ERR-005`.
 * This helper rejects drift from the current schema early so the MVP does not
 * grow multiple implicit standards across export, replay, and analysis code.
 *
 * @param {{tables: Record<string, {columns: string[], rows: unknown[][]}>}} session Session object to validate.
 * @returns {{ok: boolean, errors: string[]}} Validation result.
 */
export function validateSessionSchema(session) {
  const errors = [];
  if (!session || typeof session !== 'object' || !session.tables) {
    return { ok: false, errors: ['Session is missing a tables object.'] };
  }

  for (const tableName of REQUIRED_TABLES) {
    const table = session.tables[tableName];
    const expectedColumns = TABLE_SCHEMAS[tableName];
    if (!table) {
      errors.push(`Missing required table: ${tableName}`);
      continue;
    }
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      errors.push(`Table ${tableName} must have columns and rows arrays.`);
      continue;
    }
    if (table.columns.join('|') !== expectedColumns.join('|')) {
      errors.push(`Table ${tableName} columns do not match the current schema.`);
    }
    table.rows.forEach((row, index) => {
      if (!Array.isArray(row)) {
        errors.push(`Table ${tableName} row ${index} is not an array.`);
      } else if (row.length !== expectedColumns.length) {
        errors.push(
          `Table ${tableName} row ${index} has ${row.length} cells, expected ${expectedColumns.length}.`,
        );
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Converts an object row into the canonical column order for a table.
 *
 * Requirement links: `FR-DATA-003`, `FR-DATA-006`, and `FR-DATA-007`.
 * Table rows are stored as arrays to keep exports compact, but most application
 * code produces named objects for readability and reduced column-order errors.
 *
 * @param {string} tableName Canonical table name.
 * @param {Record<string, unknown>} row Object keyed by column name.
 * @returns {unknown[]} Row array in schema order.
 */
export function rowObjectToArray(tableName, row) {
  const columns = TABLE_SCHEMAS[tableName];
  if (!columns) {
    throw new Error(`Unknown canonical table: ${tableName}`);
  }
  return columns.map((column) => row[column] ?? null);
}

/**
 * Converts a canonical row array into an object keyed by column name.
 *
 * Requirement links: `FR-DATA-003`, `FR-REPLAY-001`, and `FR-ANA-009`.
 * Analysis and replay logic use this helper to keep schema references explicit
 * while preserving the compact array representation in persisted data.
 *
 * @param {string} tableName Canonical table name.
 * @param {unknown[]} row Row array in schema order.
 * @returns {Record<string, unknown>} Object keyed by column name.
 */
export function rowArrayToObject(tableName, row) {
  const columns = TABLE_SCHEMAS[tableName];
  if (!columns) {
    throw new Error(`Unknown canonical table: ${tableName}`);
  }
  return Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]));
}
