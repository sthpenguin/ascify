import { createGifEncoder } from './gifEncoder.js';
import { buildThreeHtml } from './threeTemplate.js';

/**
 * Export pipeline.
 *
 * Every exporter takes an `ExportContext` and a `signal`, reports progress,
 * and resolves to a Blob. Nothing is written to disk by this module: the caller
 * hands the Blob to a temporary object URL, triggers a download, and revokes it
 * immediately.
 */

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelled';
  }
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new ExportCancelled();
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------ still images */

async function exportStill(ctx, { mimeType, quality, onProgress, signal }) {
  onProgress?.(0.2);
  ctx.renderOnce();
  await nextTick();
  checkCancelled(signal);
  onProgress?.(0.6);
  const blob = await canvasToBlob(ctx.canvas, mimeType, quality);
  onProgress?.(1);
  return blob;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Could not encode ${type}.`))),
      type,
      quality,
    );
  });
}

/* -------------------------------------------------------------------- GIF */

async function exportGif(ctx, { fps = 12, seconds = 3, onProgress, signal }) {
  const { canvas, source, renderAt } = ctx;
  const frameCount = Math.max(1, Math.min(300, Math.round(fps * seconds)));
  const delay = 1000 / fps;

  const encoder = createGifEncoder({ width: canvas.width, height: canvas.height });
  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  try {
    for (let i = 0; i < frameCount; i++) {
      checkCancelled(signal);
      await renderAt((i / fps) % Math.max(source?.duration || seconds, 0.001), i / fps);
      sctx.drawImage(canvas, 0, 0);
      encoder.addFrame(sctx.getImageData(0, 0, scratch.width, scratch.height), delay);
      onProgress?.((i + 1) / frameCount);
      // Yield so the progress bar paints and cancel stays responsive.
      await nextTick();
    }
    return encoder.finish();
  } finally {
    scratch.width = 0;
    scratch.height = 0;
  }
}

/* ------------------------------------------------------------------ video */

function pickVideoMime(preferred) {
  const candidates =
    preferred === 'mp4'
      ? ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

async function exportVideo(ctx, { container = 'mp4', seconds = 5, fps = 30, onProgress, signal }) {
  const mime = pickVideoMime(container);
  if (!mime) {
    throw new Error('This browser cannot record video from a canvas (no supported MediaRecorder codec).');
  }

  const stream = ctx.canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });

  const startedAt = performance.now();
  recorder.start(200);
  ctx.startLoop();

  try {
    while (performance.now() - startedAt < seconds * 1000) {
      if (signal?.aborted) break;
      onProgress?.(Math.min(0.98, (performance.now() - startedAt) / (seconds * 1000)));
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    recorder.stop();
    await done;
    for (const track of stream.getTracks()) track.stop();
  }

  checkCancelled(signal);
  onProgress?.(1);
  return new Blob(chunks, { type: mime.split(';')[0] });
}

/* -------------------------------------------------------------------- SVG */

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * Runs of identical adjacent characters sharing a colour are merged into one
 * <text> element. On typical output this cuts the node count by 5-10x, which
 * is the difference between an SVG a browser can open and one it cannot.
 */
export function groupCells(grid) {
  const { cols, rows, cells } = grid;
  const groups = [];
  for (let y = 0; y < rows; y++) {
    let run = null;
    for (let x = 0; x < cols; x++) {
      const cell = cells[y * cols + x];
      if (!cell || cell.char === ' ') {
        if (run) groups.push(run);
        run = null;
        continue;
      }
      if (run && run.color === cell.color && run.y === y && run.x + run.count === x) {
        run.text += cell.char;
        run.count++;
      } else {
        if (run) groups.push(run);
        run = { text: cell.char, count: 1, x, y, color: cell.color };
      }
    }
    if (run) groups.push(run);
  }
  return groups;
}

async function exportSvg(ctx, { onProgress, signal }) {
  onProgress?.(0.2);
  const grid = ctx.asciiGrid();
  if (!grid) throw new Error('SVG export needs the ascii effect (it writes characters, not pixels).');
  checkCancelled(signal);

  const cellW = 10;
  const cellH = 18;
  const width = grid.cols * cellW;
  const height = grid.rows * cellH;
  const groups = groupCells(grid);
  onProgress?.(0.6);

  const body = groups
    .map(
      (g) =>
        `<text x="${g.x * cellW}" y="${g.y * cellH + cellH * 0.75}" fill="${g.color}">${escapeXml(g.text)}</text>`,
    )
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${ctx.backgroundColor}"/>
  <g font-family="JetBrains Mono, ui-monospace, monospace" font-size="${cellH * 0.8}" xml:space="preserve">
${body}
  </g>
</svg>`;
  onProgress?.(1);
  return new Blob([svg], { type: 'image/svg+xml' });
}

