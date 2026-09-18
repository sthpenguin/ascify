#!/usr/bin/env node
/**
 * Lighthouse run on the mobile profile, asserting the thresholds the README
 * claims. Fails the process if any category drops below its floor.
 */
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.ASCIFY_URL ?? 'http://localhost:4173/ascify/';
const START_SERVER = !process.env.ASCIFY_URL;

const THRESHOLDS = {
  performance: 95,
  accessibility: 95,
  'best-practices': 95,
  seo: 95,
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
      process.stderr.write('lighthouse-check: preview server never came up\n');
      process.exit(1);
    }
  }

  const chrome = await launch({
    chromePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });

  const result = await lighthouse(BASE, {
    port: chrome.port,
    output: ['json', 'html'],
    logLevel: 'error',
    // Defaults are the mobile profile: Moto G Power emulation + 4G throttling.
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
    onlyCategories: Object.keys(THRESHOLDS),
  });

  await chrome.kill();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }

  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/lighthouse.html', result.report[1]);
  writeFileSync('reports/lighthouse.json', result.report[0]);

  process.stdout.write('\nLighthouse (mobile)\n');
  let failures = 0;
  for (const [key, floor] of Object.entries(THRESHOLDS)) {
    const score = Math.round((result.lhr.categories[key]?.score ?? 0) * 100);
    const ok = score >= floor;
    if (!ok) failures++;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${key.padEnd(15)} ${score} (floor ${floor})\n`);
  }

  if (failures) {
    process.stdout.write('\n  top opportunities:\n');
    for (const audit of Object.values(result.lhr.audits)) {
      if (audit.score !== null && audit.score < 0.9 && audit.details?.overallSavingsMs > 50) {
        process.stdout.write(`    - ${audit.title}: ${Math.round(audit.details.overallSavingsMs)}ms\n`);
      }
    }
  }

  process.stdout.write(`\n  report: reports/lighthouse.html\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`lighthouse-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
