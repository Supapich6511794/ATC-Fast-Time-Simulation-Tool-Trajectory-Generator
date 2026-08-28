/**
 * A minimal Word (.docx) writer — enough of OOXML to save a report, and
 * nothing else.
 *
 * A .docx is a ZIP of XML parts. Four of them are all Word needs to open one:
 * the content-type map, the package relationships, the document body and its
 * (empty) relationships.
 * Written by hand here rather than pulled from a library because the web app
 * carries a deliberately short dependency list (leaflet, next, react) and this
 * is ~100 lines against a format that has not changed since 2007.
 *
 * The ZIP entries are STORED, not deflated: the reports are a few kilobytes,
 * and store-only keeps the writer free of a compression dependency. Every
 * byte is deterministic (fixed timestamp), so the output can be tested.
 */

const enc = new TextEncoder();

/** CRC-32 (IEEE), the checksum every ZIP entry carries. */
let CRC_TABLE: Uint32Array | null = null;
export function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** DOS date/time stamped on every entry: 2026-01-01 00:00, fixed so the same
 *  log always produces the same bytes. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/** The entries as a ZIP archive, stored (method 0). */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true); // compressed size
    lv.setUint32(22, e.data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, e.data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); // where this entry's local header sits
    cen.set(name, 46);
    central.push(cen);

    offset += local.length + e.data.length;
  }

  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Text as XML content — the five predefined entities. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  /** Point size (the XML wants half-points; this converts). */
  size?: number;
  /** Hex RGB without the "#". */
  color?: string;
}

export interface Run {
  text: string;
  style?: RunStyle;
}

/** One paragraph, optionally as several differently-styled runs. */
export function para(
  runs: string | Run[],
  opts: { style?: RunStyle; spaceAfterPt?: number; keepNext?: boolean } = {},
): string {
  const list = typeof runs === "string" ? [{ text: runs, style: opts.style }] : runs;
  const pPr =
    "<w:pPr>" +
    `<w:spacing w:after="${Math.round((opts.spaceAfterPt ?? 4) * 20)}"/>` +
    (opts.keepNext ? "<w:keepNext/>" : "") +
    "</w:pPr>";
  const body = list
    .map((r) => {
      const st = r.style ?? {};
      const rPr =
        "<w:rPr>" +
        (st.bold ? "<w:b/>" : "") +
        (st.italic ? "<w:i/>" : "") +
        (st.color ? `<w:color w:val="${st.color}"/>` : "") +
        (st.size ? `<w:sz w:val="${Math.round(st.size * 2)}"/>` : "") +
        "</w:rPr>";
      // xml:space="preserve" so leading/trailing spaces in a run survive.
      return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
    })
    .join("");
  return `<w:p>${pPr}${body}</w:p>`;
}

export interface TableCell {
  text: string;
  style?: RunStyle;
}

/**
 * A bordered table. `widths` are twentieths of a point (twips) and should sum
 * to the page's text width (`PAGE_WIDTH_TWIPS`).
 */
export function table(
  rows: TableCell[][],
  widths: number[],
  opts: { headerRow?: boolean } = {},
): string {
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="B0BEC5"/>`;
  const tblPr =
    '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("") +
    "</w:tblBorders></w:tblPr>";
  const grid = `<w:tblGrid>${widths
    .map((w) => `<w:gridCol w:w="${w}"/>`)
    .join("")}</w:tblGrid>`;
  const trs = rows
    .map((cells, i) => {
      const head = opts.headerRow === true && i === 0;
      const tcs = cells
        .map((c, j) => {
          const shade = head ? '<w:shd w:val="clear" w:fill="ECEFF1"/>' : "";
          const style = { size: 8.5, ...(c.style ?? {}), ...(head ? { bold: true } : {}) };
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${widths[j] ?? 1000}" w:type="dxa"/>${shade}</w:tcPr>` +
            para([{ text: c.text, style }], { spaceAfterPt: 0 }) +
            "</w:tc>"
          );
        })
        .join("");
      // A header row repeats when the table breaks across pages.
      const trPr = head ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      return `<w:tr>${trPr}${tcs}</w:tr>`;
    })
    .join("");
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

/** The document part declares no relationships of its own (no images, no
 *  hyperlinks, no styles part) — but strict OPC readers still look for the
 *  file, so it ships empty. */
const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

/** A4 portrait with 2 cm margins. */
const SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
  "</w:sectPr>";

/** Text width of that page, for sizing tables. */
export const PAGE_WIDTH_TWIPS = 9638;

/** The MIME type a .docx is served/saved as. */
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The finished .docx, from body XML built with `para`/`table`. */
export function buildDocx(bodyXml: string): Uint8Array {
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    // A body must not end on a table, so a trailing empty paragraph always
    // closes it out before the section properties.
    `<w:body>${bodyXml}${para("")}${SECT_PR}</w:body></w:document>`;
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(DOC_RELS) },
    { name: "word/document.xml", data: enc.encode(doc) },
  ]);
}
