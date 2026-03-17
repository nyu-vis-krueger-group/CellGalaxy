import React, { useEffect, useState, useMemo, useRef } from "react";
import "./AnnotationStatsPopover.css";

const API_BASE =
  typeof window !== "undefined" && window.location?.port === "3000"
    ? "http://localhost:8000"
    : "";

function computeCounts(rawList, selectedIdSet, selectedRegions) {
  const globalByKey = {};
  const localByKey = {};
  const region1ByKey = {};
  const region2ByKey = {};
  const set1 = Array.isArray(selectedRegions) && selectedRegions.length >= 1 && selectedRegions[0]?.has
    ? selectedRegions[0]
    : null;
  const set2 = Array.isArray(selectedRegions) && selectedRegions.length >= 2 && selectedRegions[1]?.has
    ? selectedRegions[1]
    : null;
  const twoRegions = set1 && set2;

  for (const item of rawList) {
    const id = item.id;
    const ct = item.raw?.celltype != null ? String(item.raw.celltype).trim() : null;
    const nn = item.raw?.neigh_names != null ? String(item.raw.neigh_names).trim() : null;
    if (ct && ct.toLowerCase() !== "unknown") {
      globalByKey[ct] = (globalByKey[ct] || 0) + 1;
      if (selectedIdSet && selectedIdSet.has(id)) {
        localByKey[ct] = (localByKey[ct] || 0) + 1;
      }
      if (twoRegions) {
        if (set1.has(id)) region1ByKey[ct] = (region1ByKey[ct] || 0) + 1;
        if (set2.has(id)) region2ByKey[ct] = (region2ByKey[ct] || 0) + 1;
      }
    }
    if (nn) {
      const key = `neigh:${nn}`;
      globalByKey[key] = (globalByKey[key] || 0) + 1;
      if (selectedIdSet && selectedIdSet.has(id)) {
        localByKey[key] = (localByKey[key] || 0) + 1;
      }
      if (twoRegions) {
        if (set1.has(id)) region1ByKey[key] = (region1ByKey[key] || 0) + 1;
        if (set2.has(id)) region2ByKey[key] = (region2ByKey[key] || 0) + 1;
      }
    }
  }
  return {
    globalByKey,
    localByKey,
    region1ByKey: twoRegions ? region1ByKey : null,
    region2ByKey: twoRegions ? region2ByKey : null,
  };
}

