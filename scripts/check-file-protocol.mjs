// Verifies the built site works when opened straight from disk (file://),
// which is what "open index.html on localhost" usually means. No server, no
// module scripts, no CORS: styles, Alpine and the playground must all work.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './lib/browser.mjs';

const root = resolve(import.meta.dirname, '..');
const file = (p) => pathToFileURL(resolve(root, 'site', p)).href;

const browser = await launch();
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url().split('/').slice(-2).join('/')));

// --- landing page from disk
await page.goto(file('index.html'), { waitUntil: 'load' });
await page.waitForTimeout(900);
const landing = await page.evaluate(() => ({
	font: getComputedStyle(document.body).fontFamily,
	h1Size: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize),
	alpine: typeof window.Alpine !== 'undefined',
	demo: typeof window.FchDemo?.Fch,
	url: document.querySelector('pre[x-text="url"]')?.textContent?.trim() ?? '',
	out: document.querySelector('pre[x-text="output"]')?.textContent?.trim() ?? '',
	navClosed: getComputedStyle(document.querySelector('#mobile-nav')).display === 'none',
}));

if (/Times New Roman/.test(landing.font)) problems.push('landing: Tailwind CSS did not load (serif font)');
if (landing.h1Size < 40) problems.push('landing: h1 not styled (' + landing.h1Size + 'px)');
if (!landing.alpine) problems.push('landing: Alpine did not load');
if (landing.demo !== 'function') problems.push('landing: demo bundle did not expose Fch');
if (!landing.url.startsWith('https://api.example.com')) problems.push('landing: playground URL empty: ' + JSON.stringify(landing.url));
if (!landing.out.includes('Cottage')) problems.push('landing: playground did not run: ' + JSON.stringify(landing.out.slice(0, 60)));
if (!landing.navClosed) problems.push('landing: mobile nav visible on load');

// --- a docs page from disk
await page.goto(file('docs/api.html'), { waitUntil: 'load' });
await page.waitForTimeout(300);
const doc = await page.evaluate(() => ({
	font: getComputedStyle(document.body).fontFamily,
	h1: document.querySelector('h1')?.textContent?.trim(),
	colours: new Set([...document.querySelectorAll('pre code span')].slice(0, 30).map((s) => getComputedStyle(s).color)).size,
	copyButtons: document.querySelectorAll('.prose-doc button').length,
}));
if (/Times New Roman/.test(doc.font)) problems.push('docs: Tailwind CSS did not load');
if (!doc.h1) problems.push('docs: no h1');
if (doc.colours < 3) problems.push('docs: syntax highlighting missing (' + doc.colours + ' colours)');
if (doc.copyButtons === 0) problems.push('docs: copy buttons missing');

// --- Alpine interactivity from disk (mobile nav toggle)
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(file('docs/api.html'), { waitUntil: 'load' });
await page.waitForTimeout(300);
await page.click('button[aria-controls="mobile-nav"]');
await page.waitForTimeout(250);
const opened = await page.isVisible('#mobile-nav');
if (!opened) problems.push('docs: mobile nav did not open from file:// (Alpine inactive)');

console.log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'file:// (double-click) deploy: OK');
await browser.close();
process.exit(problems.length ? 1 : 0);
