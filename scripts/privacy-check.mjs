#!/usr/bin/env node
/**
 * Automated privacy verification.
 *
 * Drives the built app in a real browser and asserts the guarantee the README
 * makes: loading media, then replacing it, leaves no media bytes anywhere.
 *
 * It checks five things that would each independently break the promise:
 *   1. No network request carries a request body (nothing is uploaded).
 *   2. Object URLs created for the first file are revoked when it is replaced.
 *   3. The resource registry drops to zero live handles after a clear.
 *   4. IndexedDB holds only settings/ui/presets, and stays small.
 *   5. localStorage/sessionStorage contain no data: or blob: payloads.
 *
 * Run against `npm run preview`:  node scripts/privacy-check.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.ASCIFY_URL ?? 'http://localhost:4173/ascify/';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const START_SERVER = !process.env.ASCIFY_URL;

let failures = 0;
const check = (name, ok, detail = '') => {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}\n`);
};

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

/**
 * Builds a large synthetic video in the page.
 *
 * Generated rather than committed: the repo must contain no media files, and a
 * recorded canvas stream produces a genuinely large decoded payload.
 */
const MAKE_VIDEO = `async (seconds) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12000000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(100);
  const start = performance.now();
  await new Promise(resolve => {
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      // High-entropy noise so the encoder cannot cheat the file size down.
      const img = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255;
        img.data[i+1] = Math.random() * 255;
        img.data[i+2] = Math.random() * 255;
        img.data[i+3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      if (t < seconds) requestAnimationFrame(draw); else resolve();
    };
    draw();
  });
  rec.stop();
  await new Promise(r => { rec.onstop = r; });
  for (const tr of stream.getTracks()) tr.stop();
  canvas.width = 0; canvas.height = 0;
  const blob = new Blob(chunks, { type: 'video/webm' });
  return blob;
}`;

