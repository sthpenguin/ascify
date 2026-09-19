import { useMemo } from 'react';
import { useApp } from '../../state/appStore.js';
import { ADJUSTMENT_DEFS, POST_DEFS, RENDER_DEFS, AUDIO_DEFS } from '../../lib/schema.js';
import { ParamGroup } from '../controls/ParamGroup.jsx';
import { StatusLine } from '../controls/Controls.jsx';

/** Global image adjustments. */
export function AdjustmentsPanel() {
  const adjustments = useApp((s) => s.settings.adjustments);
  const updateSettings = useApp((s) => s.updateSettings);
  const colorMode = adjustments.colorMode;

  const set = (key, value, transient) =>
    updateSettings((s) => ({ ...s, adjustments: { ...s.adjustments, [key]: value } }), {
      transient,
      path: ['adjustments', key],
    });

  return (
    <ParamGroup
      defs={ADJUSTMENT_DEFS}
      values={adjustments}
      groupPath={['adjustments']}
      onChange={set}
      // The gradient endpoints only mean anything in gradient mode.
      exclude={colorMode === 'gradient' ? [] : ['gradientFrom', 'gradientTo']}
    />
  );
}

/** Renderer/performance settings, plus live backend telemetry. */
/**
 * What this device actually supports. Read once — these do not change within a
 * session — and shown in the panel so a rendering problem can be diagnosed from
 * the phone it happens on, without a console.
 */
function readCapabilities() {
  let webgl2 = false;
  try {
    const probe = document.createElement('canvas');
    webgl2 = !!probe.getContext('webgl2');
    probe.width = 0;
    probe.height = 0;
  } catch {
    webgl2 = false;
  }
  return {
    webgl2,
    webgpu: typeof navigator !== 'undefined' && !!navigator.gpu,
    dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

export function ProcessingPanel() {
  const render = useApp((s) => s.settings.render);
  const stats = useApp((s) => s.stats);
  const updateSettings = useApp((s) => s.updateSettings);
  const caps = useMemo(readCapabilities, []);

  const set = (key, value, transient) =>
    updateSettings((s) => ({ ...s, render: { ...s.render, [key]: value } }), {
      transient,
      path: ['render', key],
    });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border border-term-line p-2 text-[12px]">
        <span className="text-term-muted">backend</span>
        <span className="text-right text-term-accent">{stats.backend}</span>
        <span className="text-term-muted">fps</span>
        <span className="text-right text-term-accent tabular-nums">{stats.fps}</span>
        <span className="text-term-muted">render size</span>
        <span className="text-right text-term-accent tabular-nums">
          {stats.width}×{stats.height}
        </span>
        <span className="text-term-muted">webgl2 / webgpu</span>
        <span className="text-right text-term-accent">
          {caps.webgl2 ? 'yes' : 'no'} / {caps.webgpu ? 'yes' : 'no'}
        </span>
        <span className="text-term-muted">viewport @dpr</span>
        <span className="text-right text-term-accent tabular-nums">
          {caps.viewport} @{caps.dpr}
        </span>
      </div>
      <ParamGroup defs={RENDER_DEFS} values={render} groupPath={['render']} onChange={set} />
      <StatusLine>
        auto picks WebGPU, then WebGL2, then CPU. Phones get a lower pixel budget to stay cool.
      </StatusLine>
    </div>
  );
}

export function PostPanel() {
  const post = useApp((s) => s.settings.post);
  const updateSettings = useApp((s) => s.updateSettings);

  const set = (key, value, transient) =>
    updateSettings((s) => ({ ...s, post: { ...s.post, [key]: value } }), {
      transient,
      path: ['post', key],
    });

  return (
    <ParamGroup
      defs={POST_DEFS}
      values={post}
      groupPath={['post']}
      onChange={set}
      exclude={post.bloom > 0 ? [] : ['bloomThreshold']}
    />
  );
}

export function AudioPanel() {
  const audio = useApp((s) => s.settings.audio);
  const updateSettings = useApp((s) => s.updateSettings);

  const set = (key, value, transient) =>
    updateSettings((s) => ({ ...s, audio: { ...s.audio, [key]: value } }), {
      transient,
      path: ['audio', key],
    });

  return (
    <div className="space-y-2">
      <ParamGroup defs={AUDIO_DEFS} values={audio} groupPath={['audio']} onChange={set} />
      <StatusLine>
        Microphone audio is analysed in-page and never recorded, stored or sent anywhere.
      </StatusLine>
    </div>
  );
}
