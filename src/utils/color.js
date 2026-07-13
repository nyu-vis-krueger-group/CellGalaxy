/** RGB tuple [r,g,b] ↔ CSS hex helpers. */

export function rgbToHex(rgb) {
  const [r, g, b] = rgb || [255, 255, 255];
  const clamp = (v) => Math.max(0, Math.min(255, Number(v) | 0));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/** OME Channel.Color is often RGBA; use first three components. */
export function rgbaToHex(rgba) {
  if (!rgba || rgba.length < 3) return "#ffffff";
  return rgbToHex(rgba);
}

export function hexToRgb(hex) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "#ffffff");
  if (!match) return [255, 255, 255];
  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ];
}
