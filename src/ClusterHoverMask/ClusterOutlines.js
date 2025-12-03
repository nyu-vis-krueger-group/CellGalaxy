import { useEffect, useState } from "react";
import { projectOutlines3D } from "../utils/clustering";

export default function ClusterOutlines({
  is3D = false,
  clusterOutlineOn = false,
  forceCompute = false,
  points = [],
  filteredIds = new Set(),
  deckRef,
  viewDeps = [],
  labelKey = "label",
}) {
  const [screenOutlines, setScreenOutlines] = useState([]);

  useEffect(() => {
    if (!is3D || (!clusterOutlineOn && !forceCompute)) {
      setScreenOutlines([]);
      return;
    }
    try {
      const deck = deckRef.current?.deck;
      const viewport = deck?.getViewports?.()[0];
      if (!viewport || !points || points.length < 3) {
        setScreenOutlines([]);
        return;
      }
      const paths = projectOutlines3D(viewport, points, filteredIds, labelKey);
      setScreenOutlines(paths);
    } catch {
      setScreenOutlines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, clusterOutlineOn, forceCompute, points, filteredIds, deckRef, labelKey, ...viewDeps]);

  return screenOutlines;
}

