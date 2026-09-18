import { trackStream, trackDisposable } from '../media/resourceRegistry.js';

/**
 * Audio-reactive input.
 *
 * Reads a live microphone (or the loaded video's own audio) through an
 * AnalyserNode and reports a single smoothed 0..1 level. Only that number ever
 * leaves this module — the audio itself is analysed in the graph and never
 * buffered, recorded or stored.
 */

const BANDS = {
  all: [0, 1],
  bass: [0, 0.12],
  mid: [0.12, 0.5],
  treble: [0.5, 1],
};

export function createAudioAnalyser() {
  let ctx = null;
  let analyser = null;
  let sourceNode = null;
  let data = null;
  let level = 0;
  let active = false;

  async function startFromMic() {
    await stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser exposes no microphone API.');
    }
    const stream = trackStream(
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
    );
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    trackDisposable('audioContext', ctx, () => ctx.close?.());
    sourceNode = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    sourceNode.connect(analyser);
    // Deliberately not connected to ctx.destination: no monitoring, no echo.
    data = new Uint8Array(analyser.frequencyBinCount);
    active = true;
  }

  async function startFromElement(element) {
    await stop();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    trackDisposable('audioContext', ctx, () => ctx.close?.());
    sourceNode = ctx.createMediaElementSource(element);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    sourceNode.connect(analyser);
    // Element audio still needs to reach the speakers.
    analyser.connect(ctx.destination);
    data = new Uint8Array(analyser.frequencyBinCount);
    active = true;
  }

  function sample(band = 'all', smoothing = 0.7) {
    if (!active || !analyser || !data) return 0;
    analyser.getByteFrequencyData(data);
    const [lo, hi] = BANDS[band] ?? BANDS.all;
    const start = Math.floor(lo * data.length);
    const end = Math.max(start + 1, Math.floor(hi * data.length));
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i];
    const raw = sum / (end - start) / 255;
    level = level * smoothing + raw * (1 - smoothing);
    return Math.min(1, level);
  }

  async function stop() {
    active = false;
    level = 0;
    try {
      sourceNode?.disconnect();
      analyser?.disconnect();
      await ctx?.close();
    } catch {
      /* already torn down */
    }
    ctx = null;
    analyser = null;
    sourceNode = null;
    data = null;
  }

  return {
    startFromMic,
    startFromElement,
    sample,
    stop,
    isActive: () => active,
    setSmoothing(v) {
      if (analyser) analyser.smoothingTimeConstant = Math.min(0.98, Math.max(0, v));
    },
  };
}
