import React, { useEffect, useRef, useState } from "react";
import "../../FeatureDock/FeatureDock.css";
import "./GroupFeaturePanel.css";
import { API_BASE, fetchViolinGlobalKDE, fetchViolinSelectionKDE } from "../../api/api";
import { kde1d } from "../../utils/utils";

export default function GroupFeaturePanel({
  data,
  channels,
  colors,

}) {
  // ============== Violin (Global vs Selection) ==============
  const [violinData, setViolinData] = useState(null); // { global:{channels,values}, sel:{channels,values} }
  const [violinMsg, setViolinMsg] = useState("Loading...");
  const violinRef = useRef(null);
  const [channelNames, setChannelNames] = useState(new Map()); // id -> name (from channel_info.json)
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
    return () => { abort = true; };
  }, []);
  useEffect(() => {
    let abort = false;
    const run = async () => {
      try {
        setViolinMsg("Loading...");
        // Use moderate sampling to keep interaction responsive:
        // - Global KDE: larger sample for smooth background
        // - Selection KDE: smaller sample / coarser grid (already downsampled in api.js)
        const MAX_GLOBAL = 80000;
        const MAX_SELECTION = 30000;
        const GRID = 192;
        const activeChs = Array.isArray(channels) && channels.length > 0 ? channels.map((c) => Number(c)) : [];
        if (activeChs.length === 0) {
          setViolinData(null);
          setViolinMsg("No active channels");
          return;
        }
        // collect ids
        const ids = Array.isArray(data?.coords) ? data.coords.map((o) => o.id) : [];
        if (!Array.isArray(ids) || ids.length === 0) {
          setViolinData(null);
          setViolinMsg("No selection");
          return;
        }
        // fetch global and selection KDE
        const [gkde, skde] = await Promise.all([
          fetchViolinGlobalKDE(MAX_GLOBAL, 99.0, 0.1, activeChs, GRID, undefined),
          fetchViolinSelectionKDE(ids, MAX_SELECTION, 99.0, 0.1, activeChs, GRID, undefined),
        ]);
        if (!abort) {
          if (gkde && skde && !gkde.error && !skde.error && Array.isArray(gkde.channels) && Array.isArray(skde.channels)) {
            setViolinData({ global_kde: gkde, sel_kde: skde });
            setViolinMsg("");
          } else {
            setViolinData(null);
            setViolinMsg("Failed to load violin data");
          }
        }
      } catch {
        if (!abort) {
          setViolinData(null);
          setViolinMsg("Failed to load violin data");
        }
      }
    };
    run();
    return () => {
      abort = true;
    };
  }, [data]);

  useEffect(() => {
    const canvas = violinRef.current;
    if (!canvas) return;
    const pack = violinData;
    const gkde = pack?.global_kde;
    const skde = pack?.sel_kde;
    const chs = Array.isArray(gkde?.channels) ? gkde.channels : null;
    if (!chs || !Array.isArray(gkde?.xs) || !Array.isArray(gkde?.ys) || !Array.isArray(skde?.xs) || !Array.isArray(skde?.ys)) {

      const ctx0 = canvas.getContext("2d");
      if (!ctx0) return;
      const dpr0 = window.devicePixelRatio || 1;
      const w0 = canvas.clientWidth || 600;
      const h0 = canvas.clientHeight || 220;
      canvas.width = Math.round(w0 * dpr0);
      canvas.height = Math.round(h0 * dpr0);
      ctx0.setTransform(1,0,0,1,0,0);
      ctx0.scale(dpr0, dpr0);
      ctx0.clearRect(0,0,w0,h0);

      ctx0.fillStyle = "rgba(255,255,255,0.03)";
      ctx0.fillRect(0,0,w0,h0);
      if (violinMsg) {
        ctx0.fillStyle = "rgba(255,255,255,0.75)";
        ctx0.font = "14px sans-serif";
        ctx0.fillText(violinMsg, 12, 22);
        ctx0.fillStyle = "rgba(255,255,255,0.15)";
        ctx0.fillRect(10, 28, w0 - 20, 1);
      }
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 900;
    const h = canvas.clientHeight || 200;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,w,h);

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "rgba(255,255,255,0.02)");
    bg.addColorStop(1, "rgba(255,255,255,0.02)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const marginL = 56, marginR = 16, marginT = 16, marginB = 32;
    const plotW = w - marginL - marginR;
    const plotH = h - marginT - marginB;
    const C = chs.length;
    if (C === 0) return;
    // x-axis layout for each channel (x-axis layout for each channel)
    const colW = plotW / C;

    // 与双区域对比一致：Y 轴 gamma 略低，压缩低值区、拉伸高值区，让分布更不均匀、高值区更易见
    const gammaY = 0.5;
    const toY = (t01) => {
      const u = Math.max(0, Math.min(1, t01));
      const nonlin = Math.pow(u, gammaY);
      return marginT + (1 - nonlin) * plotH;
    };
    // use grayscale for violin plots to avoid conflicting with per-channel colors
    const colorGlobal = "rgba(200,200,200,0.95)"; // global (left): lighter gray
    const colorSel = "rgba(120,120,120,0.95)";    // selection (right): darker gray

    ctx.lineWidth = 1;

    // Use a fixed 16-bit range [0, 65535] for the intensity axis,
    // so tick labels are linear and comparable across channels.
    let uLo = 0;
    let uHi = 65535;
    const mapToUnion01 = (v) => (v - uLo) / (uHi - uLo + 1e-6);
    // left y-axis ticks (real intensity values, linearly spaced)
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    const numTicks = 4; // display 3~4 ticks
    for (let i = 0; i < numTicks; i++) {
      // f: 0 -> bottom (min), 1 -> top (max), evenly spaced in value
      const f = i / (numTicks - 1);
      const y = marginT + (1 - f) * plotH;
      const v = uLo + f * (uHi - uLo);
      // render tick labels as integers (previous behavior), avoid trailing decimals like '0.00'
      const label = Math.round(v).toString();
      ctx.fillText(label, marginL - 6, y + 4);
    }
    // x-axis channel names (using channel colors + displaying real channel names from channel_info.json)
    ctx.textAlign = "center";
    ctx.font = "14px sans-serif";
    for (let i = 0; i < C; i++) {
      const cx = marginL + i * colW + colW * 0.5;
      const chIdx = chs[i];
      const label = channelNames.get(chIdx) || (channels?.[chIdx]?.name) || `ch${chIdx}`;
      const col = colors?.[chIdx] || [230,230,235];
      ctx.fillStyle = `rgba(${col[0] ?? 230},${col[1] ?? 230},${col[2] ?? 235},0.95)`;
      ctx.fillText(label, cx, h - 10);
    }
    // calculate density and draw (global/selection both use backend KDE)
    for (let i = 0; i < C; i++) {
      const xsG = Array.isArray(gkde?.xs?.[i]) ? gkde.xs[i] : [];
      const ysG = Array.isArray(gkde?.ys?.[i]) ? gkde.ys[i] : [];
      const maxYG = Math.max(1e-6, ...(ysG || []));
      const nG = (Array.isArray(gkde?.n) && typeof gkde.n[i] === "number") ? gkde.n[i] : 0;
      const dg = {
        lo: Array.isArray(xsG) && xsG.length ? xsG[0] : 0,
        hi: Array.isArray(xsG) && xsG.length ? xsG[xsG.length - 1] : 1,
        xs: xsG,
        ys: (ysG || []).map(v => v / maxYG),
      };
      const xsS = Array.isArray(skde?.xs?.[i]) ? skde.xs[i] : [];
      const ysS = Array.isArray(skde?.ys?.[i]) ? skde.ys[i] : [];
      const maxYS = Math.max(1e-6, ...(ysS || []));
      const nS = (Array.isArray(skde?.n) && typeof skde.n[i] === "number") ? skde.n[i] : 0;
      const ds = {
        lo: Array.isArray(xsS) && xsS.length ? xsS[0] : 0,
        hi: Array.isArray(xsS) && xsS.length ? xsS[xsS.length - 1] : 1,
        xs: xsS,
        ys: (ysS || []).map(v => v / maxYS),
      };
      const cx = marginL + i * colW + colW * 0.5;
      const halfW = Math.max(8, Math.min(22, colW * 0.35));
      const denom = Math.max(1, nG);
      const selScale = Math.max(0, Math.min(1, nS / denom)); // sample size ratio relative to global
      const halfW_sel = halfW * selScale;
      // global (left)
      ctx.fillStyle = colorGlobal;
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
      // outer border (enhanced contrast)
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
      // selection (right)
      ctx.fillStyle = colorSel;
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
      ctx.globalAlpha = 1.0;
      // middle line (slightly thicker)
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, marginT);
      ctx.lineTo(cx, marginT + plotH);
      ctx.stroke();
    }
  }, [violinData, channels]);

  // High-dimensional Similarity Field (seriation-based)
  const fieldRef = useRef(null);
  useEffect(() => {
    const canvas = fieldRef.current;
    if (!canvas) return;
    const sims = Array.isArray(data?.centroid_similarities) ? data.centroid_similarities.slice() : [];
    const seriation = Array.isArray(data?.seriation_order) ? data.seriation_order.slice() : [];
    const gY = data?.global_y_hist || { centers: [], counts: [] };
    const medGroup = typeof data?.group_y_median === "number" ? data.group_y_median : null;
    const medGlobal = typeof data?.global_y_median === "number" ? data.global_y_median : null;
    const memberIds = Array.isArray(data?.coords) ? data.coords.map((o) => o.id) : [];
    const N = Math.min(sims.length, memberIds.length);
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 360;
    const h = canvas.clientHeight || 320;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,w,h);
    if (N === 0) return;

    const mx = 36, my = 28;
    // x from seriation
    const orderIdx = [];
    if (seriation.length === memberIds.length) {
      const idToRank = new Map(seriation.map((id, rank) => [id, rank]));
      for (let i = 0; i < memberIds.length; i++) {
        const id = memberIds[i];
        const r = idToRank.has(id) ? idToRank.get(id) : i;
        orderIdx.push(r);
      }
    } else {
      for (let i = 0; i < memberIds.length; i++) orderIdx.push(i);
    }
    const n1 = Math.max(1, memberIds.length - 1);
    const x01 = orderIdx.map(r => r / n1);
    // y from similarity to centroid
    const y01 = sims.map(s => Math.max(0, Math.min(1, (s + 1) / 2)));

    // draw global y background bands (1D hist as horizontal bands)
    if (Array.isArray(gY.centers) && Array.isArray(gY.counts) && gY.centers.length === gY.counts.length && gY.centers.length > 0) {
      const maxC = Math.max(1, ...gY.counts);
      ctx.save();
      ctx.filter = "blur(0.8px)";
      for (let i = 0; i < gY.centers.length; i++) {
        const y = my + (1 - gY.centers[i]) * (h - 2 * my);
        const a = 0.04 + 0.16 * (gY.counts[i] / maxC);
        ctx.strokeStyle = `rgba(200,200,205,${a})`;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(mx, y);
        ctx.lineTo(w - mx, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    // 2D KDE grid
    const gw = 160, gh = 100;
    const grid = new Float32Array(gw * gh);
    const sigma = 0.055;
    const sig2 = 2 * sigma * sigma;
    for (let i = 0; i < N; i++) {
      const xi = x01[i];
      const yi = y01[i];
      const gx = Math.round(xi * (gw - 1));
      const gy = Math.round((1 - yi) * (gh - 1));
      const r = Math.max(2, Math.ceil(3 * sigma * gw));
      for (let yy = Math.max(0, gy - r); yy <= Math.min(gh - 1, gy + r); yy++) {
        const vy = (yy / (gh - 1));
        const dy = (vy - (1 - yi));
        for (let xx = Math.max(0, gx - r); xx <= Math.min(gw - 1, gx + r); xx++) {
          const ux = (xx / (gw - 1));
          const dx = (ux - xi);
          const wv = Math.exp(-((dx * dx + dy * dy) / sig2));
          grid[yy * gw + xx] += wv;
        }
      }
    }
    let maxV = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > maxV) maxV = grid[i];
    if (maxV > 0) {
      for (let yy = 0; yy < gh; yy++) {
        for (let xx = 0; xx < gw; xx++) {
          const v = grid[yy * gw + xx] / maxV;
          if (v <= 0) continue;
          const alpha = 0.05 + 0.36 * v;
          ctx.fillStyle = `rgba(0,160,255,${alpha})`;
          const x = mx + (xx / (gw - 1)) * (w - 2 * mx);
          const y = my + (yy / (gh - 1)) * (h - 2 * my);
          ctx.fillRect(x, y, (w - 2 * mx) / (gw - 1), (h - 2 * my) / (gh - 1));
        }
      }
    }
    // overlay group points
    for (let i = 0; i < N; i++) {
      const x = mx + x01[i] * (w - 2 * mx);
      const y = my + (1 - y01[i]) * (h - 2 * my);
      const id = memberIds[i];
      const isEx = data?.exemplars?.some(ex => ex.id === id);
      const light = 45 + Math.round(40 * y01[i]);
      const size = isEx ? 3.0 : 2.0;
      if (isEx) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x, y, size + 1.4, 0, Math.PI*2);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(x, y, size + 0.6, 0, Math.PI*2);
      ctx.stroke();
      ctx.fillStyle = `hsl(195, 90%, ${light}%)`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI*2);
      ctx.fill();
    }
    // median reference lines
    if (typeof medGlobal === "number") {
      const yg = my + (1 - medGlobal) * (h - 2 * my);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(200,200,205,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, yg);
      ctx.lineTo(w - mx, yg);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (typeof medGroup === "number") {
      const yg2 = my + (1 - medGroup) * (h - 2 * my);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(0,160,255,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, yg2);
      ctx.lineTo(w - mx, yg2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // legend box
    if (typeof medGlobal === "number" || typeof medGroup === "number") {
      const pad = 8;
      const lh = 16;
      const boxW = 160, boxH = 2 * lh + pad + 6;
      const x0 = w - mx - boxW;
      const y0 = my + 6;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x0, y0, boxW, boxH, 6);
        ctx.fill();
      } else {
        ctx.fillRect(x0, y0, boxW, boxH);
      }
      ctx.font = "11px sans-serif";
      // global
      ctx.strokeStyle = "rgba(200,200,205,0.75)";
      ctx.setLineDash([6,3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0 + pad, y0 + lh - 6);
      ctx.lineTo(x0 + pad + 26, y0 + lh - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(230,230,235,0.9)";
      ctx.textAlign = "left";
      ctx.fillText("global median", x0 + pad + 32, y0 + lh - 2);
      // group
      ctx.strokeStyle = "rgba(0,160,255,0.85)";
      ctx.setLineDash([6,3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0 + pad, y0 + 2*lh - 6);
      ctx.lineTo(x0 + pad + 26, y0 + 2*lh - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(0,180,255,0.95)";
      ctx.fillText("group median", x0 + pad + 32, y0 + 2*lh - 2);
    }
    // axis ticks (lightweight, non-intrusive)
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 1;
    ctx.font = "11px sans-serif";
    // x ticks: 0..1
    ctx.textAlign = "center";
    const xts = [0, 0.25, 0.5, 0.75, 1];
    for (const t of xts) {
      const px = mx + t * (w - 2 * mx);
      const py = h - my;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - 5);
      ctx.stroke();
      ctx.fillText(t.toFixed(2), px, py + 12);
    }
    // y ticks: 0..1 (top=1)
    ctx.textAlign = "right";
    const yts = [0, 0.25, 0.5, 0.75, 1];
    for (const t of yts) {
      const py = my + (1 - t) * (h - 2 * my);
      const px0 = mx, px1 = mx + 5;
      ctx.beginPath();
      ctx.moveTo(px0, py);
      ctx.lineTo(px1, py);
      ctx.stroke();
      ctx.fillText(t.toFixed(2), mx - 4, py + 4);
    }
    // axis labels
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("x: similarity-based ordering (seriation)", w/2, h - 4);
    ctx.save();
    ctx.translate(14, h/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText("y: similarity to group centroid (0..1)", 0, 0);
    ctx.restore();
  }, [data]);

  // Unified radial visualization
  const radialRef = useRef(null);
  useEffect(() => {
    const canvas = radialRef.current;
    if (!canvas) return;
    const sims = Array.isArray(data?.centroid_similarities) ? data.centroid_similarities.slice() : [];
    const proj = Array.isArray(data?.proj1) ? data.proj1.slice() : [];
    const ghist = data?.global_sims_hist || { centers: [], counts: [] };
    const memberIds = Array.isArray(data?.coords) ? data.coords.map((o) => o.id) : [];
    const exemplarSet = new Set((data?.exemplars || []).map((ex) => ex.id));
    const N = Math.min(sims.length, proj.length);
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 240;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,w,h);
    // center, radii
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.48;
    const R0 = Math.min(w, h) * 0.075;

    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.fill();

    const sClip = sims.map(v => Math.max(-1, Math.min(1, v)));
    const rVals = sClip.map(v => 1 - v);
    let rMin = 0, rMax = 1;
    if (N > 0) {
      rMin = Math.min(...rVals);
      rMax = Math.max(...rVals);
    }
    const r01Group = rVals.map(v => (v - rMin) / (rMax - rMin + 1e-6));
    // calculate group KDE (based on r_norm smooth radial band)
    const bw = Math.max(0.05, Math.min(0.15, 1 / Math.sqrt(Math.max(8, r01Group.length))));
    const { xs: gx, ys: gy } = kde1d(r01Group, bw, 192);
    // calculate global density (smoothed by histogram)
    let hx = [], hy = [];
    if (Array.isArray(ghist.centers) && Array.isArray(ghist.counts) && ghist.centers.length === ghist.counts.length && ghist.centers.length > 0) {
      const maxC = Math.max(1, ...ghist.counts);
      // smooth counts (3-point mean) and normalize
      const sm = ghist.counts.map((c, i, a) => {
        const c0 = a[Math.max(0, i-1)] ?? c, c1 = c, c2 = a[Math.min(a.length-1, i+1)] ?? c;
        return (c0 + c1 + c2) / 3;
      }).map(v => v / maxC);
      hx = ghist.centers.slice();
      hy = sm;
    }
    // draw global background band (soft, low opacity) to avoid "CD"
    if (hx.length > 0) {
      ctx.save();
      ctx.filter = "blur(1.2px)";
      for (let i = 0; i < hx.length; i++) {
        const s01 = Math.max(0, Math.min(1, hx[i]));
        const r01 = 1 - s01; // r_global_norm
        const r = R0 + r01 * (R - R0);
        const a = 0.06 + 0.18 * hy[i];
        ctx.strokeStyle = `rgba(180,180,185,${a})`; // global: light gray
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI*2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // draw group density band (smoothed KDE, no stripes, light blue)
    if (N > 0) {
      ctx.save();
      ctx.filter = "blur(1.8px)";
      for (let i = 0; i < gx.length; i++) {
        const r01 = gx[i];
        const r = R0 + r01 * (R - R0);
        const a = 0.10 + 0.35 * gy[i];
        ctx.strokeStyle = `rgba(0,160,255,${a})`; // group: light blue; brightness scales with density
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI*2);
        ctx.stroke();
      }
      ctx.restore();
      // angle from proj1 (direction axis)
      let minP = Math.min(...proj), maxP = Math.max(...proj);
      if (!isFinite(minP) || !isFinite(maxP) || minP === maxP) {
        minP = -1; maxP = 1;
      }
      // angle from proj1 (direction axis)
      const thetaPos = Math.PI; // direction corresponding to t=1
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (R-2) * Math.cos(thetaPos), cy + (R-2) * Math.sin(thetaPos));
      ctx.stroke();
      // small arrow
      const ax = cx + (R-2) * Math.cos(thetaPos);
      const ay = cy + (R-2) * Math.sin(thetaPos);
      const ah = 6;
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ah * Math.cos(thetaPos - Math.PI/8), ay - ah * Math.sin(thetaPos - Math.PI/8));
      ctx.lineTo(ax - ah * Math.cos(thetaPos + Math.PI/8), ay - ah * Math.sin(thetaPos + Math.PI/8));
      ctx.closePath();
      ctx.fill();

      // calculate local density (used for point size, dense→small, sparse→large)
      const tvals = proj.map(v => (v - minP) / (maxP - minP)); // [0,1]
      const dens = new Array(N).fill(0);
      if (N <= 1500) {
        const aeps = 0.08, reps = 0.06; // angle/radius neighborhood
        for (let i = 0; i < N; i++) {
          let c = 0;
          const ti = tvals[i], ri = r01Group[i];
          for (let j = 0; j < N; j++) {
            if (i === j) continue;
            const tj = tvals[j], rj = r01Group[j];
            let dt = Math.abs(ti - tj);
            dt = Math.min(dt, 1 - dt); // wrap around
            const dr = Math.abs(ri - rj);
            if (dt < aeps && dr < reps) c++;
          }
          dens[i] = c;
        }
        // normalize to [0,1]
        const md = Math.max(1, ...dens);
        for (let i = 0; i < N; i++) dens[i] = dens[i] / md;
      } else {
        // for large groups, do not calculate, default medium density
        for (let i = 0; i < N; i++) dens[i] = 0.5;
      }

      // foreground points: brightness=similarity, size=density(inverse), stroke=exemplar
      for (let i = 0; i < N; i++) {
        const r01 = r01Group[i];
        const r = R0 + r01 * (R - R0);
        const t = (proj[i] - minP) / (maxP - minP);
        const theta = (t * Math.PI * 2) - Math.PI;
        const x = cx + r * Math.cos(theta);
        const y = cy + r * Math.sin(theta);
        // point size: sparse larger
        const size = 1.6 + (1 - dens[i]) * 2.2; // 1.6..3.8
        // brightness: higher similarity brighter (HSL)
        const s01_for_light = Math.max(0, Math.min(1, (sClip[i] + 1) / 2));
        const light = 40 + Math.round(45 * s01_for_light); // 40%..85%
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, size + 0.7, 0, Math.PI*2);
        ctx.stroke();
        ctx.fillStyle = `hsl(195, 90%, ${light}%)`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI*2);
        ctx.fill();
        const idHere = memberIds[i];
        if (exemplarSet.has(idHere)) {
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, size + 1.6, 0, Math.PI*2);
          ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.arc(x, y, size + 2.6, 0, Math.PI*2);
          ctx.stroke();
        }
      }
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("high sim", cx + 6, cy + 4);
    ctx.textAlign = "right";
    ctx.fillText("low sim", cx + R - 6, cy + 4);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("− projection → +", cx, cy - R - 6 + 16);
  }, [data]);

  if (!data) return null;
  return (
    <div>


      <div className="feature-section">
        <div className="gfp-header">
          <div className="feature-title">Expression Distribution: Local vs Global</div>
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

        <canvas ref={violinRef} className="gfp-violin-canvas" />
      </div>
    </div>
  );
}
