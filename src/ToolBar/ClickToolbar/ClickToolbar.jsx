import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ClickToolbar.css";
import { clampPositionToParent } from "../../utils/utils";

export default function ClickToolbar({
  show,
  x,
  y,
  onClose = () => {},
  onViewRaw,
  onFindTopK = () => {},
}) {
  const rootRef = useRef(null);
  const [pos, setPos] = useState({ left: Math.round(x), top: Math.round(y) });

  // Clamp inside offset parent to prevent overflow
  const clamp = () => {
    const node = rootRef.current;
    if (!node) return;
    const { x: nx, y: ny } = clampPositionToParent(node, x + 6, y - 6, 8);
    setPos({ left: nx, top: ny });
  };
  useLayoutEffect(() => { clamp(); }, [x, y, show]);
  useEffect(() => {
    const onResize = () => clamp();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  if (!show) return null;
  const style = pos;
  const viewNavDisabled = typeof onViewRaw !== "function";
  return (
    <div ref={rootRef} className="click-toolbar" style={style}>
      <button
        className={`tb-btn ${viewNavDisabled ? "tb-btn-disabled" : ""}`}
        title={viewNavDisabled ? "View in other projection (disabled in single mode)" : "View meta data"}
        onClick={viewNavDisabled ? undefined : onViewRaw}
        disabled={viewNavDisabled}
      >
        <span className="material-icons">visibility</span>
      </button>
      <button className="tb-btn" title="Find similar cells" onClick={onFindTopK}>
        <span className="material-icons">search</span>
      </button>
      <div className="tb-divider" />
      <button className="tb-btn tb-close" title="Close" onClick={onClose}>
        <span className="material-icons">close</span>
      </button>
    </div>
  );
}


