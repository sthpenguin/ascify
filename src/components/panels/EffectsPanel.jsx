import { useApp } from '../../state/appStore.js';
import { EFFECTS, EFFECT_IDS, ASCII_DEFS, CHARSET_LABELS } from '../../lib/schema.js';
import { ParamGroup } from '../controls/ParamGroup.jsx';
import { CharsetEditor } from '../CharsetEditor.jsx';

export function EffectsPanel() {
  const effect = useApp((s) => s.settings.effect);
  const setEffect = useApp((s) => s.setEffect);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1 xl:grid-cols-3">
        {EFFECT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            data-active={effect === id}
            title={EFFECTS[id].blurb}
            onClick={() => setEffect(id)}
            className="term-btn justify-start truncate px-2 text-[12px]"
          >
            {EFFECTS[id].label}
          </button>
        ))}
      </div>
      <p className="text-[12px] leading-snug text-term-muted">{EFFECTS[effect].blurb}</p>
    </div>
  );
}

/** Parameters for whichever effect is active, including the ascii sub-panel. */
export function EffectParamsPanel() {
  const effect = useApp((s) => s.settings.effect);
  const effectParams = useApp((s) => s.settings.effectParams[s.settings.effect]);
  const ascii = useApp((s) => s.settings.ascii);
  const updateSettings = useApp((s) => s.updateSettings);

  const setEffectParam = (key, value, transient) =>
    updateSettings(
      (s) => ({
        ...s,
        effectParams: { ...s.effectParams, [effect]: { ...s.effectParams[effect], [key]: value } },
      }),
      { transient, path: ['effectParams', effect, key] },
    );

  const setAscii = (key, value, transient) =>
    updateSettings((s) => ({ ...s, ascii: { ...s.ascii, [key]: value } }), {
      transient,
      path: ['ascii', key],
    });

  if (effect === 'ascii') {
    return (
      <div className="space-y-2">
        <ParamGroup
          defs={ASCII_DEFS}
          values={ascii}
          groupPath={['ascii']}
          onChange={setAscii}
          labels={{ charset: CHARSET_LABELS }}
          exclude={['customCharset']}
        />
        <p className="text-[12px] leading-snug text-term-muted">
          Output width 0 follows the scale slider; any other value pins the column count.
        </p>
        <CharsetEditor />
      </div>
    );
  }

  const defs = EFFECTS[effect].params;
  if (!Object.keys(defs).length) {
    return <p className="text-[12px] text-term-muted">This effect has no parameters.</p>;
  }

  return (
    <ParamGroup
      defs={defs}
      values={effectParams}
      groupPath={['effectParams', effect]}
      onChange={setEffectParam}
    />
  );
}
