// Verifies the deployed GitHub Pages site, not just its status codes:
// styling, Alpine, syntax highlighting, the playground, and that the
// published install instructions name the scoped package.
import { launch } from './lib/browser.mjs';

const base = process.argv[2] ?? 'https://westtrade.github.io/Fch';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('response', (r) => {
	if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
});

// --- landing page
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const landing = await page.evaluate(() => ({
	font: getComputedStyle(document.body).fontFamily,
	h1: document.querySelector('h1')?.textContent?.trim(),
	h1Size: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize),
	alpine: typeof window.Alpine !== 'undefined',
	demo: typeof window.FchDemo?.Fch,
	pgUrl: document.querySelector('pre[x-text="url"]')?.textContent?.trim() ?? '',
	pgOut: document.querySelector('pre[x-text="output"]')?.textContent?.trim() ?? '',
	install: [...document.querySelectorAll('code, span')]
		.map((n) => n.textContent.trim())
		.find((t) => t.includes('npm install')),
	tableRows: document.querySelectorAll('table tbody tr').length,
}));

if (/Times New Roman/.test(landing.font)) problems.push('landing: CSS missing');
if (landing.h1Size < 40) problems.push('landing: h1 unstyled');
if (!landing.alpine) problems.push('landing: Alpine missing');
if (landing.demo !== 'function') problems.push('landing: demo bundle missing');
if (!landing.pgUrl.includes('api.example.com')) problems.push('landing: playground empty');
if (!landing.pgOut.includes('Cottage')) problems.push('landing: playground did not run');
if (!landing.install?.includes('westtrade')) problems.push('landing: install line wrong: ' + landing.install);
if (landing.tableRows !== 6) problems.push('landing: comparison rows ' + landing.tableRows);

// --- docs
await page.goto(base + '/docs/getting-started.html', { waitUntil: 'networkidle' });
const doc = await page.evaluate(() => ({
	h1: document.querySelector('h1')?.textContent?.trim(),
	colours: new Set([...document.querySelectorAll('pre code span')].slice(0, 40).map((s) => getComputedStyle(s).color)).size,
	copy: document.querySelectorAll('.prose-doc button').length,
	imports: [...document.querySelectorAll('pre code')].map((c) => c.textContent).join('\n'),
	scoped: document.body.innerText.includes('@westtrade/fch'),
	bareImport: /\bfrom "fch"/.test(document.body.innerText),
}));
if (!doc.h1) problems.push('docs: no h1');
if (doc.colours < 3) problems.push('docs: no syntax highlighting');
if (doc.copy === 0) problems.push('docs: no copy buttons');
if (!doc.scoped) problems.push('docs: scoped name not mentioned');
if (doc.bareImport) problems.push('docs: bare "fch" import still present');

// --- every docs page reachable and styled
const slugs = ['vs-fetch', 'vs-libraries', 'url-first', 'requests', 'reading-responses',
	'retries', 'timeouts', 'dedupe', 'cancelling', 'forms', 'shortcuts', 'hooks', 'logging', 'api'];
for (const slug of slugs) {
	await page.goto(`${base}/docs/${slug}.html`, { waitUntil: 'domcontentloaded' });
	const ok = await page.evaluate(() => ({
		h1: !!document.querySelector('h1'),
		css: getComputedStyle(document.body).fontFamily.includes('-apple-system'),
	}));
	if (!ok.h1) problems.push(`${slug}: no h1`);
	if (!ok.css) problems.push(`${slug}: CSS missing`);
}

// --- mobile nav works on the live site
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base + '/docs/retries.html', { waitUntil: 'networkidle' });
await page.click('button[aria-controls="mobile-nav"]');
await page.waitForTimeout(300);
if (!(await page.isVisible('#mobile-nav'))) problems.push('live: mobile nav does not open');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 1) problems.push('live: horizontal overflow ' + overflow + 'px');

console.log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : `live site OK: ${base}`);
console.log('playground:', landing.pgUrl);
console.log('install line:', landing.install);
await browser.close();
process.exit(problems.length ? 1 : 0);
