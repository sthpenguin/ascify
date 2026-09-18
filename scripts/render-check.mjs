#!/usr/bin/env node
/**
 * Render smoke test.
 *
 * Loads a generated test image and cycles every effect through every backend
 * the browser offers, asserting each one produces a non-blank, non-uniform
 * frame. A shader that fails to compile, a uniform that is packed into the
 * wrong slot, or an effect that silently renders black all show up here.
 *
 * Chromium's SwiftShader gives a real WebGL2 context in CI, so the GPU path is
 * genuinely exercised rather than skipped.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.ASCIFY_URL ?? 'http://localhost:4173/ascify/';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const START_SERVER = !process.env.ASCIFY_URL;

const EFFECTS = [
  'ascii', 'waveLines', 'dithering', 'halftone', 'pixelSort', 'dots', 'contour',
  'edgeDetection', 'crosshatch', 'blockify', 'threshold', 'noiseField',
  'matrixRain', 'vhs', 'voronoi',
];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  process.stdout.write(`    [${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(16)}${detail ? ` ${detail}` : ''}\n`);
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

/** A colourful gradient + shapes: enough structure for every effect to bite. */
const MAKE_IMAGE = `async () => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 640, 360);
  g.addColorStop(0, '#ff0044'); g.addColorStop(0.5, '#ffdd00'); g.addColorStop(1, '#0044ff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.arc(60 + i * 48, 180 + Math.sin(i) * 90, 18 + (i % 4) * 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 300, 640, 60);
  ctx.fillStyle = '#ffffff';
  ctx.font = '48px monospace';
  ctx.fillText('ASCIFY', 20, 60);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = 0; c.height = 0;
  return new File([blob], 'test.png', { type: 'image/png' });
}`;

async function main() {
  let server = null;
  if (START_SERVER) {
    server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!(await waitForServer(BASE))) {
      process.stderr.write('render-check: preview server never came up\n');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const shaderErrors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/shader|program link|WebGL|GPU/i.test(text) && msg.type() === 'error') shaderErrors.push(text);
  });
  page.on('pageerror', (err) => shaderErrors.push(err.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(`(async () => {
    const make = ${MAKE_IMAGE};
    window.__img = await make();
    await window.__ascifyStore.getState().load(window.__img);
  })()`);
  await page.waitForTimeout(1200);

  process.stdout.write('\nascify render check\n');

  for (const backend of ['webgl2', 'cpu']) {
    process.stdout.write(`\n  backend: ${backend}\n`);
    await page.evaluate(
      `window.__ascifyStore.getState().updateSettings(s => ({ ...s, render: { ...s.render, backend: '${backend}' } }))`,
    );
    await page.waitForTimeout(400);

    const active = await page.evaluate('window.__ascifyStore.getState().stats.backend');

    for (const effect of EFFECTS) {
      await page.evaluate(`window.__ascifyStore.getState().setEffect('${effect}')`);
      await page.waitForTimeout(260);

      const result = await page.evaluate(`(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas || !canvas.width) return { ok: false, reason: 'no canvas' };
        const probe = document.createElement('canvas');
        probe.width = 64; probe.height = 36;
        const p = probe.getContext('2d');
        p.drawImage(canvas, 0, 0, 64, 36);
        const d = p.getImageData(0, 0, 64, 36).data;
        let min = 255, max = 0, sum = 0;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4) {
          const l = (d[i] * 0.2126 + d[i+1] * 0.7152 + d[i+2] * 0.0722);
          if (l < min) min = l;
          if (l > max) max = l;
          sum += l;
          seen.add((d[i] >> 4) + ',' + (d[i+1] >> 4) + ',' + (d[i+2] >> 4));
        }
        probe.width = 0; probe.height = 0;
        return { ok: true, min, max, mean: sum / (d.length / 4), colors: seen.size, size: canvas.width + 'x' + canvas.height };
      })()`);

      if (!result.ok) {
        check(effect, false, result.reason);
        continue;
      }
      // A working effect produces variation; a broken one is flat black/white.
      const varied = result.max - result.min > 12 && result.colors > 3;
      check(
        effect,
        varied,
        `range ${Math.round(result.min)}-${Math.round(result.max)} colors ${result.colors} @${result.size}`,
      );
    }

    process.stdout.write(`    (reported backend: ${active})\n`);
  }

  /* --- ascii grid + export surface -------------------------------------- */
  process.stdout.write('\n  ascii pipeline\n');
  await page.evaluate(`window.__ascifyStore.getState().setEffect('ascii')`);
  await page.waitForTimeout(300);

  // Drive the real export pipeline rather than just the canvas, so the GIF
  // encoder, the SVG/JSON grouping and the Three.js template are all exercised.
  const exportCheck = await page.evaluate(`(async () => {
    if (!window.__ascifyExportContext) return { error: 'no export context' };
    const runExport = (id, _ctx, opts) => window.__ascifyRunExport(id, opts);
    const engineCtx = null;
    const out = {};
    for (const [id, opts] of [['png', {}], ['gif', { fps: 6, seconds: 0.5 }], ['svg', {}], ['txt', {}], ['plain', {}], ['html', { bloom: true }]]) {
      try {
        const blob = await runExport(id, engineCtx, { ...opts, onProgress: () => {} });
        out[id] = { size: blob.size, type: blob.type };
        if (id === 'txt') {
          const parsed = JSON.parse(await blob.text());
          out.txtShape = {
            hasBg: typeof parsed.backgroundColor === 'string',
            hasDims: Number.isFinite(parsed.dimensions?.width) && Number.isFinite(parsed.dimensions?.height),
            groups: Array.isArray(parsed.groups) ? parsed.groups.length : -1,
            firstGroupKeys: parsed.groups?.[0] ? Object.keys(parsed.groups[0]).sort().join(',') : '',
          };
        }
        if (id === 'html') out.htmlHasThree = (await blob.text()).includes('UnrealBloomPass');
        if (id === 'svg') out.svgWellFormed = !!new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').querySelector('svg');
      } catch (err) {
        out[id] = { error: String(err && err.message || err) };
      }
    }
    return out;
  })()`);

  if (exportCheck.error) {
    check('export context', false, exportCheck.error);
  } else {
    for (const id of ['png', 'gif', 'svg', 'txt', 'plain', 'html']) {
      const r = exportCheck[id];
      check(`export ${id}`, !!r && !r.error && r.size > 200, r?.error ?? `${r?.size} bytes ${r?.type}`);
    }
    check(
      '.txt matches documented shape',
      exportCheck.txtShape?.hasBg &&
        exportCheck.txtShape?.hasDims &&
        exportCheck.txtShape?.groups > 0 &&
        exportCheck.txtShape?.firstGroupKeys === 'color,count,text,x,y',
      JSON.stringify(exportCheck.txtShape),
    );
    check('svg is well-formed', exportCheck.svgWellFormed === true);
    check('three.js export includes bloom pass', exportCheck.htmlHasThree === true);
  }

  check('no shader or page errors', shaderErrors.length === 0, shaderErrors.slice(0, 2).join(' | '));

  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }

  process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall render checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`render-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
