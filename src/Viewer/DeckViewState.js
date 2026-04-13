import { useEffect, useMemo, useRef, useState } from "react";
import { LinearInterpolator } from "@deck.gl/core";
import { computeCenter, ease } from "../utils/utils";

export default function DeckViewState({
  points = [],
  is3D = false,
  sharedZoom,
  setSharedZoom,
  initialZoom = 8,
  imageSize = 4,
  transitionsEnabled = true,
}) {
  const center = useMemo(() => computeCenter(points), [points]);

  const [viewState, setViewState] = useState(() => ({
    target: [0, 0, 0],
    zoom: typeof sharedZoom === "number" ? sharedZoom : initialZoom,
    rotationX: 0,
    rotationOrbit: 0,
    transitionDuration: 0,
    transitionEasing: undefined,
    transitionInterpolator: undefined,
  }));

  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current && points.length) {
      setViewState((prev) => ({ ...prev, target: center }));
      initialized.current = true;
    }
  }, [center, points.length]);

  useEffect(() => {
    if (typeof sharedZoom === "number" && sharedZoom !== viewState.zoom) {
      setViewState((prev) => ({ ...prev, zoom: sharedZoom }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedZoom]);

  useEffect(() => {
    setViewState((prev) => ({
      ...prev,
      rotationX: is3D ? 45 : 0,
      transitionDuration: transitionsEnabled ? 600 : 0,
      transitionEasing: transitionsEnabled ? ease : undefined,
      transitionInterpolator: transitionsEnabled
        ? new LinearInterpolator(["rotationX", "rotationOrbit", "target"])
        : undefined,
    }));
  }, [is3D, transitionsEnabled]);

  const [altPressed, setAltPressed] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e && e.altKey) setAltPressed(true);
      if (is3D && e?.key === " ") {
        e.preventDefault();
        setAutoRotate((prev) => !prev);
      }
    };
    const onKeyUp = (e) => {
      if (!e || !e.altKey) setAltPressed(false);
    };
    const onBlur = () => setAltPressed(false);
    try {
      window.addEventListener("keydown", onKeyDown, { passive: false });
      window.addEventListener("keyup", onKeyUp, { passive: true });
      window.addEventListener("blur", onBlur, { passive: true });
    } catch {}
    return () => {
      try {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
      } catch {}
    };
  }, [is3D]);

  // Space: 3D auto-rotate (rAF)
  const autoRotateSpeed = 0.3; // deg/frame (was 0.15)
  useEffect(() => {
    if (!is3D || !autoRotate) return;
    let rafId;
    const tick = () => {
      setViewState((prev) => ({
        ...prev,
        rotationOrbit: (prev.rotationOrbit ?? 0) + autoRotateSpeed,
      }));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [is3D, autoRotate]);

  const baseZoomRef = useRef(null);
  if (baseZoomRef.current == null) baseZoomRef.current = viewState.zoom;
  const zoomScale = Math.pow(2, (viewState.zoom ?? 0) - (baseZoomRef.current ?? 0));
  const computedImageSize = Math.max(1, Math.min(2048, imageSize * zoomScale));

  const handleViewStateChange = ({ viewState: next }) => {
    const isZoomChange = next.zoom !== viewState.zoom;
    setViewState((prev) => ({
      ...prev,
      ...next,
      transitionDuration: isZoomChange ? 0 : next.transitionDuration ?? prev.transitionDuration,
    }));
    if (typeof setSharedZoom === "function" && next.zoom !== sharedZoom) {
      setSharedZoom(next.zoom);
    }
  };

  return {
    viewState,
    setViewState,
    handleViewStateChange,
    computedImageSize,
    altPressed,
    autoRotate,
  };
}


