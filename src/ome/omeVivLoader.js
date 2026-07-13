/** OME-TIFF via @vivjs/loaders loadOmeTiff (geotiff.js); no cogeotiff / virtual zarr. */
import { loadOmeTiff } from "@vivjs/loaders";
import { Matrix4 } from "math.gl";
import { assert, MAX_CHANNELS } from "./omeTiffUtils.js";
import {
  scaleRgbByToneGain,
  resolveChannelRawWindow,
  readOmePixelRange,
  firstFinite,
  normalizeIntensityRange,
  computeRangeFromNumericArray,
} from "../utils/intensityWindow.js";
import { rgbaToHex } from "../utils/color.js";

export { MAX_CHANNELS };

function defaultContrastForPixelType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "uint8") return [0, 255];
  if (t === "uint16" || t === "int16") return [0, 65535];
  if (t === "uint32" || t === "int32") return [0, 65535];
  if (t === "float" || t === "double") return [0, 1];
  return [0, 65535];
}

function readChannelRangeFromOmeMetadata(channel, fallbackLo, fallbackHi) {
  if (!channel || typeof channel !== "object") {
    return normalizeIntensityRange(undefined, undefined, undefined, undefined, fallbackLo, fallbackHi);
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
  return normalizeIntensityRange(dataMin, dataMax, autoMin, autoMax, fallbackLo, fallbackHi);
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

/** Dedupe concurrent / Strict-Mode double mounts (Viewer + DataLoader share one decode). */
const _omeSourceByUrl = new Map();
const _omeSourceByFile = new WeakMap();

/** Remote URL (same-origin /public/...) */
export async function openOmeTiffAsPixelSources(absoluteUrl) {
  const key = String(absoluteUrl || "");
  if (!key) throw new Error("OME-TIFF: empty URL");
  let pending = _omeSourceByUrl.get(key);
  if (!pending) {
    pending = loadOmeTiff(absoluteUrl)
      .then((ome) => mapVivOmeImageToSource(ome))
      .catch((err) => {
        _omeSourceByUrl.delete(key);
        throw err;
      });
    _omeSourceByUrl.set(key, pending);
  }
  return pending;
}

/** Local browser File */
export async function openOmeTiffFromFile(file) {
  if (!file) throw new Error("OME-TIFF: empty file");
  let pending = _omeSourceByFile.get(file);
  if (!pending) {
    pending = loadOmeTiff(file)
      .then((ome) => mapVivOmeImageToSource(ome))
      .catch((err) => {
        _omeSourceByFile.delete(file);
        throw err;
      });
    _omeSourceByFile.set(file, pending);
  }
  return pending;
}

export async function computeOmeChannelRangeFromPixels(source, omeChannelIndex) {
  const idx = Number(omeChannelIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;
  const computed = await readChannelRangeFromPixels(source?.loader, source?.labels, idx);
  return computed || null;
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
  const {
    channels,
    colors,
    windows,
    alphas,
    channelOmeIndexById,
    omePixelRangeByChannelId = {},
  } = ui;

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

    // Shared OME range (same as Zarr/UMAP). If map not ready yet, use loader metadata.
    const omeRange = readOmePixelRange(omePixelRangeByChannelId?.[chIdx]);
    const cRange =
      Number.isFinite(selectedOmeC) && channelRanges[selectedOmeC]
        ? channelRanges[selectedOmeC]
        : null;
    const rangeById =
      omeRange || !cRange
        ? omePixelRangeByChannelId
        : {
            ...omePixelRangeByChannelId,
            [chIdx]: {
              data_min: cRange.dataMin,
              data_max: cRange.dataMax,
              auto_min: cRange.autoMin,
              auto_max: cRange.autoMax,
            },
          };
    const { min: wMin, max: wMax } = resolveChannelRawWindow(
      chIdx,
      windows,
      rangeById,
    );
    contrastLimits.push([wMin, wMax]);
    const bounds = readOmePixelRange(rangeById?.[chIdx]);
    const rMin = bounds?.dataMin ?? wMin;
    const rMax = bounds?.dataMax ?? wMax;
    contrastLimitsRange.push([Math.min(rMin, rMax), Math.max(rMin, rMax)]);

    const rgb = colors?.[chIdx] || [255, 255, 255];
    vivColors.push(scaleRgbByToneGain(rgb));

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
