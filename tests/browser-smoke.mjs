import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'] });

async function startGame(page) {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Play Now' }).click();
  await page.getByRole('button', { name: 'Start game' }).click();
  await page.getByLabel('Scoreboard', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('canvas').waitFor({ state: 'visible' });
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startGame(desktop);
  assert.ok(await desktop.locator('canvas').count() >= 1, 'game canvas should be present');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await startGame(mobile);
  const controls = mobile.getByRole('group', { name: 'Touch controls' });
  await controls.waitFor({ state: 'visible' });
  assert.ok(await controls.locator('button').count() > 0, 'touch action buttons should be available');
  const dimensions = await mobile.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    canvas: document.querySelector('canvas')?.getBoundingClientRect(),
  }));
  assert.ok(dimensions.document <= dimensions.viewport, `mobile layout overflows horizontally: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.canvas && dimensions.canvas.width > 0 && dimensions.canvas.height > 0, 'canvas should have usable dimensions on mobile');
  console.log('Browser smoke passed for desktop and mobile.');
} finally {
  await browser.close();
}
