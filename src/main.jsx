import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { useApp } from './state/appStore.js';
import { installUnloadCleanup } from './media/resourceRegistry.js';
import './index.css';

// Last line of defence: anything still held when the document goes away is
// disposed rather than left to the garbage collector.
installUnloadCleanup();

// Handle for scripts/privacy-check.mjs, which drives real loads in a real
// browser and then asserts nothing was retained. The app is fully client-side
// and holds no credentials, so there is nothing here an exposed store leaks —
// and a guarantee that is only verifiable by hand is not much of a guarantee.
window.__ascifyStore = useApp;

// Same idea for scripts/render-check.mjs, which drives the real export
// pipeline end to end. The export context itself is published by the studio
// as it mounts; this just wires it to the (code-split) exporters.
window.__ascifyRunExport = async (id, options = {}) => {
  const ctx = window.__ascifyExportContext;
  if (!ctx) throw new Error('No media is loaded.');
  const { runExport } = await import('./export/exporters.js');
  return runExport(id, ctx, options);
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
