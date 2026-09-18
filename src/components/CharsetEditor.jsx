import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/appStore.js';
import { CHARSETS, resolveCharset } from '../lib/schema.js';
import { buildFontAtlas, sortedRampIndices } from '../renderer/fontAtlas.js';

/**
 * Custom character-set editor.
 *
 * The live preview is the point: it renders a luminance sweep through the ramp
 * using the *same* atlas and ink-coverage ordering the renderer uses, so a
 * charset that looks smooth here looks smooth in the output. Characters typed
 * in any order are sorted by measured ink, and duplicates are flagged.
 */
export function CharsetEditor() {
  const ascii = useApp((s) => s.settings.ascii);
  const updateSettings = useApp((s) => s.updateSettings);
  const canvasRef = useRef(null);
  const [expanded, setExpanded] = useState(ascii.charset === 'custom');

  const isCustom = ascii.charset === 'custom';
  const chars = useMemo(() => resolveCharset(ascii), [ascii]);

  const analysis = useMemo(() => {
    const atlas = buildFontAtlas(chars, { size: 32 });
    const order = sortedRampIndices(atlas).reverse();
    const seen = new Set();
    const duplicates = [];
    for (const c of chars) {
      if (seen.has(c)) duplicates.push(c);
      seen.add(c);
    }
    return { atlas, order, duplicates, unique: seen.size };
  }, [chars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !expanded) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 240;
    const cssH = 56;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, cssW, cssH);

    // A left-to-right luminance ramp, rendered through the active charset.
    const cols = Math.max(8, Math.floor(cssW / 9));
    const rows = 3;
    const cw = cssW / cols;
    const ch = cssH / rows;
    ctx.font = `500 ${Math.floor(ch * 0.95)}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const { order } = analysis;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const t = cols > 1 ? x / (cols - 1) : 0;
        const slot = Math.round(t * (order.length - 1));
        const char = chars[order[slot]] ?? ' ';
        const g = Math.round(60 + t * 195);
        ctx.fillStyle = `rgb(0,${g},${Math.round(g * 0.35)})`;
        ctx.fillText(char, (x + 0.5) * cw, (y + 0.5) * ch);
      }
    }
  }, [chars, analysis, expanded]);

  const setCharset = (value) =>
    updateSettings((s) => ({ ...s, ascii: { ...s.ascii, charset: value } }), {
      path: ['ascii', 'charset'],
    });

  const setCustom = (value) =>
    updateSettings((s) => ({ ...s, ascii: { ...s.ascii, customCharset: value, charset: 'custom' } }), {
      path: ['ascii', 'customCharset'],
    });

  return (
    <div className="border border-term-line">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex min-h-11 w-full items-center gap-2 px-2 text-left hover:bg-term-raised"
      >
        <span className="text-[12px] text-term-accent-dim">{expanded ? '▼' : '▶'}</span>
        <span className="term-label text-term-text">charset editor</span>
        <span className="ml-auto text-[12px] text-term-muted">{chars.length} glyphs</span>
      </button>

      {expanded ? (
        <div className="space-y-2 p-2 pt-0">
          <canvas
            ref={canvasRef}
            className="block w-full border border-term-line-soft"
            style={{ height: 56 }}
            aria-label="Live preview of the character ramp"
          />

          <textarea
            value={isCustom ? ascii.customCharset : CHARSETS[ascii.charset] ?? ''}
            onChange={(e) => setCustom(e.target.value)}
            rows={2}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Type characters darkest…lightest — order is corrected automatically"
            className="w-full resize-y border border-term-line bg-term-bg p-2 font-mono text-[13px] text-term-text"
          />

          <div className="flex flex-wrap gap-1">
            {Object.keys(CHARSETS)
              .filter((k) => k !== 'custom')
              .map((k) => (
                <button
                  key={k}
                  type="button"
                  data-active={ascii.charset === k}
                  onClick={() => setCharset(k)}
                  className="term-btn px-2 text-[12px]"
                >
                  {k}
                </button>
              ))}
          </div>

          <p className="text-[12px] leading-snug text-term-muted">
            Glyphs are ordered by measured ink coverage, so the ramp stays monotonic no matter how you
            type it.
            {analysis.duplicates.length
              ? ` ${analysis.duplicates.length} duplicate${analysis.duplicates.length > 1 ? 's' : ''} ignored.`
              : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}
