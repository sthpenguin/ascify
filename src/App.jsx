import { useCallback, useEffect, useState } from 'react';
import { useApp } from './state/appStore.js';
import { useLayout } from './hooks/useMediaQuery.js';
import { useRoute, Link } from './lib/router.jsx';
import { Preview } from './components/Preview.jsx';
import { Section } from './components/controls/Controls.jsx';
import { InputPanel } from './components/panels/InputPanel.jsx';
import { EffectsPanel, EffectParamsPanel } from './components/panels/EffectsPanel.jsx';
import { PresetsPanel } from './components/panels/PresetsPanel.jsx';
import {
  AdjustmentsPanel,
  ProcessingPanel,
  PostPanel,
  AudioPanel,
} from './components/panels/SettingsPanels.jsx';
import { ExportPanel } from './components/panels/ExportPanel.jsx';
import { About } from './pages/About.jsx';
import { Changelog } from './pages/Changelog.jsx';

export default function App() {
  const route = useRoute();
  const init = useApp((s) => s.init);
  const ready = useApp((s) => s.ready);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    // Remove the pre-mount boot placeholder once React has painted.
    document.getElementById('boot')?.setAttribute('hidden', '');
  }, []);

  useKeyboardShortcuts();

  if (!ready) {
    return (
      <div className="grid h-full place-items-center text-term-accent-dim">
        <p className="text-[12px] tracking-widest">loading settings…</p>
      </div>
    );
  }

  if (route === '/about') return <Page title="about"><About /></Page>;
  if (route === '/changelog') return <Page title="changelog"><Changelog /></Page>;
  return <Studio />;
}

/* ------------------------------------------------------------------ chrome */

function TopBar() {
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const canUndo = useApp((s) => s.history.past.length > 0);
  const canRedo = useApp((s) => s.history.future.length > 0);
  const backend = useApp((s) => s.stats.backend);
  const fps = useApp((s) => s.stats.fps);

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-term-line bg-term-panel px-2 pt-safe inset-safe-x">
      <Link to="/" className="tap min-h-11 gap-1.5 pr-2 no-underline">
        <span className="text-term-accent">▮</span>
        <span className="text-[13px] font-medium tracking-wide text-term-text">ascify</span>
      </Link>

      <span className="hidden text-[12px] text-term-muted sm:inline">
        private by design — your files never leave this device
      </span>

      <div className="ml-auto flex items-center gap-1">
        <span className="hidden text-[12px] tabular-nums text-term-muted md:inline">
          {backend} · {fps}fps
        </span>
        <button
          type="button"
          className="term-btn w-11 px-0"
          disabled={!canUndo}
          onClick={undo}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          type="button"
          className="term-btn w-11 px-0"
          disabled={!canRedo}
          onClick={redo}
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
        >
          ↷
        </button>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="flex shrink-0 items-center justify-center gap-3 border-t border-term-line bg-term-panel px-2 text-[12px] text-term-muted pb-safe inset-safe-x">
      <a
        href="https://github.com/sthpenguin"
        target="_blank"
        rel="noopener noreferrer"
        className="tap min-h-11 px-2 hover:text-term-accent"
      >
        Follow
      </a>
      <Link to="/about" className="tap min-h-11 px-2 hover:text-term-accent">
        About
      </Link>
      <Link to="/changelog" className="tap min-h-11 px-2 hover:text-term-accent">
        Changelog
      </Link>
    </footer>
  );
}

