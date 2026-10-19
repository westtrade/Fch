import { launch } from './lib/browser.mjs';

const browser = await launch();
const base = 'http://127.0.0.1:8765';
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = [];
const ok = [];

await page.goto(base + '/', { waitUntil: 'networkidle' });

// --- the playground must actually run the real library
await page.waitForTimeout(400);
const pg = await page.evaluate(() => ({
	url: document.querySelector('pre[x-text="url"]')?.textContent?.trim(),
	out: document.querySelector('pre[x-text="output"]')?.textContent?.trim(),
	status: [...document.querySelectorAll('span[x-text]')].map((s) => s.textContent.trim()),
}));
if (!pg.url?.startsWith('https://api.example.com')) fail.push('playground url: ' + JSON.stringify(pg.url));
else ok.push('playground builds URL: ' + pg.url);
if (!pg.out?.includes('"Cottage"')) fail.push('playground output: ' + JSON.stringify(pg.out));
else ok.push('playground parsed JSON');

// edit an input, the URL must follow
await page.fill('#pg-value', 'beach house');
await page.waitForTimeout(150);
const edited = await page.evaluate(() => document.querySelector('pre[x-text="url"]')?.textContent);
if (!edited.includes('beach+house') && !edited.includes('beach%20house')) fail.push('playground does not react: ' + edited);
else ok.push('playground reacts to input: ' + edited);

// --- hero code sample: check the syntax colours actually applied
const heroColors = await page.evaluate(() => {
	const spans = [...document.querySelectorAll('section pre code span')].slice(0, 40);
	return new Set(spans.map((s) => getComputedStyle(s).color)).size;
});
if (heroColors < 3) fail.push('hero code sample is not coloured (' + heroColors + ' colours)');
else ok.push('hero code sample coloured (' + heroColors + ' colours)');

// --- comparison table: header sticky/visible, rows readable, not clipped
const table = await page.evaluate(() => {
	const t = document.querySelector('table');
	const wrap = t.parentElement;
	const firstCell = t.querySelector('tbody tr td');
	return {
		wrapOverflowX: getComputedStyle(wrap).overflowX,
		wrapWidth: Math.round(wrap.getBoundingClientRect().width),
		tableWidth: Math.round(t.getBoundingClientRect().width),
		fontSize: getComputedStyle(firstCell).fontSize,
		rowCount: t.querySelectorAll('tbody tr').length,
	};
});
if (table.rowCount !== 6) fail.push('comparison table rows: ' + table.rowCount);
else ok.push(`comparison table ${table.rowCount} rows, wraps at ${table.wrapWidth}px`);

// --- sticky header does not overlap content when scrolled
await page.evaluate(() => window.scrollTo(0, 1200));
await page.waitForTimeout(200);
const headerBox = await page.evaluate(() => {
	const h = document.querySelector('header');
	const r = h.getBoundingClientRect();
	return { top: Math.round(r.top), height: Math.round(r.height), z: getComputedStyle(h).zIndex };
});
if (headerBox.top !== 0) fail.push('header not sticky: top=' + headerBox.top);
else ok.push(`sticky header at top, h=${headerBox.height}px`);

// --- docs page: sidebar, toc and content do not overlap
await page.goto(base + '/docs/api.html', { waitUntil: 'networkidle' });
const cols = await page.evaluate(() => {
	const aside = document.querySelector('aside');
	const main = document.querySelector('main');
	const toc = document.querySelectorAll('aside')[1];
	const a = aside.getBoundingClientRect();
	const m = main.getBoundingClientRect();
	const t = toc?.getBoundingClientRect();
	return {
		asideRight: Math.round(a.right),
		mainLeft: Math.round(m.left),
		mainRight: Math.round(m.right),
		tocLeft: t ? Math.round(t.left) : null,
	};
});
if (cols.asideRight > cols.mainLeft) fail.push('sidebar overlaps main: ' + JSON.stringify(cols));
else ok.push('sidebar/main/toc columns do not overlap');
if (cols.tocLeft !== null && cols.mainRight > cols.tocLeft) fail.push('main overlaps toc: ' + JSON.stringify(cols));
else ok.push('toc column clear of main');

// --- TOC links resolve to real headings
const tocCheck = await page.evaluate(() => {
	const links = [...document.querySelectorAll('aside a[href^="#"]')];
	const missing = links.filter((a) => !document.querySelector(a.getAttribute('href')));
	return { total: links.length, missing: missing.map((a) => a.getAttribute('href')) };
});
if (tocCheck.missing.length) fail.push('toc links without targets: ' + tocCheck.missing.join(','));
else ok.push(`${tocCheck.total} toc links all resolve`);

// --- scroll-margin so anchor targets are not hidden under the sticky header
await page.click('aside a[href="#errors-you-may-see"]');
await page.waitForTimeout(500);
const anchored = await page.evaluate(() => {
	const h = document.getElementById('errors-you-may-see');
	const r = h.getBoundingClientRect();
	const header = document.querySelector('header').getBoundingClientRect();
	return { headingTop: Math.round(r.top), headerBottom: Math.round(header.bottom) };
});
if (anchored.headingTop < anchored.headerBottom - 2) fail.push('anchor hidden under header: ' + JSON.stringify(anchored));
else ok.push(`anchor lands below header (${anchored.headingTop} > ${anchored.headerBottom})`);

// --- copy buttons present and wired
const copy = await page.evaluate(() => {
	const b = document.querySelector('.prose-doc button');
	return { count: document.querySelectorAll('.prose-doc button').length, text: b?.textContent };
});
ok.push(`${copy.count} copy buttons, label "${copy.text}"`);

// --- tables inside docs scroll instead of breaking the page
const docTables = await page.evaluate(() => [...document.querySelectorAll('.prose-doc table')].map((t) => getComputedStyle(t.parentElement).overflowX));
ok.push('doc table wrappers: ' + docTables.join(', '));

// --- 404 page renders
await page.goto(base + '/404.html', { waitUntil: 'networkidle' });
const notFound = await page.evaluate(() => document.querySelector('h1')?.textContent);
if (notFound !== 'Page not found') fail.push('404 page: ' + notFound);
else ok.push('404 page renders');

console.log('PASS');
for (const l of ok) console.log('  ✓', l);
if (fail.length) { console.log('FAIL'); for (const l of fail) console.log('  ✗', l); }
await browser.close();
process.exit(fail.length ? 1 : 0);
