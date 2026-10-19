import { launch } from './lib/browser.mjs';

const browser = await launch();
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const fail = [];
const ok = [];

await page.goto('http://127.0.0.1:8765/docs/retries.html', { waitUntil: 'networkidle' });

// copy button copies the code block it belongs to
const btn = page.locator('.prose-doc .group button').first();
const codeText = await page.locator('.prose-doc .group pre code').first().innerText();
await btn.click();
await page.waitForTimeout(250);
const label = await btn.innerText();
const clip = await page.evaluate(() => navigator.clipboard.readText());
if (label.trim() !== 'copied') fail.push('copy label did not change: ' + label);
else ok.push('copy label flips to "copied"');
if (clip !== codeText) fail.push(`clipboard mismatch:\n  got: ${JSON.stringify(clip.slice(0, 80))}\n  want: ${JSON.stringify(codeText.slice(0, 80))}`);
else ok.push('clipboard holds the exact code block');
await page.waitForTimeout(1300);
const restored = await btn.innerText();
if (restored.trim() !== 'copy') fail.push('copy label did not reset: ' + restored);
else ok.push('copy label resets after ~1.4s');

// escaping: the angle-bracket examples must render as text, not markup
await page.goto('http://127.0.0.1:8765/docs/forms.html', { waitUntil: 'networkidle' });
const escaped = await page.evaluate(() => {
	const text = document.querySelector('.prose-doc').innerText;
	return {
		hasLiteralTag: text.includes('<form>') || text.includes('<input'),
		strayElements: document.querySelectorAll('.prose-doc form, .prose-doc input').length,
	};
});
if (!escaped.hasLiteralTag) fail.push('inline <form> was swallowed');
else ok.push('inline HTML in prose is escaped');
if (escaped.strayElements > 0) fail.push('markdown created real form elements: ' + escaped.strayElements);
else ok.push('no stray form/input elements created from code samples');

// tables in markdown are real tables with a header row
const tables = await page.evaluate(() =>
	[...document.querySelectorAll('.prose-doc table')].map((t) => ({
		head: t.querySelectorAll('thead th').length,
		rows: t.querySelectorAll('tbody tr').length,
	}))
);
if (!tables.length || tables.some((t) => t.head === 0)) fail.push('bad tables: ' + JSON.stringify(tables));
else ok.push('markdown tables: ' + JSON.stringify(tables));

// external links open safely
const ext = await page.evaluate(() =>
	[...document.querySelectorAll('a[href^="http"]')].map((a) => ({ rel: a.rel, target: a.target }))
);
if (ext.some((e) => e.target === '_blank' && !e.rel.includes('noopener'))) fail.push('external link without noopener');
else ok.push(ext.length + ' external links, all noopener');

// mobile: nav closes on Escape
await page.setViewportSize({ width: 390, height: 844 });
await page.goto('http://127.0.0.1:8765/docs/retries.html', { waitUntil: 'networkidle' });
await page.click('button[aria-controls="mobile-nav"]');
await page.waitForTimeout(200);
const open = await page.isVisible('#mobile-nav');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const closed = await page.isVisible('#mobile-nav');
if (!open || closed) fail.push(`mobile nav escape: open=${open} closed=${closed}`);
else ok.push('mobile nav opens and closes on Escape');

console.log('PASS');
for (const l of ok) console.log('  ✓', l);
if (fail.length) { console.log('FAIL'); for (const l of fail) console.log('  ✗', l); }
await browser.close();
process.exit(fail.length ? 1 : 0);
