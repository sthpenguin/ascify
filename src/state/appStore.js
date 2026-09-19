import { create } from '../lib/store.js';
import {
  DEFAULT_SETTINGS,
  DEFAULT_UI,
  sanitizeSettings,
  sanitizeUi,
  EFFECTS,
} from '../lib/schema.js';
import { loadPersisted, savePersisted, listPresets, savePreset, deletePreset } from '../lib/db.js';
import { loadMedia, clearMedia, MediaError } from '../media/mediaSource.js';
import { decodeParams } from '../lib/shareLink.js';

/**
 * Application state.
 *
 * Deliberately split in two: `settings`/`ui` are plain data and get persisted;
 * `media` holds live object handles and is *never* written anywhere. The
 * setters below are the only way media enters state, and each one disposes the
 * previous generation first.
 */

const HISTORY_LIMIT = 60;

function samePath(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export const useApp = create((set, get) => ({
  ready: false,
  settings: structuredClone(DEFAULT_SETTINGS),
  ui: structuredClone(DEFAULT_UI),

  /** Live media handle. Not serialisable, not persisted, not shareable. */
  media: null,
  mediaInfo: null, // { kind, name, width, height, duration, sizeLabel }
  loading: null, // { phase, progress }
  error: null,
  notice: null,

  presets: [],
  backend: 'none',
  stats: { fps: 0, backend: 'none', width: 0, height: 0 },

  history: { past: [], future: [] },

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    const { settings, ui, reset } = await loadPersisted();
    const shared = decodeParams(window.location.search);
    const merged = shared ? sanitizeSettings({ ...settings, ...shared }) : settings;
    set({
      settings: merged,
      ui,
      ready: true,
      notice: reset ? 'Stored settings were from an older version and have been reset.' : null,
    });
    void get().refreshPresets();
  },

  /* -------------------------------------------------------------- settings */

  /**
   * Commit a settings change.
   * `transient` (a slider mid-drag) updates state without pushing history, so
   * one undo step corresponds to one gesture rather than 200 pointer events.
   */
  updateSettings(updater, { transient = false, path = [] } = {}) {
    const prev = get().settings;
    const next = sanitizeSettings(typeof updater === 'function' ? updater(prev) : { ...prev, ...updater });
    if (JSON.stringify(next) === JSON.stringify(prev)) return;

    if (!transient) {
      const { past } = get().history;
      const last = past[past.length - 1];
      // Consecutive edits to the same control collapse into one history entry.
      const collapse = last && path.length && samePath(last.path ?? [], path) && Date.now() - last.at < 700;
      const entry = { settings: prev, path, at: Date.now() };
      const newPast = collapse ? [...past.slice(0, -1), { ...last, at: Date.now() }] : [...past, entry];
      set({
        settings: next,
        history: { past: newPast.slice(-HISTORY_LIMIT), future: [] },
      });
    } else {
      set({ settings: next });
    }
    void savePersisted({ settings: next });
  },

  /**
   * Push the pre-gesture snapshot when a drag begins.
   *
   * Repeated arrow-key presses on the same slider fire this once per keydown,
   * so a recent entry for the same control is reused rather than stacked —
   * otherwise holding an arrow key would fill the undo stack with 60 steps.
   */
  beginGesture(path = []) {
    const { past } = get().history;
    const last = past[past.length - 1];
    if (last && samePath(last.path ?? [], path) && Date.now() - last.at < 700) {
      set({ history: { past: [...past.slice(0, -1), { ...last, at: Date.now() }], future: [] } });
      return;
    }
    set({
      history: {
        past: [...past, { settings: get().settings, path, at: Date.now() }].slice(-HISTORY_LIMIT),
        future: [],
      },
    });
  },

  undo() {
    const { past, future } = get().history;
    if (!past.length) return;
    const entry = past[past.length - 1];
    const current = get().settings;
    set({
      settings: entry.settings,
      history: { past: past.slice(0, -1), future: [{ settings: current, path: entry.path }, ...future].slice(0, HISTORY_LIMIT) },
    });
    void savePersisted({ settings: entry.settings });
  },

  redo() {
    const { past, future } = get().history;
    if (!future.length) return;
    const entry = future[0];
    const current = get().settings;
    set({
      settings: entry.settings,
      history: { past: [...past, { settings: current, path: entry.path }].slice(-HISTORY_LIMIT), future: future.slice(1) },
    });
    void savePersisted({ settings: entry.settings });
  },

  canUndo: () => get().history.past.length > 0,
  canRedo: () => get().history.future.length > 0,

  setEffect(effect) {
    if (!EFFECTS[effect]) return;
    get().updateSettings({ effect }, { path: ['effect'] });
  },

  resetSettings() {
    get().updateSettings(structuredClone(DEFAULT_SETTINGS), { path: ['reset'] });
  },

  /* -------------------------------------------------------------------- ui */

  updateUi(partial) {
    const next = sanitizeUi({ ...get().ui, ...partial });
    set({ ui: next });
    void savePersisted({ ui: next });
  },

  toggleSection(name) {
    const ui = get().ui;
    get().updateUi({ openSections: { ...ui.openSections, [name]: !ui.openSections[name] } });
  },

  /* ----------------------------------------------------------------- media */

  /**
   * Load new media. Disposal of whatever was loaded before happens inside
   * `loadMedia` *before* the new file is read, so two files are never resident
   * at once.
   */
  async load(input, opts = {}) {
    set({ loading: { phase: 'reading', progress: 0 }, error: null });
    try {
      const onProgress = (p) => set({ loading: p });
      const media = await loadMedia(input, { ...opts, onProgress });
      const name =
        input instanceof File ? input.name : input === 'camera' ? 'camera' : 'media';
      const size = input instanceof File ? input.size : 0;
      set({
        media,
        mediaInfo: {
          kind: media.kind,
          name,
          width: media.width,
          height: media.height,
          duration: media.duration ?? 0,
          sizeLabel: size ? `${(size / 1048576).toFixed(1)}MB` : '',
        },
        loading: null,
        error: null,
      });
      // New media is framed fresh. Zoom and pan are persisted, so without this
      // a view left zoomed or panned from a previous file silently applies to
      // the next one.
      get().updateUi({ zoom: 1, panX: 0, panY: 0 });
    } catch (err) {
      const e = err instanceof MediaError ? err : new MediaError(err?.message ?? 'Load failed.');
      set({ media: null, mediaInfo: null, loading: null, error: { message: e.message, hint: e.hint } });
    }
  },

  clear() {
    clearMedia();
    set({ media: null, mediaInfo: null, error: null, loading: null });
  },

  setStats(stats) {
    set({ stats, backend: stats.backend });
  },

  setError(error) {
    set({ error });
  },

  setNotice(notice) {
    set({ notice });
  },

  /* --------------------------------------------------------------- presets */

  async refreshPresets() {
    set({ presets: await listPresets() });
  },

  async saveCurrentAsPreset(name) {
    await savePreset(name, get().settings);
    await get().refreshPresets();
  },

  async removePreset(id) {
    await deletePreset(id);
    await get().refreshPresets();
  },

  applyPreset(settings) {
    get().updateSettings(sanitizeSettings(settings), { path: ['preset'] });
  },
}));

/** Convenience hook for the common "one settings group" read. */
export function useSettings(selector) {
  return useApp((s) => selector(s.settings));
}