function BarChartSection({ title, globalByKey, localByKey, prefix = "" }) {
  const keys = useMemo(() => {
    const set = new Set([
      ...Object.keys(globalByKey).filter((k) => k.startsWith(prefix)),
      ...Object.keys(localByKey).filter((k) => k.startsWith(prefix)),
    ]);
    return [...set].sort();
  }, [globalByKey, localByKey, prefix]);

  const totalGlobal = useMemo(
    () => keys.reduce((s, k) => s + (globalByKey[k] || 0), 0),
    [keys, globalByKey]
  );
  const totalLocal = useMemo(
    () => keys.reduce((s, k) => s + (localByKey[k] || 0), 0),
    [keys, localByKey]
  );

  if (keys.length === 0) return null;
  const label = (k) => (prefix ? k.replace(prefix, "") : k);

  return (
    <div className="annotation-stats-section">
      <div className="annotation-stats-section-title">{title}</div>
      <div className="annotation-stats-legend">
        <span className="annotation-stats-legend-item global">Global % (left)</span>
        <span className="annotation-stats-legend-item local">Selection % (right)</span>
      </div>
      <div className="annotation-stats-chart">
        {keys.map((key) => {
          const g = globalByKey[key] || 0;
          const l = localByKey[key] || 0;
          const gPct = totalGlobal > 0 ? (g / totalGlobal) * 100 : 0;
          const lPct = totalLocal > 0 ? (l / totalLocal) * 100 : 0;
          const gPctStr = totalGlobal > 0 ? `${(gPct).toFixed(1)}%` : "0%";
          const lPctStr = totalLocal > 0 ? `${(lPct).toFixed(1)}%` : "0%";
          return (
            <div key={key} className="annotation-stats-row">
              <div className="annotation-stats-label" title={label(key)}>
                {label(key)}
              </div>
              <div className="annotation-stats-bars-symmetric">
                <div className="annotation-stats-bars-half left">
                  <span className="annotation-stats-pct-outside left" title={`${g.toLocaleString()} cells`}>
                    {gPctStr}
                  </span>
                  <div
                    className="annotation-stats-bar-wrap"
                    style={{ width: g === 0 ? 0 : `${gPct}%` }}
                    title={`${g.toLocaleString()} cells`}
                  >
                    <div className="annotation-stats-bar global" />
                  </div>
                </div>
                <div className="annotation-stats-bar-center" />
                <div className="annotation-stats-bars-half right">
                  <div
                    className="annotation-stats-bar-wrap"
                    style={{ width: l === 0 ? 0 : `${lPct}%` }}
                    title={`${l.toLocaleString()} cells`}
                  >
                    <div className="annotation-stats-bar local" />
                  </div>
                  <span className="annotation-stats-pct-outside right" title={`${l.toLocaleString()} cells`}>
                    {lPctStr}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupBarChartSection({ title, globalByKey, region1ByKey, region2ByKey, prefix = "" }) {
  const keys = useMemo(() => {
    const set = new Set([
      ...Object.keys(globalByKey || {}).filter((k) => k.startsWith(prefix)),
      ...Object.keys(region1ByKey || {}).filter((k) => k.startsWith(prefix)),
      ...Object.keys(region2ByKey || {}).filter((k) => k.startsWith(prefix)),
    ]);
    return [...set]
      .filter((k) => (region1ByKey?.[k] || 0) > 0 || (region2ByKey?.[k] || 0) > 0)
      .sort();
  }, [globalByKey, region1ByKey, region2ByKey, prefix]);

  const totalGlobal = useMemo(
    () => keys.reduce((s, k) => s + (globalByKey?.[k] || 0), 0),
    [keys, globalByKey]
  );
  const totalR1 = useMemo(
    () => keys.reduce((s, k) => s + (region1ByKey?.[k] || 0), 0),
    [keys, region1ByKey]
  );
  const totalR2 = useMemo(
    () => keys.reduce((s, k) => s + (region2ByKey?.[k] || 0), 0),
    [keys, region2ByKey]
  );

  if (keys.length === 0) return null;
  const label = (k) => (prefix ? k.replace(prefix, "") : k);

  return (
    <div className="annotation-stats-section">
      <div className="annotation-stats-section-header-group">
        <div className="annotation-stats-section-title">{title}</div>
        <div className="annotation-stats-legend annotation-stats-legend-group">
          <span className="annotation-stats-legend-item global">Global</span>
          <span className="annotation-stats-legend-item region1">Region 1</span>
          <span className="annotation-stats-legend-item region2">Region 2</span>
        </div>
      </div>
      <div className="annotation-stats-chart-rows">
        <div className="annotation-stats-rows">
          {keys.map((key) => {
            const g = globalByKey?.[key] || 0;
            const r1 = region1ByKey?.[key] || 0;
            const r2 = region2ByKey?.[key] || 0;
            const gPct = totalGlobal > 0 ? (g / totalGlobal) * 100 : 0;
            const r1Pct = totalR1 > 0 ? (r1 / totalR1) * 100 : 0;
            const r2Pct = totalR2 > 0 ? (r2 / totalR2) * 100 : 0;
            const gPctStr = totalGlobal > 0 ? `${(gPct).toFixed(1)}%` : "0%";
            const r1PctStr = totalR1 > 0 ? `${(r1Pct).toFixed(1)}%` : "0%";
            const r2PctStr = totalR2 > 0 ? `${(r2Pct).toFixed(1)}%` : "0%";
            return (
              <div key={key} className="annotation-stats-row-group">
                <div className="annotation-stats-y-label" title={label(key)}>
                  {label(key)}
                </div>
                <div className="annotation-stats-bar-group annotation-stats-bar-group-h">
                  <div className="annotation-stats-bar-row-h">
                    <div className="annotation-stats-bar-track-h">
                      <div className="annotation-stats-bar-fill-h">
                        <div
                          className="annotation-stats-bar-h global"
                          style={{ width: g === 0 ? "0%" : `${Math.min(100, gPct)}%` }}
                          title={`Global: ${g.toLocaleString()} (${gPctStr})`}
                        />
                        <span className="annotation-stats-bar-pct" style={{ left: `${gPct}%` }}>{gPctStr}</span>
                      </div>
                      <span className="annotation-stats-bar-pct-spacer" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="annotation-stats-bar-row-h">
                    <div className="annotation-stats-bar-track-h">
                      <div className="annotation-stats-bar-fill-h">
                        <div
                          className="annotation-stats-bar-h region1"
                          style={{ width: r1 === 0 ? "0%" : `${Math.min(100, r1Pct)}%` }}
                          title={`Region 1: ${r1.toLocaleString()} (${r1PctStr})`}
                        />
                        <span className="annotation-stats-bar-pct" style={{ left: `${r1Pct}%` }}>{r1PctStr}</span>
                      </div>
                      <span className="annotation-stats-bar-pct-spacer" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="annotation-stats-bar-row-h">
                    <div className="annotation-stats-bar-track-h">
                      <div className="annotation-stats-bar-fill-h">
                        <div
                          className="annotation-stats-bar-h region2"
                          style={{ width: r2 === 0 ? "0%" : `${Math.min(100, r2Pct)}%` }}
                          title={`Region 2: ${r2.toLocaleString()} (${r2PctStr})`}
                        />
                        <span className="annotation-stats-bar-pct" style={{ left: `${r2Pct}%` }}>{r2PctStr}</span>
                      </div>
                      <span className="annotation-stats-bar-pct-spacer" aria-hidden="true" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function AnnotationStatsPopover({
  open,
  onClose,
  selectedIds = new Set(),
  selectedRegions = [],
}) {
  const [rawList, setRawList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    let cancelled = false;
    fetch(`${API_BASE}/public/raw.json?ts=${Date.now()}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load raw data");
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (!Array.isArray(data) || data.length < 2) {
          setRawList([]);
          return;
        }
        setRawList(data.slice(1));
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Load failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const { globalByKey, localByKey, region1ByKey, region2ByKey } = useMemo(() => {
    const selectedSet = selectedIds && selectedIds.size > 0 ? selectedIds : null;
    return computeCounts(rawList, selectedSet, selectedRegions);
  }, [rawList, selectedIds, selectedRegions]);

  const isCompareMode = region1ByKey != null && region2ByKey != null;

  const cellTypeGlobal = useMemo(() => {
    const o = {};
    for (const [k, v] of Object.entries(globalByKey)) {
      if (!k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [globalByKey]);
  const cellTypeLocal = useMemo(() => {
    const o = {};
    for (const [k, v] of Object.entries(localByKey)) {
      if (!k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [localByKey]);
  const cellTypeRegion1 = useMemo(() => {
    if (!region1ByKey) return null;
    const o = {};
    for (const [k, v] of Object.entries(region1ByKey)) {
      if (!k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [region1ByKey]);
  const cellTypeRegion2 = useMemo(() => {
    if (!region2ByKey) return null;
    const o = {};
    for (const [k, v] of Object.entries(region2ByKey)) {
      if (!k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [region2ByKey]);
  const neighGlobal = useMemo(() => {
    const o = {};
    for (const [k, v] of Object.entries(globalByKey)) {
      if (k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [globalByKey]);
  const neighLocal = useMemo(() => {
    const o = {};
    for (const [k, v] of Object.entries(localByKey)) {
      if (k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [localByKey]);
  const neighRegion1 = useMemo(() => {
    if (!region1ByKey) return null;
    const o = {};
    for (const [k, v] of Object.entries(region1ByKey)) {
      if (k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [region1ByKey]);
  const neighRegion2 = useMemo(() => {
    if (!region2ByKey) return null;
    const o = {};
    for (const [k, v] of Object.entries(region2ByKey)) {
      if (k.startsWith("neigh:")) o[k] = v;
    }
    return o;
  }, [region2ByKey]);

  const [position, setPosition] = useState(null);
  const dragRef = useRef({ startX: 0, startY: 0, startLeft: 0, startTop: 0 });

  useEffect(() => {
    if (!open) setPosition(null);
  }, [open]);

  const handleDragStart = (e) => {
    if (!e.target.closest(".annotation-stats-drag-handle")) return;
    if (e.target.closest(".annotation-stats-close")) return;
    e.preventDefault();
    const popover = e.currentTarget.closest(".annotation-stats-popover");
    if (!popover) return;
    const rect = popover.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: position ? position.x : cx,
      startTop: position ? position.y : cy,
    };
    const onMove = (ev) => {
      setPosition({
        x: dragRef.current.startLeft + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.startTop + (ev.clientY - dragRef.current.startY),
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!open) return null;

  const style = position
    ? { left: position.x, top: position.y, transform: "translate(-50%, -50%)" }
    : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div
      className="annotation-stats-popover"
      style={style}
      role="dialog"
      aria-label="Cell type and Neigh names statistics"
    >
      <div
        className="annotation-stats-header annotation-stats-drag-handle"
        onMouseDown={handleDragStart}
      >
        <span className="annotation-stats-title">Cell type & Neigh names</span>
        <button type="button" className="annotation-stats-close" onClick={onClose} title="Close" aria-label="Close">
          <span className="material-icons">close</span>
        </button>
      </div>
      <div className="annotation-stats-body">
        {loading && <div className="annotation-stats-loading">Loading…</div>}
        {error && <div className="annotation-stats-error">{error}</div>}
        {!loading && !error && rawList.length > 0 && (
          <>
            {isCompareMode ? (
              <>
                <GroupBarChartSection
                  title="Cell type"
                  globalByKey={cellTypeGlobal}
                  region1ByKey={cellTypeRegion1}
                  region2ByKey={cellTypeRegion2}
                />
                <GroupBarChartSection
                  title="Neigh names"
                  globalByKey={neighGlobal}
                  region1ByKey={neighRegion1}
                  region2ByKey={neighRegion2}
                  prefix="neigh:"
                />
              </>
            ) : (
              <>
                <BarChartSection
                  title="Cell type"
                  globalByKey={cellTypeGlobal}
                  localByKey={cellTypeLocal}
                />
                <BarChartSection
                  title="Neigh names"
                  globalByKey={neighGlobal}
                  localByKey={neighLocal}
                  prefix="neigh:"
                />
              </>
            )}
          </>
        )}
        {!loading && !error && rawList.length === 0 && (
          <div className="annotation-stats-empty">No annotation data.</div>
        )}
      </div>
    </div>
  );
}
