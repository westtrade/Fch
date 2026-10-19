// Verifies the site works when served from a GitHub Pages project subpath
// (https://<user>.github.io/Fch/), which is how it is deployed.
import { launch } from './lib/browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:8766/Fch';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });

// Every page must load with no 4xx and no broken relative assets.
const pages = ['', 'docs/getting-started.html', 'docs/vs-fetch.html', 'docs/vs-libraries.html',
	'docs/url-first.html', 'docs/requests.html', 'docs/reading-responses.html', 'docs/retries.html',
	'docs/timeouts.html', 'docs/dedupe.html', 'docs/cancelling.html', 'docs/forms.html',
	'docs/shortcuts.html', 'docs/hooks.html', 'docs/logging.html', 'docs/api.html'];

for (const p of pages) {
	await page.goto(`${base}/${p}`, { waitUntil: 'networkidle' });
	const state = await page.evaluate(() => ({
		styled: getComputedStyle(document.body).backgroundColor,
		h1: !!document.querySelector('h1'),
		cssLoaded: [...document.styleSheets].some((s) => s.href?.includes('tailwind.css')),
	}));
	if (!state.h1) problems.push(`${p}: no h1`);
	if (!state.cssLoaded) problems.push(`${p}: tailwind.css not loaded`);
}

// The playground must work from a subpath (relative dynamic import).
await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const pg = await page.evaluate(() => document.querySelector('pre[x-text="output"]')?.textContent?.trim());
if (!pg?.includes('Cottage')) problems.push('playground broken at subpath: ' + JSON.stringify(pg));

// The 404 page's absolute links must resolve under the subpath.
await page.goto(`${base}/404.html`, { waitUntil: 'networkidle' });
const notFoundCss = await page.evaluate(() => [...document.styleSheets].some((s) => s.href?.includes('tailwind.css')));
if (!notFoundCss) problems.push('404 page CSS did not load under subpath');
const notFoundLink = await page.evaluate(() => document.querySelector('a[href*="getting-started"]')?.href);
if (!notFoundLink?.includes('/Fch/docs/getting-started.html')) problems.push('404 link wrong: ' + notFoundLink);

console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'subpath deploy: OK');
await browser.close();
process.exit(problems.length ? 1 : 0);
