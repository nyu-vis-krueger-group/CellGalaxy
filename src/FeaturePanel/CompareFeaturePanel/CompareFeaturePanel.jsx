import React, { useEffect, useMemo, useRef, useState } from "react";
import "../../FeatureDock/FeatureDock.css";
import "./CompareFeaturePanel.css";
import { drawCellPreviewToCanvas } from "../../Viewer/HoverPreview/HoverPreview";
import { API_BASE } from "../../api/api";

// Violin 形状本身仍然用中性白/灰两色区分 Region 1 / Region 2，
// 颜色提示通过文字（Region 1 橙色 / Region 2 青色）来表达。
const COLOR_REGION1 = "rgba(230,230,230,0.95)"; // Region 1 → 较亮的白
const COLOR_REGION2 = "rgba(130,130,130,0.95)"; // Region 2 → 较深的灰

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

function drawViolinRow(canvas, kdeA, kdeB, channelNames, colors, message) {
  if (!canvas) return;
  const chs = Array.isArray(kdeA?.channels)
    ? kdeA.channels
    : Array.isArray(kdeB?.channels)
    ? kdeB.channels
    : null;
  const hasData =
    chs &&
    Array.isArray(kdeA?.xs) &&
    Array.isArray(kdeA?.ys) &&
    Array.isArray(kdeB?.xs) &&
    Array.isArray(kdeB?.ys);
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
  // 低值很多时压缩底部、拉伸高值区，让上方分布可见。gammaY > 1 时高值占更多纵轴
  const gammaY = 0.5;
  const toY = (t01) => {
    const u = Math.max(0, Math.min(1, t01));
    const nonlin = Math.pow(u, gammaY);
    return marginT + (1 - nonlin) * plotH;
  };

  // 每通道用两区域实际数据范围 [lo,hi] 的并集映射 Y，避免整条压到底部
  const unionRangeForChannel = (i) => {
    const loA = Array.isArray(kdeA?.lo) ? kdeA.lo[i] : undefined;
    const hiA = Array.isArray(kdeA?.hi) ? kdeA.hi[i] : undefined;
    const loB = Array.isArray(kdeB?.lo) ? kdeB.lo[i] : undefined;
    const hiB = Array.isArray(kdeB?.hi) ? kdeB.hi[i] : undefined;
    let uLo = 0;
    let uHi = 65535;
    if (typeof loA === "number" && typeof hiA === "number" && typeof loB === "number" && typeof hiB === "number") {
      uLo = Math.min(loA, loB);
      uHi = Math.max(hiA, hiB);
    } else {
      const xsA = Array.isArray(kdeA?.xs?.[i]) ? kdeA.xs[i] : [];
      const xsB = Array.isArray(kdeB?.xs?.[i]) ? kdeB.xs[i] : [];
      const allX = [...xsA, ...xsB].filter((x) => typeof x === "number");
      if (allX.length) {
        uLo = Math.min(...allX);
        uHi = Math.max(...allX);
      }
    }
    if (uHi <= uLo) uHi = uLo + 1;
    return { uLo, uHi };
  };

  // Y 轴刻度：与 toY 一致，按数据值 0 / 0.33 / 0.67 / 1 标在对应像素位置
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  const tickValues = [1, 0.67, 0.33, 0];
  for (const v01 of tickValues) {
    const y = toY(v01);
    const label = v01.toFixed(2).replace(/\.00$/, "");
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
    const { uLo, uHi } = unionRangeForChannel(i);
    const mapToUnion01 = (v) => (v - uLo) / (uHi - uLo + 1e-6);

    const xsA = Array.isArray(kdeA?.xs?.[i]) ? kdeA.xs[i] : [];
    const ysA = Array.isArray(kdeA?.ys?.[i]) ? kdeA.ys[i] : [];
    const maxYA = Math.max(1e-6, ...(ysA || []));
    const d1 = { xs: xsA, ys: (ysA || []).map((v) => v / maxYA) };

    const xsB = Array.isArray(kdeB?.xs?.[i]) ? kdeB.xs[i] : [];
    const ysB = Array.isArray(kdeB?.ys?.[i]) ? kdeB.ys[i] : [];
    const maxYB = Math.max(1e-6, ...(ysB || []));
    const d2 = { xs: xsB, ys: (ysB || []).map((v) => v / maxYB) };

    const cx = marginL + i * colW + colW * 0.5;
    // 宽度严格按密度，不加最小比例，避免变成等宽柱状图；halfW 稍大让“肚子”可见
    const halfW = Math.max(20, Math.min(30, colW * 0.45));
    const minPx = 1;

    // 轮廓点：宽度 = 密度×halfW（仅 2px 下限防断线），再插值一次使轮廓圆滑
    const buildOutline = (xs, ys, sign) => {
      const raw = [];
      for (let b = 0; b < (xs?.length || 0); b++) {
        const y = toY(mapToUnion01(xs[b]));
        const w = Math.max((ys[b] || 0) * halfW, minPx) * (sign === "left" ? -1 : 1);
        raw.push({ y, w });
      }
      if (raw.length === 0) return raw;
      raw.sort((a, b) => a.y - b.y);
      const out = [];
      for (let j = 0; j < raw.length; j++) {
        out.push(raw[j]);
        if (j < raw.length - 1)
          out.push({ y: (raw[j].y + raw[j + 1].y) / 2, w: (raw[j].w + raw[j + 1].w) / 2 });
      }
      return out;
    };

    const pts1 = buildOutline(d1.xs, d1.ys, "left");
    const pts2 = buildOutline(d2.xs, d2.ys, "right");

    // Region 1：左侧提琴
    ctx.fillStyle = COLOR_REGION1;
    ctx.beginPath();
    if (pts1.length) ctx.moveTo(cx, pts1[0].y);
    for (let j = 0; j < pts1.length; j++) ctx.lineTo(cx + pts1[j].w, pts1[j].y);
    for (let j = pts1.length - 1; j >= 0; j--) ctx.lineTo(cx, pts1[j].y);
    ctx.closePath();
    ctx.globalAlpha = 0.88;
    ctx.fill();
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Region 2：右侧提琴
    ctx.fillStyle = COLOR_REGION2;
    ctx.beginPath();
    if (pts2.length) ctx.moveTo(cx, pts2[0].y);
    for (let j = 0; j < pts2.length; j++) ctx.lineTo(cx + pts2[j].w, pts2[j].y);
    for (let j = pts2.length - 1; j >= 0; j--) ctx.lineTo(cx, pts2[j].y);
    ctx.closePath();
    ctx.globalAlpha = 0.88;
    ctx.fill();
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
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

  const violinRef = useRef(null);

  const regionA = data?.regions?.[0] || {};
  const regionB = data?.regions?.[1] || {};

  useEffect(() => {
    drawViolinRow(
      violinRef.current,
      regionA?.sel_kde,
      regionB?.sel_kde,
      channelNames,
      colors,
      "No intensity data for the two regions"
    );
  }, [regionA, regionB, channelNames, colors]);

  if (!data) {
    return <div className="loading">No comparison data</div>;
  }

  return (
    <div className="feature-section">
      <div className="gfp-header gfp-header--center">
        <div className="feature-title">Comparative Analysis of the Two Selected Regions</div>
      </div>

      {/* 第二行：左侧小标题 + 右侧两个代表性细胞缩略图 */}
      <div className="compare-reps-row">
        <div className="compare-reps-title">
          <span>Representative</span>
          <br />
          <span>images</span>
        </div>
        <div className="compare-reps compare-reps-inline">
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

      <div className="compare-violin-stack">
        <div className="compare-violin-caption-row">
          <div className="compare-violin-caption">
          Distribution of Intensity Values 
          in Two Regions
          </div>
          <div className="gfp-legend">
            <div className="gfp-legend-item">
              <span className="gfp-swatch gfp-swatch--global" />
              <span className="gfp-legend-label region1-label">Region 1</span>
            </div>
            <div className="gfp-legend-item">
              <span className="gfp-swatch gfp-swatch--selection" />
              <span className="gfp-legend-label region2-label">Region 2</span>
            </div>
          </div>
        </div>
        <canvas ref={violinRef} className="compare-violin-canvas" />
      </div>
    </div>
  );
}
