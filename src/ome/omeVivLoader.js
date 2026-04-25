/** OME-TIFF via @vivjs/loaders loadOmeTiff (geotiff.js); no cogeotiff / virtual zarr. */
import { loadOmeTiff } from "@vivjs/loaders";
import { Matrix4 } from "math.gl";
import { assert, MAX_CHANNELS } from "./omeTiffUtils.js";

export { MAX_CHANNELS };

function defaultContrastForPixelType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "uint8") return [0, 255];
  if (t === "uint16" || t === "int16") return [0, 65535];
  if (t === "uint32" || t === "int32") return [0, 65535];
  if (t === "float" || t === "double") return [0, 1];
  return [0, 65535];
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeRange(dataMin, dataMax, autoMin, autoMax, fallbackLo, fallbackHi) {
  const lo0 = Number.isFinite(dataMin) ? dataMin : fallbackLo;
  const hi0 = Number.isFinite(dataMax) ? dataMax : fallbackHi;
  const lo = Math.min(lo0, hi0);
  const hi = Math.max(lo0, hi0);
  const aLo0 = Number.isFinite(autoMin) ? autoMin : lo;
  const aHi0 = Number.isFinite(autoMax) ? autoMax : hi;
  const aLo = Math.min(aLo0, aHi0);
  const aHi = Math.max(aLo0, aHi0);
  return { dataMin: lo, dataMax: hi, autoMin: aLo, autoMax: aHi };
}

function readChannelRangeFromOmeMetadata(channel, fallbackLo, fallbackHi) {
  if (!channel || typeof channel !== "object") {
    return normalizeRange(undefined, undefined, undefined, undefined, fallbackLo, fallbackHi);
  }
  const windowObj = channel.Window && typeof channel.Window === "object" ? channel.Window : null;
  const dataMin = firstFinite(
    channel.Min,
    channel.min,
    channel.data_min,
    channel.dataMin,
    windowObj?.Min,
    windowObj?.Start,
    windowObj?.min,
    windowObj?.start,
  );
  const dataMax = firstFinite(
    channel.Max,
    channel.max,
    channel.data_max,
    channel.dataMax,
    windowObj?.Max,
    windowObj?.End,
    windowObj?.max,
    windowObj?.end,
  );
  const autoMin = firstFinite(
    channel.auto_min,
    channel.autoMin,
    channel.WindowStart,
    channel.window_start,
    windowObj?.Start,
    windowObj?.start,
  );
  const autoMax = firstFinite(
    channel.auto_max,
    channel.autoMax,
    channel.WindowEnd,
    channel.window_end,
    windowObj?.End,
    windowObj?.end,
  );
  return normalizeRange(dataMin, dataMax, autoMin, autoMax, fallbackLo, fallbackHi);
}

