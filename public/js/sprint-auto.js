// Sprint analysis: the app suggests every position and point (owner decision). Google's free MediaPipe pose model runs
// here in the browser (served from our own /vendor/mediapipe, Apache 2.0) on every frame, sprint-detect.js turns the
// body points into marks, and the page saves them as suggestions people can override. The clip never leaves the
// device for this: it's read where it plays (the phone's own file right after upload, or the private play link).
import { findEvents, framePoints } from './sprint-detect.js';

const BASE = '/vendor/mediapipe/';
let model = null, clock = 0;
export const canSuggest = () => typeof WebAssembly === 'object' && typeof document !== 'undefined';

function loadModel() {
  model ??= (async () => {
    const { PoseLandmarker } = await import(`${BASE}vision_bundle.mjs`);
    const fileset = { wasmLoaderPath: `${BASE}wasm/vision_wasm_internal.js`, wasmBinaryPath: `${BASE}wasm/vision_wasm_internal.wasm` };
    const options = (delegate) => ({ baseOptions: { modelAssetPath: `${BASE}pose_landmarker_full.task`, delegate }, runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4 });
    try { return await PoseLandmarker.createFromOptions(fileset, options('GPU')); }
    catch { return PoseLandmarker.createFromOptions(fileset, options('CPU')); }
  })().catch((e) => { model = null; throw e; });
  return model;
}
const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { el.removeEventListener('error', bad); res(); };
  const bad = () => { el.removeEventListener(ev, ok); rej(new Error('The video couldn\'t be read here. If it plays, the private bucket\'s CORS rule needs GET for this site.')); };
  el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true });
});

// src: a play link or an object URL for the file just picked. fileFps: the frame rate the file plays at.
// onProgress(text, fraction). Answers { marks, steps, direction, note, video_w, video_h }.
export async function suggest({ src, kind, steps = 2, fileFps = 30, crossOrigin = false, onProgress = () => {} }) {
  onProgress('Loading the body tracker…', 0);
  const lm = await loadModel();
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  if (crossOrigin) v.crossOrigin = 'anonymous';
  v.src = src;
  await once(v, 'loadeddata');
  const w = v.videoWidth, h = v.videoHeight, fps = fileFps || 30, total = Math.floor((v.duration || 0) * fps);
  if (!total) throw new Error('The video has no frames to read.');
  // Every frame up to 120 a second (every other frame of a 240 file), at most 1,500 frames.
  const every = Math.max(1, Math.round(fps / 120), Math.ceil(total / 1500));
  const frames = [];
  for (let i = 0; i < total; i += every) {
    v.currentTime = (i + 0.5) / fps;
    await once(v, 'seeked');
    clock += 1;   // the model wants each frame's time to be later than the last
    const res = lm.detectForVideo(v, clock);
    frames.push({ t: v.currentTime, pts: framePoints(res?.landmarks?.[0], w, h) });
    if (frames.length % 10 === 0) onProgress(`Finding the positions… ${Math.round((i / total) * 100)}%`, i / total);
  }
  v.removeAttribute('src'); v.load();
  onProgress('Working out the steps…', 1);
  return { ...findEvents(frames, { kind, steps }), video_w: w, video_h: h, frames };   // frames: the raw points, for checking (not saved)
}
