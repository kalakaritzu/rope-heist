// Instant replay. Remembers the last few seconds of frames; after a win or a bust it plays the end of the
// round back zoomed in and a little slower, so the best (or funniest) moment is easy to clip. V replays on demand.
const KEEP_MS = 9000; // how much history to remember
const REPLAY_MS = 5000; // how much of the round's end to replay
const AFTER_MS = 600; // ...plus this much after it ended
const REPLAY_SPEED = 0.8;
const START_DELAY_MS = 1500; // the banner shows first, then the replay starts
const ZOOM = 0.78; // camera distance while replaying

export function createDirector({ view, onChange = () => {} }) {
  const frames = []; // { t, pose }
  let replay = null; // { frames, from, to, startedAt }
  let prevStatus = 0;
  let endedAt = 0;
  let startAt = null;
  let lastNow = 0;

  function stop() {
    if (!replay) return;
    replay = null;
    view.setZoom(1);
    onChange(false);
  }

  function start(now, endAt = now) {
    const slice = frames.filter((f) => f.t >= endAt - REPLAY_MS && f.t <= endAt + AFTER_MS);
    if (slice.length < 10) return false;
    replay = { frames: slice, from: slice[0].t, to: slice[slice.length - 1].t, startedAt: now };
    view.setZoom(ZOOM);
    onChange(true);
    return true;
  }

  return {
    get active() { return replay !== null; },
    get lastNow() { return lastNow; },
    get frameCount() { return frames.length; },
    start,
    stop,

    /** Call once per frame with the live pose (and the pose layout). Returns the pose that should be drawn. */
    frame(pose, now, L) {
      lastNow = now;
      const status = pose[L.sOff];
      frames.push({ t: now, pose: pose.slice() });
      while (frames.length && now - frames[0].t > KEEP_MS) frames.shift();

      if (status !== 0 && prevStatus === 0) { endedAt = now; startAt = now + START_DELAY_MS; } // the round just ended
      if (status === 0 && prevStatus !== 0) { startAt = null; stop(); } // a new round began
      prevStatus = status;
      if (startAt !== null && now >= startAt && !replay) { startAt = null; start(now, endedAt); }

      if (!replay) return pose;
      const target = replay.from + (now - replay.startedAt) * REPLAY_SPEED;
      if (target > replay.to) { stop(); return pose; }
      let best = replay.frames[0];
      for (const f of replay.frames) { if (f.t <= target) best = f; else break; }
      return best.pose;
    },
  };
}

/** Saves what is currently on the canvas as a PNG. Call right after rendering, before the browser presents the frame. */
export function saveScreenshot(canvas) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rope-heist-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
}