function percentileFromSorted(sorted, p01) {
  if (!Array.isArray(sorted) || sorted.length === 0) return undefined;
  const p = Math.max(0, Math.min(1, p01));
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function computeRangeFromNumericArray(values) {
  if (!values || typeof values.length !== "number" || values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  const sample = [];
  const stride = Math.max(1, Math.floor(values.length / 50000));
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    if (i % stride === 0) sample.push(v);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  sample.sort((a, b) => a - b);
  const autoMin = percentileFromSorted(sample, 0.01);
  const autoMax = percentileFromSorted(sample, 0.99);
  return normalizeRange(min, max, autoMin, autoMax, min, max);
}

async function readChannelRangeFromPixels(loader, labels, channelIndex) {
  try {
    if (!Array.isArray(loader) || loader.length === 0) return null;
    const source = loader[loader.length - 1] || loader[0];
    if (!source || typeof source.getRaster !== "function") return null;
    const hasLabel = (name) => Array.isArray(labels) && labels.includes(name);
    const sel = {};
    if (hasLabel("t")) sel.t = 0;
    if (hasLabel("c")) sel.c = channelIndex;
    if (hasLabel("z")) sel.z = 0;
    let raster = null;
    try {
      raster = await source.getRaster({ selection: sel });
    } catch {
      raster = null;
    }
    if (!raster) return null;
    const values = ArrayBuffer.isView(raster)
      ? raster
      : ArrayBuffer.isView(raster?.data)
        ? raster.data
        : null;
    return computeRangeFromNumericArray(values);
  } catch {
    return null;
  }
}

function rgbaToHex(rgba) {
  if (!rgba || rgba.length < 3) return "#ffffff";
  const [r, g, b] = rgba;
  const clamp = (v) => Math.max(0, Math.min(255, Number(v) | 0));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

async function mapVivOmeImageToSource(ome) {
  const loader = ome?.data;
  assert(loader?.length, "OME-TIFF: no pyramid levels");
  const labels = loader[0].labels;
  const pixels = ome.metadata?.Pixels;
  const sizeC =
    pixels?.SizeC ??
    (labels.includes("c") ? loader[0].shape[labels.indexOf("c")] : 1);
  const channels = pixels?.Channels || [];
  const pxType = pixels?.Type || "uint16";
  const [lo, hi] = defaultContrastForPixelType(pxType);

  const names = [];
  const colors = [];
  const contrast_limits = [];
  const channelRanges = [];
  const visibilities = [];
  for (let i = 0; i < sizeC; i++) {
    const ch = channels[i];
    const range = readChannelRangeFromOmeMetadata(ch, lo, hi);
    names.push(ch?.Name || ch?.ID || `channel_${i}`);
    const rgba = ch?.Color;
    colors.push(rgba && rgba.length >= 3 ? rgbaToHex(rgba) : "#ffffff");
    contrast_limits.push([range.autoMin, range.autoMax]);
    channelRanges.push(range);
    visibilities.push(true);
  }
  const ix = (name) => labels.indexOf(name);
  const imageWidth = loader[0].shape[ix("x")];
  const imageHeight = loader[0].shape[ix("y")];

  // Pixels / CSV raw: y down; Viv default vs deck ortho y up → flip Y.
  // translate(0,h,0)*scale(1,-1,1) aligns image to scatterplot pixel coords.
  const modelMatrix = new Matrix4().translate([0, imageHeight, 0]).scale([1, -1, 1]);

  return {
    pixelBackend: "viv-tiff",
    loader,
    labels,
    modelMatrix,
    names,
    colors,
    contrast_limits,
    channelRanges,
    visibilities,
    channel_axis: ix("c"),
    defaultT: 0,
    defaultZ: 0,
    imageWidth,
    imageHeight,
  };
}

/** Remote URL (same-origin /public/...) */
export async function openOmeTiffAsPixelSources(absoluteUrl) {
  const ome = await loadOmeTiff(absoluteUrl);
  return await mapVivOmeImageToSource(ome);
}

/** Local browser File */
export async function openOmeTiffFromFile(file) {
  const ome = await loadOmeTiff(file);
  return await mapVivOmeImageToSource(ome);
}

export async function computeOmeChannelRangeFromPixels(source, omeChannelIndex) {
  const idx = Number(omeChannelIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;
  const computed = await readChannelRangeFromPixels(source?.loader, source?.labels, idx);
  return computed || null;
}

function hexToRGB(hex) {
  let h = String(hex || "").replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [255, 255, 255];
  return [r, g, b];
}

/** MultiscaleImageLayer props: loader = TiffPixelSource[]; selection { t, c, z } per @vivjs/loaders. */
export function buildMultiscaleImageLayerProps(source, ui) {
  const {
    loader,
    labels,
    pixelBackend,
    defaultT = 0,
    defaultZ = 0,
    modelMatrix,
    channelRanges = [],
  } = source;
  const { channels, colors, windows, alphas, channelOmeIndexById } = ui;

  const selections = [];
  const contrastLimits = [];
  const contrastLimitsRange = [];
  const vivColors = [];
  const channelsVisible = [];

  const map = channelOmeIndexById && typeof channelOmeIndexById === "object" ? channelOmeIndexById : {};
  const maxViv = Math.min(MAX_CHANNELS, channels.length);
  for (let i = 0; i < maxViv; i++) {
    const chIdx = Number(channels[i]);
    if (!Number.isFinite(chIdx)) continue;
    let selectedOmeC = null;

    if (pixelBackend === "viv-tiff" && labels) {
      const sel = {};
      const cForOme = Object.prototype.hasOwnProperty.call(map, chIdx)
        ? Number(map[chIdx])
        : chIdx;
      if (!Number.isFinite(cForOme)) continue;
      selectedOmeC = cForOme;
      if (labels.includes("t")) sel.t = defaultT;
      if (labels.includes("c")) sel.c = cForOme;
      if (labels.includes("z")) sel.z = defaultZ;
      selections.push(sel);
    } else {
      throw new Error("Unsupported OME loader backend");
    }

    const w = windows?.[chIdx];
    const cRange =
      Number.isFinite(selectedOmeC) &&
      channelRanges[selectedOmeC]
        ? channelRanges[selectedOmeC]
        : null;
    const wMin = w && Number.isFinite(w.min)
      ? w.min
      : Number.isFinite(cRange?.autoMin)
        ? cRange.autoMin
        : 0;
    const wMax = w && Number.isFinite(w.max)
      ? w.max
      : Number.isFinite(cRange?.autoMax)
        ? cRange.autoMax
        : 65535;
    contrastLimits.push([wMin, wMax]);
    const rMin = Number.isFinite(cRange?.dataMin) ? cRange.dataMin : wMin;
    const rMax = Number.isFinite(cRange?.dataMax) ? cRange.dataMax : wMax;
    contrastLimitsRange.push([Math.min(rMin, rMax), Math.max(rMin, rMax)]);

    const rgb = colors?.[chIdx] || [255, 255, 255];
    vivColors.push([rgb[0], rgb[1], rgb[2]]);

    const a = alphas?.[chIdx];
    channelsVisible.push(a == null || a > 0.01);
  }

  if (selections.length === 0) {
    return null;
  }

  const opacity =
    channels.length > 0
      ? Math.min(
          1,
          Math.max(
            0,
            channels.reduce((s, ch) => s + (alphas?.[ch] ?? 1), 0) / channels.length,
          ),
        )
      : 1;

  return {
    id: "ome-tiff-multiscale",
    loader,
    selections,
    colors: vivColors,
    contrastLimits,
    contrastLimitsRange,
    channelsVisible,
    opacity,
    colormap: "",
    modelMatrix,
  };
}

export { hexToRGB };
