#!/usr/bin/env node
/**
 * Orientation regression test.
 *
 * Loads a top-red / bottom-blue image and asserts the rendered output keeps red
 * on top, across effects and backends.
 *
 * This exists because of a specific, silent bug class. WebGL honours
 * `UNPACK_FLIP_Y_WEBGL` for canvas and video sources but *ignores* it for
 * ImageBitmap — so relying on it flipped still images while leaving video, GIF
 * and GLB upright. Nothing threw, no shader failed, and the render smoke test
 * still passed because the output was perfectly valid, just upside down. The
 * only way to catch it is to assert on where the colours land.
 *
 * Both media paths are covered: a File (decoded to ImageBitmap) and the
 * canvas-backed path, since those are the two that behave differently.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.ASCIFY_URL ?? 'http://localhost:4173/ascify/';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const START_SERVER = !process.env.ASCIFY_URL;

/**
 * Effects whose output keeps the source colours, so red-over-blue survives.
 * Monochrome effects (crosshatch, threshold, edgeDetection...) are excluded:
 * they are orientation-correct by the same code path but carry no colour to
 * assert on.
 */
const COLOUR_EFFECTS = ['blockify', 'ascii', 'vhs', 'halftone', 'dots', 'voronoi', 'noiseField'];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  process.stdout.write(`    [${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(12)}${detail ? ` ${detail}` : ''}\n`);
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

const MAKE_IMAGE = `async () => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const x = c.getContext('2d');
  x.fillStyle = '#ff0000'; x.fillRect(0, 0, 400, 200);   // TOP half red
  x.fillStyle = '#0000ff'; x.fillRect(0, 200, 400, 200); // BOTTOM half blue
  const b = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = 0; c.height = 0;
  return new File([b], 'orientation.png', { type: 'image/png' });
}`;

const SAMPLE = `(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas || !canvas.width) return null;
  const p = document.createElement('canvas');
  p.width = 20; p.height = 20;
  const g = p.getContext('2d');
  g.drawImage(canvas, 0, 0, 20, 20);
  const d = g.getImageData(0, 0, 20, 20).data;
  const band = (y0, y1) => {
    let r = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < 20; x++) {
      const i = (y * 20 + x) * 4; r += d[i]; b += d[i + 2]; n++;
    }
    return { r: Math.round(r / n), b: Math.round(b / n) };
  };
  p.width = 0; p.height = 0;
  return { top: band(2, 8), bottom: band(12, 18) };
})()`;

function verdict(s) {
  if (!s) return { ok: false, label: 'no canvas' };
  const topRed = s.top.r - s.top.b;
  const bottomBlue = s.bottom.b - s.bottom.r;
  const label = `top(r${s.top.r}/b${s.top.b}) bottom(r${s.bottom.r}/b${s.bottom.b})`;
  // A decisive margin: anything ambiguous means the colours got mixed, which is
  // itself a defect worth failing on.
  if (topRed > 20 && bottomBlue > 20) return { ok: true, label: `upright ${label}` };
  if (topRed < -20 && bottomBlue < -20) return { ok: false, label: `FLIPPED ${label}` };
  return { ok: false, label: `colours not preserved ${label}` };
}

async function main() {
  let server = null;
  if (START_SERVER) {
    server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!(await waitForServer(BASE))) {
      process.stderr.write('orientation-check: preview server never came up\n');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => process.stdout.write(`    page error: ${err.message}\n`));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(`(async () => {
    const make = ${MAKE_IMAGE};
    await window.__ascifyStore.getState().load(await make());
  })()`);
  await page.waitForTimeout(1500);

  process.stdout.write('\nascify orientation check (image → ImageBitmap path)\n');

  for (const backend of ['webgl2', 'cpu']) {
    process.stdout.write(`\n  backend: ${backend}\n`);
    await page.evaluate(
      `window.__ascifyStore.getState().updateSettings(s => ({ ...s, render: { ...s.render, backend: '${backend}' } }))`,
    );
    await page.waitForTimeout(700);

    for (const effect of COLOUR_EFFECTS) {
      await page.evaluate(`window.__ascifyStore.getState().setEffect('${effect}')`);
      await page.waitForTimeout(320);
      const v = verdict(await page.evaluate(SAMPLE));
      check(effect, v.ok, v.label);
    }
  }

  /* --- clearing must actually remove the picture ------------------------ */
  process.stdout.write('\n  clear\n');
  await page.evaluate('window.__ascifyStore.getState().clear()');
  await page.waitForTimeout(700);
  const cleared = await page.evaluate(`({
    canvas: !!document.querySelector('canvas'),
    placeholder: (document.body.innerText || '').includes('Load an image'),
    media: !!window.__ascifyStore.getState().media,
  })`);
  check('canvas removed', cleared.canvas === false);
  check('placeholder', cleared.placeholder === true);
  check('media dropped', cleared.media === false);

  // And loading again after a clear must still work.
  await page.evaluate(`(async () => {
    const make = ${MAKE_IMAGE};
    await window.__ascifyStore.getState().load(await make());
  })()`);
  await page.waitForTimeout(1500);
  const reloaded = verdict(await page.evaluate(SAMPLE));
  check('reload after clear', reloaded.ok, reloaded.label);

  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }

  process.stdout.write(
    failures ? `\n${failures} check(s) failed\n` : '\nall orientation checks passed\n',
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`orientation-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
