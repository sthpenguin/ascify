import {
  openGeneration,
  disposeCurrentGeneration,
  trackObjectUrl,
  trackBitmap,
  trackVideo,
  trackStream,
  trackCanvas,
  trackDisposable,
} from './resourceRegistry.js';

/**
 * Turns a File / MediaStream into a uniform frame source.
 *
 * Every source exposes the same surface:
 *   { kind, width, height, animated, duration, frame(), seek(t), play/pause, dispose }
 * `frame()` returns a CanvasImageSource for *right now* — the pipeline draws it
 * and never holds onto it, so no decoded frame outlives a render tick.
 *
 * Nothing here writes to disk, fetches over the network, or touches storage.
 * Bytes travel File -> decoder -> GPU/canvas and are released on dispose.
 */

export const MAX_BYTES = 500 * 1024 * 1024; // 500MB

export const ACCEPTED = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'],
  gif: ['image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'],
  model: ['model/gltf-binary'],
};

export const ACCEPT_ATTR =
  '.png,.jpg,.jpeg,.webp,.avif,.bmp,.gif,.mp4,.webm,.mov,.glb,image/*,video/*,model/gltf-binary';

export class MediaError extends Error {
  constructor(message, { code = 'load_failed', hint } = {}) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.hint = hint;
  }
}

function classify(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'gif';
  if (name.endsWith('.glb') || type === 'model/gltf-binary') return 'model';
  if (type.startsWith('video/') || /\.(mp4|webm|mov|ogv)$/.test(name)) return 'video';
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|avif|bmp)$/.test(name)) return 'image';
  return null;
}

function assertAcceptable(file) {
  if (file.size > MAX_BYTES) {
    throw new MediaError(`File is ${(file.size / 1048576).toFixed(0)}MB — the limit is 500MB.`, {
      code: 'too_large',
      hint: 'Trim the clip or lower its resolution before loading.',
    });
  }
  const kind = classify(file);
  if (!kind) {
    throw new MediaError(`Unsupported file type: ${file.type || file.name || 'unknown'}.`, {
      code: 'unsupported',
      hint: 'Accepted: PNG, JPG, WebP, GIF, MP4, WebM, GLB.',
    });
  }
  return kind;
}

/* ------------------------------------------------------------------ image */

async function loadImage(file) {
  let bitmap;
  try {
    bitmap = trackBitmap(await createImageBitmap(file, { imageOrientation: 'from-image' }));
  } catch {
    throw new MediaError('This image could not be decoded.', {
      code: 'decode_failed',
      hint: 'Try re-exporting it as PNG or JPG.',
    });
  }
  return {
    kind: 'image',
    width: bitmap.width,
    height: bitmap.height,
    animated: false,
    duration: 0,
    frame: () => bitmap,
    seek() {},
    play() {},
    pause() {},
    isPlaying: () => false,
  };
}

/* -------------------------------------------------------------------- gif */

/**
 * GIFs take one of two paths:
 *  - WebCodecs ImageDecoder, which gives real per-frame seeking; or
 *  - a live <img>, which the browser animates and which drawImage samples at
 *    its current frame. Less control, but universal.
 */
async function loadGif(file) {
  const url = trackObjectUrl(file);

  if (typeof ImageDecoder !== 'undefined') {
    try {
      const buffer = await file.arrayBuffer();
      const decoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
      await decoder.completed;
      const track = decoder.tracks.selectedTrack;
      const frameCount = track?.frameCount ?? 1;

      const canvas = trackCanvas(document.createElement('canvas'));
      const ctx = canvas.getContext('2d', { willReadFrequently: false });

      // Decode frame 0 to learn the dimensions and to have something to show.
      const first = await decoder.decode({ frameIndex: 0 });
      canvas.width = first.image.displayWidth;
      canvas.height = first.image.displayHeight;
      ctx.drawImage(first.image, 0, 0);
      first.image.close();

      trackDisposable('imageDecoder', decoder, () => decoder.close?.());

      let index = 0;
      let playing = true;
      let acc = 0;
      let frameDuration = 0.1; // seconds; refreshed from each decoded frame

      const decodeInto = async (i) => {
        try {
          const res = await decoder.decode({ frameIndex: i % frameCount });
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(res.image, 0, 0);
          frameDuration = Math.max(0.02, (res.image.duration ?? 100000) / 1e6);
          res.image.close();
        } catch {
          /* a truncated GIF simply stops advancing */
        }
      };

      // GIF timing is per-frame; this is the nominal length used for scrubbing.
      const total = frameCount * 0.1;

      return {
        kind: 'gif',
        width: canvas.width,
        height: canvas.height,
        animated: frameCount > 1,
        duration: total,
        frameCount,
        frame: () => canvas,
        tick(dt) {
          if (!playing || frameCount <= 1) return;
          acc += dt;
          while (acc >= frameDuration) {
            acc -= frameDuration;
            index = (index + 1) % frameCount;
            void decodeInto(index);
          }
        },
        seek(t) {
          const i = Math.floor((t / Math.max(total, 0.001)) * frameCount) % frameCount;
          index = i;
          void decodeInto(i);
        },
        play() {
          playing = true;
        },
        pause() {
          playing = false;
        },
        isPlaying: () => playing,
        previewUrl: url,
      };
    } catch {
      /* fall through to the <img> path */
    }
  }

  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new MediaError('This GIF could not be decoded.', { code: 'decode_failed' }));
  });
  trackDisposable('img', img, () => {
    img.src = '';
  });

  return {
    kind: 'gif',
    width: img.naturalWidth,
    height: img.naturalHeight,
    animated: true,
    duration: 0,
    frame: () => img,
    tick() {},
    seek() {},
    play() {},
    pause() {},
    isPlaying: () => true,
    previewUrl: url,
  };
}

