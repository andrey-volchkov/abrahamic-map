// Screenshot many chapters in one page load: node scripts/chapters.mjs 0,3,8 [w] [h]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('/opt/node22/lib/node_modules/playwright');
const list = (process.argv[2] || '0').split(',').map(Number);
const w = +(process.argv[3] || 1600), h = +(process.argv[4] || 900);
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`.slice(0, 400)); });
await page.goto(`http://127.0.0.1:5173/?snap=${list[0]}&fast=1`);
await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });
for (const n of list) {
  await page.evaluate((n) => window.app.snapTo(n, 0.75), n);
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `shots/ch${n}.png`, timeout: 120000 });
  console.log('shot', n);
}
await browser.close();
