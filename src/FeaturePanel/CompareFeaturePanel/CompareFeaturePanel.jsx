import React, { useEffect, useMemo, useRef, useState } from "react";
import "../../FeatureDock/FeatureDock.css";
import "./CompareFeaturePanel.css";
import { drawCellPreviewToCanvas } from "../../Viewer/HoverPreview/HoverPreview";
import { API_BASE } from "../../api/api";

// Use grayscale colors for violin plots (avoid conflicting with per-channel colors)
const COLOR_GLOBAL = "rgba(200,200,200,0.95)"; // global: lighter gray
const COLOR_SEL = "rgba(120,120,120,0.95)";    // selection: darker gray

function RegionThumb({
  repId,
  mapById,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL,
  channels,
  colors,
  alphas,
  windows,
}) {
  const obj = mapById.get(repId);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !obj) return;
    let cancelled = false;
    (async () => {
      await drawCellPreviewToCanvas({
        canvas,
        object: obj,
        iconMappingsByChunk,
        chunkUV,
        atlasByChannel,
        channels,
        colors,
        alphas,
        windows,
        previewSize: 110,
      });
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [
    obj,
    iconMappingsByChunk,
    chunkUV,
    atlasByChannel,
    channels,
    colors,
    alphas,
    windows,
  ]);

  return (
    <div className="compare-thumb">
      {obj ? (
        <canvas
          ref={canvasRef}
          style={{
            width: 72,
            height: 72,
            borderRadius: 8,
            display: "block",
          }}
        />
      ) : null}
    </div>
  );
}