function Page({ title, children }) {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="term-scroll min-h-0 flex-1 px-4 py-6 inset-safe-x">
        <div className="mx-auto max-w-2xl">
          <p className="term-label mb-4">{title}</p>
          {children}
        </div>
      </main>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ studio */

function Studio() {
  const layout = useLayout();
  const [exportContext, setExportContext] = useState(null);
  const onContext = useCallback((ctx) => {
    setExportContext(ctx);
    // Published for scripts/render-check.mjs; see main.jsx.
    window.__ascifyExportContext = ctx;
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar />
      {layout.compact ? (
        <CompactLayout exportContext={exportContext} onContext={onContext} />
      ) : (
        <WideLayout exportContext={exportContext} onContext={onContext} layout={layout} />
      )}
      <Footer />
    </div>
  );
}

/** Tablet/desktop: the three-column terminal. */
function WideLayout({ exportContext, onContext, layout }) {
  const ui = useApp((s) => s.ui);
  const toggleSection = useApp((s) => s.toggleSection);
  const updateUi = useApp((s) => s.updateUi);

  const railWidth = layout.tablet ? 'w-60' : 'w-72';

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`term-scroll ${railWidth} shrink-0 border-r border-term-line bg-term-panel ${
          ui.leftOpen ? '' : 'hidden'
        }`}
      >
        <Section id="sec-input" title="input" open={ui.openSections.input} onToggle={() => toggleSection('input')}>
          <InputPanel />
        </Section>
        <Section id="sec-effects" title="effects" open={ui.openSections.effects} onToggle={() => toggleSection('effects')}>
          <EffectsPanel />
        </Section>
        <Section id="sec-presets" title="presets" open={ui.openSections.presets} onToggle={() => toggleSection('presets')}>
          <PresetsPanel />
        </Section>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-term-line bg-term-panel px-2 py-1">
          <button
            type="button"
            className="term-btn px-2 text-[12px]"
            onClick={() => updateUi({ leftOpen: !ui.leftOpen })}
          >
            {ui.leftOpen ? '◧ hide' : '◧ show'} input
          </button>
          <button
            type="button"
            className="term-btn px-2 text-[12px]"
            onClick={() => updateUi({ showGrid: !ui.showGrid })}
            data-active={ui.showGrid}
          >
            grid
          </button>
          <button
            type="button"
            className="term-btn ml-auto px-2 text-[12px]"
            onClick={() => updateUi({ rightOpen: !ui.rightOpen })}
          >
            {ui.rightOpen ? 'hide ◨' : 'show ◨'} controls
          </button>
        </div>
        <Preview onContext={onContext} />
      </main>

      <aside
        className={`term-scroll ${railWidth} shrink-0 border-l border-term-line bg-term-panel ${
          ui.rightOpen ? '' : 'hidden'
        }`}
      >
        <Section id="sec-settings" title="settings" open={ui.openSections.settings} onToggle={() => toggleSection('settings')}>
          <EffectParamsPanel />
        </Section>
        <Section id="sec-adjust" title="adjustments" open={ui.openSections.processing} onToggle={() => toggleSection('processing')}>
          <AdjustmentsPanel />
        </Section>
        <Section id="sec-post" title="post-processing" open={ui.openSections.post} onToggle={() => toggleSection('post')}>
          <PostPanel />
          <div className="mt-3 border-t border-term-line-soft pt-2">
            <AudioPanel />
          </div>
          <div className="mt-3 border-t border-term-line-soft pt-2">
            <ProcessingPanel />
          </div>
        </Section>
        <Section id="sec-export" title="export" open={ui.openSections.export} onToggle={() => toggleSection('export')}>
          <ExportPanel exportContext={exportContext} />
        </Section>
      </aside>
    </div>
  );
}

const TABS = [
  { id: 'input', label: 'input' },
  { id: 'effects', label: 'effects' },
  { id: 'preview', label: 'preview' },
  { id: 'settings', label: 'settings' },
  { id: 'export', label: 'export' },
];

/**
 * Phone portrait: the preview owns the screen and the panels live in a
 * bottom sheet. The sheet is what the thumb reaches, so the tab bar sits at the
 * very bottom above the home indicator.
 */
function CompactLayout({ exportContext, onContext }) {
  const ui = useApp((s) => s.ui);
  const updateUi = useApp((s) => s.updateUi);
  const tab = ui.mobileTab;
  const [sheetOpen, setSheetOpen] = useState(true);

  const showPreviewOnly = tab === 'preview';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex min-h-0 ${showPreviewOnly || !sheetOpen ? 'flex-1' : 'h-[38%] shrink-0'}`}>
        <Preview onContext={onContext} />
      </div>

      {!showPreviewOnly && sheetOpen ? (
        <div className="term-scroll min-h-0 flex-1 border-t border-term-line bg-term-panel inset-safe-x">
          {tab === 'input' ? (
            <div className="p-3">
              <InputPanel />
            </div>
          ) : null}
          {tab === 'effects' ? (
            <div className="space-y-3 p-3">
              <EffectsPanel />
              <PresetsPanel />
            </div>
          ) : null}
          {tab === 'settings' ? (
            <div className="space-y-4 p-3">
              <EffectParamsPanel />
              <div className="border-t border-term-line-soft pt-3">
                <p className="term-label mb-1">adjustments</p>
                <AdjustmentsPanel />
              </div>
              <div className="border-t border-term-line-soft pt-3">
                <p className="term-label mb-1">post-processing</p>
                <PostPanel />
              </div>
              <div className="border-t border-term-line-soft pt-3">
                <p className="term-label mb-1">audio</p>
                <AudioPanel />
              </div>
              <div className="border-t border-term-line-soft pt-3">
                <p className="term-label mb-1">processing</p>
                <ProcessingPanel />
              </div>
            </div>
          ) : null}
          {tab === 'export' ? (
            <div className="p-3">
              <ExportPanel exportContext={exportContext} />
            </div>
          ) : null}
        </div>
      ) : null}

      <nav
        className="flex shrink-0 items-stretch border-t border-term-line bg-term-panel inset-safe-x"
        aria-label="Panels"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id}
            onClick={() => {
              if (t.id === tab && t.id !== 'preview') setSheetOpen((v) => !v);
              else {
                setSheetOpen(true);
                updateUi({ mobileTab: t.id });
              }
            }}
            className={`min-h-11 flex-1 px-1 text-[12px] tracking-wide transition-colors ${
              tab === t.id ? 'bg-term-accent-faint text-term-accent' : 'text-term-muted'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/* --------------------------------------------------------------- shortcuts */

function useKeyboardShortcuts() {
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  useEffect(() => {
    const onKey = (e) => {
      const target = e.target;
      // Never steal keys from a field the user is typing into.
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);
}
