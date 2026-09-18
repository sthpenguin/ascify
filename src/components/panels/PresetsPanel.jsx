import { useState } from 'react';
import { useApp } from '../../state/appStore.js';
import { buildShareUrl } from '../../lib/shareLink.js';
import { CopyButton, StatusLine } from '../controls/Controls.jsx';
import { BUILTIN_PRESETS } from '../../lib/builtinPresets.js';

/**
 * Presets and sharing.
 *
 * A share link encodes the parameter diff only. There is no code path from
 * media to a URL — see lib/shareLink.js, which walks the defaults tree rather
 * than the live object.
 */
export function PresetsPanel() {
  const settings = useApp((s) => s.settings);
  const presets = useApp((s) => s.presets);
  const applyPreset = useApp((s) => s.applyPreset);
  const saveCurrentAsPreset = useApp((s) => s.saveCurrentAsPreset);
  const removePreset = useApp((s) => s.removePreset);
  const resetSettings = useApp((s) => s.resetSettings);
  const [name, setName] = useState('');

  const shareUrl = buildShareUrl(settings);

  return (
    <div className="space-y-3">
      <div>
        <p className="term-label mb-1">gallery</p>
        <div className="grid grid-cols-2 gap-1">
          {BUILTIN_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              title={p.blurb}
              onClick={() => applyPreset({ ...settings, ...p.settings })}
              className="term-btn justify-start truncate px-2 text-[12px]"
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="term-label mb-1">save current</p>
        <div className="flex gap-1">
          <input
            type="text"
            value={name}
            maxLength={64}
            placeholder="preset name"
            onChange={(e) => setName(e.target.value)}
            className="term-input"
          />
          <button
            type="button"
            className="term-btn shrink-0"
            disabled={!name.trim()}
            onClick={async () => {
              await saveCurrentAsPreset(name.trim());
              setName('');
            }}
          >
            save
          </button>
        </div>
      </div>

      {presets.length ? (
        <div>
          <p className="term-label mb-1">saved</p>
          <ul className="space-y-1">
            {presets.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => applyPreset(p.settings)}
                  className="term-btn flex-1 justify-start truncate px-2 text-[12px]"
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete preset ${p.name}`}
                  onClick={() => void removePreset(p.id)}
                  className="term-btn w-11 shrink-0 px-0 text-term-muted hover:text-term-error"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="term-label mb-1">share these settings</p>
        <div className="flex gap-1">
          <input readOnly value={shareUrl} className="term-input truncate" onFocus={(e) => e.target.select()} />
          <CopyButton text={shareUrl} className="shrink-0" />
        </div>
        <StatusLine>Parameters only — no media, ever.</StatusLine>
      </div>

      <button type="button" className="term-btn w-full" onClick={resetSettings}>
        reset all settings
      </button>
    </div>
  );
}