function useChannelNames() {
  const [channelNames, setChannelNames] = useState(new Map()); // id -> name
  useEffect(() => {
    let abort = false;
    const run = async () => {
      try {
        const url = `${API_BASE}/public/channel_info.json?ts=${Date.now()}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        const m = new Map();
        if (json && Array.isArray(json.channels)) {
          for (const ch of json.channels) {
            if (typeof ch?.id === "number" && typeof ch?.name === "string") {
              m.set(ch.id, ch.name);
            }
          }
        }
        if (!abort) setChannelNames(m);
      } catch {}
    };
    run();
    return () => {
      abort = true;
    };
  }, []);
  return channelNames;
}

function drawViolinRow(canvas, gkde, skde, channelNames, colors, message, selCountMaxPerChannel = null) {
  if (!canvas) return;
  const chs = Array.isArray(gkde?.channels) ? gkde.channels : null;
  const hasData =
    chs &&
    Array.isArray(gkde?.xs) &&
    Array.isArray(gkde?.ys) &&
    Array.isArray(skde?.xs) &&
    Array.isArray(skde?.ys);
  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return;
  const dpr0 = window.devicePixelRatio || 1;
  const w0 = canvas.clientWidth || 640;
  const h0 = canvas.clientHeight || 180;
  canvas.width = Math.round(w0 * dpr0);
  canvas.height = Math.round(h0 * dpr0);
  ctx0.setTransform(1, 0, 0, 1, 0, 0);
  ctx0.scale(dpr0, dpr0);
  ctx0.clearRect(0, 0, w0, h0);

  const renderEmpty = (msg) => {
    ctx0.fillStyle = "rgba(255,255,255,0.03)";
    ctx0.fillRect(0, 0, w0, h0);
    if (msg) {
      ctx0.fillStyle = "rgba(255,255,255,0.75)";
      ctx0.font = "14px sans-serif";
      ctx0.fillText(msg, 12, 22);
      ctx0.fillStyle = "rgba(255,255,255,0.15)";
      ctx0.fillRect(10, 28, w0 - 20, 1);
    }
  };

  if (!hasData) {
    renderEmpty(message || "No violin data");
    return;
  }

  const ctx = ctx0;
  const w = w0;
  const h = h0;
  const marginL = 56,
    marginR = 16,
    marginT = 16,
    marginB = 32;
  const plotW = w - marginL - marginR;
  const plotH = h - marginT - marginB;
  const C = chs.length;
  if (C === 0) {
    renderEmpty("No active channels");
    return;
  }

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "rgba(255,255,255,0.02)");
  bg.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const colW = plotW / C;
  const gammaY = 4.0;
  const toY = (t01) => {
    const u = Math.max(0, Math.min(1, t01));
    const nonlin = Math.pow(u, gammaY);
    return marginT + (1 - nonlin) * plotH;
  };

  let uLo = 0;
  let uHi = 65535;
  const mapToUnion01 = (v) => (v - uLo) / (uHi - uLo + 1e-6);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  const numTicks = 4;
  for (let i = 0; i < numTicks; i++) {
    const p = i / (numTicks - 1);
    const y = marginT + p * plotH;
    const t = Math.pow(1 - p, 1 / gammaY);
    const v = uLo + t * (uHi - uLo);
    const label = Math.round(v).toString();
    ctx.fillText(label, marginL - 6, y + 4);
  }

  ctx.textAlign = "center";
  ctx.font = "14px sans-serif";
  for (let i = 0; i < C; i++) {
    const cx = marginL + i * colW + colW * 0.5;
    const chIdx = chs[i];
    const label = channelNames.get(chIdx) || `ch${chIdx}`;
    const col = colors?.[chIdx] || [230, 230, 235];
    ctx.fillStyle = `rgba(${col[0] ?? 230},${col[1] ?? 230},${col[2] ?? 235},0.95)`;
    ctx.fillText(label, cx, h - 10);
  }

  ctx.lineWidth = 1;
  for (let i = 0; i < C; i++) {
    const xsG = Array.isArray(gkde?.xs?.[i]) ? gkde.xs[i] : [];
    const ysG = Array.isArray(gkde?.ys?.[i]) ? gkde.ys[i] : [];
    const maxYG = Math.max(1e-6, ...(ysG || []));
    const nG = Array.isArray(gkde?.n) && typeof gkde.n[i] === "number" ? gkde.n[i] : 0;
    const dg = {
      lo: Array.isArray(xsG) && xsG.length ? xsG[0] : 0,
      hi: Array.isArray(xsG) && xsG.length ? xsG[xsG.length - 1] : 1,
      xs: xsG,
      ys: (ysG || []).map((v) => v / maxYG),
      n: nG,
    };
    const xsS = Array.isArray(skde?.xs?.[i]) ? skde.xs[i] : [];
    const ysS = Array.isArray(skde?.ys?.[i]) ? skde.ys[i] : [];
    const maxYS = Math.max(1e-6, ...(ysS || []));
    const nS = Array.isArray(skde?.n) && typeof skde.n[i] === "number" ? skde.n[i] : 0;
    const ds = {
      lo: Array.isArray(xsS) && xsS.length ? xsS[0] : 0,
      hi: Array.isArray(xsS) && xsS.length ? xsS[xsS.length - 1] : 1,
      xs: xsS,
      ys: (ysS || []).map((v) => v / maxYS),
      n: nS,
    };
    const cx = marginL + i * colW + colW * 0.5;
    const halfW = Math.max(8, Math.min(22, colW * 0.35));
    // For selection, keep a mostly constant visual width so that
    // the shape reflects intensity distribution rather than being
    // dominated by absolute sample count. We still encode relative
    // count very softly (0.4–1.0) so tiny selections don't look
    // identical to huge ones.
    const denomSel =
      selCountMaxPerChannel && typeof selCountMaxPerChannel[i] === "number"
        ? Math.max(1, selCountMaxPerChannel[i])
        : Math.max(1, nG);
    const rawScale = Math.max(0, Math.min(1, nS / denomSel));
    const selScale = 0.4 + 0.6 * rawScale; // clamp to [0.4, 1.0]
    const halfW_sel = halfW * selScale;

    ctx.fillStyle = COLOR_GLOBAL;
    ctx.beginPath();
    for (let b = 0; b < (dg.xs?.length || 0); b++) {
      const v = dg.xs[b];
      const tUnion = mapToUnion01(v);
      const y = toY(tUnion);
      const wLeft = (dg.ys[b] || 0) * halfW;
      if (b === 0) ctx.moveTo(cx, y);
      ctx.lineTo(cx - wLeft, y);
    }
    for (let b = (dg.xs?.length || 0) - 1; b >= 0; b--) {
      const v = dg.xs[b];
      const tUnion = mapToUnion01(v);
      const y = toY(tUnion);
      ctx.lineTo(cx, y);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COLOR_SEL;
    ctx.beginPath();
    for (let b = 0; b < (ds.xs?.length || 0); b++) {
      const v = ds.xs[b];
      const tUnion = mapToUnion01(v);
      const y = toY(tUnion);
      const wRight = (ds.ys[b] || 0) * halfW_sel;
      if (b === 0) ctx.moveTo(cx, y);
      ctx.lineTo(cx + wRight, y);
    }
    for (let b = (ds.xs?.length || 0) - 1; b >= 0; b--) {
      const v = ds.xs[b];
      const tUnion = mapToUnion01(v);
      const y = toY(tUnion);
      ctx.lineTo(cx, y);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, marginT);
    ctx.lineTo(cx, marginT + plotH);
    ctx.stroke();
  }
}

export default function CompareFeaturePanel({
  data,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL,
  channels,
  colors,
  alphas,
  windows,
  points = [],
}) {
  const channelNames = useChannelNames();
  const mapById = useMemo(() => {
    const m = new Map();
    for (const p of points) m.set(p.id, p);
    return m;
  }, [points]);
  const row1Ref = useRef(null);
  const row2Ref = useRef(null);

  const regionA = data?.regions?.[0] || {};
  const regionB = data?.regions?.[1] || {};
  const gkde = data?.global_kde;

  const selCountsA = Array.isArray(regionA?.sel_kde?.n) ? regionA.sel_kde.n : [];
  const selCountsB = Array.isArray(regionB?.sel_kde?.n) ? regionB.sel_kde.n : [];
  const selCountMaxPerChannel = useMemo(() => {
    const len = Math.max(selCountsA.length, selCountsB.length);
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const a = typeof selCountsA[i] === "number" ? selCountsA[i] : 0;
      const b = typeof selCountsB[i] === "number" ? selCountsB[i] : 0;
      out[i] = Math.max(a, b);
    }
    return out;
  }, [selCountsA, selCountsB]);

  useEffect(() => {
    drawViolinRow(
      row1Ref.current,
      gkde,
      regionA?.sel_kde,
      channelNames,
      colors,
      "Region 1: no data",
      selCountMaxPerChannel
    );
  }, [gkde, regionA, channelNames, colors, selCountMaxPerChannel]);

  useEffect(() => {
    drawViolinRow(
      row2Ref.current,
      gkde,
      regionB?.sel_kde,
      channelNames,
      colors,
      "Region 2: no data",
      selCountMaxPerChannel
    );
  }, [gkde, regionB, channelNames, colors, selCountMaxPerChannel]);

  if (!data) {
    return <div className="loading">No comparison data</div>;
  }

  return (
    <div>
      <div className="feature-section">
        <div className="feature-title">Representative cells</div>
        <div className="compare-reps">
          <div className="compare-rep-item">
            <RegionThumb
              repId={regionA?.representative}
              mapById={mapById}
              iconMappingsByChunk={iconMappingsByChunk}
              chunkUV={chunkUV}
              atlasByChannel={atlasByChannel}
              atlasURL={atlasURL}
              channels={channels}
              colors={colors}
              alphas={alphas}
              windows={windows}
            />
            <div className="compare-rep-label region1-label">Region 1</div>
          </div>
          <div className="compare-rep-item">
            <RegionThumb
              repId={regionB?.representative}
              mapById={mapById}
              iconMappingsByChunk={iconMappingsByChunk}
              chunkUV={chunkUV}
              atlasByChannel={atlasByChannel}
              atlasURL={atlasURL}
              channels={channels}
              colors={colors}
              alphas={alphas}
              windows={windows}
            />
            <div className="compare-rep-label region2-label">Region 2</div>
          </div>
        </div>
      </div>

      <div className="feature-section">
        <div className="gfp-header">
          <div className="feature-title">Two-region comparison</div>
          <div className="gfp-legend">
            <div className="gfp-legend-item">
              <span className="gfp-swatch gfp-swatch--global" />
              <span className="gfp-legend-label">Global</span>
            </div>
            <div className="gfp-legend-item">
              <span className="gfp-swatch gfp-swatch--selection" />
              <span className="gfp-legend-label">Selection</span>
            </div>
          </div>
        </div>

        <div className="compare-violin-stack">
          <div className="compare-row-head">
            <span className="region1-label">Region 1</span>
            <span className="compare-row-sub">cells: {regionA?.size ?? regionA?.ids?.length ?? 0}</span>
          </div>
          <canvas ref={row1Ref} className="compare-violin-canvas" />
          <div className="compare-row-head">
            <span className="region2-label">Region 2</span>
            <span className="compare-row-sub">cells: {regionB?.size ?? regionB?.ids?.length ?? 0}</span>
          </div>
          <canvas ref={row2Ref} className="compare-violin-canvas" />
        </div>
      </div>
    </div>
  );
}
