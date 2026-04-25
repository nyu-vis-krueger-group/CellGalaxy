import { useState, useEffect } from "react";
import { SolidPolygonLayer } from "@deck.gl/layers";
import { clusterColor } from "../utils/clustering";
import { pointInPolygon, getEventCoordinates } from "../utils/utils";


function outlinePathToWorld(path, pixelYFlipHeight) {
  if (pixelYFlipHeight == null || !Number.isFinite(pixelYFlipHeight) || !Array.isArray(path)) {
    return path;
  }
  const h = pixelYFlipHeight;
  return path.map(([x, y, z = 0]) => [x, h - y, z]);
}

export default function ClusterHoverMask({
  outlineData = [],
  is3D = false,
  deckRef,
  containerRef,
  active = true,
  altPressed = false,
  /** Match scatter/PathLayer: world y = h - raw_y */
  pixelYFlipHeight = null,

  screenOutlines3D = [],
  children = () => null,
}) {
  const [hoverMask, setHoverMask] = useState(null);      // 2D: world-space polygon
  const [hoverMask3D, setHoverMask3D] = useState(null);  // 3D: screen-space path

  const onHover = (info) => {
    if (!active) { setHoverMask(null); setHoverMask3D(null); return; }

    const altFromEvent = !!(info && info.srcEvent && info.srcEvent.altKey);
    const preferCluster = altPressed || altFromEvent;
    if (!preferCluster) { setHoverMask(null); setHoverMask3D(null); return; }
    if (!is3D && (!outlineData || outlineData.length === 0)) { setHoverMask(null); return; }
    if (is3D && (!screenOutlines3D || screenOutlines3D.length === 0)) { setHoverMask3D(null); return; }
    try {
      const deck = deckRef.current?.deck;
      const viewport = deck?.getViewports?.()[0];
      if (!viewport) { setHoverMask(null); setHoverMask3D(null); return; }
      const { x, y } = getEventCoordinates(info, containerRef);
      if (!is3D) {
        for (const o of outlineData) {
          const pathW = outlinePathToWorld(o.path, pixelYFlipHeight);
          const polyScreen = pathW.map(([wx, wy, wz]) =>
            viewport.project([wx, wy, wz || 0]),
          );
          if (polyScreen.length >= 3 && pointInPolygon([x, y], polyScreen)) {
            const rgb = clusterColor(o.label ?? 0);

            setHoverMask({
              path: pathW,
              color: [rgb[0], rgb[1], rgb[2], 64],
            });
            setHoverMask3D(null);
            return;
          }
        }
        setHoverMask(null);
      } else {

        for (const s of screenOutlines3D) {
          const poly = s.poly || [];
          if (poly.length >= 3 && pointInPolygon([x, y], poly)) {
            const rgb = s.rgb || [255, 255, 255];
            setHoverMask3D({
              d: s.d,
              fill: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.25)`,
              label: s.label,
            });
            setHoverMask(null);
            return;
          }
        }
        setHoverMask3D(null);
      }
    } catch {
      setHoverMask(null);
      setHoverMask3D(null);
    }
  };

  // when hover on 3D mode, update the hover mask 
  useEffect(() => {
    if (!is3D || !hoverMask3D || !screenOutlines3D || screenOutlines3D.length === 0) return;
    const s = screenOutlines3D.find((o) => o.label === hoverMask3D.label);
    if (!s) return;
    const rgb = s.rgb || [255, 255, 255];
    setHoverMask3D((prev) =>
      prev
        ? {
            d: s.d,
            fill: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.25)`,
            label: s.label,
          }
        : prev
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, screenOutlines3D]);

  const layers = [];
  if (!is3D && hoverMask) {
    layers.push(
      new SolidPolygonLayer({
        id: "cluster-hover-mask",
        data: [hoverMask],
        getPolygon: (d) => d.path,
        getFillColor: (d) => d.color,
        stroked: false,
        filled: true,
        pickable: false,
        parameters: { depthTest: false, blend: true, blendFunc: [1, 771] }, // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
        updateTriggers: { getFillColor: [hoverMask?.color?.join(',')], getPolygon: [hoverMask?.path?.length] }
      })
    );
  }

  const child = children({ onHover, layers });
  return (
    <>
      {child}
      {is3D && hoverMask3D && (
        <svg className="cluster-outline-svg">
          <path d={hoverMask3D.d} fill={hoverMask3D.fill} stroke="none" />
        </svg>
      )}
    </>
  );
}

