// Headless screenshots for visual QA: node scripts/shot.mjs <url> <out.png> [waitMs] [w] [h]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const [url, out, wait = '6000', w = '1600', h = '900'] = process.argv.slice(2);
const browser = await pw.chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
try { await page.waitForFunction('window.__ready === true', null, { timeout: 120000 }); } catch { logs.push('ready timeout'); }
await page.waitForTimeout(+wait);
await page.evaluate(() => { if (window.stage) window.stage.running = false; });
await page.waitForTimeout(800);
await page.screenshot({ path: out, timeout: 180000 });
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
