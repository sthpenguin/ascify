import { useRef, useState } from 'react';
import { useApp } from '../../state/appStore.js';
import { FORMAT_META, suggestFilename } from '../../export/formats.js';
import { StatusLine } from '../controls/Controls.jsx';

/**
 * Export panel.
 *
 * Every format runs through the same controller: an AbortController for cancel,
 * a progress callback for the bar, and a Blob handed straight to a download.
 * Nothing intermediate is written anywhere.
 */
export function ExportPanel({ exportContext }) {
  const effect = useApp((s) => s.settings.effect);
  const media = useApp((s) => s.media);
  const [format, setFormat] = useState('png');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [seconds, setSeconds] = useState(3);
  const [fps, setFps] = useState(12);
  const [quality, setQuality] = useState(0.92);
  const [bloom, setBloom] = useState(true);
  const abortRef = useRef(null);

  const meta = FORMAT_META[format];
  const asciiOnly = meta.kind === 'ascii';
  const motion = meta.kind === 'motion';
  const blocked = asciiOnly && effect !== 'ascii';

  async function run() {
    if (!exportContext || !media) return;
    setError(null);
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // The encoders, the Three.js template and the video recorder are only
      // fetched once an export actually starts — they are dead weight on a
      // first paint that most visits never reach.
      const { runExport, downloadBlob } = await import('../../export/exporters.js');
      const blob = await runExport(format, exportContext, {
        signal: controller.signal,
        onProgress: setProgress,
        seconds,
        fps,
        quality,
        bloom,
      });
      downloadBlob(blob, suggestFilename(effect, meta.ext));
    } catch (err) {
      if (err?.name !== 'ExportCancelled') setError(err?.message ?? 'Export failed.');
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1">
        {Object.entries(FORMAT_META).map(([id, f]) => (
          <button
            key={id}
            type="button"
            data-active={format === id}
            onClick={() => setFormat(id)}
            className="term-btn truncate px-1 text-[12px]"
          >
            {f.label}
          </button>
        ))}
      </div>

      {motion ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="term-label">seconds</span>
            <input
              type="number"
              min={1}
              max={30}
              value={seconds}
              onChange={(e) => setSeconds(Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
              className="term-input mt-1"
            />
          </label>
          <label className="block">
            <span className="term-label">fps</span>
            <input
              type="number"
              min={5}
              max={60}
              value={fps}
              onChange={(e) => setFps(Math.min(60, Math.max(5, Number(e.target.value) || 12)))}
              className="term-input mt-1"
            />
          </label>
        </div>
      ) : null}

      {meta.options?.includes('quality') ? (
        <label className="block">
          <span className="term-label">quality {quality.toFixed(2)}</span>
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.01}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="ascify-range mt-1 w-full"
          />
        </label>
      ) : null}

      {meta.options?.includes('bloom') ? (
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="term-label">include UnrealBloomPass</span>
          <input
            type="checkbox"
            checked={bloom}
            onChange={(e) => setBloom(e.target.checked)}
            className="h-5 w-5 accent-[#00ff00]"
          />
        </label>
      ) : null}

      {progress === null ? (
        <button
          type="button"
          className="term-btn w-full"
          disabled={!media || blocked}
          onClick={() => void run()}
        >
          export {meta.label}
        </button>
      ) : (
        <div className="space-y-1">
          <div className="h-1.5 w-full bg-term-raised">
            <div
              className="h-full bg-term-accent transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <button
            type="button"
            className="term-btn w-full"
            onClick={() => abortRef.current?.abort()}
          >
            cancel ({Math.round(progress * 100)}%)
          </button>
        </div>
      )}

      {blocked ? <StatusLine tone="warn">{meta.label} needs the ascii effect.</StatusLine> : null}
      {!media ? <StatusLine>Load something first.</StatusLine> : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {format === 'mp4' ? (
        <StatusLine>
          Recorded through MediaRecorder. Browsers without an MP4 encoder fall back to WebM
          automatically.
        </StatusLine>
      ) : null}
    </div>
  );
}
