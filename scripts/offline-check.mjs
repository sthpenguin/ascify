#!/usr/bin/env node
/**
 * Offline / PWA verification.
 *
 * Loads the app, lets the service worker install and precache the shell, then
 * drops the network entirely and reloads. The app must still boot, and the
 * cache must still contain no media.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.ASCIFY_URL ?? 'http://localhost:4173/ascify/';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const START_SERVER = !process.env.ASCIFY_URL;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
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
      process.stderr.write('offline-check: preview server never came up\n');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  process.stdout.write('\nascify offline check\n');

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Wait for the service worker to take control and finish precaching.
  const registered = await page.evaluate(`(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    return !!reg;
  })()`);
  check('service worker registered', registered === true);

  // Precaching happens in the install handler; give it a moment to settle.
  let cached = [];
  for (let i = 0; i < 20; i++) {
    cached = await page.evaluate(`(async () => {
      const names = await caches.keys();
      const urls = [];
      for (const n of names) {
        const c = await caches.open(n);
        for (const r of await c.keys()) urls.push(r.url);
      }
      return urls;
    })()`);
    if (cached.length > 5) break;
    await sleep(500);
  }
  check('app shell precached', cached.length > 5, `${cached.length} entries`);
  check(
    'index.html is in the precache',
    cached.some((u) => u.includes('index.html') || u.endsWith('/ascify/')),
  );
  check(
    'no media in the precache',
    !cached.some((u) => /^blob:|\.(mp4|webm|gif|jpe?g)$/i.test(u)),
  );

  /* --- go offline ------------------------------------------------------- */
  await context.setOffline(true);

  const reload = await page.reload({ waitUntil: 'domcontentloaded' }).catch((e) => e);
  const offlineOk = !(reload instanceof Error);
  check('page reloads with the network down', offlineOk, offlineOk ? '' : String(reload?.message));

  if (offlineOk) {
    await page.waitForTimeout(1200);
    const state = await page.evaluate(`({
      title: document.title,
      hasRoot: !!document.querySelector('#root')?.children.length,
      hasStore: typeof window.__ascifyStore === 'function',
      text: (document.body.innerText || '').slice(0, 60),
    })`);
    check('app booted offline', state.hasRoot && state.hasStore, state.text.replace(/\n/g, ' '));
    check('title intact offline', state.title.includes('ascify'), state.title);

    // Deep link offline, which exercises the navigation fallback.
    const deep = await page
      .goto(`${BASE}about`, { waitUntil: 'domcontentloaded' })
      .catch((e) => e);
    if (deep instanceof Error) {
      check('deep link works offline', false, deep.message);
    } else {
      await page.waitForTimeout(800);
      const aboutOk = await page.evaluate(
        `(document.body.innerText || '').toLowerCase().includes('private by design')`,
      );
      check('deep link /about works offline', aboutOk === true);
    }
  }

  await context.setOffline(false);
  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }

  process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall offline checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`offline-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
