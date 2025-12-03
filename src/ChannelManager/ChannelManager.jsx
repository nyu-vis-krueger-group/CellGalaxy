import React, { useState, useEffect } from "react";
import "./ChannelManager.css";

export default function ChannelManager({
  selected,
  setSelected,
  colors = {},
  setColors = () => {},
  windows = {},
  setWindows = () => {},
  dataVersion = 0,
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [channelInfo, setChannelInfo] = useState({});
  // Slider read/write directly uses global windows (min/max for each channel)
  const [tooltip, setTooltip] = useState({ show: false, value: '', x: 0, y: 0 });

  // Normalize backend pixel_value_range into:
  // - dataMin/dataMax: true global range (slider bounds)
  // - autoMin/autoMax: recommended automatic window (based on 1%-99% percentiles)
  const getChannelRanges = (channel) => {
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

  // Get channel information
  useEffect(() => {
    const fetchChannelInfo = async () => {
      try {
        const response = await fetch(`/public/channel_info.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
          setChannelInfo({});
          return;
        }
        const data = await response.json();
        setChannelInfo(data);
      } catch (err) {
        console.error("channel_info fetch failed", err);
        setChannelInfo({});
      }
    };

    fetchChannelInfo();
  }, [dataVersion]);

  useEffect(() => {
    const validIds = new Set(channelInfo.channels?.map((ch) => ch.id) || []);
    if (validIds.size === 0) {
      if (selected.length > 0) setSelected([]);
      return;
    }
    const filtered = selected.filter((id) => validIds.has(id));
    if (filtered.length !== selected.length) {
      setSelected(filtered);
    }
  }, [channelInfo, selected, setSelected]);

  // Listen for click events, close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      // If clicking on dropdown item, don't close menu
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

  // Calculate available channels (unselected)
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

  // Add channel
  const addChannel = (channel) => {
    setSelected(prev => [...prev, channel.id]);
    if (!colors[channel.id]) {
      const c = defaultColorFor(channel.id);
      setColors((prev) => ({ ...prev, [channel.id]: c }));
    }
    // If window has not been initialized, use recommended autoMin/autoMax as default window.
    const { autoMin, autoMax } = getChannelRanges(channel);
    setWindows((prev) => (
      prev[channel.id]
        ? prev
        : { ...prev, [channel.id]: { min: autoMin, max: autoMax } }
    ));
  };

  // Remove channel
  const removeChannel = (channelId) => {
    setSelected(prev => prev.filter(id => id !== channelId));
  };

  // Handle slider value changes
  const handleSliderChange = (channelId, type, value) => {
    const v = Number(value);
    setWindows((prev) => {
      const cur = prev[channelId] || { min: 0, max: 65535 };
      const next = { ...cur, [type]: v };
      // Ensure min <= max
      if (next.min > next.max) {
        if (type === 'min') next.max = next.min;
        else next.min = next.max;
      }
      return { ...prev, [channelId]: next };
    });
  };

  // Show tooltip
  const showTooltip = (value, event) => {
    setTooltip({
      show: true,
      value: Math.round(value),
      x: event.clientX,
      y: event.clientY - 30
    });
  };

  // Hide tooltip
  const hideTooltip = () => {
    setTooltip({ show: false, value: '', x: 0, y: 0 });
  };

  // Render slider (currently UI only; can be extended to normalized lo/hi control)
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
        
        {/* Add channel area */}
        <div className="add-channel-section">
          <div
            className="add-channel-button"
            onClick={() => setShowDropdown(!showDropdown)}
          >
            <span>+</span>
          </div>

          {/* Dropdown list */}
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

      {/* Selected channels list */}
      <div className="selected-channels">
        {selected.map((channelId) => {
          const channel = channelInfo.channels?.find(ch => ch.id === channelId);
          if (!channel) return null;

          const { dataMin, dataMax, autoMin, autoMax } = getChannelRanges(channel);

          return (
            <div key={channelId} className="channel-item">
              {/* Color picker */}
              <input
                type="color"
                className="color-picker"
                value={toHex(colors[channelId] || defaultColorFor(channelId))}
                onChange={(e) => setColors((prev) => ({ ...prev, [channelId]: fromHex(e.target.value) }))}
              />

              {/* Channel name */}
              <span className="channel-name" title={channel.name}>{channel.name}</span>

              {/* Dual-end slider */}
              <div className="range-slider-container">
                <div className="dual-range-slider">
                  {renderSlider(channelId, 'min', autoMin, dataMin, dataMax)}
                  {renderSlider(channelId, 'max', autoMax, dataMin, dataMax)}
                </div>
              </div>

              {/* Auto button: reset to recommended automatic window */}
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

              {/* Delete button */}
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
      
      {/* Custom Tooltip */}
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
