import { useMemo } from "react";

export default function useClusterSelection({
  points = [],
  filteredIds = new Set(),
  selectedRegions = [],
  setSelectedRegions = () => {},
  setSelectedIds = () => {},
  viewerId = "viewer",
  labelKey = "label",
  resolveClusterIds = null,
}) {
  const idsByLabel = useMemo(() => {
    const map = new Map();
    for (const p of points ?? []) {
      const rawVal = p?.[labelKey];
      const label = Number.isFinite(rawVal) ? rawVal : p?.label;
      const id = p?.id;
      if (label == null || id == null) continue;
      let s = map.get(label);
      if (!s) {
        s = new Set();
        map.set(label, s);
      }
      s.add(id);
    }
    return map;
  }, [points]);

  function commitRegions(newRegions) {
    const union = new Set();
    for (const r of newRegions) {
      if (!r) continue;
      for (const id of r) union.add(id);
    }
    setSelectedRegions(newRegions);
    setSelectedIds(union);
    try { window.__selectionOwner = viewerId; } catch {}
  }

  function selectClusterByLabel(label, idOverride = null) {
    if (label == null) return false;
    const full =
      idOverride?.size > 0
        ? idOverride
        : typeof resolveClusterIds === "function"
          ? resolveClusterIds(label)
          : null;
    const src =
      full && full.size > 0 ? full : (idsByLabel.get(label) || new Set());
    const dst = new Set();
    const activeFilter = filteredIds && filteredIds.size > 0;
    if (activeFilter) {
      for (const id of src) if (filteredIds.has(id)) dst.add(id);
    } else {
      for (const id of src) dst.add(id);
    }
    if (dst.size === 0) return false;

    const prev = Array.isArray(selectedRegions) ? selectedRegions : [];
    let newRegions;
    if (prev.length === 0) newRegions = [dst];
    else if (prev.length === 1) newRegions = [prev[0], dst];
    else newRegions = [prev[1], dst];

    commitRegions(newRegions);
    return true;
  }

  function selectSingleById(id) {
    if (id == null) return false;
    const one = new Set([id]);
    commitRegions([one]);
    return true;
  }

  return { selectClusterByLabel, selectSingleById, idsByLabel };
}
