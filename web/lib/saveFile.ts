/**
 * Hand a generated file to the browser.
 *
 * The trajectory exports are written by the API and fetched by URL; the run
 * reports are built in the browser and have no URL, so they are handed over as
 * a blob instead.
 */

/** Release the object URL well after the click has been serviced — the same
 *  grace period the trajectory downloads use. */
const REVOKE_AFTER_MS = 30000;

export function saveBlob(data: BlobPart, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** Save a binary file — an .xlsx workbook, say, which is a ZIP. */
export function saveBinaryFile(data: Uint8Array, name: string, mime: string): void {
  saveBlob(data, name, mime);
}

/** Save a UTF-8 text file (CSV and friends). */
export function saveTextFile(text: string, name: string): void {
  saveBlob(text, name, "text/csv;charset=utf-8");
}