/* -------------------------------------------------------------------- TXT */

/**
 * The .txt export is JSON by design — it round-trips position and colour, which
 * plain text cannot, and it is the documented interchange format.
 */
async function exportText(ctx, { onProgress, signal }) {
  onProgress?.(0.2);
  const grid = ctx.asciiGrid();
  if (!grid) throw new Error('Text export needs the ascii effect.');
  checkCancelled(signal);

  const payload = {
    backgroundColor: ctx.backgroundColor,
    dimensions: { width: grid.cols, height: grid.rows },
    groups: groupCells(grid).map((g) => ({
      text: g.text,
      count: g.count,
      x: g.x,
      y: g.y,
      color: g.color,
    })),
  };
  onProgress?.(1);
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'text/plain;charset=utf-8' });
}

/** Plain, un-wrapped character rows — handy for pasting into a terminal. */
async function exportPlainText(ctx, { onProgress }) {
  const grid = ctx.asciiGrid();
  if (!grid) throw new Error('Text export needs the ascii effect.');
  const lines = [];
  for (let y = 0; y < grid.rows; y++) {
    let line = '';
    for (let x = 0; x < grid.cols; x++) line += grid.cells[y * grid.cols + x]?.char ?? ' ';
    lines.push(line.replace(/\s+$/, ''));
  }
  onProgress?.(1);
  return new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
}

/* ------------------------------------------------------------- Three.js HTML */

async function exportThreeHtml(ctx, { bloom = true, onProgress, signal }) {
  onProgress?.(0.2);
  const grid = ctx.asciiGrid();
  if (!grid) throw new Error('The Three.js export needs the ascii effect.');
  checkCancelled(signal);
  const groups = groupCells(grid);
  onProgress?.(0.7);
  const html = buildThreeHtml({
    groups,
    cols: grid.cols,
    rows: grid.rows,
    backgroundColor: ctx.backgroundColor,
    bloom,
  });
  onProgress?.(1);
  return new Blob([html], { type: 'text/html;charset=utf-8' });
}

/* ------------------------------------------------------------------ registry */

/**
 * Runner per format id. The user-facing metadata lives in ./formats.js so the
 * export panel can render without loading any of this.
 */
export const RUNNERS = {
  png: (c, o) => exportStill(c, { ...o, mimeType: 'image/png' }),
  jpeg: (c, o) => exportStill(c, { ...o, mimeType: 'image/jpeg', quality: o.quality ?? 0.92 }),
  webp: (c, o) => exportStill(c, { ...o, mimeType: 'image/webp', quality: o.quality ?? 0.92 }),
  gif: exportGif,
  mp4: (c, o) => exportVideo(c, { ...o, container: 'mp4' }),
  webm: (c, o) => exportVideo(c, { ...o, container: 'webm' }),
  svg: exportSvg,
  txt: exportText,
  plain: exportPlainText,
  html: exportThreeHtml,
};

/** Run one export by id. This is the entry point the panel dynamically imports. */
export function runExport(id, ctx, options) {
  const runner = RUNNERS[id];
  if (!runner) throw new Error(`Unknown export format: ${id}`);
  return runner(ctx, options);
}

/**
 * Trigger a download for a Blob.
 *
 * The object URL lives only as long as the click, and is revoked on the next
 * task — the same discipline the preview path uses.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { FORMAT_META, suggestFilename } from './formats.js';
