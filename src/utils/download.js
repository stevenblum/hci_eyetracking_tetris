/**
 * Starts a browser download for generated JSON, CSV, or media output.
 *
 * Requirement links: `FR-DATA-002`, `FR-DATA-004`, `FR-DATA-011`,
 * and `FR-ERR-004`.
 * The function is isolated from export assembly so automated tests can verify
 * data generation without requiring DOM download behavior.
 *
 * @param {Blob | string} content Blob or string content to save.
 * @param {string} fileName Suggested file name.
 * @param {string} mimeType MIME type used when content is a string.
 * @returns {HTMLAnchorElement} Anchor used to trigger the download.
 */
export function downloadFile(content, fileName, mimeType = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
  return anchor;
}
