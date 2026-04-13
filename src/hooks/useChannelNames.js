import { useEffect, useState } from "react";
import { API_BASE } from "../api/api";

// id → display name from channel_info.json
export function useChannelNames() {
  const [channelNames, setChannelNames] = useState(() => new Map());
  useEffect(() => {
    let abort = false;
    const run = async () => {
      try {
        const url = `${API_BASE}/public/channel_info.json?ts=${Date.now()}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        const m = new Map();
        if (json && Array.isArray(json.channels)) {
          for (const ch of json.channels) {
            if (typeof ch?.id === "number" && typeof ch?.name === "string") {
              m.set(ch.id, ch.name);
            }
          }
        }
        if (!abort) setChannelNames(m);
      } catch {
        /* ignore */
      }
    };
    run();
    return () => {
      abort = true;
    };
  }, []);
  return channelNames;
}
