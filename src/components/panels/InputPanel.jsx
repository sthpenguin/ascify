import { useRef, useState, useCallback } from 'react';
import { useApp } from '../../state/appStore.js';
import { ACCEPT_ATTR, MAX_BYTES } from '../../media/mediaSource.js';
import { StatusLine } from '../controls/Controls.jsx';

/**
 * File input.
 *
 * Three routes in: drop, picker, and (on phones) the camera. All three go
 * through `load`, which disposes the previous media before touching the new
 * file — see media/resourceRegistry.js.
 */
export function InputPanel() {
  const load = useApp((s) => s.load);
  const clear = useApp((s) => s.clear);
  const mediaInfo = useApp((s) => s.mediaInfo);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.error);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const onFiles = useCallback(
    (files) => {
      const file = files?.[0];
      if (file) void load(file);
    },
    [load],
  );

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
        className={`flex min-h-24 flex-col items-center justify-center gap-1 border border-dashed p-3 text-center transition-colors ${
          dragOver ? 'border-term-accent bg-term-accent-faint' : 'border-term-line'
        }`}
      >
        <p className="text-[12px] text-term-muted">
          <span className="hidden sm:inline">drop a file here, or </span>choose one
        </p>
        <div className="flex w-full flex-wrap justify-center gap-1.5">
          <button type="button" className="term-btn flex-1" onClick={() => fileRef.current?.click()}>
            browse
          </button>
          <button
            type="button"
            className="term-btn flex-1 sm:hidden"
            onClick={() => cameraRef.current?.click()}
          >
            camera roll
          </button>
          <button type="button" className="term-btn flex-1" onClick={() => void load('camera')}>
            webcam
          </button>
        </div>
        <p className="text-[12px] text-term-muted">
          png · jpg · webp · gif · mp4 · webm · glb — up to {Math.round(MAX_BYTES / 1048576)}MB
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTR}
        aria-label="Choose an image, GIF, video or GLB file"
        className="sr-only"
        onChange={(e) => {
          onFiles(e.target.files);
          // Reset so re-picking the same file fires change again.
          e.target.value = '';
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        aria-label="Capture a photo or video with the camera"
        className="sr-only"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {loading ? (
        <div>
          <StatusLine>{loading.phase}…</StatusLine>
          <div className="mt-1 h-1 w-full bg-term-raised">
            <div
              className="h-full bg-term-accent transition-[width]"
              style={{ width: `${Math.round((loading.progress ?? 0) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="border border-term-error/40 bg-term-error/5 p-2">
          <StatusLine tone="error">{error.message}</StatusLine>
          {error.hint ? <StatusLine>{error.hint}</StatusLine> : null}
        </div>
      ) : null}

      {mediaInfo ? (
        <div className="border border-term-line p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[12px] text-term-text" title={mediaInfo.name}>
                {mediaInfo.name}
              </p>
              <p className="text-[12px] text-term-muted">
                {mediaInfo.kind} · {mediaInfo.width}×{mediaInfo.height}
                {mediaInfo.duration ? ` · ${mediaInfo.duration.toFixed(1)}s` : ''}
                {mediaInfo.sizeLabel ? ` · ${mediaInfo.sizeLabel}` : ''}
              </p>
            </div>
            <button type="button" className="term-btn shrink-0" onClick={clear}>
              clear
            </button>
          </div>
        </div>
      ) : null}

      <p className="text-[12px] leading-snug text-term-accent-dim">
        Private by design — your files never leave this device.
      </p>
    </div>
  );
}
