/** Shared rounded-square ring icon for GPU cluster / tile outlines (billboard). */

const ICON_SIZE = 64;
const STROKE_PX = 3;

let _cached = null;

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function getClusterOutlineIconDescriptor() {
  if (_cached) return _cached;

  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    _cached = { atlas: "", mapping: { outline: { x: 0, y: 0, width: 1, height: 1, mask: true } } };
    return _cached;
  }

  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  const inset = STROKE_PX / 2;
  roundRect(ctx, inset, inset, ICON_SIZE - STROKE_PX, ICON_SIZE - STROKE_PX, 8);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = STROKE_PX;
  ctx.lineJoin = "round";
  ctx.stroke();

  _cached = {
    atlas: canvas.toDataURL("image/png"),
    mapping: {
      outline: {
        x: 0,
        y: 0,
        width: ICON_SIZE,
        height: ICON_SIZE,
        mask: true,
      },
    },
  };
  return _cached;
}
