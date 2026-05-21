/** Module-level lock — survives React remounts / Fast Refresh during long uploads. */
let depth = 0;
const listeners = new Set();

function notify() {
  listeners.forEach((fn) => {
    try {
      fn(depth);
    } catch {
      /* ignore */
    }
  });
}

export function getChannelUploadDepth() {
  return depth;
}

export function beginChannelUpload() {
  depth += 1;
  notify();
}

export function endChannelUpload() {
  depth = Math.max(0, depth - 1);
  notify();
}

export function subscribeChannelUpload(listener) {
  listeners.add(listener);
  listener(depth);
  return () => listeners.delete(listener);
}
