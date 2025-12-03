import React, { useEffect, useMemo, useRef, useState } from "react";
import "./FeatureDock.css";
import { fetchT1, fetchT2 } from "../api/api";
import { buildIconMappingsByChunk } from "../utils";
import CellAnalysisPanel from "../FeaturePanel/LocalFeaturePanel/LocalFeaturePanel";
import GroupAnalysisPanel from "../FeaturePanel/GroupFeaturePanel/GroupFeaturePanel";

export default function FeatureDock({
  meta,
  chunkUV,
  atlasURL,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
  // points for two projections (used to locate thumbnails metadata)
  pointsRaw = [],
  pointsUMAP = [],
  useUMAP = false,
  setSelectedIds = () => {},

  analysisCommand = null,
}) {
  const iconMappingsByChunk = useMemo(
    () => buildIconMappingsByChunk(meta, chunkUV),
    [meta, chunkUV]
  );

  const [mode, setMode] = useState("none"); // 'none' | 't1' | 't2'
  const [t1, setT1] = useState(null);
  const [t2, setT2] = useState(null);
  const activeQueryRef = useRef(null);


  useEffect(() => {
    if (!analysisCommand) return;
    const run = async () => {
      if (analysisCommand.type === "t1" && Number.isFinite(analysisCommand.q)) {
        const q = Number(analysisCommand.q);
        setMode("t1");
        setT2(null);
        const res = await fetchT1(q, 30, undefined);
        if (!res || res.error) return;
        setT1(res);
        activeQueryRef.current = q;

        try {
          const neighborIds = (res.neighbors || []).map((n) => n.id);
          const all = new Set([q, ...neighborIds]);
          setSelectedIds(all);
        } catch {}
      }
      if (analysisCommand.type === "t2" && Array.isArray(analysisCommand.ids)) {
        const ids = analysisCommand.ids.map((x) => Number(x)).filter((x) => Number.isFinite(x));
        if (ids.length === 0) return;
        setMode("t2");
        setT1(null);
        activeQueryRef.current = null;
        const res = await fetchT2(ids, undefined);
        if (!res || res.error) return;
        setT2(res);
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisCommand]);

  const open = mode !== "none";

  return (
    <div className={`feature-dock ${open ? "open" : ""}`}>
      {mode === "t1" && t1 && (
        <CellAnalysisPanel
          data={t1}
          iconMappingsByChunk={iconMappingsByChunk}
          chunkUV={chunkUV}
          atlasByChannel={atlasByChannel}
          atlasURL={atlasURL}
          channels={channels}
          colors={colors}
          alphas={alphas}
          windows={windows}
          points={useUMAP ? pointsUMAP : pointsRaw}
          viewerId={useUMAP ? "umap" : "raw"}
        />
      )}
      {mode === "t2" && t2 && (
        <GroupAnalysisPanel
          data={t2}
          iconMappingsByChunk={iconMappingsByChunk}
          chunkUV={chunkUV}
          atlasByChannel={atlasByChannel}
          atlasURL={atlasURL}
          channels={channels}
          colors={colors}
          alphas={alphas}
          points={useUMAP ? pointsUMAP : pointsRaw}
        />
      )}
    </div>
  );
}


