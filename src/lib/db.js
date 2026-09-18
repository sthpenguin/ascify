import { SCHEMA_VERSION, sanitizeSettings, sanitizeUi } from './schema.js';

/**
 * Settings persistence.
 *
 * Three rules hold this file to the privacy guarantee:
 *   1. Only three stores exist: settings, ui, presets. There is no media store.
 *   2. Every value is run through `assertPlain` before it is written. Blobs,
 *      ArrayBuffers, typed arrays, ImageBitmaps, File handles and long strings
 *      are rejected — a bug that tries to stash a frame here throws instead of
 *      silently persisting pixels.
 *   3. On a schema-version mismatch the database is deleted outright rather
 *      than migrated, so no stale record can survive across formats.
 */
const DB_NAME = 'ascify';
const DB_VERSION = 1;
const STORES = ['settings', 'ui', 'presets'];

/** Anything longer than this is not a setting; refuse it. */
const MAX_STRING = 4096;

const BANNED = [
  typeof Blob !== 'undefined' && Blob,
  typeof File !== 'undefined' && File,
  typeof ArrayBuffer !== 'undefined' && ArrayBuffer,
  typeof ImageData !== 'undefined' && ImageData,
  typeof ImageBitmap !== 'undefined' && ImageBitmap,
].filter(Boolean);

export function assertPlain(value, path = 'value', depth = 0) {
  if (depth > 8) throw new Error(`ascify/db: ${path} nested too deeply to be a setting`);
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;

  if (t === 'string') {
    if (value.length > MAX_STRING) {
      throw new Error(`ascify/db: refusing to persist ${path} — string exceeds ${MAX_STRING} chars`);
    }
    // Catches the classic accident: a canvas.toDataURL() slipping into a preset.
    if (/^data:|^blob:/i.test(value)) {
      throw new Error(`ascify/db: refusing to persist ${path} — looks like encoded media`);
    }
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    throw new Error(`ascify/db: refusing to persist ${path} — typed array (pixel data?)`);
  }
  for (const Ctor of BANNED) {
    if (value instanceof Ctor) {
      throw new Error(`ascify/db: refusing to persist ${path} — ${Ctor.name} is media, not a setting`);
    }
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertPlain(v, `${path}[${i}]`, depth + 1));
    return value;
  }

  if (t === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error(`ascify/db: refusing to persist ${path} — not a plain object`);
    }
    for (const [k, v] of Object.entries(value)) assertPlain(v, `${path}.${k}`, depth + 1);
    return value;
  }

  throw new Error(`ascify/db: refusing to persist ${path} — unsupported type ${t}`);
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Private-browsing modes and storage-blocked contexts reject here; the app
    // simply runs without persistence rather than failing.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let t;
    try {
      t = db.transaction(store, mode);
    } catch {
      return resolve(null);
    }
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : null);
    t.onerror = () => resolve(null);
    t.onabort = () => resolve(null);
  });
}

export async function idbGet(store, key) {
  return tx(store, 'readonly', (os) => os.get(key));
}

export async function idbSet(store, key, value) {
  assertPlain(value, `${store}/${key}`);
  return tx(store, 'readwrite', (os) => os.put(value, key));
}

export async function idbDelete(store, key) {
  return tx(store, 'readwrite', (os) => os.delete(key));
}

export async function idbAll(store) {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const out = [];
    let t;
    try {
      t = db.transaction(store, 'readonly');
    } catch {
      return resolve([]);
    }
    const cursorReq = t.objectStore(store).openCursor();
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (c) {
        out.push({ key: c.key, value: c.value });
        c.continue();
      }
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => resolve([]);
  });
}

/** Nuke and reopen — used when the stored schema version does not match. */
export async function resetDb() {
  const db = await openDb();
  if (db) db.close();
  dbPromise = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

export async function loadPersisted() {
  const [settingsRec, uiRec] = await Promise.all([idbGet('settings', 'current'), idbGet('ui', 'current')]);

  const stale =
    (settingsRec && settingsRec.version !== SCHEMA_VERSION) || (uiRec && uiRec.version !== SCHEMA_VERSION);

  if (stale) {
    await resetDb();
    return { settings: sanitizeSettings(null), ui: sanitizeUi(null), reset: true };
  }

  return {
    settings: sanitizeSettings(settingsRec),
    ui: sanitizeUi(uiRec),
    reset: false,
  };
}

export async function savePersisted({ settings, ui }) {
  if (settings) await idbSet('settings', 'current', sanitizeSettings(settings));
  if (ui) await idbSet('ui', 'current', sanitizeUi(ui));
}

/** Presets are plain-text: a name plus a sanitized settings object. */
export async function listPresets() {
  const rows = await idbAll('presets');
  return rows
    .map(({ key, value }) => ({
      id: String(key),
      name: typeof value?.name === 'string' ? value.name.slice(0, 64) : String(key),
      createdAt: Number(value?.createdAt) || 0,
      settings: sanitizeSettings(value?.settings),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function savePreset(name, settings) {
  const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await idbSet('presets', id, {
    name: String(name).slice(0, 64),
    createdAt: Date.now(),
    settings: sanitizeSettings(settings),
  });
  return id;
}

export async function deletePreset(id) {
  await idbDelete('presets', String(id));
}

/**
 * Reports what the origin currently stores. The privacy test asserts this stays
 * small and media-free after loading and replacing large files.
 */
export async function storageReport() {
  const [settings, ui, presets] = await Promise.all([idbAll('settings'), idbAll('ui'), idbAll('presets')]);
  const bytes = (v) => {
    try {
      return JSON.stringify(v).length;
    } catch {
      return -1;
    }
  };
  let estimate = null;
  if (navigator.storage?.estimate) {
    try {
      estimate = await navigator.storage.estimate();
    } catch {
      estimate = null;
    }
  }
  return {
    stores: { settings: settings.length, ui: ui.length, presets: presets.length },
    jsonBytes: bytes(settings) + bytes(ui) + bytes(presets),
    localStorageKeys: Object.keys(localStorage ?? {}),
    estimate,
  };
}
