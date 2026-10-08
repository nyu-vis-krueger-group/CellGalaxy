import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  fetchChannelInfoMaps,
  defaultChannelColor,
  pickChannelColor,
} from "../utils/channelInfo";
import { readOmePixelRange, INTENSITY_FULL_RANGE, isFullRangePlaceholderWindow } from "../utils/intensityWindow";
import { rgbToHex, hexToRgb } from "../utils/color";
import "./ChannelManager.css";

export default function ChannelManager({
  selected,
  setSelected,
  colors = {},
  setColors = () => {},
  windows = {},
  setWindows = () => {},
  channelZarrIndexById = {},
  dataVersion = 0,
  omePixelRangeByChannelId = {},
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [serverChannelInfo, setServerChannelInfo] = useState({});
  const [tooltip, setTooltip] = useState({ show: false, value: '', x: 0, y: 0 });
  /** Last applied auto window per channel — re-sync when tile/OME stats refine, unless user dragged. */
  const lastAutoWindowRef = useRef({});

  // OME-TIFF or Zarr atlas tile stats → slider bounds + auto window (shared with Viv + Zarr)
  const getChannelRanges = (channel) => {
    const channelId = Number(channel?.id);
    const ome =
      Number.isFinite(channelId) && omePixelRangeByChannelId?.[channelId]
        ? omePixelRangeByChannelId[channelId]
        : null;
    const range = readOmePixelRange(ome);
    if (range) {
      return {
        dataMin: range.dataMin,
        dataMax: range.dataMax,
        autoMin: range.autoMin,
        autoMax: range.autoMax,
      };
    }
    // No OME / Zarr range yet: full-range placeholder until tile or OME stats arrive.
    return {
      dataMin: 0,
      dataMax: INTENSITY_FULL_RANGE,
      autoMin: 0,
      autoMax: INTENSITY_FULL_RANGE,
    };
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const parsed = await fetchChannelInfoMaps(undefined);
        if (cancelled) return;
        setServerChannelInfo(
          parsed?.catalog?.length
            ? { channels: parsed.catalog.map(({ id, name }) => ({ id, name })) }
            : {},
        );
      } catch (err) {
        console.error("channel_info fetch failed", err);
        if (!cancelled) setServerChannelInfo({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const channelInfo = useMemo(() => serverChannelInfo, [serverChannelInfo]);

  useEffect(() => {
    const channels = channelInfo.channels || [];
    const validIds = new Set(channels.map((ch) => ch.id));
    if (validIds.size === 0) {
      if (selected.length > 0) setSelected([]);
      return;
    }
    const filtered = selected.filter((id) => validIds.has(id));
    if (filtered.length !== selected.length) {
      setSelected(filtered);
    }
  }, [channelInfo, selected, setSelected]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (event.target.closest('.dropdown-item')) {
        return;
      }
      
      if (showDropdown && !event.target.closest('.add-channel-section')) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showDropdown]);

  useEffect(() => {
    if (!selected?.length) return;
    const channels = channelInfo.channels || [];
    const eps = 1e-6;
    setWindows((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const channelId of selected) {
        const channel = channels.find((ch) => ch.id === channelId);
        if (!channel) continue;
        const ome = readOmePixelRange(omePixelRangeByChannelId?.[channelId]);
        if (!ome) continue;
        const cur = prev?.[channelId];
        const lastAuto = lastAutoWindowRef.current[channelId];
        const isDefaultWindow = isFullRangePlaceholderWindow(cur);
        const matchesLastAuto =
          lastAuto &&
          cur &&
          Math.abs((cur.min ?? NaN) - lastAuto.min) < eps &&
          Math.abs((cur.max ?? NaN) - lastAuto.max) < eps;
        if (cur?.user) {
          lastAutoWindowRef.current[channelId] = {
            min: ome.autoMin,
            max: ome.autoMax,
          };
          continue;
        }
        if (!cur || isDefaultWindow || matchesLastAuto || !lastAuto) {
          next[channelId] = { min: ome.autoMin, max: ome.autoMax };
          changed = true;
        }
        lastAutoWindowRef.current[channelId] = {
          min: ome.autoMin,
          max: ome.autoMax,
        };
      }
      return changed ? next : prev;
    });
  }, [selected, channelInfo, omePixelRangeByChannelId, setWindows]);

  const availableChannels = channelInfo.channels?.filter(
    (ch) => !selected.includes(ch.id)
  ) || [];

  const defaultColorFor = (id) => defaultChannelColor(id);

  const addChannel = (channel) => {
    setSelected(prev => [...prev, channel.id]);
    setColors((prev) => {
      if (prev[channel.id]) return prev;
      const c = pickChannelColor(channel.id, prev);
      return { ...prev, [channel.id]: c };
    });
    const { autoMin, autoMax } = getChannelRanges(channel);
    setWindows((prev) => (
      prev[channel.id]
        ? prev
        : { ...prev, [channel.id]: { min: autoMin, max: autoMax } }
    ));
  };

  const removeChannel = (channelId) => {
    setSelected(prev => prev.filter(id => id !== channelId));
  };

  const handleSliderChange = (channelId, type, value) => {
    const v = Number(value);
    setWindows((prev) => {
      const cur = prev[channelId] || { min: 0, max: INTENSITY_FULL_RANGE };
      const next = { ...cur, [type]: v, user: true };
      if (next.min > next.max) {
        if (type === 'min') next.max = next.min;
        else next.min = next.max;
      }
      return { ...prev, [channelId]: next };
    });
  };

  const showTooltip = (value, event) => {
    setTooltip({
      show: true,
      value: Math.round(value),
      x: event.clientX,
      y: event.clientY - 30
    });
  };

  const hideTooltip = () => {
    setTooltip({ show: false, value: '', x: 0, y: 0 });
  };

  const renderSlider = (channelId, type, defaultValue, min, max) => {
    const current = windows?.[channelId] || { min: defaultValue, max: defaultValue };
    const currentValue = (type === 'min' ? current.min : current.max) ?? defaultValue;
    
    return (
      <input
        type="range"
        className={`range-slider range-slider-${type}`}
        min={min}
        max={max}
        step="any"
        value={currentValue}
        onChange={(e) => handleSliderChange(channelId, type, e.target.value)}
        onInput={(e) => handleSliderChange(channelId, type, e.target.value)}
        onMouseEnter={(e) => showTooltip(currentValue, e)}
        onMouseMove={(e) => showTooltip(currentValue, e)}
        onMouseLeave={hideTooltip}
      />
    );
  };

  return (
    <div className="channel-manager">
      <div className="channel-section-title">
        <span>Channels({selected.length} / 4)</span>
        
        <div className="add-channel-section">
          <div
            className="add-channel-button"
            onClick={() => setShowDropdown(!showDropdown)}
          >
            <span>+</span>
          </div>

          {showDropdown && (
            <div className="channel-dropdown">
              {availableChannels.length > 0 ? (
                availableChannels.map((channel) => (
                  <div
                    key={channel.id}
                    className="dropdown-item"
                    onClick={() => addChannel(channel)}
                  >
                    {channel.name}
                    {channelZarrIndexById[channel.id] == null &&
                    Object.keys(channelZarrIndexById).length > 0 ? (
                      <span className="channel-source-tag"> OME</span>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="dropdown-item disabled">
                  All channels have been added
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="selected-channels">
        {selected.map((channelId) => {
          const channel = channelInfo.channels?.find(ch => ch.id === channelId);
          if (!channel) return null;

          const { autoMin, autoMax } = getChannelRanges(channel);

          return (
            <div key={channelId} className="channel-item">
              <input
                type="color"
                className="color-picker"
                value={rgbToHex(colors[channelId] || defaultColorFor(channelId))}
                onChange={(e) => setColors((prev) => ({ ...prev, [channelId]: hexToRgb(e.target.value) }))}
              />

              <span className="channel-name" title={channel.name}>{channel.name}</span>

              <div className="range-slider-container">
                <div className="dual-range-slider">
                  {renderSlider(channelId, 'min', autoMin, 0, INTENSITY_FULL_RANGE)}
                  {renderSlider(channelId, 'max', autoMax, 0, INTENSITY_FULL_RANGE)}
                </div>
              </div>

              <button
                className="auto-button"
                onClick={() => {
                  const { autoMin: aMin, autoMax: aMax } = getChannelRanges(channel);
                  lastAutoWindowRef.current[channelId] = { min: aMin, max: aMax };
                  setWindows((prev) => ({
                    ...prev,
                    [channelId]: { min: aMin, max: aMax },
                  }));
                }}
              >
                Auto
              </button>

              <button
                className="delete-button"
                onClick={() => removeChannel(channelId)}
              >
                <span className="delete-channel material-icons">delete</span>
              </button>
            </div>
          );
        })}
      </div>
      
      {tooltip.show && (
        <div 
          className="custom-tooltip"
          style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y,
            zIndex: 10000
          }}
        >
          {tooltip.value}
        </div>
      )}
    </div>
  );
}
