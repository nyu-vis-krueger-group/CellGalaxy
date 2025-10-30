import React from "react";
import useDataLoader from "./DataLoader/DataLoader";
import Viewer from "./Viewer/Viewer";
import Control from "./Control/Control";
import "./App.css";

export default function App() {
  const dataLoader = useDataLoader();
  const {
    pointsRaw,
    pointsUMAP,
    // pass-through for other props
    ...rest
  } = dataLoader;
  const [sharedZoom, setSharedZoom] = React.useState(8);

  return (
    <div className="app-container">
      <div className="viewer-split">
        <div className="viewer-pane">
          <div className="viewer-label">Raw</div>
          <Viewer {...rest} points={pointsRaw} sharedZoom={sharedZoom} setSharedZoom={setSharedZoom} />
        </div>
        <div className="viewer-pane">
          <div className="viewer-label">UMAP</div>
          <Viewer {...rest} points={pointsUMAP} sharedZoom={sharedZoom} setSharedZoom={setSharedZoom} />
        </div>
      </div>
      <Control {...dataLoader} />
    </div>
  );
}
