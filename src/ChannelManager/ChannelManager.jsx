import React, { useState, useEffect, useMemo } from "react";
import "./ChannelManager.css";

export default function ChannelManager({
  selected,
  setSelected,
  colors = {},
  setColors = () => {},
  windows = {},
  setWindows = () => {},
  dataVersion = 0,
  omePixelRangeByChannelId = {},
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [serverChannelInfo, setServerChannelInfo] = useState({});
  const [tooltip, setTooltip] = useState({ show: false, value: '', x: 0, y: 0 });

  // pixel_value_range → slider bounds + auto window
  const getChannelRanges = (channel) => {
    const channelId = Number(channel?.id);
    const omePv =
      Number.isFinite(channelId) && omePixelRangeByChannelId && omePixelRangeByChannelId[channelId]
        ? omePixelRangeByChannelId[channelId]
        : null;
    const pv = omePv || channel?.pixel_value_range || {};
    const dataMin = Number.isFinite(pv.data_min)
      ? pv.data_min
      : (Number.isFinite(pv.min) ? pv.min : 0);
    const dataMax = Number.isFinite(pv.data_max)
      ? pv.data_max
      : (Number.isFinite(pv.max) ? pv.max : 65535);
    const autoMin = Number.isFinite(pv.auto_min) ? pv.auto_min : dataMin;
    const autoMax = Number.isFinite(pv.auto_max) ? pv.auto_max : dataMax;
    return { dataMin, dataMax, autoMin, autoMax };
  };
  const getServerChannelRanges = (channel) => {
    const pv = channel?.pixel_value_range || {};
    const dataMin = Number.isFinite(pv.data_min)
      ? pv.data_min
      : (Number.isFinite(pv.min) ? pv.min : 0);
    const dataMax = Number.isFinite(pv.data_max)
      ? pv.data_max
      : (Number.isFinite(pv.max) ? pv.max : 65535);
    const autoMin = Number.isFinite(pv.auto_min) ? pv.auto_min : dataMin;
    const autoMax = Number.isFinite(pv.auto_max) ? pv.auto_max : dataMax;
    return { dataMin, dataMax, autoMin, autoMax };
  };

  useEffect(() => {
    const fetchChannelInfo = async () => {
      try {
        const response = await fetch(`/public/channel_info.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
          setServerChannelInfo({});
          return;
        }
        const data = await response.json();
        setServerChannelInfo(data);
      } catch (err) {
        console.error("channel_info fetch failed", err);
        setServerChannelInfo({});
      }
    };

    fetchChannelInfo();
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
        const ome = omePixelRangeByChannelId?.[channelId];
        if (!ome) continue;
        const cur = prev?.[channelId];
        const server = getServerChannelRanges(channel);
        const isCurrentServerAuto =
          cur &&
          Math.abs((cur.min ?? NaN) - server.autoMin) < eps &&
          Math.abs((cur.max ?? NaN) - server.autoMax) < eps;
        if (!cur || isCurrentServerAuto) {
          next[channelId] = { min: ome.auto_min, max: ome.auto_max };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selected, channelInfo, omePixelRangeByChannelId, setWindows]);

  const availableChannels = channelInfo.channels?.filter(
    (ch) => !selected.includes(ch.id)
  ) || [];

  const palette = [
    [255, 0, 0], [0, 255, 0], [0, 128, 255], [255, 255, 0], [255, 0, 255],
    [0, 255, 255], [255, 128, 0], [128, 0, 255], [0, 255, 128], [255, 0, 128]
  ];
  
  const toHex = (rgb) => {
    const [r, g, b] = rgb || [255, 255, 255];
    return `#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
  };
  
  const fromHex = (hex) => {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '#ffffff');
    return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : [255, 255, 255];
  };
  
  const defaultColorFor = (id) => palette[id % palette.length];

  const addChannel = (channel) => {
    setSelected(prev => [...prev, channel.id]);
    if (!colors[channel.id]) {
      const c = defaultColorFor(channel.id);
      setColors((prev) => ({ ...prev, [channel.id]: c }));
    }
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
      const cur = prev[channelId] || { min: 0, max: 65535 };
      const next = { ...cur, [type]: v };
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

          const { dataMin, dataMax, autoMin, autoMax } = getChannelRanges(channel);

          return (
            <div key={channelId} className="channel-item">
              <input
                type="color"
                className="color-picker"
                value={toHex(colors[channelId] || defaultColorFor(channelId))}
                onChange={(e) => setColors((prev) => ({ ...prev, [channelId]: fromHex(e.target.value) }))}
              />

              <span className="channel-name" title={channel.name}>{channel.name}</span>

              <div className="range-slider-container">
                <div className="dual-range-slider">
                  {renderSlider(channelId, 'min', autoMin, dataMin, dataMax)}
                  {renderSlider(channelId, 'max', autoMax, dataMin, dataMax)}
                </div>
              </div>

              <button
                className="auto-button"
                onClick={() => {
                  const { autoMin: aMin, autoMax: aMax } = getChannelRanges(channel);
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
