// Capture a sequence of frames: node scripts/seq.mjs <url> <prefix> <count> <intervalMs>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('/opt/node22/lib/node_modules/playwright');
const [url, prefix, count = '6', interval = '3000'] = process.argv.slice(2);
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });
for (let i = 0; i < +count; i++) {
  await page.waitForTimeout(+interval);
  const st = await page.evaluate(() => { const a = window.app; const v = a.stage.rig.view; return `year=${a.year.toFixed(0)} dist=${v.dist.toFixed(0)} phase=${a.film.phase} i=${a.film.i}`; });
  await page.screenshot({ path: `${prefix}${i}.png`, timeout: 120000 });
  console.log(i, st);
}
await browser.close();
