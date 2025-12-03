import React from 'react';
import './SemanticZoomControl.css';

export default function SemanticZoomControl({ 
  level, 
  setLevel, 
  maxLevel = 6,
  isAuto,
  setIsAuto
}) {
  return (
    <div className="semantic-zoom-control">
      <div className="semantic-header">
        <div className="semantic-label">Semantic Level: {level}</div>
        <label className="auto-toggle">
          <input 
            type="checkbox" 
            checked={isAuto} 
            onChange={(e) => setIsAuto(e.target.checked)} 
          />
          Auto
        </label>
      </div>
      <input
        type="range"
        min="1"
        max={maxLevel}
        step="1"
        value={level}
        disabled={isAuto}
        onChange={(e) => setLevel(Number(e.target.value))}
        className={isAuto ? "disabled" : ""}
      />
    </div>
  );
}
