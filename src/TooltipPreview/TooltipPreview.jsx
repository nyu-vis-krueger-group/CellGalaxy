import "./TooltipPreview.css";

/**
 * Generate HTML string for image preview in tooltip
 * - Same as main screen: based on grayscale atlas per channel, through mask + color overlay, and using plus-lighter addition blending
 */
export function buildTooltipHTML({
  object,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL,
  channels,
  colors,
  alphas,
  previewSize = 128,
  // For embedded display (e.g., fixed cluster preview), remove extra margin/shadow, etc.
  compact = false,
}) {
  if (!object) return "";
  const chunkId = object.chunk_id;
  const localIndex = object.local_index;
  const mapping = iconMappingsByChunk?.[chunkId]?.[`t_${localIndex}`];
  const uvMeta = chunkUV?.[chunkId];
  if (!mapping || !uvMeta) return "";

  const availableByCh = atlasByChannel?.[chunkId] || {};
  const orderedChannels = Array.isArray(channels) && channels.length > 0
    ? channels
    : Object.keys(availableByCh).map((v) => Number(v));

  const tile = uvMeta.tile || mapping.width || 16;
  const dispW = Math.max(1, previewSize);
  const dispH = Math.max(1, previewSize);
  const bgW = uvMeta.width || 0;
  const bgH = uvMeta.height || 0;
  const bgX = mapping.x || 0;
  const bgY = mapping.y || 0;
  const scale = tile > 0 ? (previewSize / tile) : 1;

  const containerStyle = [
    `width:${dispW}px`,
    `height:${dispH}px`,
    `border-radius:8px`,
    `margin-top:${compact ? 0 : 6}px`,
    `overflow:hidden`,
    `position:relative`,
    `background:#000`,
    `isolation:isolate`,
    compact ? `` : `box-shadow:0 2px 8px rgba(0,0,0,0.35)`,
  ].join(";");

  const layers = [];
  for (const ch of orderedChannels) {
    const src = availableByCh?.[ch];
    if (!src) continue;
    const col = colors?.[ch] || [255, 255, 255];
    const a = Math.min(255, Math.max(0, (alphas?.[ch] ?? 255)));
    const alpha = (a / 255).toFixed(3);
    const layerStyle = [
      `position:absolute`,
      `left:0`,
      `top:0`,
      `right:0`,
      `bottom:0`,
      `background-color: rgba(${col[0] ?? 255},${col[1] ?? 255},${col[2] ?? 255},${alpha})`,
      `-webkit-mask-image: url('${src}')`,
      `mask-image: url('${src}')`,
      `-webkit-mask-size: ${bgW * scale}px ${bgH * scale}px`,
      `mask-size: ${bgW * scale}px ${bgH * scale}px`,
      `-webkit-mask-position: -${bgX * scale}px -${bgY * scale}px`,
      `mask-position: -${bgX * scale}px -${bgY * scale}px`,
      `-webkit-mask-repeat: no-repeat`,
      `mask-repeat: no-repeat`,
      `mix-blend-mode: plus-lighter`,
    ].join(";");
    layers.push(`<div class="tooltip-layer" style="${layerStyle}"></div>`);
  }

  if (layers.length === 0 && atlasURL?.[chunkId]) {
    const src = atlasURL[chunkId];
    const bgStyle = [
      `width:${dispW}px`,
      `height:${dispH}px`,
      `background-image:url('${src}')`,
      `background-size:${bgW}px ${bgH}px`,
      `background-position:-${bgX}px -${bgY}px`,
      `background-repeat:no-repeat`,
      `border-radius:8px`,
    ].join(";");
    return `<div class="tooltip-thumb" style="${bgStyle}"></div>`;
  }

  return `<div class="tooltip-thumb tooltip-composite" style="${containerStyle}">${layers.join("")}</div>`;
}

export default buildTooltipHTML;


