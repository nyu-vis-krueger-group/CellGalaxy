/** Shared channel_info.json / channel_list.csv parsing. */

export const CHANNEL_COLOR_PALETTE = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 128, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 128, 0],
  [128, 0, 255],
  [0, 255, 128],
  [255, 0, 128],
];

export function colorsRgbEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) {
    return false;
  }
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Default color from logical channel_id (OME index); each channel gets a distinct palette slot. */
export function defaultChannelColor(channelId) {
  const id = Number(channelId);
  if (!Number.isFinite(id)) return CHANNEL_COLOR_PALETTE[0];
  const palette = CHANNEL_COLOR_PALETTE;
  return palette[((id % palette.length) + palette.length) % palette.length];
}

/** Prefer channel_id color; if already used by another selected channel, pick next free palette color. */
export function pickChannelColor(channelId, colorsByChannelId = {}) {
  const preferred = defaultChannelColor(channelId);
  const id = Number(channelId);
  const isTaken = (rgb) =>
    Object.entries(colorsByChannelId).some(
      ([cid, cur]) => Number(cid) !== id && colorsRgbEqual(cur, rgb),
    );
  if (!isTaken(preferred)) return preferred;
  for (const c of CHANNEL_COLOR_PALETTE) {
    if (!isTaken(c)) return c;
  }
  return preferred;
}

export function parseChannelInfoPayload(data) {
  const omeMap = {};
  const zarrMap = {};
  const names = {};
  const catalog = [];
  for (const ch of data?.channels || []) {
    const id = Number(ch?.id);
    if (!Number.isFinite(id)) continue;
    catalog.push({
      id,
      name: typeof ch?.name === "string" ? ch.name : `ch_${id}`,
      ome_c:
        ch?.ome_c != null && ch.ome_c !== "" && Number.isFinite(Number(ch.ome_c))
          ? Number(ch.ome_c)
          : id,
      zarr_c:
        ch?.zarr_c != null &&
        ch.zarr_c !== "" &&
        Number.isFinite(Number(ch.zarr_c)) &&
        Number(ch.zarr_c) >= 0
          ? Number(ch.zarr_c)
          : null,
    });
    names[id] = typeof ch?.name === "string" ? ch.name : "";
    const omeC =
      ch?.ome_c != null && ch.ome_c !== "" && Number.isFinite(Number(ch.ome_c))
        ? Number(ch.ome_c)
        : id;
    omeMap[id] = omeC;
    const zarrRaw = ch?.zarr_c ?? ch?.zarr_index;
    if (
      zarrRaw != null &&
      zarrRaw !== "" &&
      Number.isFinite(Number(zarrRaw)) &&
      Number(zarrRaw) >= 0
    ) {
      zarrMap[id] = Number(zarrRaw);
    }
  }
  return { omeMap, zarrMap, names, catalog };
}

export function parseChannelListCsvText(text) {
  const omeMap = {};
  const zarrMap = {};
  const names = {};
  const catalog = [];
  if (!text || typeof text !== "string") {
    return { omeMap, zarrMap, names, catalog };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { omeMap, zarrMap, names, catalog };

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idIdx = header.findIndex((h) => h === "channel_id" || h === "id");
  const nameIdx = header.findIndex(
    (h) => h === "channel_name" || h === "name" || h === "channel",
  );
  const zarrIdx = header.findIndex(
    (h) => h === "zarr_index" || h === "zarr_c" || h === "index_in_zarr",
  );
  if (idIdx < 0 || nameIdx < 0) return { omeMap, zarrMap, names, catalog };

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const id = Number(cols[idIdx]?.trim());
    if (!Number.isFinite(id)) continue;
    const name = (cols[nameIdx] || "").trim() || `ch_${id}`;
    let zarrC = null;
    if (zarrIdx >= 0) {
      const raw = (cols[zarrIdx] ?? "").trim();
      if (raw && !/^(na|nan|null|-)$/i.test(raw) && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
        zarrC = Number(raw);
      }
    } else {
      zarrC = id;
    }
    names[id] = name;
    omeMap[id] = id;
    catalog.push({ id, name, ome_c: id, zarr_c: zarrC });
    if (zarrC != null) zarrMap[id] = zarrC;
  }
  return { omeMap, zarrMap, names, catalog };
}

export async function fetchChannelInfoMaps(signal) {
  let parsed = null;
  try {
    const res = await fetch(`/public/channel_info.json?ts=${Date.now()}`, {
      cache: "no-store",
      signal,
    });
    if (res.ok) {
      parsed = parseChannelInfoPayload(await res.json());
      if (Object.keys(parsed.zarrMap).length > 0) {
        return parsed;
      }
    }
  } catch {
    /* try channel_list.csv fallback */
  }
  try {
    const csvRes = await fetch(`/public/channel_list.csv?ts=${Date.now()}`, {
      cache: "no-store",
      signal,
    });
    if (csvRes.ok) {
      const fromCsv = parseChannelListCsvText(await csvRes.text());
      if (Object.keys(fromCsv.zarrMap).length > 0) {
        return fromCsv;
      }
    }
  } catch {
    /* ignore */
  }
  return parsed;
}
