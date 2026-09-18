const RELEASES = [
  {
    version: '1.0.0',
    date: '2026-09-19',
    items: [
      'Fifteen effects: ascii, waveLines, dithering, halftone, pixelSort, dots, contour, edgeDetection, crosshatch, blockify, threshold, noiseField, matrixRain, vhs, voronoi.',
      'WebGPU → WebGL2 → CPU backend selection, with the WebGPU renderer loaded only where it exists.',
      'Image, GIF, video, webcam and GLB input, up to 500MB, all processed in memory.',
      'Exports: PNG, JPEG, WebP, GIF, MP4/WebM, SVG, JSON .txt and a standalone Three.js page.',
      'Custom charset editor with a live ramp preview ordered by measured ink coverage.',
      'Undo/redo across every setting, with one history step per gesture.',
      'Preset gallery plus URL-encoded share links that carry parameters only.',
      'Audio-reactive mode driven by the Web Audio API.',
      'Mobile-first layout: bottom-sheet panels, pinch-zoom, drag-to-pan, safe-area insets.',
      'Installable PWA with offline support scoped to the Pages base path.',
    ],
  },
];

export function Changelog() {
  return (
    <div className="space-y-6">
      {RELEASES.map((r) => (
        <section key={r.version} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13px] text-term-accent">v{r.version}</h2>
            <span className="text-[12px] text-term-muted">{r.date}</span>
          </div>
          <ul className="space-y-1">
            {r.items.map((item) => (
              <li key={item} className="flex gap-2 text-[12px] leading-relaxed text-term-text">
                <span className="text-term-accent-dim">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
