import { Slider, Select, Toggle, TextField, ColorField } from './Controls.jsx';
import { useApp } from '../../state/appStore.js';

/**
 * Renders a whole group of schema params.
 *
 * Because the descriptors drive the widget choice, adding a parameter to
 * lib/schema.js is all it takes for it to appear here, persist, undo/redo and
 * ride along in a share link.
 */
export function ParamGroup({ defs, values, onChange, groupPath, labels, disabled, exclude = [] }) {
  const beginGesture = useApp((s) => s.beginGesture);

  return (
    <div className="space-y-0.5">
      {Object.entries(defs).map(([key, def]) => {
        if (exclude.includes(key)) return null;
        const value = values[key];
        const path = [...groupPath, key];
        const commit = (v, transient) => onChange(key, v, transient);

        if (def.kind === 'number') {
          return (
            <Slider
              key={key}
              name={key}
              def={def}
              value={value}
              disabled={disabled}
              onBegin={() => beginGesture(path)}
              // Mid-drag updates are transient: the pre-drag snapshot is
              // already on the undo stack, so each gesture is one step.
              onChange={(v) => commit(v, true)}
              onCommit={(v) => commit(v, true)}
            />
          );
        }
        if (def.kind === 'enum') {
          return (
            <Select
              key={key}
              name={key}
              def={def}
              value={value}
              disabled={disabled}
              labels={labels?.[key]}
              onChange={(v) => commit(v, false)}
            />
          );
        }
        if (def.kind === 'bool') {
          return (
            <Toggle
              key={key}
              name={key}
              def={def}
              value={value}
              disabled={disabled}
              onChange={(v) => commit(v, false)}
            />
          );
        }
        if (def.kind === 'string') {
          const isColor = /^#[0-9a-f]{6}$/i.test(def.def);
          const Cmp = isColor ? ColorField : TextField;
          return (
            <Cmp
              key={key}
              name={key}
              def={def}
              value={value}
              disabled={disabled}
              onChange={(v) => commit(v, false)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