/* ------------------------------------------------------------------ video */

async function loadVideo(file, { startTime = 0 } = {}) {
  const url = trackObjectUrl(file);
  const video = trackVideo(document.createElement('video'));
  video.src = url;
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';

  await new Promise((resolve, reject) => {
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(
        new MediaError('This video could not be decoded by your browser.', {
          code: 'decode_failed',
          hint: 'H.264 MP4 and VP8/VP9 WebM are the most widely supported.',
        }),
      );
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    video.addEventListener('error', onErr, { once: true });
  });

  if (startTime > 0 && startTime < video.duration) {
    video.currentTime = startTime;
  }

  // Autoplay may be refused; the UI exposes a play control either way.
  try {
    await video.play();
  } catch {
    /* user gesture required — not an error */
  }

  return {
    kind: 'video',
    width: video.videoWidth,
    height: video.videoHeight,
    animated: true,
    duration: video.duration || 0,
    element: video,
    frame: () => video,
    tick() {},
    seek(t) {
      if (Number.isFinite(t)) video.currentTime = Math.max(0, Math.min(video.duration || 0, t));
    },
    currentTime: () => video.currentTime,
    play: () => video.play().catch(() => {}),
    pause: () => video.pause(),
    isPlaying: () => !video.paused && !video.ended,
    previewUrl: url,
  };
}

/* ----------------------------------------------------------------- camera */

async function loadCamera({ facingMode = 'environment' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MediaError('This browser exposes no camera API.', { code: 'no_camera' });
  }
  let stream;
  try {
    stream = trackStream(
      await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      }),
    );
  } catch (err) {
    throw new MediaError(
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied.'
        : 'No camera is available on this device.',
      { code: 'camera_denied', hint: 'Frames stay on-device either way — nothing is uploaded.' },
    );
  }

  const video = trackVideo(document.createElement('video'));
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  await new Promise((resolve) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  await video.play().catch(() => {});

  return {
    kind: 'camera',
    width: video.videoWidth || 1280,
    height: video.videoHeight || 720,
    animated: true,
    duration: 0,
    element: video,
    frame: () => video,
    tick() {},
    seek() {},
    play: () => video.play().catch(() => {}),
    pause: () => video.pause(),
    isPlaying: () => !video.paused,
    facingMode,
  };
}

/* ------------------------------------------------------------------ model */

async function loadModel(file, { onProgress } = {}) {
  // Three and the GLTF loader are only pulled in when a .glb actually arrives.
  const [{ createModelStage }] = await Promise.all([import('./glbSource.js')]);
  onProgress?.({ phase: 'decoding', progress: 0.4 });
  return createModelStage(file, { onProgress });
}

/* ------------------------------------------------------------------- API */

/**
 * Load new media.
 *
 * Opening a generation is the first thing that happens, and that *disposes the
 * previous media outright* — decoded frames, bitmaps, textures and object URLs.
 * The old file is gone before the new one is touched.
 */
export async function loadMedia(input, opts = {}) {
  openGeneration('media');
  try {
    if (input instanceof File || input instanceof Blob) {
      const kind = assertAcceptable(input);
      opts.onProgress?.({ phase: 'decoding', progress: 0.1 });
      switch (kind) {
        case 'image':
          return await loadImage(input);
        case 'gif':
          return await loadGif(input);
        case 'video':
          return await loadVideo(input, opts);
        case 'model':
          return await loadModel(input, opts);
        default:
          throw new MediaError('Unsupported file.', { code: 'unsupported' });
      }
    }
    if (input === 'camera') return await loadCamera(opts);
    throw new MediaError('Nothing to load.', { code: 'empty' });
  } catch (err) {
    // A failed load must not leave half-built resources behind.
    disposeCurrentGeneration();
    throw err instanceof MediaError ? err : new MediaError(err?.message || 'Load failed.');
  }
}

/** Explicitly drop all media. Used on "clear" and on unload. */
export function clearMedia() {
  disposeCurrentGeneration();
}

export { classify };
