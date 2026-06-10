/**
 * Escapes a value for a standards-compatible CSV field.
 *
 * Requirement links: `FR-DATA-004`, `FR-ANA-010`, and `FR-DATA-003`.
 * The exporter keeps arrays and objects as JSON strings so the canonical table
 * model can remain simple while still preserving details fields.
 *
 * @param {unknown} value Cell value from a canonical table row.
 * @returns {string} CSV-safe text.
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/u.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/**
 * Converts a canonical table to CSV text.
 *
 * Requirement links: `FR-DATA-004` and `FR-ANA-010`.
 * CSV export is intentionally table-oriented instead of relationally rich
 * because researchers can open the MVP output directly in spreadsheet and
 * statistics tools during pilot validation.
 *
 * @param {{columns: string[], rows: unknown[][]}} table Canonical table object.
 * @returns {string} CSV content with a header row.
 */
export function tableToCsv(table) {
  const lines = [
    table.columns.map(escapeCsvCell).join(','),
    ...table.rows.map((row) => row.map(escapeCsvCell).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}
