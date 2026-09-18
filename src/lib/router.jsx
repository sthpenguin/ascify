import { useSyncExternalStore, useCallback } from 'react';

/**
 * Tiny path router.
 *
 * GitHub Pages serves the app from a sub-path and has no rewrite rules, so the
 * base is stripped here and `dist/404.html` (a copy of index.html, written by
 * the Vite config) makes deep links resolve.
 */

export const BASE = import.meta.env.BASE_URL || '/';

const listeners = new Set();

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
}

function currentPath() {
  const path = window.location.pathname;
  const stripped = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '');
  return `/${stripped.replace(/^\/+|\/+$/g, '')}`;
}

export function navigate(to) {
  const target = `${BASE}${to.replace(/^\//, '')}`;
  if (window.location.pathname === target) return;
  window.history.pushState({}, '', target);
  notify();
}

export function useRoute() {
  const getSnapshot = useCallback(() => currentPath(), []);
  return useSyncExternalStore(subscribe, getSnapshot, () => '/');
}

export function Link({ to, children, className, onClick, ...rest }) {
  return (
    <a
      href={`${BASE}${to.replace(/^\//, '')}`}
      className={className}
      onClick={(e) => {
        // Let modified clicks open a new tab as the user expects.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
