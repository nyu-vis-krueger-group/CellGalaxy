/** Minimal helpers for OME-TIFF store (adapted from vizarr). */

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(expr, msg = "") {
  if (!expr) throw new AssertionError(msg);
}

const COLORS = {
  cyan: "#00FFFF",
  yellow: "#FFFF00",
  magenta: "#FF00FF",
  red: "#FF0000",
  green: "#00FF00",
  blue: "#0000FF",
  white: "#FFFFFF",
};

export const MAX_CHANNELS = 6;
export const MAGENTA_GREEN = [COLORS.magenta, COLORS.green];
export const RGB = [COLORS.red, COLORS.green, COLORS.blue];
export const CYMRGB = [
  COLORS.magenta,
  COLORS.yellow,
  COLORS.cyan,
  COLORS.red,
  COLORS.green,
  COLORS.blue,
];

export function getDefaultVisibilities(n, visibilities) {
  if (!visibilities) {
    if (n <= MAX_CHANNELS) {
      visibilities = Array(n).fill(true);
    } else {
      visibilities = [...Array(MAX_CHANNELS).fill(true), ...Array(n - MAX_CHANNELS).fill(false)];
    }
  }
  return visibilities;
}

export function getDefaultColors(n, visibilities) {
  let colors;
  if (n === 1) {
    colors = [COLORS.white];
  } else if (n === 2) {
    colors = MAGENTA_GREEN;
  } else if (n === 3) {
    colors = RGB;
  } else if (n <= MAX_CHANNELS) {
    colors = CYMRGB.slice(0, n);
  } else {
    colors = Array(n).fill(COLORS.white);
    const visibleIndices = visibilities.flatMap((bool, i) => (bool ? i : []));
    for (const [i, visibleIndex] of visibleIndices.entries()) {
      colors[visibleIndex] = CYMRGB[i];
    }
  }
  return colors;
}
