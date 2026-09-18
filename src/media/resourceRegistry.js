/**
 * Ownership ledger for every disposable resource the app creates.
 *
 * The privacy guarantee is not "we try to remember to free things" — it is
 * "nothing is created without being registered, and replacing media disposes
 * the whole previous generation". Each media load opens a *generation*; loading
 * or clearing media closes it and releases everything registered under it.
 *
 * Tracked kinds: object URLs, ImageBitmaps, HTMLVideoElements, MediaStreams,
 * WebGL textures, WebGPU resources, canvases and AudioContexts.
 */

let generationCounter = 0;

class Generation {
  constructor(id) {
    this.id = id;
    this.entries = new Set();
    this.closed = false;
  }

  add(entry) {
    if (this.closed) {
      // Late registration means the resource belongs to a generation that is
      // already gone: free it immediately rather than leaking it.
      try {
        entry.dispose();
      } catch {
        /* disposal is best-effort */
      }
      return entry.value;
    }
    this.entries.add(entry);
    return entry.value;
  }

  release(entry) {
    if (!this.entries.delete(entry)) return;
    try {
      entry.dispose();
    } catch {
      /* disposal is best-effort */
    }
  }

  dispose() {
    this.closed = true;
    // Dispose in reverse creation order: textures before their canvases,
    // object URLs after the elements that reference them.
    const list = [...this.entries].reverse();
    this.entries.clear();
    for (const entry of list) {
      try {
        entry.dispose();
      } catch {
        /* disposal is best-effort */
      }
    }
  }

  get size() {
    return this.entries.size;
  }
}

const generations = new Map();
let current = null;

export function openGeneration(label = 'media') {
  disposeCurrentGeneration();
  const id = `${label}#${++generationCounter}`;
  current = new Generation(id);
  generations.set(id, current);
  return id;
}

export function disposeCurrentGeneration() {
  if (!current) return;
  current.dispose();
  generations.delete(current.id);
  current = null;
}

export function currentGenerationId() {
  return current?.id ?? null;
}

/** Live resource count — asserted to return to zero by the privacy test. */
export function liveResourceCount() {
  let total = 0;
  for (const g of generations.values()) total += g.size;
  return total;
}

export function resourceSnapshot() {
  const byKind = {};
  for (const g of generations.values()) {
    for (const e of g.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }
  return { generations: generations.size, total: liveResourceCount(), byKind };
}

function register(kind, value, dispose) {
  const entry = { kind, value, dispose };
  if (!current) {
    // No generation open (e.g. a stray load): dispose rather than retain.
    try {
      dispose();
    } catch {
      /* best-effort */
    }
    return value;
  }
  return current.add(entry);
}

/* ---------- typed helpers ---------- */

const liveObjectUrls = new Set();

export function trackObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  liveObjectUrls.add(url);
  return register('objectURL', url, () => {
    URL.revokeObjectURL(url);
    liveObjectUrls.delete(url);
  });
}

/** Object URLs still outstanding — the privacy test asserts this hits zero. */
export function liveObjectUrlCount() {
  return liveObjectUrls.size;
}

export function trackBitmap(bitmap) {
  return register('ImageBitmap', bitmap, () => bitmap.close?.());
}

export function trackVideo(video) {
  return register('video', video, () => {
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    // Detaching the source is what actually lets the decoder buffers go.
    video.removeAttribute('src');
    video.srcObject = null;
    try {
      video.load();
    } catch {
      /* ignore */
    }
  });
}

export function trackStream(stream) {
  return register('MediaStream', stream, () => {
    for (const track of stream.getTracks()) track.stop();
  });
}

export function trackCanvas(canvas) {
  return register('canvas', canvas, () => {
    // Zeroing the backing store releases the pixel memory immediately instead
    // of waiting for GC to notice the canvas is unreachable.
    canvas.width = 0;
    canvas.height = 0;
  });
}

export function trackGlTexture(gl, texture) {
  return register('glTexture', texture, () => {
    if (!gl.isContextLost?.()) gl.deleteTexture(texture);
  });
}

export function trackGpuResource(resource) {
  return register('gpuResource', resource, () => resource.destroy?.());
}

export function trackDisposable(kind, value, dispose) {
  return register(kind, value, dispose);
}

/**
 * Release one resource early (before its generation ends) — used when a frame
 * bitmap is superseded mid-playback.
 */
export function releaseNow(kind, value) {
  if (!current) return;
  for (const entry of current.entries) {
    if (entry.value === value && entry.kind === kind) {
      current.release(entry);
      return;
    }
  }
}

/** Last-resort sweep on page unload so nothing outlives the document. */
export function installUnloadCleanup() {
  const cleanup = () => {
    for (const g of generations.values()) g.dispose();
    generations.clear();
    current = null;
  };
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
  return cleanup;
}

if (typeof window !== 'undefined') {
  // Exposed for the automated privacy check; read-only introspection only.
  window.__ascifyResources = { resourceSnapshot, liveResourceCount, liveObjectUrlCount };
}
