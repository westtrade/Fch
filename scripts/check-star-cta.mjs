// The "Star" call-to-action must be visible, reachable and correctly linked on
// every page, at every width — that is its whole purpose.
import { launch } from './lib/browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:8765';
const browser = await launch();
const problems = [];
const ok = [];

const pages = ['/', '/docs/getting-started.html', '/docs/api.html', '/docs/forms.html', '/docs/literal.html'];

for (const width of [390, 768, 1440]) {
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	for (const p of pages) {
		await page.goto(base + p, { waitUntil: 'domcontentloaded' });
		const star = await page.evaluate(() => {
			const a = document.querySelector('a[aria-label="Star Fch on GitHub"]');
			if (!a) return null;
			const r = a.getBoundingClientRect();
			const cs = getComputedStyle(a);
			return {
				href: a.getAttribute('href'),
				width: Math.round(r.width),
				height: Math.round(r.height),
				right: Math.round(r.right),
				visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
				inViewport: r.right <= window.innerWidth + 1 && r.left >= -1,
				label: a.textContent.trim(),
			};
		});

		if (!star) {
			problems.push(`${width}px ${p}: star link missing`);
			continue;
		}
		if (!star.visible) problems.push(`${width}px ${p}: star hidden`);
		if (!star.inViewport) problems.push(`${width}px ${p}: star clipped (right=${star.right})`);
		if (star.href !== 'https://github.com/westtrade/Fch') problems.push(`${width}px ${p}: href ${star.href}`);
		if (star.height < 28) problems.push(`${width}px ${p}: star too small to tap (${star.height}px)`);
		// The icon must render even when the word hides on narrow screens.
		if (star.width < 30) problems.push(`${width}px ${p}: star collapsed (${star.width}px)`);
	}
	await page.close();
}
ok.push('star present, visible and tappable on all pages at 390/768/1440px');

// It must not overlap the menu button on mobile.
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.goto(base + '/docs/api.html', { waitUntil: 'domcontentloaded' });
const overlap = await page.evaluate(() => {
	const star = document.querySelector('a[aria-label="Star Fch on GitHub"]').getBoundingClientRect();
	const menu = document.querySelector('button[aria-controls="mobile-nav"]').getBoundingClientRect();
	return { starRight: Math.round(star.right), menuLeft: Math.round(menu.left) };
});
if (overlap.starRight > overlap.menuLeft + 1) problems.push('star overlaps the menu button: ' + JSON.stringify(overlap));
else ok.push(`no overlap with menu (star ${overlap.starRight}px < menu ${overlap.menuLeft}px)`);

// Header height must not grow (sticky offsets in the docs rely on it).
const heights = {};
for (const p of ['/', '/docs/api.html']) {
	await page.goto(base + p, { waitUntil: 'domcontentloaded' });
	heights[p] = await page.evaluate(() => Math.round(document.querySelector('header').getBoundingClientRect().height));
}
if (Object.values(heights).some((h) => h > 68)) problems.push('header grew taller: ' + JSON.stringify(heights));
else ok.push('header height unchanged: ' + JSON.stringify(heights));

console.log('PASS');
for (const l of ok) console.log('  ✓', l);
if (problems.length) {
	console.log('FAIL');
	for (const l of problems) console.log('  ✗', l);
}
await browser.close();
process.exit(problems.length ? 1 : 0);
