import { useEffect, useRef, useCallback, useState } from 'react';
import { useApp } from '../state/appStore.js';
import { usePinchPan } from '../hooks/usePinchPan.js';

/**
 * The preview surface.
 *
 * Owns the renderer engine and the pointer gestures. The canvas is transformed
 * with CSS (zoom/pan) rather than re-rendered at a different resolution, so
 * dragging around a 4K frame costs nothing.
 */
export function Preview({ onContext }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const engineRef = useRef(null);
  const audioRef = useRef(null);

  const media = useApp((s) => s.media);
  const settings = useApp((s) => s.settings);
  const ui = useApp((s) => s.ui);
  const setStats = useApp((s) => s.setStats);
  const updateUi = useApp((s) => s.updateUi);
  const [playing, setPlaying] = useState(true);
  const [scrub, setScrub] = useState(0);
  // Surfaced on screen rather than only in the console: a preview that renders
  // nothing is indistinguishable from one that is merely empty, and on a phone
  // there is no console to check.
  const [engineError, setEngineError] = useState(null);
  const [frameBox, setFrameBox] = useState(null);

  const { zoom, panX, panY } = ui;

  const setTransform = useCallback(
    (next) => updateUi(next),
    [updateUi],
  );

  usePinchPan(wrapRef, { zoom, panX, panY }, setTransform);

  /* ---------------------------------------------------------- engine setup */

  // The renderer (shader sources, all three backends, the font atlas) is only
  // fetched once there is something to render. An empty studio needs none of
  // it, and that is the state every first visit starts in.
  const [engineReady, setEngineReady] = useState(false);

  // A canvas element is permanently bound to the first context type it is
  // given, so changing backend means mounting a new canvas. `canvasKey` is
  // what forces that remount; `backendOverride` is set when a backend dies
  // mid-frame and the engine asks to be rebuilt one rung lower.
  const backendPref = settings.render.backend;
  const [canvasKey, setCanvasKey] = useState(0);
  const backendOverride = useRef(null);
  const lastPref = useRef(backendPref);

  useEffect(() => {
    if (lastPref.current === backendPref) return;
    lastPref.current = backendPref;
    backendOverride.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
    setEngineReady(false);
    setCanvasKey((k) => k + 1);
  }, [backendPref]);

  // Clearing media tears the engine down rather than just stopping it. A
  // stopped backend leaves its last frame on the canvas, which reads as "clear
  // didn't work", and it would also keep the GPU textures for a file the user
  // has just asked to be rid of. The canvas itself unmounts (see below), so
  // the next load starts from a fresh one.
  useEffect(() => {
    if (media) setEngineError(null);
  }, [media]);

  useEffect(() => {
    if (media || !engineRef.current) return;
    engineRef.current.dispose();
    engineRef.current = null;
    backendOverride.current = null;
    setEngineReady(false);
    setStats({ fps: 0, backend: 'none', width: 0, height: 0 });
    setCanvasKey((k) => k + 1);
  }, [media, setStats]);

  useEffect(() => {
    if (!media || engineRef.current) return undefined;
    let cancelled = false;
    void (async () => {
      const { createEngine } = await import('../renderer/index.js');
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const current = useApp.getState().settings;
      const pref = backendOverride.current ?? current.render.backend;
      try {
        const engine = await createEngine(canvas, {
          settings: pref === current.render.backend ? current : { ...current, render: { ...current.render, backend: pref } },
          onStats: setStats,
          onBackendChange: (name) => setStats({ ...useApp.getState().stats, backend: name }),
          onError: (err) => {
            // Backend problems are recoverable; surface them without a modal.
            console.warn('[ascify renderer]', err);
            setEngineError(String(err?.message ?? err).slice(0, 220));
          },
          onFatal: (next) => {
            // Rebuild one rung down on a brand-new canvas.
            backendOverride.current = next;
            engineRef.current?.dispose();
            engineRef.current = null;
            setEngineReady(false);
            setCanvasKey((k) => k + 1);
          },
        });
        if (cancelled || !engine) {
          engine?.dispose();
          return;
        }
        engineRef.current = engine;
        setEngineReady(true);
      } catch (err) {
        const message = err?.message ?? 'No rendering backend is available.';
        setEngineError(message);
        useApp.getState().setError({ message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [media, canvasKey, setStats]);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    [],
  );

  useEffect(() => {
    engineRef.current?.setSettings(settings);
  }, [settings, engineReady]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return undefined;
    // setSettings must land before the first frame so a backend exists.
    engine.setSettings(settings);
    engine.setSource(media);
    if (!media) {
      engine.stop();
      return undefined;
    }
    const wrap = wrapRef.current;
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      engine.setViewport({ width: r.width, height: r.height });
    }
    // Still images need exactly one frame; everything else runs the loop.
    if (media.animated) {
      engine.start();
    } else {
      engine.renderOnce();
      // A settings change on a still image re-renders via the effect below.
    }
    return () => engine.stop();
    // `settings` is intentionally omitted: it is applied by the effect above,
    // and restarting the loop on every slider tick would stutter playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, engineReady]);

  // Still images: re-render on any settings change.
  useEffect(() => {
    const engine = engineRef.current;
    if (engine && media && !media.animated) engine.renderOnce();
  }, [settings, media]);

  /* ----------------------------------------------------------- viewport fit */

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setFrameBox({ width: Math.round(width), height: Math.round(height) });
      engineRef.current?.setViewport({ width, height });
      if (media && !media.animated) engineRef.current?.renderOnce();
      media?.resize?.(width, height);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [media]);

  /* ------------------------------------------------------------ audio input */

  useEffect(() => {
    if (!settings.audio.enabled) {
      void audioRef.current?.stop();
      audioRef.current = null;
      engineRef.current?.setAudioLevel(0);
      return undefined;
    }
    let cancelled = false;
    let raf = 0;

    void (async () => {
      // Web Audio plumbing only loads for the people who switch it on.
      const { createAudioAnalyser } = await import('../lib/audio.js');
      if (cancelled) return;
      const analyser = createAudioAnalyser();
      audioRef.current = analyser;
      try {
        await analyser.startFromMic();
      } catch {
        if (!cancelled) useApp.getState().setError({ message: 'Microphone access was denied.' });
        return;
      }
      const tick = () => {
        raf = requestAnimationFrame(tick);
        engineRef.current?.setAudioLevel(
          analyser.sample(settings.audio.band, settings.audio.smoothing),
        );
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      void audioRef.current?.stop();
      audioRef.current = null;
    };
  }, [settings.audio.enabled, settings.audio.band, settings.audio.smoothing]);

  /* ------------------------------------------------- GLB orbit passthrough */

  useEffect(() => {
    if (media?.kind !== 'model' || !media.attachControls) return undefined;
    return media.attachControls(wrapRef.current);
  }, [media]);

  /* ------------------------------------------------------- export context */

  useEffect(() => {
    if (!onContext) return;
    const engine = engineRef.current;
    if (!engine || !media) {
      onContext(null);
      return;
    }
    onContext({
      canvas: canvasRef.current,
      source: media,
      backgroundColor: '#0a0a0a',
      renderOnce: () => engine.renderOnce(),
      asciiGrid: () => engine.asciiGrid(),
      startLoop: () => engine.start(),
      stopLoop: () => engine.stop(),
      /** Seek + render one frame; used by the GIF exporter. */
      renderAt: async (mediaTime) => {
        if (media.seek && media.duration) {
          media.seek(mediaTime);
          // Give the decoder a moment to land on the requested frame.
          await new Promise((r) => setTimeout(r, media.kind === 'video' ? 40 : 0));
        } else {
          media.tick?.(1 / 12);
        }
        engine.renderOnce();
      },
    });
  }, [media, onContext, engineReady]);

  /* ------------------------------------------------------------- transport */

  const isTimeline = media && media.duration > 0 && media.seek;

  useEffect(() => {
    if (!isTimeline) return undefined;
    const id = setInterval(() => {
      const t = media.currentTime?.();
      if (Number.isFinite(t)) setScrub(t);
    }, 250);
    return () => clearInterval(id);
  }, [isTimeline, media]);

  // Remember the playhead (a number — never a frame) across reloads.
  useEffect(() => {
    if (!isTimeline) return undefined;
    const id = setInterval(() => {
      const t = media.currentTime?.();
      if (Number.isFinite(t)) updateUi({ videoTime: t });
    }, 2000);
    return () => clearInterval(id);
  }, [isTimeline, media, updateUi]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={wrapRef}
        className="relative flex min-h-0 flex-1 touch-none-pan items-center justify-center overflow-hidden bg-term-bg"
        style={{
          backgroundImage: ui.showGrid
            ? 'linear-gradient(#0f170f 1px, transparent 1px), linear-gradient(90deg, #0f170f 1px, transparent 1px)'
            : undefined,
          backgroundSize: ui.showGrid ? '24px 24px' : undefined,
        }}
      >
        {/* The canvas fills its frame absolutely so its box never depends on
            percentage resolution, and object-contain letterboxes the bitmap
            inside it. max-height:100% on a flex child is exactly the kind of
            thing Safari gets wrong when the parent height came from flex. */}
        {media ? (
          <canvas
            key={canvasKey}
            ref={canvasRef}
            className="absolute inset-0 h-full w-full object-contain"
            style={{
              transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
              transformOrigin: 'center',
              imageRendering: zoom > 1.8 ? 'pixelated' : 'auto',
            }}
          />
        ) : null}

        {media && (engineError || (frameBox && frameBox.height < 24)) ? (
          <div className="absolute inset-x-2 top-2 z-10 border border-term-error/50 bg-term-bg/95 p-2">
            <p className="text-[12px] text-term-error">
              {engineError
                ? 'The renderer could not start on this device.'
                : 'The preview area has collapsed to no height.'}
            </p>
            <p className="mt-1 break-words text-[12px] text-term-muted">
              {engineError ?? `frame ${frameBox?.width}x${frameBox?.height}`}
            </p>
          </div>
        ) : null}

        {!media ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
            <div className="space-y-1">
              <p className="text-term-accent-dim">ascify</p>
              <p className="text-[12px] text-term-muted">
                Load an image, GIF, video, webcam or .glb to begin.
              </p>
              <p className="text-[12px] text-term-accent-dim">
                Private by design — your files never leave this device.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <PreviewToolbar
        media={media}
        playing={playing}
        setPlaying={setPlaying}
        scrub={scrub}
        setScrub={setScrub}
        isTimeline={isTimeline}
        zoom={zoom}
        setTransform={setTransform}
      />
    </div>
  );
}

function PreviewToolbar({ media, playing, setPlaying, scrub, setScrub, isTimeline, zoom, setTransform }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-term-line bg-term-panel px-2 py-1.5">
      {media?.animated ? (
        <button
          type="button"
          className="term-btn w-11 px-0"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (playing) media.pause?.();
            else media.play?.();
            setPlaying(!playing);
          }}
        >
          {playing ? '❚❚' : '▶'}
        </button>
      ) : null}

      {isTimeline ? (
        <input
          type="range"
          min={0}
          max={media.duration}
          step={0.05}
          value={Math.min(scrub, media.duration)}
          onChange={(e) => {
            const t = Number(e.target.value);
            setScrub(t);
            media.seek(t);
          }}
          className="ascify-range min-w-24 flex-1"
          aria-label="Timeline"
        />
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          className="term-btn w-11 px-0"
          aria-label="Zoom out"
          onClick={() => setTransform({ zoom: Math.max(0.2, zoom / 1.25) })}
        >
          −
        </button>
        <span className="min-w-12 text-center text-[12px] tabular-nums text-term-muted">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="term-btn w-11 px-0"
          aria-label="Zoom in"
          onClick={() => setTransform({ zoom: Math.min(8, zoom * 1.25) })}
        >
          +
        </button>
        <button
          type="button"
          className="term-btn px-2 text-[12px]"
          onClick={() => setTransform({ zoom: 1, panX: 0, panY: 0 })}
        >
          fit
        </button>
      </div>
    </div>
  );
}
