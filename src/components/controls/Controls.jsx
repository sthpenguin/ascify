import { useId, useRef, useState, useEffect } from 'react';

/**
 * Schema-driven controls.
 *
 * Each takes a param descriptor from lib/schema.js, so min/max/step/label and
 * the reset value all come from one place and cannot drift from what the
 * renderer and the persistence layer expect.
 */

export function Slider({ def, value, onChange, onCommit, onBegin, name, disabled }) {
  const id = useId();
  const dragging = useRef(false);
  const isDefault = Math.abs(value - def.def) < (def.step ?? 0.01) / 2;

  const commit = (v) => {
    onChange(v);
  };

  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="term-label truncate">
          {def.label ?? name}
        </label>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[12px] tabular-nums text-term-accent">
            {formatValue(value, def)}
            {def.unit ?? ''}
          </span>
          <button
            type="button"
            title={`Reset ${def.label ?? name}`}
            aria-label={`Reset ${def.label ?? name}`}
            disabled={disabled || isDefault}
            onClick={() => {
              onBegin?.();
              onChange(def.def);
              onCommit?.(def.def);
            }}
            className="tap h-6 w-6 shrink-0 border border-term-line text-[12px] leading-none text-term-muted hover:border-term-accent-dim hover:text-term-accent disabled:opacity-30"
          >
            ↺
          </button>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        disabled={disabled}
        // Pointer events bracket the gesture so undo treats a drag as one step.
        onPointerDown={() => {
          dragging.current = true;
          onBegin?.();
        }}
        onPointerUp={() => {
          if (dragging.current) {
            dragging.current = false;
            onCommit?.(value);
          }
        }}
        onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onBegin?.();
        }}
        onKeyUp={() => onCommit?.(value)}
        onChange={(e) => commit(Number(e.target.value))}
        className="ascify-range w-full"
      />
    </div>
  );
}

function formatValue(v, def) {
  if (def.step >= 1) return String(Math.round(v));
  if (def.step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

export function Select({ def, value, onChange, name, labels, disabled }) {
  const id = useId();
  return (
    <div className="py-1">
      <label htmlFor={id} className="term-label block">
        {def.label ?? name}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="term-input mt-1 cursor-pointer"
      >
        {def.options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Toggle({ def, value, onChange, name, disabled }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <label htmlFor={id} className="term-label cursor-pointer">
        {def.label ?? name}
      </label>
      {/* The button carries the hit area; the inner span is the visible track,
          so the switch stays compact while remaining tappable. */}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className="tap min-h-6 shrink-0 disabled:opacity-40"
      >
        <span
          className={`relative block h-6 w-11 border transition-colors ${
            value ? 'border-term-accent bg-term-accent-faint' : 'border-term-line bg-term-raised'
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 transition-all ${
              value ? 'left-6 bg-term-accent' : 'left-0.5 bg-term-muted'
            }`}
          />
        </span>
      </button>
    </div>
  );
}

export function TextField({ def, value, onChange, name, placeholder, mono = true, disabled }) {
  const id = useId();
  return (
    <div className="py-1">
      <label htmlFor={id} className="term-label block">
        {def?.label ?? name}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={def?.maxLength ?? 256}
        onChange={(e) => onChange(e.target.value)}
        className={`term-input mt-1 ${mono ? 'font-mono' : ''}`}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}

export function ColorField({ def, value, onChange, name, disabled }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <label htmlFor={id} className="term-label">
        {def?.label ?? name}
      </label>
      <input
        id={id}
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#00ff00'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-14 cursor-pointer border border-term-line bg-term-bg p-0.5"
      />
    </div>
  );
}

/** Collapsible panel section — the primary structure on every screen size. */
export function Section({ title, open, onToggle, children, right, id }) {
  return (
    <section className="border-b border-term-line-soft last:border-b-0" aria-labelledby={id}>
      <div className="flex items-stretch">
        <button
          type="button"
          id={id}
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-h-11 flex-1 items-center gap-2 px-3 text-left hover:bg-term-raised"
        >
          <span className="text-term-accent-dim text-[12px]">{open ? '▼' : '▶'}</span>
          <span className="term-label text-term-text">{title}</span>
        </button>
        {right ? <div className="flex items-center pr-2">{right}</div> : null}
      </div>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </section>
  );
}

/** Announces async state to assistive tech as well as to the eye. */
export function StatusLine({ tone = 'muted', children }) {
  const color =
    tone === 'error' ? 'text-term-error' : tone === 'warn' ? 'text-term-warn' : 'text-term-muted';
  return (
    <p role="status" className={`text-[12px] leading-snug ${color}`}>
      {children}
    </p>
  );
}

/** Copy-to-clipboard button that confirms in place rather than via a toast. */
export function CopyButton({ text, label = 'copy', className = '' }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={`term-btn ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'copied ✓' : label}
    </button>
  );
}
