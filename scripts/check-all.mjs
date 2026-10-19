import { readdirSync } from 'node:fs';
import { launch } from './lib/browser.mjs';

const browser = await launch();
const base = 'http://127.0.0.1:8765';
const docs = readdirSync('site/docs').filter((f) => f.endsWith('.html')).map((f) => 'docs/' + f);
const pages = ['', ...docs];
const errors = [];
let bad = 0;

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
	const page = await browser.newPage({ viewport });
	page.on('pageerror', (e) => errors.push(`${page.url()} pageerror: ${e.message}`));
	page.on('console', (m) => { if (m.type() === 'error') errors.push(`${page.url()} console: ${m.text()}`); });
	page.on('requestfailed', (r) => errors.push(`${page.url()} reqfail: ${r.url()}`));

	for (const p of pages) {
		const url = `${base}/${p}`;
		await page.goto(url, { waitUntil: 'networkidle' });
		const res = await page.evaluate(() => ({
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			h1: document.querySelector('h1')?.textContent?.trim().slice(0, 40) ?? null,
			broken: [...document.querySelectorAll('a[href]')]
				.map((a) => a.getAttribute('href'))
				.filter((h) => h.startsWith('/') || h.endsWith('.html') || h.endsWith('.md')),
			emptyLinks: [...document.querySelectorAll('a')].filter((a) => !a.textContent.trim() && !a.getAttribute('aria-label')).length,
		}));
		if (res.overflow > 1) { bad++; console.log(`OVERFLOW ${viewport.width}px ${p}: ${res.overflow}px`); }
		if (!res.h1) { bad++; console.log(`NO H1 ${p}`); }
	}
	await page.close();
}

// Link integrity: every internal href must resolve.
const page = await browser.newPage();
const seen = new Set();
for (const p of pages) {
	await page.goto(`${base}/${p}`, { waitUntil: 'domcontentloaded' });
	const hrefs = await page.evaluate(() =>
		[...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin))
	);
	for (const h of hrefs) seen.add(h);
}
for (const h of seen) {
	const r = await page.request.get(h);
	if (!r.ok()) { bad++; console.log(`BROKEN LINK ${h} -> ${r.status()}`); }
}
console.log(`checked ${pages.length} pages x3 viewports, ${seen.size} internal links, problems: ${bad}`);
console.log('js errors:', errors.length ? [...new Set(errors)] : 'none');
await browser.close();
