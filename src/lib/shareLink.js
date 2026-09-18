import { DEFAULT_SETTINGS, sanitizeSettings } from './schema.js';

/**
 * Shareable preset links.
 *
 * A link carries *parameters only* — the diff against the defaults, JSON'd and
 * base64url'd. There is no code path here that can encode media: the encoder
 * walks the default settings tree and copies only keys that exist in it, so
 * even a deliberately poisoned settings object cannot smuggle a data URI into
 * a URL.
 */

const PARAM = 'p';

function diff(current, defaults) {
  const out = {};
  for (const [key, defVal] of Object.entries(defaults)) {
    const cur = current?.[key];
    if (cur === undefined) continue;
    if (defVal && typeof defVal === 'object' && !Array.isArray(defVal)) {
      const sub = diff(cur, defVal);
      if (Object.keys(sub).length) out[key] = sub;
    } else if (cur !== defVal) {
      out[key] = cur;
    }
  }
  return out;
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode the current settings as a `?p=` query string fragment. */
export function encodeParams(settings) {
  const delta = diff(settings, DEFAULT_SETTINGS);
  // The effect id always travels, so a link reads the same as what was shared.
  delta.effect = settings.effect;
  const json = JSON.stringify(delta);
  return `${PARAM}=${toBase64Url(json)}`;
}

export function buildShareUrl(settings, base = window.location.href) {
  const url = new URL(base);
  url.search = encodeParams(settings);
  url.hash = '';
  return url.toString();
}

/** Decode `?p=` back into a partial settings object, or null. */
export function decodeParams(search) {
  try {
    const value = new URLSearchParams(search).get(PARAM);
    if (!value) return null;
    if (value.length > 8192) return null; // a params blob is never this big
    const parsed = JSON.parse(fromBase64Url(value));
    if (!parsed || typeof parsed !== 'object') return null;
    // sanitizeSettings rebuilds from the schema, so unknown keys are dropped.
    return sanitizeSettings(parsed);
  } catch {
    return null;
  }
}

export function stripParamsFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PARAM)) return;
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}
