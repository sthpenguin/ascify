/**
 * Export format metadata.
 *
 * Kept apart from the implementations so the panel can render its format list
 * without pulling in the GIF encoder, the Three.js template and the rest of
 * the export machinery on first paint. `exporters.js` is imported the moment
 * an export actually starts.
 */
export const FORMAT_META = {
  png: { label: 'PNG', ext: 'png', kind: 'still' },
  jpeg: { label: 'JPEG', ext: 'jpg', kind: 'still', options: ['quality'] },
  webp: { label: 'WebP', ext: 'webp', kind: 'still', options: ['quality'] },
  gif: { label: 'GIF', ext: 'gif', kind: 'motion', options: ['fps', 'seconds'] },
  mp4: { label: 'MP4', ext: 'mp4', kind: 'motion', options: ['fps', 'seconds'] },
  webm: { label: 'WebM', ext: 'webm', kind: 'motion', options: ['fps', 'seconds'] },
  svg: { label: 'SVG', ext: 'svg', kind: 'ascii' },
  txt: { label: '.txt (JSON)', ext: 'txt', kind: 'ascii' },
  plain: { label: '.txt (plain)', ext: 'txt', kind: 'ascii' },
  html: { label: 'Three.js .html', ext: 'html', kind: 'ascii', options: ['bloom'] },
};

export const FORMAT_IDS = Object.keys(FORMAT_META);

export function suggestFilename(effect, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `ascify-${effect}-${stamp}.${ext}`;
}
