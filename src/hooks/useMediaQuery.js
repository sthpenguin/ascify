import { useSyncExternalStore, useCallback } from 'react';

/** Subscribe to a media query without re-running it on every render. */
export function useMediaQuery(query) {
  const subscribe = useCallback(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Layout breakpoints.
 *
 * `compact` drives the bottom-sheet layout. It is deliberately keyed on width
 * alone: a phone in landscape is wide enough for the three-column terminal, and
 * forcing the sheet there wastes the little vertical room there is.
 */
export function useLayout() {
  const compact = useMediaQuery('(max-width: 767px)');
  const tablet = useMediaQuery('(min-width: 768px) and (max-width: 1279px)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const shortViewport = useMediaQuery('(max-height: 520px)');
  return { compact, tablet, desktop: !compact && !tablet, coarse, shortViewport };
}
