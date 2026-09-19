# ascify

Turn images, GIFs, video, webcam frames and GLB models into ASCII art and fourteen other retro
effects — entirely in the browser.

**Live:** <https://sthpenguin.github.io/ascify/>

There is no server, no account, and no upload step. Your files are read by the browser, handed to
the GPU, and released. Nothing is stored and nothing is sent.

---

## Contents

- [What it does](#what-it-does)
- [Privacy guarantees](#privacy-guarantees)
- [Architecture](#architecture)
- [Responsive matrix](#responsive-matrix)
- [Running it locally](#running-it-locally)
- [Verification](#verification)
- [Deployment](#deployment)
- [Export formats](#export-formats)
- [Project layout](#project-layout)

---

## What it does

**Inputs** — PNG, JPG, WebP, AVIF, BMP, GIF, MP4, WebM, MOV, `.glb`, and the live webcam. Up to
500MB, by drag-and-drop, file picker, or the phone camera.

**Effects** — one active at a time:

| | | |
|---|---|---|
| `ascii` | `waveLines` | `dithering` |
| `halftone` | `pixelSort` | `dots` |
| `contour` | `edgeDetection` | `crosshatch` |
| `blockify` | `threshold` | `noiseField` |
| `matrixRain` | `vhs` | `voronoi` |

**Adjustments** — brightness, contrast, saturation, hue, sharpness, gamma, colour mode
(original / mono / gradient) and background intensity. Every slider has a reset.

**ASCII controls** — scale, spacing, output width, charset, threshold, tilt, spatial weight, and a
custom character-set editor with a live ramp preview.

**Beyond the basics** — undo/redo across every setting, a preset gallery, URL-encoded share links
that carry parameters only, and an audio-reactive mode driven by the Web Audio API.

---

## Privacy guarantees

The claim on the page is *"Private by design — your files never leave this device."* Here is
exactly what backs it.

### What never happens

- Media is **never written to disk**, **never placed in IndexedDB or localStorage**, **never
  precached by the service worker**, and **never sent over the network**. There is no network call
  anywhere in the processing path.
- No analytics, no telemetry, no third-party requests of any kind. The font is self-hosted
  precisely so that loading the page contacts nothing but the origin it came from.
- No media or sample files are tracked by git — `.gitignore` blocks image, video and model
  extensions outright, and the PWA icons are generated at build time rather than committed.

### How it is enforced, not just intended

**Ownership is explicit.** `src/media/resourceRegistry.js` is a ledger. Every object URL,
`ImageBitmap`, video element, `MediaStream`, canvas, GL texture and WebGPU resource is registered
against a *generation*. Loading new media opens a new generation, and opening one disposes the
previous one **before the new file is touched** — so two files are never resident at once. Page
unload disposes everything that remains.

**Settings storage rejects media structurally.** `src/lib/db.js` runs every value through
`assertPlain` before writing. Typed arrays, `Blob`, `File`, `ArrayBuffer`, `ImageData`,
`ImageBitmap`, non-plain objects, strings over 4KB, and anything matching `data:` or `blob:` all
**throw** rather than being persisted. A bug that tried to stash a frame in settings would crash
loudly instead of quietly leaking.

**Share links cannot carry media.** `src/lib/shareLink.js` builds the payload by walking the
*default settings tree* and copying only keys that exist there. A poisoned settings object has no
path into a URL.

**The schema is a closed set.** `sanitizeSettings` rebuilds state key-by-key from the schema rather
than spreading the input, so unknown fields from IndexedDB or a shared link are dropped, and
numbers are clamped to their declared range.

**Audio is analysed, never captured.** The analyser node is deliberately not connected to
`destination` for microphone input, and only a single smoothed 0–1 number leaves the module.

### It is tested, on every change

`npm run test:privacy` drives the built app in a real browser: it generates a large video in-page,
loads it, replaces it with a second one, clears it, and then asserts —

| Check | Asserts |
|---|---|
| no upload body | no request carried a body |
| no third-party request | every request went to the origin |
| object URLs revoked | replacing media revoked the previous URLs |
| one generation resident | the old media was disposed before the new one loaded |
| registry drains | live resource count returns to **0** after clear |
| IndexedDB scope | only `settings`, `ui`, `presets` exist |
| IndexedDB content | no `data:`/`blob:` payload anywhere |
| IndexedDB size | stays under 64KB after two large videos (observed: ~260 bytes) |
| web storage | no encoded media in local/sessionStorage |
| service worker | no media in any cache |

### What *is* persisted

Settings, panel state, saved presets, zoom/pan, and the video playhead position. All plain numbers,
booleans and short strings, under a versioned schema. On a version mismatch the database is
**deleted rather than migrated**, so no stale record survives a format change.

---

## Architecture

```
File / MediaStream
        │
        ▼
  media/mediaSource.js ── opens a resource generation, disposing the previous one
        │                 (image · gif · video · webcam · glb)
        ▼
  renderer/index.js ───── picks a backend, clamps resolution, drives the frame loop
        │
        ├── gpu/webgpuBackend.js   WGSL · lazy-imported only where navigator.gpu exists
        ├── gl/webgl2Backend.js    GLSL ES 3.00 · adjust → effect/ascii → post
        └── cpu/cpuBackend.js      ImageData + 2D canvas · universal fallback
        │
        ▼
   export/exporters.js ── PNG · JPEG · WebP · GIF · MP4/WebM · SVG · .txt · Three.js .html
```

### Backend selection

Preference order is **WebGPU → WebGL2 → CPU**, chosen once per canvas. A canvas element is
permanently bound to the first context type it is given, so changing backend requires mounting a
new canvas — the renderer never tries to swap one in place, and `Preview` remounts the canvas when
the preference changes or when a backend dies mid-frame.

The WebGPU backend is a separate chunk that is only fetched on devices that actually have
`navigator.gpu`. Any failure in it — no adapter, a rejected shader, a lost device — degrades to
WebGL2 without interrupting the session.

Two effects are inherently sequential and always run on the CPU: **pixel sorting** and
**error-diffusion dithering** (Floyd–Steinberg, Atkinson). On a GPU backend their pixels are
computed on the CPU and uploaded, so post-processing still runs on the GPU.

### Rendering pipeline

The WebGL2 path is four passes: `adjust` → (`cells` → `glyphs` for ASCII, or a single switched
`effect` shader) → `post`. Effects write `vec4(rgb, ink)` and compositing against the background
happens once, so *background intensity* behaves identically across all fifteen. Per-effect
parameters ride in generic `uP[8]`/`uM[4]` uniforms, so adding an effect never means touching the
uniform plumbing.

WebGPU mirrors this in three passes, folding adjustments into a function called per tap rather than
using a separate render target.

### Font atlas

Glyphs are rasterised **once** on the CPU (`OffscreenCanvas` + `fillText`), measured for ink
coverage with `getImageData`, cached by `(chars, size, weight, font)`, and uploaded as a GPU
texture. The coverage measurement is what lets any charset — including one typed in arbitrary
order — map monotonically onto luminance.

### Performance

Resolution is clamped to a **pixel budget** rather than a dimension cap, and the budget is roughly
halved on phones: a 4K clip thermally throttles a mid-range phone long before it drops frames, and
these effects are low-frequency enough that the reduction is invisible. The loop caps at the
configured fps and pauses entirely when the tab is hidden. Steady-state rendering allocates
nothing — render targets are reallocated only when the size changes.

### State

`src/lib/store.js` is a ~50-line `create()` built on React 19's `useSyncExternalStore`. Selectors
are compared with `Object.is`, so a component re-renders only when the slice it reads changes.
There is no third-party state library.

Undo/redo stores whole settings snapshots. A slider drag pushes one entry on pointer-down and
updates transiently thereafter, so **one gesture is one undo step** rather than 200.

---

## Responsive matrix

Mobile-first. Tested at 320, 768 and 1440px by `npm run test:responsive`.

| Width | Layout | Panels | Interaction |
|---|---|---|---|
| **< 768px** (phone portrait) | Preview on top, bottom sheet below | Tab bar: input · effects · preview · settings · export — pinned to the bottom for thumb reach, above the home indicator | Pinch to zoom, drag to pan, tap the active tab to collapse the sheet |
| **768–1279px** (tablet / phone landscape) | Three columns, narrow rails | Input·Effects·Presets ⟋ preview ⟍ Settings·Processing·Post·Export | Pinch and drag still work; rails collapsible |
| **≥ 1280px** (desktop) | Three columns, wide rails | as above, all sections expanded | Wheel to zoom, drag to pan, buttons for stepped zoom, double-click to fit |

Also handled: iOS safe-area insets on every edge, a **44px minimum touch target** on coarse
pointers (denser on mouse), `touch-action: none` on the canvas so panning never scrolls the page,
`overscroll-behavior: none` to kill rubber-banding, and `prefers-reduced-motion` support.

---

## Running it locally

```bash
npm install
npm run dev        # http://localhost:5173/ascify/
```

```bash
npm run build      # generates icons, then builds to dist/
npm run preview    # serves dist/ at http://localhost:4173/ascify/
```

Node 20+ is required.

---

## Verification

```bash
npm run verify     # build + all three test suites + Lighthouse
```

Individually:

| Command | What it does |
|---|---|
| `npm run test:privacy` | Loads, replaces and clears large media, then asserts nothing persisted anywhere |
| `npm run test:responsive` | Checks overflow, layout mode and 44px touch targets at 320/768/1440 |
| `npm run test:render` | Renders all 15 effects on **both** WebGL2 and CPU, then runs every export format |
| `npm run test:orientation` | Asserts output is never flipped, and that clearing media really removes it |
| `npm run test:offline` | Installs the service worker, cuts the network, and reloads — including a deep link |
| `npm run lighthouse` | Mobile profile; fails below 95 in any category |

The browser tests drive the system Chromium via `playwright-core` (`CHROME_PATH` to override) —
no browser download is needed. Point any of them at another URL with `ASCIFY_URL=…`.

Current results on the mobile profile:

```
performance     99
accessibility  100
best-practices 100
seo            100
```

---

## Deployment

GitHub Pages, entirely static, no backend and no VPS.

### How this repository actually deploys

Pages serves from the **`gh-pages` branch**, published by:

```bash
npm run deploy      # builds, then force-pushes dist/ to gh-pages
```

That is deliberate rather than preferred. `.github/workflows/deploy.yml` is the better route and
needs no manual step, but GitHub Actions cannot allocate a runner for this account: jobs are
created and then fail in ~2s with no runner assigned, no steps recorded and zero billable time,
which is what a spending-limit or payment block looks like. GitHub reported no incident at the
time, and the same happens for a six-line `echo hello` workflow, so it is not the workflow's
content. Both workflows are disabled to keep that failure out of the commit history.

`scripts/deploy-pages.mjs` stages the build in a scratch directory with its own fresh git
repository before pushing. That detail matters: this project's `.gitignore` blocks `dist/` and
`*.png`, so committing the build from inside the repo would silently drop every generated icon.

**If Actions starts working**, switch back with:

```bash
gh api -X PUT repos/sthpenguin/ascify/actions/workflows/ci.yml/enable
gh api -X PUT repos/sthpenguin/ascify/actions/workflows/deploy.yml/enable
gh api -X PUT repos/sthpenguin/ascify/pages -f build_type=workflow
```

Nothing in the workflow needs editing — it already builds and uploads `dist/` correctly.

### CI

`.github/workflows/ci.yml` builds, asserts the expected artifacts exist, fails if any media file
ever becomes tracked by git, and runs the privacy, render, orientation, responsive and offline
suites in a real browser. While Actions is blocked, `npm run verify` runs the same checks locally.

### How the Pages build is wired

- `vite.config.js` sets `base: '/ascify/'`, so every asset resolves under the project sub-path.
- `dist/404.html` is written as a copy of `index.html` at build time — the standard Pages shim
  that makes deep links like `/ascify/about` resolve.
- `.github/workflows/deploy.yml` runs `actions/configure-pages` → `actions/upload-pages-artifact`
  (artifact `dist/`) → `actions/deploy-pages`. Once Pages is available, the workflow enables and
  configures it itself; no manual repository setting is required.
- The PWA manifest and service worker are both scoped to `/ascify/`, so install and offline work
  under the sub-path.

### Service worker

`registerType: 'autoUpdate'`, precaching only the built application shell. `runtimeCaching` is
**empty by design** — there is no rule that could capture a `blob:` response, so the service worker
has no path to user media. Navigation falls back to the app shell so deep links work offline.

---

## Export formats

| Format | Notes |
|---|---|
| PNG / JPEG / WebP | Direct canvas encode; JPEG and WebP expose a quality slider |
| GIF | Self-contained encoder (median-cut palette + LZW) in `src/export/gifEncoder.js` — smaller than any npm alternative and one less thing to precache |
| MP4 / WebM | `MediaRecorder` over `canvas.captureStream()`; MP4 falls back to WebM where no H.264 encoder exists |
| SVG | Adjacent same-colour characters merged into single `<text>` runs, cutting node count 5–10× |
| `.txt` | JSON: `{ backgroundColor, dimensions: {width, height}, groups: [{text, count, x, y, color}] }` |
| `.txt` (plain) | Raw character rows, for pasting into a terminal |
| `.html` | Standalone Three.js page with `OrbitControls` and an optional `UnrealBloomPass`; opens by double-clicking |

Every export reports progress and can be cancelled. SVG, both `.txt` variants and the Three.js page
require the `ascii` effect, since they write characters rather than pixels.

---

## Project layout

```
src/
  lib/          store · schema · IndexedDB · share links · router · audio · presets
  media/        resource registry · source loading · GLB stage
  renderer/     engine · font atlas · params
    gl/         WebGL2 backend + GLSL
    gpu/        WebGPU backend + WGSL (lazy)
    cpu/        CPU backend + ascii analysis
  export/       format metadata · exporters · GIF encoder · Three.js template
  components/   panels · controls · preview · charset editor
  hooks/        breakpoints · pinch/pan gestures
  pages/        about
  state/        app store
scripts/        icon generation · privacy · responsive · render · Lighthouse checks
```

---

## Licence

MIT — see [LICENSE](LICENSE).
