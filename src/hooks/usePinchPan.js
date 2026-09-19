import { useEffect, useRef } from 'react';

/**
 * Pinch-to-zoom and drag-to-pan on the preview.
 *
 * Pointer Events handle mouse, touch and pen with one code path. Two-finger
 * pinch zooms around the midpoint between the fingers rather than the element
 * centre, which is what makes zooming into a corner feel right on a phone.
 *
 * Values are written back through `onChange` (throttled to animation frames) so
 * they persist as plain numbers in the UI store.
 */
export function usePinchPan(ref, value, onChange) {
  // The latest transform is mirrored in a ref so the pointer handlers can read
  // it without being re-created — re-binding listeners mid-gesture drops it.
  const state = useRef(value);
  state.current = value;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const pointers = new Map();
    let pinchStart = null;
    let panStart = null;
    let frame = 0;
    let pending = null;

    const flush = () => {
      frame = 0;
      if (pending) {
        onChangeRef.current(pending);
        pending = null;
      }
    };

    /**
     * Keep the canvas inside the frame.
     *
     * Without this, one swipe — the gesture people instinctively use to scroll
     * a phone — drags the image arbitrarily far away, and because pan is
     * persisted the preview then looks permanently empty: every later upload
     * renders correctly but off-screen, with nothing on screen to explain why.
     *
     * The bound is the overflow the current zoom actually produces, so at
     * zoom 1 (where the image already fits) the pan range is zero and a stray
     * drag does nothing at all.
     */
    const clampPan = (next) => {
      const canvas = el.querySelector('canvas');
      if (!canvas) return next;
      const zoom = next.zoom ?? state.current.zoom;
      // offsetWidth/Height are the laid-out size, before the CSS transform.
      const overflowX = Math.max(0, (canvas.offsetWidth * zoom - el.clientWidth) / 2);
      const overflowY = Math.max(0, (canvas.offsetHeight * zoom - el.clientHeight) / 2);
      const panX = next.panX ?? state.current.panX;
      const panY = next.panY ?? state.current.panY;
      return {
        ...next,
        panX: Math.min(overflowX, Math.max(-overflowX, panX)),
        panY: Math.min(overflowY, Math.max(-overflowY, panY)),
      };
    };

    const schedule = (raw) => {
      const next = clampPan(raw);
      pending = { ...pending, ...next };
      state.current = { ...state.current, ...next };
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const centroid = () => {
      const pts = [...pointers.values()];
      const x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const y = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      return { x, y };
    };

    const spread = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    const onPointerDown = (e) => {
      // Ignore pointers that started on a control inside the surface.
      if (e.target.closest('button, input, select, a, textarea')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture?.(e.pointerId);

      if (pointers.size === 1) {
        panStart = { x: e.clientX, y: e.clientY, panX: state.current.panX, panY: state.current.panY };
        pinchStart = null;
      } else if (pointers.size === 2) {
        panStart = null;
        const c = centroid();
        pinchStart = {
          dist: spread(),
          zoom: state.current.zoom,
          cx: c.x,
          cy: c.y,
          panX: state.current.panX,
          panY: state.current.panY,
        };
      }
    };

    const onPointerMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2 && pinchStart) {
        const dist = spread();
        if (!pinchStart.dist) return;
        const scale = dist / pinchStart.dist;
        const zoom = Math.min(8, Math.max(0.2, pinchStart.zoom * scale));
        const c = centroid();
        // Keep the point under the fingers anchored while the scale changes.
        const rect = el.getBoundingClientRect();
        const originX = rect.left + rect.width / 2;
        const originY = rect.top + rect.height / 2;
        const relX = pinchStart.cx - originX - pinchStart.panX;
        const relY = pinchStart.cy - originY - pinchStart.panY;
        const k = zoom / pinchStart.zoom;
        schedule({
          zoom,
          panX: pinchStart.panX + (c.x - pinchStart.cx) + relX * (1 - k),
          panY: pinchStart.panY + (c.y - pinchStart.cy) + relY * (1 - k),
        });
        e.preventDefault();
        return;
      }

      if (pointers.size === 1 && panStart) {
        schedule({
          panX: panStart.panX + (e.clientX - panStart.x),
          panY: panStart.panY + (e.clientY - panStart.y),
        });
        e.preventDefault();
      }
    };

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      el.releasePointerCapture?.(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) panStart = null;
      else if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        panStart = { x: p.x, y: p.y, panX: state.current.panX, panY: state.current.panY };
      }
    };

    const onWheel = (e) => {
      // Trackpad pinch arrives as ctrlKey+wheel; plain wheel also zooms here
      // because the preview never scrolls.
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const originX = rect.left + rect.width / 2;
      const originY = rect.top + rect.height / 2;
      const k = Math.exp(-e.deltaY * 0.0015);
      const zoom = Math.min(8, Math.max(0.2, state.current.zoom * k));
      const ratio = zoom / state.current.zoom;
      const relX = e.clientX - originX - state.current.panX;
      const relY = e.clientY - originY - state.current.panY;
      schedule({
        zoom,
        panX: state.current.panX + relX * (1 - ratio),
        panY: state.current.panY + relY * (1 - ratio),
      });
    };

    const onDoubleClick = () => schedule({ zoom: 1, panX: 0, panY: 0 });

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDoubleClick);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endPointer);
      el.removeEventListener('pointercancel', endPointer);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDoubleClick);
    };
  }, [ref]);
}
