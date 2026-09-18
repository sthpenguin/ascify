import { useSyncExternalStore, useRef, useCallback } from 'react';

/**
 * `create` — the app's store primitive.
 *
 * React 19 ships `useSyncExternalStore` as the sanctioned way to read from an
 * external mutable source, but no store factory of its own. This is that
 * factory in ~50 lines, so the app carries no third-party state library.
 *
 *   const useThing = create((set, get) => ({ n: 0, inc: () => set({ n: get().n + 1 }) }));
 *   const n = useThing(s => s.n);          // selector-scoped subscription
 *   useThing.getState().inc();             // imperative access outside React
 *
 * Selectors are compared with Object.is, so a component only re-renders when
 * the slice it actually reads changes.
 */
export function create(initializer) {
  let state;
  const listeners = new Set();

  const get = () => state;

  const set = (partial, replace = false) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    if (next == null) return;
    const merged = replace ? next : { ...state, ...next };
    if (Object.is(merged, state)) return;
    const prev = state;
    state = merged;
    for (const l of listeners) l(state, prev);
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  state = initializer(set, get, { subscribe });

  const identity = (s) => s;

  function useStore(selector = identity) {
    // The selector is read through a ref so an inline arrow doesn't force a
    // resubscribe on every render.
    const selRef = useRef(selector);
    selRef.current = selector;
    const getSnapshot = useCallback(() => selRef.current(state), []);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  useStore.getState = get;
  useStore.setState = set;
  useStore.subscribe = subscribe;
  /** Subscribe to one derived slice; fires only when that slice changes. */
  useStore.subscribeTo = (selector, cb) => {
    let prev = selector(state);
    return subscribe((s) => {
      const next = selector(s);
      if (!Object.is(next, prev)) {
        const old = prev;
        prev = next;
        cb(next, old);
      }
    });
  };
  useStore.destroy = () => listeners.clear();

  return useStore;
}

/** Shallow-equality selector helper for picking several keys at once. */
export function shallow(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}
