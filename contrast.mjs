import { launch } from './scripts/lib/browser.mjs';

// Compute WCAG contrast in-page, resolving oklch through the browser itself.
const CONTRAST = `(() => {
  const toRgb = (css) => {
    const d = document.createElement('div');
    d.style.color = css; document.body.appendChild(d);
    const v = getComputedStyle(d).color; d.remove();
    const n = v.match(/[\\d.]+/g).slice(0,3).map(Number);
    return n;
  };
  const lin = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  const lum = ([r,g,b]) => 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  const ratio = (a, b) => { const [x,y] = [lum(a), lum(b)].sort((m,n)=>n-m); return (x+0.05)/(y+0.05); };
  const bar = document.querySelector('[role="tablist"]');
  const barBg = toRgb(getComputedStyle(bar).backgroundColor);
  return [...bar.querySelectorAll('[role="tab"]')].map(t => {
    const s = getComputedStyle(t);
    const own = s.backgroundColor === 'rgba(0, 0, 0, 0)' ? barBg : toRgb(s.backgroundColor);
    return { label: t.textContent.trim(), selected: t.getAttribute('aria-selected') === 'true', ratio: +ratio(toRgb(s.color), own).toFixed(2) };
  });
})()`;

const b = await launch();
const problems = [];
for (const width of [390, 768, 1440]) {
  for (const page of ['getting-started', 'retries', 'timeouts', 'dedupe', 'requests', 'reading-responses']) {
    const p = await b.newPage({ viewport: { width, height: 900 } });
    await p.goto(`http://127.0.0.1:8766/docs/${page}.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(300);
    const tabs = await p.evaluate(CONTRAST);
    // 4.5:1 is the WCAG AA threshold for normal text; these are 11px, so small.
    for (const t of tabs) {
      if (t.ratio < 4.5) problems.push(`${page} @${width}: "${t.label}" contrast ${t.ratio} (selected=${t.selected})`);
    }
    // Active vs inactive must be visually distinct, not just by hue.
    const sel = tabs.filter(t => t.selected), un = tabs.filter(t => !t.selected);
    if (sel.length !== 1) problems.push(`${page} @${width}: ${sel.length} selected tabs`);
    if (sel.length && un.length && sel[0].ratio === un[0].ratio) problems.push(`${page} @${width}: active and inactive look identical`);
    await p.close();
  }
}
console.log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'tab contrast OK at 390/768/1440 on all pages');
await b.close();
process.exit(problems.length ? 1 : 0);
