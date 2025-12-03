export const defaultRegionColors = [
  [255, 140, 0, 255],  // orange
  [0, 200, 255, 255],  // cyan
];

export function makeRegionIndexGetter(selectedRegions) {
  const regions = Array.isArray(selectedRegions) ? selectedRegions : [];
  return function getRegionIndexForId(id) {
    if (regions.length === 0) return -1;
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (r && typeof r.has === "function" && r.has(id)) return i;
    }
    return -1;
  };
}


