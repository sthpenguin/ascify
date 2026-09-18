export function About() {
  return (
    <div className="space-y-5 text-[12px] leading-relaxed text-term-text">
      <p>
        <span className="text-term-accent">ascify</span> converts images, GIFs, video, webcam frames and
        GLB models into ASCII art and fourteen other retro effects. It is a static page: there is no
        server, no account, and no upload step.
      </p>

      <section className="space-y-2">
        <h2 className="term-label text-term-accent">private by design</h2>
        <p>
          Your files are read by the browser and handed straight to the GPU. They are never written to
          disk, never cached by the service worker, never placed in IndexedDB or localStorage, and never
          sent over the network — there is no network call in the processing path at all.
        </p>
        <p>
          Loading a new file disposes the previous one first: decoded frames, ImageBitmaps, GPU textures,
          canvas buffers and object URLs are all tracked and released as a unit. The only things that
          persist between visits are your settings, panel state and saved presets, which are plain
          numbers and short strings. The storage layer actively rejects anything that is not — a typed
          array or a data URI throws rather than being written.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="term-label text-term-accent">how it renders</h2>
        <p>
          The renderer prefers WebGPU, falls back to WebGL2, and falls back again to a pure-CPU path, so
          it works on anything from a current desktop to an older phone. Pixel-sorting and
          error-diffusion dithering are inherently sequential and always run on the CPU, with the result
          handed back to the GPU for post-processing.
        </p>
        <p>
          Character glyphs are rasterised once into an atlas and measured for ink coverage, so any
          charset you type is ordered by actual darkness rather than the order you typed it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="term-label text-term-accent">exports</h2>
        <p>
          PNG, JPEG, WebP, GIF, MP4/WebM, SVG, a JSON <code>.txt</code> grid, and a standalone Three.js
          HTML page with OrbitControls and optional bloom. Every export runs in-page with a progress bar
          and a cancel button.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="term-label text-term-accent">offline</h2>
        <p>
          ascify installs as a PWA and runs with no connection. Only the application shell is precached —
          your media is never given to the service worker.
        </p>
      </section>
    </div>
  );
}
