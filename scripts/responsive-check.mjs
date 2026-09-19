#!/usr/bin/env node
/**
 * Responsive smoke test.
 *
 * Loads the built app at the three breakpoints the README documents and
 * asserts the things that actually break on small screens: horizontal
 * overflow, touch targets under 44px, and the layout switching between the
 * bottom-sheet and three-column arrangements.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.ASCIFY_URL ?? 'http://localhost:4173/ascify/';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const START_SERVER = !process.env.ASCIFY_URL;

const VIEWPORTS = [
  { name: '320  (small phone)', width: 320, height: 640, touch: true, expect: 'sheet' },
  { name: '768  (tablet)', width: 768, height: 1024, touch: true, expect: 'columns' },
  { name: '1440 (desktop)', width: 1440, height: 900, touch: false, expect: 'columns' },
];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  process.stdout.write(`    [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
};

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function main() {
  let server = null;
  if (START_SERVER) {
    server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!(await waitForServer(BASE))) {
      process.stderr.write('responsive-check: preview server never came up\n');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });

  process.stdout.write('\nascify responsive check\n');

  for (const vp of VIEWPORTS) {
    process.stdout.write(`\n  ${vp.name}\n`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch && vp.width < 768,
      deviceScaleFactor: vp.touch ? 2 : 1,
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    const overflow = await page.evaluate(
      `({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`,
    );
    check('no horizontal overflow', overflow.scroll <= overflow.client + 1, `${overflow.scroll} > ${overflow.client}`);

    const layout = await page.evaluate(`(() => {
      const nav = document.querySelector('nav[aria-label="Panels"]');
      const asides = document.querySelectorAll('aside');
      return { sheet: !!nav, columns: asides.length };
    })()`);
    if (vp.expect === 'sheet') {
      check('bottom-sheet tab bar present', layout.sheet);
      check('side rails hidden', layout.columns === 0, `${layout.columns} aside(s)`);
    } else {
      check('three-column rails present', layout.columns === 2, `${layout.columns} aside(s)`);
      check('no bottom-sheet tab bar', !layout.sheet);
    }

    if (vp.touch) {
      const small = await page.evaluate(`(() => {
        const bad = [];
        for (const el of document.querySelectorAll('button, a, select, input[type=range]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;         // hidden
          if (el.closest('[hidden]')) continue;
          if (r.height < 44 - 0.5) {
            bad.push((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28)
              + ' h=' + r.height.toFixed(0));
          }
        }
        return bad;
      })()`);
      check('all touch targets >= 44px tall', small.length === 0, small.slice(0, 4).join(' | '));
    }

    const title = await page.title();
    check('page rendered', title.includes('ascify'), title);

    // The preview must survive gestures. A swipe is what people instinctively
    // do to scroll a phone, and pan is persisted — so an unbounded pan leaves
    // the preview permanently empty, with every later upload rendering
    // correctly but off-screen and nothing on screen to explain why.
    if (vp.touch) {
      await page.evaluate(`(async () => {
        const c = document.createElement('canvas');
        c.width = 600; c.height = 600;
        const x = c.getContext('2d');
        x.fillStyle = '#ff5500'; x.fillRect(0, 0, 600, 300);
        x.fillStyle = '#0055ff'; x.fillRect(0, 300, 600, 300);
        const b = await new Promise(r => c.toBlob(r, 'image/png'));
        c.width = 0; c.height = 0;
        await window.__ascifyStore.getState().load(new File([b], 'g.png', { type: 'image/png' }));
      })()`);
      await page.waitForTimeout(2200);

      const overlap = async () =>
        page.evaluate(`(() => {
          const el = document.querySelector('canvas');
          if (!el) return 0;
          const b = el.getBoundingClientRect();
          const w = el.parentElement.getBoundingClientRect();
          const ox = Math.max(0, Math.min(b.right, w.right) - Math.max(b.left, w.left));
          const oy = Math.max(0, Math.min(b.bottom, w.bottom) - Math.max(b.top, w.top));
          return Math.round(Math.min(ox, oy));
        })()`);

      check('preview visible after load', (await overlap()) > 10, `${await overlap()}px overlap`);

      // A collapsed preview frame is the failure mode a percentage height in a
      // flex column produces on Safari, so assert the frame keeps real height
      // rather than only that something overlaps it.
      const frame = await page.evaluate(`(() => {
        const el = document.querySelector('canvas');
        if (!el) return null;
        const r = el.parentElement.getBoundingClientRect();
        return { h: Math.round(r.height), w: Math.round(r.width), vh: window.innerHeight };
      })()`);
      check(
        'preview frame has real height',
        frame && frame.h >= Math.min(120, frame.vh * 0.15),
        frame ? `${frame.w}x${frame.h} of ${frame.vh}` : 'no frame',
      );

      const area = await page.$('.touch-none-pan');
      const box = await area.boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      for (const [dx, dy] of [[0, -800], [0, 800], [-800, 0]]) {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(250);
      }
      check('preview survives swiping', (await overlap()) > 10, `${await overlap()}px overlap`);

      // Panning while zoomed in is allowed, but must stay bounded.
      await page.evaluate('window.__ascifyStore.getState().updateUi({ zoom: 4 })');
      await page.waitForTimeout(250);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 2000, cy - 2000, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      check('pan bounded when zoomed', (await overlap()) > 10, `${await overlap()}px overlap`);
    }

    await context.close();
  }

  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }

  process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall responsive checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`responsive-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
