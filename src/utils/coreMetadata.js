/** Minimal CSV line parser (handles quoted fields). */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse CORE_ID metadata directly from raw.csv text. */
export function parseCoreMetadataCsv(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  if (headers[0] !== "CORE_ID" || headers[1] !== "global_X" || headers[2] !== "global_Y") {
    return [];
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 3) continue;
    const gx = Number(cols[1]);
    const gy = Number(cols[2]);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
    const id = Number(cols[0]);
    const values = {};
    for (let j = 3; j < headers.length; j++) {
      values[headers[j]] = cols[j] ?? "";
    }
    rows.push({
      id: Number.isFinite(id) ? id : i,
      x: gx,
      y: gy,
      values,
    });
  }
  return rows;
}

/** Parse CORE_ID / global_X / global_Y metadata rows from raw.json. */
export function parseCoreMetadataRows(rawData) {
  if (!Array.isArray(rawData) || rawData.length < 2) return [];
  const header = rawData[0];
  const schema = header?.schema;
  const isCore =
    header?.coreMetadata === true ||
    (Array.isArray(schema) &&
      schema.length >= 2 &&
      (schema[0]?.rawName === "global_X" || schema[0]?.name === "global_X"));
  if (!isCore) return [];

  const rows = [];
  for (let i = 1; i < rawData.length; i++) {
    const item = rawData[i];
    const raw = item?.raw;
    if (!raw || typeof raw !== "object") continue;
    const gx = Number(raw.global_X);
    const gy = Number(raw.global_Y);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
    rows.push({
      id: item.id ?? i - 1,
      x: gx,
      y: gy,
      values: { ...raw },
    });
  }
  return rows;
}

/**
 * Map raw.csv global_X/Y into OME image pixel space when coords exceed image bounds.
 */
export function fitCoreMetadataTransform(rows, imageWidth, imageHeight) {
  if (
    !rows?.length ||
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return (x, y) => ({ x, y });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const row of rows) {
    const x = Number(row.x);
    const y = Number(row.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(maxX) || maxX <= 0 || !Number.isFinite(maxY) || maxY <= 0) {
    return (x, y) => ({ x, y });
  }

  const margin = 0.04;
  const fitsX = maxX <= imageWidth * (1 + margin) && minX >= -imageWidth * margin;
  const fitsY = maxY <= imageHeight * (1 + margin) && minY >= -imageHeight * margin;
  if (fitsX && fitsY) {
    return (x, y) => ({ x, y });
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const targetW = imageWidth * (1 - 2 * margin);
  const targetH = imageHeight * (1 - 2 * margin);
  const scale = Math.min(targetW / spanX, targetH / spanY);
  const offsetX = imageWidth * margin - minX * scale;
  const offsetY = imageHeight * margin - minY * scale;

  return (x, y) => ({
    x: x * scale + offsetX,
    y: y * scale + offsetY,
  });
}

export function buildCoreMetadataWorldItems({
  rows = [],
  selectedFields = [],
  imageWidth = null,
  imageHeight = null,
  pixelYFlipHeight = null,
}) {
  if (!rows.length || !selectedFields.length) return [];
  const mapCoord = fitCoreMetadataTransform(rows, imageWidth, imageHeight);

  return rows
    .map((row) => {
      const lines = selectedFields
        .map((field) => {
          const v = row.values?.[field];
          if (v == null || v === "") return null;
          return String(v);
        })
        .filter(Boolean);
      if (!lines.length) return null;

      const { x, y } = mapCoord(Number(row.x), Number(row.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      const wy =
        pixelYFlipHeight != null && Number.isFinite(pixelYFlipHeight)
          ? pixelYFlipHeight - y
          : y;

      return {
        id: row.id,
        x,
        y,
        wy,
        z: 0,
        lines,
        text: lines.join("\n"),
        position: [x, wy, 0],
      };
    })
    .filter(Boolean);
}

/** Try multiple URLs until core metadata rows are loaded. */
export async function fetchCoreMetadataRows(apiBase = "") {
  const urls = [
    "/upload/status",
    `${apiBase}/upload/status`,
    "/public/raw.csv",
    `${apiBase}/public/raw.csv`,
    "/core_metadata",
    `${apiBase}/core_metadata`,
    "/public/raw.json",
    `${apiBase}/public/raw.json`,
    "/raw.json",
  ].filter((u, i, arr) => u && arr.indexOf(u) === i);

  for (const url of urls) {
    try {
      const res = await fetch(`${url}?ts=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) continue;

      if (url.includes("/upload/status")) {
        const status = await res.json();
        const rows = status?.core_metadata?.rows;
        if (Array.isArray(rows) && rows.length > 0) return rows;
        continue;
      }

      if (url.includes(".csv")) {
        const text = await res.text();
        const rows = parseCoreMetadataCsv(text);
        if (rows.length > 0) return rows;
        continue;
      }

      const data = await res.json();
      if (Array.isArray(data?.rows) && data.rows.length > 0) return data.rows;
      if (Array.isArray(data)) {
        const rows = parseCoreMetadataRows(data);
        if (rows.length > 0) return rows;
      }
    } catch {
      /* try next */
    }
  }
  return [];
}
