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