async function main() {
  let server = null;
  if (START_SERVER) {
    server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1'], {
      stdio: 'ignore',
      detached: true,
    });
    const up = await waitForServer(BASE);
    if (!up) {
      process.stderr.write('privacy-check: preview server never came up\n');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();

  /* --- 1. nothing is uploaded ------------------------------------------ */
  const uploads = [];
  page.on('request', (req) => {
    const post = req.postData();
    if (post && post.length > 0 && !req.url().startsWith('data:')) {
      uploads.push({ url: req.url(), bytes: post.length });
    }
  });
  const external = [];
  page.on('request', (req) => {
    const url = new URL(req.url(), BASE);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (!req.url().startsWith(new URL(BASE).origin)) external.push(req.url());
  });

  page.on('pageerror', (err) => {
    process.stdout.write(`  [warn] page error: ${err.message}\n`);
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Instrument object-URL lifecycle before any media exists.
  await page.evaluate(`(() => {
    window.__urlLog = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj) => { const u = create(obj); window.__urlLog.created.push(u); return u; };
    URL.revokeObjectURL = (u) => { window.__urlLog.revoked.push(u); return revoke(u); };
  })()`);

  process.stdout.write('\nascify privacy check\n');

  /* --- load a large video ---------------------------------------------- */
  const sizeA = await page.evaluate(
    `(async () => {
      const make = ${MAKE_VIDEO};
      const blob = await make(8);
      window.__fileA = new File([blob], 'large-a.webm', { type: 'video/webm' });
      return window.__fileA.size;
    })()`,
  );
  process.stdout.write(`  generated file A: ${(sizeA / 1048576).toFixed(1)}MB\n`);

  await page.evaluate(`(async () => {
    const store = window.__ascifyStore;
    await store.getState().load(window.__fileA);
  })()`);
  await page.waitForTimeout(1500);

  const afterA = await page.evaluate(`({
    live: window.__ascifyResources.liveResourceCount(),
    urls: window.__ascifyResources.liveObjectUrlCount(),
    snapshot: window.__ascifyResources.resourceSnapshot(),
    hasMedia: !!window.__ascifyStore.getState().media,
  })`);
  check('file A loaded and is resident', afterA.hasMedia && afterA.live > 0, JSON.stringify(afterA.snapshot.byKind));

  const createdAfterA = await page.evaluate('window.__urlLog.created.length');

  /* --- replace with a second file -------------------------------------- */
  const sizeB = await page.evaluate(
    `(async () => {
      const make = ${MAKE_VIDEO};
      const blob = await make(2);
      window.__fileB = new File([blob], 'large-b.webm', { type: 'video/webm' });
      return window.__fileB.size;
    })()`,
  );
  process.stdout.write(`  generated file B: ${(sizeB / 1048576).toFixed(1)}MB\n`);

  await page.evaluate(`(async () => {
    await window.__ascifyStore.getState().load(window.__fileB);
  })()`);
  await page.waitForTimeout(1500);

  const afterB = await page.evaluate(`({
    live: window.__ascifyResources.liveResourceCount(),
    urls: window.__ascifyResources.liveObjectUrlCount(),
    created: window.__urlLog.created.length,
    revoked: window.__urlLog.revoked.length,
    snapshot: window.__ascifyResources.resourceSnapshot(),
  })`);

  check(
    'replacing media revoked the previous object URLs',
    afterB.revoked >= createdAfterA,
    `revoked ${afterB.revoked} of ${afterB.created} created`,
  );
  check(
    'only one media generation is resident after replacement',
    afterB.snapshot.generations <= 1,
    `${afterB.snapshot.generations} generation(s)`,
  );

  /* --- clear ------------------------------------------------------------ */
  await page.evaluate('window.__ascifyStore.getState().clear()');
  await page.waitForTimeout(500);

  const afterClear = await page.evaluate(`({
    live: window.__ascifyResources.liveResourceCount(),
    urls: window.__ascifyResources.liveObjectUrlCount(),
    media: !!window.__ascifyStore.getState().media,
  })`);
  check('clearing media releases every tracked resource', afterClear.live === 0, `${afterClear.live} live`);
  check('no object URL outlives the media', afterClear.urls === 0, `${afterClear.urls} outstanding`);
  check('store holds no media handle', afterClear.media === false);

  /* --- storage ---------------------------------------------------------- */
  const storage = await page.evaluate(`(async () => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    const out = { databases: dbs.map(d => d.name), records: {}, bytes: 0, suspicious: [] };
    const open = () => new Promise((res) => {
      const r = indexedDB.open('ascify');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    const db = await open();
    if (db) {
      for (const name of [...db.objectStoreNames]) {
        const rows = await new Promise((res) => {
          const items = [];
          const tx = db.transaction(name, 'readonly');
          const cur = tx.objectStore(name).openCursor();
          cur.onsuccess = () => { const c = cur.result; if (c) { items.push(c.value); c.continue(); } };
          tx.oncomplete = () => res(items);
          tx.onerror = () => res([]);
        });
        out.records[name] = rows.length;
        const json = JSON.stringify(rows);
        out.bytes += json.length;
        if (/data:[a-z/]+;base64|blob:/i.test(json)) out.suspicious.push(name);
      }
      db.close();
    }
    out.localStorage = Object.entries(localStorage).map(([k, v]) => [k, String(v).length]);
    out.sessionStorage = Object.entries(sessionStorage).map(([k, v]) => [k, String(v).length]);
    const lsJson = JSON.stringify(out.localStorage) + JSON.stringify(Object.values(localStorage));
    out.lsSuspicious = /data:[a-z/]+;base64|blob:/i.test(lsJson);
    return out;
  })()`);

  check(
    'IndexedDB contains only settings/ui/presets stores',
    Object.keys(storage.records).every((k) => ['settings', 'ui', 'presets'].includes(k)),
    Object.keys(storage.records).join(', ') || 'none',
  );
  check('no encoded media in IndexedDB', storage.suspicious.length === 0, storage.suspicious.join(', '));
  check(
    'IndexedDB stays small after two large videos',
    storage.bytes < 64 * 1024,
    `${storage.bytes} bytes`,
  );
  check('no encoded media in localStorage/sessionStorage', storage.lsSuspicious === false);

  /* --- service worker --------------------------------------------------- */
  const swCaches = await page.evaluate(`(async () => {
    if (!('caches' in window)) return { names: [], entries: [] };
    const names = await caches.keys();
    const entries = [];
    for (const n of names) {
      const c = await caches.open(n);
      for (const req of await c.keys()) entries.push(req.url);
    }
    return { names, entries };
  })()`);
  const cachedMedia = swCaches.entries.filter((u) => /^blob:|\\.webm$|\\.mp4$|\\.gif$/i.test(u));
  check('service worker cached no media', cachedMedia.length === 0, cachedMedia.join(', '));

  /* --- network ---------------------------------------------------------- */
  check('no request carried an upload body', uploads.length === 0, JSON.stringify(uploads));
  check('no third-party request was made', external.length === 0, external.slice(0, 3).join(', '));

  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }

  process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall privacy checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`privacy-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
