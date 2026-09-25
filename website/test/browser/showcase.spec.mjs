import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

async function ready(page) {
  await page.goto('./');
  await expect(page.locator('#engine-status')).toContainText('WASM 已就绪');
  await expect(page.locator('#start')).toBeEnabled();
}

test('real worker inference, pause/resume/reset, speed and scenario changes', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.selectOption('#scenario', 'running'); await page.selectOption('#speed', '4');
  await page.click('#start');
  await expect(page.locator('#result-name')).toHaveText('跑步', { timeout: 16000 });
  await page.click('#start'); await expect(page.locator('#start')).toContainText('继续');
  const stopped = await page.locator('#elapsed').textContent();
  await page.waitForTimeout(400); expect(await page.locator('#elapsed').textContent()).toBe(stopped);
  const before = Number(await page.locator('#window-count').textContent());
  await page.click('#start');
  await expect.poll(async () => Number(await page.locator('#window-count').textContent())).toBeGreaterThan(before);
  await page.selectOption('#scenario', 'static');
  await expect(page.locator('#window-count')).toHaveText('0'); await expect(page.locator('#result-name')).toHaveText('准备就绪');
  await page.click('#start'); await expect(page.locator('#result-name')).toHaveText('无活动');
  await page.click('#reset'); await expect(page.locator('#elapsed')).toHaveText('00:00');
  await page.waitForTimeout(250); await expect(page.locator('#window-count')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('complete mixed session produces temporal segments and truthful downloadable JSON', async ({ page }) => {
  await ready(page); await page.selectOption('#speed', '4'); await page.click('#start');
  await expect(page.locator('#start')).toContainText('再试一次', { timeout: 35000 });
  await expect(page.locator('#window-count')).toHaveText('60');
  await expect(page.locator('#elapsed')).toHaveText('01:02');
  expect(await page.locator('.segment').count()).toBeGreaterThan(1);
  const downloadPromise = page.waitForEvent('download'); await page.click('#export-session');
  const download = await downloadPromise;
  const session = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(session.inputSource).toBe('synthetic-project-mock'); expect(session.windows).toHaveLength(60);
  expect(session.engine.sha256).toMatch(/^[0-9a-f]{64}$/); expect(session.segments.length).toBeGreaterThan(1);
  expect(session.windows.some(window => window.classIdx === 4)).toBeTruthy();
  expect(session.windows.every(window => Number.isFinite(window.ms) && window.ms >= 0)).toBeTruthy();
  await page.screenshot({ path: 'test-results/desktop-complete.png', fullPage: true });
});

test('bounded benchmark and background pause keep controls usable', async ({ page }) => {
  await ready(page); await page.click('#benchmark');
  await expect(page.locator('#benchmark-result')).toContainText('3,000 次');
  await expect(page.locator('#start')).toBeEnabled();
  await page.click('#start'); await expect(page.locator('#start')).toContainText('暂停');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#start')).toContainText('继续');
});

test('failed WASM download shows a real error; explicit retry recovers', async ({ page, context }) => {
  await context.route('**/wasm/classifier.wasm', route => route.abort());
  await page.goto('./'); await expect(page.locator('#engine-error')).toBeVisible();
  await expect(page.locator('#start')).toBeDisabled();
  await expect(page.locator('#window-count')).toHaveText('0');
  await context.unroute('**/wasm/classifier.wasm'); await page.click('#retry-engine');
  await expect(page.locator('#engine-status')).toContainText('WASM 已就绪');
  await expect(page.locator('#engine-error')).toBeHidden(); await expect(page.locator('#start')).toBeEnabled();
});

test('mobile layout has no horizontal overflow and operates without remote runtime services', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = []; page.on('request', request => requests.push(request.url()));
  await ready(page); await page.selectOption('#speed', '4'); await page.click('#start');
  await expect(page.locator('#window-count')).not.toHaveText('0'); await page.click('#start');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#hardware').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('#hardware img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0))).toBeTruthy();
  const origin = new URL(page.url()).origin;
  expect(requests.every(url => new URL(url).origin === origin)).toBeTruthy();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
