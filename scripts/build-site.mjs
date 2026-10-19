// Builds the static site in site/ from the Markdown in docs-src/content/.
//
//   node scripts/build-site.mjs
//
// Two steps: Markdown -> HTML pages, then Tailwind scans site/ and writes
// site/assets/tailwind.css. The landing page is hand-written HTML in
// docs-src/index.html.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { marked } from 'marked'
import hljs from 'highlight.js'

const root = resolve(import.meta.dirname, '..')
const srcDir = resolve(root, 'docs-src')
const outDir = resolve(root, 'site')

// ---------------------------------------------------------------- navigation
// One source of truth for the sidebar, the pager and the build.
const NAV = [
	{
		title: 'Start here',
		items: [
			{ slug: 'getting-started', title: 'Getting started', blurb: 'Install, first request, mental model.' },
			{ slug: 'vs-fetch', title: 'Why not plain fetch?', blurb: 'Six things fetch makes you write yourself.' },
			{ slug: 'vs-libraries', title: 'How Fch compares', blurb: 'axios, ky, ofetch, wretch — and when they win.' },
		],
	},
	{
		title: 'Core ideas',
		items: [
			{ slug: 'url-first', title: 'The URL is the request', blurb: 'One object that is both a URL and a client.' },
			{ slug: 'requests', title: 'Bodies, headers, methods', blurb: 'JSON, forms, binary, auth — without boilerplate.' },
			{ slug: 'reading-responses', title: 'Reading responses', blurb: 'Tuples, typed JSON, and when to throw.' },
		],
	},
	{
		title: 'Reliability',
		items: [
			{ slug: 'retries', title: 'Retries & backoff', blurb: 'Exponential, jittered, abort-aware.' },
			{ slug: 'timeouts', title: 'Timeouts', blurb: 'Per attempt, per request, no leaked timers.' },
			{ slug: 'dedupe', title: 'Deduplication', blurb: 'One request on the wire, many callers.' },
			{ slug: 'cancelling', title: 'Cancelling', blurb: 'Abort in-flight work, keep the builder.' },
			{ slug: 'polling', title: 'Polling', blurb: 'Repeat a request until the job is done.' },
		],
	},
	{
		title: 'Working with DOM',
		items: [
			{ slug: 'forms', title: 'Forms & events', blurb: 'Pass the <form> or the submit event.' },
			{ slug: 'shortcuts', title: 'Shorthand API', blurb: 'api.get / post / put — fire and forget.' },
			{ slug: 'literal', title: 'Tagged template', blurb: 'fch`https://…` — a URL in backticks.' },
		],
	},
	{
		title: 'Extending',
		items: [
			{ slug: 'plugins', title: 'Plugins', blurb: 'use() and the plugin contract.' },
			{ slug: 'nanostores', title: 'Nano Stores', blurb: 'A request that is a store, in any framework.' },
			{ slug: 'validate', title: 'Validation', blurb: 'Check the form before sending, the reply after.' },
		],
	},
	{
		title: 'Operating',
		items: [
			{ slug: 'hooks', title: 'Interceptors', blurb: 'before() / after(), per attempt.' },
			{ slug: 'logging', title: 'Logging', blurb: 'A plugin: console, pino, or your own.' },
			{ slug: 'api', title: 'API reference', blurb: 'Every method, every option.' },
		],
	},
]

const flatNav = NAV.flatMap((section) => section.items.map((item) => ({ ...item, section: section.title })))

// ---------------------------------------------------------------- markdown
marked.setOptions({ gfm: true, headerIds: false, mangle: false })

const slugify = (text) =>
	text
		.toLowerCase()
		.replace(/<[^>]+>/g, '')
		.replace(/&[a-z]+;/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-|-$/g, '')

const escapeHtml = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const renderer = new marked.Renderer()

// Headings get ids and are collected for the "On this page" list.
let headings = []
renderer.heading = function ({ tokens, depth }) {
	const text = this.parser.parseInline(tokens)
	const id = slugify(text)
	if (depth === 2) headings.push({ id, text })
	return `<h${depth} id="${id}">${text}</h${depth}>\n`
}

// A `tabs` fence renders one example in the three ways it can be written:
//
//   ```tabs
//   === class
//   const [u] = await new Fch(url).json()
//   === function
//   const [u] = await fch.create({}).get(url)
//   === literal
//   const [u] = await fch`url`
//   ```
//
// A single fence (rather than consecutive blocks) keeps it one widget, so the
// selected tab can be tracked in one x-data scope.
const TAB_LABELS = { class: 'Class', function: 'Function', literal: 'Literal' }

function highlight(text, lang) {
	const language = lang && hljs.getLanguage(lang) ? lang : 'javascript'
	return hljs.highlight(text, { language, ignoreIllegals: true }).value
}

function renderTabs(text) {
	const sections = []
	let current = null
	for (const line of text.split('\n')) {
		const marker = line.match(/^===\s*(\w+)\s*$/)
		if (marker) {
			current = { key: marker[1], lines: [] }
			sections.push(current)
			continue
		}
		if (current) current.lines.push(line)
	}
	if (!sections.length) return null

	const code = (section) => section.lines.join('\n').replace(/^\n+|\n+$/g, '')
	const buttons = sections
		.map(
			(section, i) => `<button type="button" role="tab" x-on:click="tab = '${section.key}'" :aria-selected="tab === '${section.key}'" :class="tab === '${section.key}' ? 'border-white text-white' : 'border-transparent text-indigo-200/70 hover:text-white'" class="cursor-pointer border-b-2 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wider transition-colors"${i === 0 ? ' id="tab-first"' : ''}>${escapeHtml(TAB_LABELS[section.key] || section.key)}</button>`
		)
		.join('')

	const panels = sections
		.map(
			(section) => `<div x-show="tab === '${section.key}'" x-cloak role="tabpanel" class="group relative">
<button type="button" class="absolute right-2 top-2 cursor-pointer rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-300 opacity-0 transition hover:bg-slate-700 focus:opacity-100 group-hover:opacity-100" x-on:click="navigator.clipboard.writeText($el.parentElement.querySelector('code').innerText); copied = true; setTimeout(() => copied = false, 1400)" x-text="copied ? 'copied' : 'copy'">copy</button>
<pre class="!mt-0 !rounded-t-none !pt-9"><code class="hljs language-ts">${highlight(code(section), 'ts')}</code></pre>
</div>`
		)
		.join('\n')

	return `<div class="my-5" x-data="{ tab: '${sections[0].key}', copied: false }">
<div class="flex cursor-pointer rounded-t-xl border border-b-0 border-indigo-900 bg-indigo-950 pt-0.5" role="tablist">${buttons}</div>
${panels}
</div>`
}

// Code blocks: syntax-highlight, and wrap in a copy-button shell.
renderer.code = ({ text, lang }) => {
	if (lang === 'tabs') {
		const tabs = renderTabs(text)
		if (tabs) return tabs
	}

	const language = lang && hljs.getLanguage(lang) ? lang : 'javascript'
	const highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value
	const label = lang || 'text'
	return `<div class="group relative my-5" x-data="{ copied: false }">
<button type="button" class="absolute right-2 top-2 cursor-pointer rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-300 opacity-0 transition hover:bg-slate-700 focus:opacity-100 group-hover:opacity-100" x-on:click="navigator.clipboard.writeText($refs.code.innerText); copied = true; setTimeout(() => copied = false, 1400)" x-text="copied ? 'copied' : 'copy'">copy</button>
<span class="absolute left-3 top-2.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">${escapeHtml(label)}</span>
<pre class="!pt-9"><code x-ref="code" class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>
</div>`
}

// Tables get a wrapper so they scroll on mobile instead of breaking layout.
renderer.table = function (token) {
	const head = token.header.map((cell) => `<th>${this.parser.parseInline(cell.tokens)}</th>`).join('')
	const body = token.rows
		.map((row) => `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`)
		.join('')
	return `<div class="overflow-x-auto"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

// Internal links: `foo.md` -> `foo.html`, and keep the reader in docs/.
renderer.link = function (token) {
	const href = token.href.replace(/\.md(#|$)/, '.html$1')
	const external = /^https?:/i.test(href)
	const attrs = external ? ' target="_blank" rel="noopener"' : ''
	return `<a href="${escapeHtml(href)}"${attrs}>${this.parser.parseInline(token.tokens)}</a>`
}

marked.use({ renderer })

// ---------------------------------------------------------------- templates
const SITE_NAME = 'Fch'
const GITHUB = 'https://github.com/westtrade/Fch'

// The version badge is read from package.json. Hardcoding it is how it drifted
// to v1.2.3 while the package was at 1.3.0.
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const VERSION = pkg.version
// There is no npm package to link: the `fch` name on npm belongs to another
// author's library. Every "npm" affordance points at the repository instead.

const icon = (paths, cls = 'h-5 w-5') =>
	`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const ICONS = {
	menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
	close: '<path d="M6 6l12 12M18 6L6 18"/>',
	arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
	check: '<path d="M20 6L9 17l-5-5"/>',
	cross: '<path d="M18 6L6 18M6 6l12 12"/>',
	star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>',
	github:
		'<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 00-.9-2.6c3-.3 6.2-1.5 6.2-6.8A5.3 5.3 0 0019.9 5 4.9 4.9 0 0019.8.6S18.6.2 16 1.9a13.4 13.4 0 00-7 0C6.4.2 5.2.6 5.2.6A4.9 4.9 0 005.1 5a5.3 5.3 0 00-1.4 3.7c0 5.3 3.2 6.5 6.2 6.8a3.4 3.4 0 00-.9 2.6V22"/>',
}

const navItem = (item, current, extra = '') => {
	const active = item.slug === current
	return `<li>
	<a href="${item.slug}.html"${active ? ' aria-current="page"' : ''} class="block rounded-lg px-3 py-2 text-sm transition ${
		active
			? 'bg-indigo-50 font-semibold text-indigo-700'
			: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
	}"${extra}>${item.title}</a>
</li>`
}

const sidebar = (current) => `
<nav aria-label="Documentation" class="space-y-7">
${NAV.map(
	(section) => `<div>
	<p class="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">${section.title}</p>
	<ul class="space-y-0.5">${section.items.map((item) => navItem(item, current)).join('')}</ul>
</div>`
).join('\n')}
</nav>`

const header = () => `
<header class="sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 backdrop-blur">
	<div class="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
		<a href="../index.html" class="flex items-center gap-2.5">
			<span class="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 font-mono text-sm font-bold text-white">F</span>
			<span class="text-[15px] font-semibold tracking-tight text-slate-900">Fch</span>
			<span class="hidden rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500 sm:inline">v${VERSION}</span>
		</a>
		<span class="hidden text-slate-300 sm:inline">/</span>
		<a href="getting-started.html" class="hidden text-sm text-slate-500 hover:text-slate-900 sm:inline">Docs</a>
		<div class="ml-auto flex items-center gap-1">
			<a href="${GITHUB}" class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50" aria-label="Star Fch on GitHub">
				<span class="text-amber-500">${icon(ICONS.star, 'h-4 w-4')}</span>
				<span class="hidden sm:inline">Star</span>
			</a>
			<a href="${GITHUB}" class="hidden rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 sm:inline">GitHub</a>
			<a href="${GITHUB}" class="rounded-lg p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900" aria-label="GitHub">${icon(ICONS.github)}</a>
			<button type="button" class="cursor-pointer rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" x-on:click="nav = !nav" :aria-expanded="nav" aria-controls="mobile-nav" aria-label="Menu">
				<span x-show="!nav">${icon(ICONS.menu)}</span>
				<span x-show="nav" x-cloak>${icon(ICONS.close)}</span>
			</button>
		</div>
	</div>
	<div id="mobile-nav" x-show="nav" x-cloak x-transition.opacity class="border-t border-slate-200 bg-white lg:hidden">
		<div class="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-6">${sidebar('')}</div>
	</div>
</header>`

const footer = () => `
<footer class="border-t border-slate-200 bg-white">
	<div class="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
		<p>MIT licensed. Built with <code class="font-mono text-slate-700">fetch</code>, <code class="font-mono text-slate-700">URL</code> and nothing else.</p>
		<p class="flex gap-4">
			<a href="${GITHUB}" class="hover:text-slate-900">GitHub</a>
			<a href="getting-started.html" class="hover:text-slate-900">Docs</a>
			<a href="api.html" class="hover:text-slate-900">API</a>
		</p>
	</div>
</footer>`

const docPage = ({ title, description, slug, body, toc, prev, next }) => `<!doctype html>
<html lang="en" class="scroll-smooth">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Fch docs</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)} — Fch docs">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../assets/tailwind.css">
<link rel="stylesheet" href="../assets/hljs.css">
<script src="../assets/alpine.min.js" defer></script>
</head>
<body class="bg-white text-slate-900 antialiased" x-data="{ nav: false }" x-on:keydown.escape="nav = false">

${header()}

<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
	<div class="flex gap-10 py-8 lg:py-12">

		<aside class="hidden w-60 shrink-0 lg:block">
			<div class="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8 pr-2">
				${sidebar(slug)}
			</div>
		</aside>

		<main class="min-w-0 flex-1">
			<article class="prose-doc max-w-3xl">
				${body}
			</article>

			<nav class="mt-14 flex max-w-3xl flex-col gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-between" aria-label="Pagination">
				${prev ? `<a href="${prev.slug}.html" class="group rounded-xl border border-slate-200 px-4 py-3 transition hover:border-slate-300 hover:bg-slate-50"><span class="block text-[11px] uppercase tracking-wider text-slate-400">Previous</span><span class="mt-0.5 block text-sm font-medium text-slate-800">${prev.title}</span></a>` : '<span></span>'}
				${next ? `<a href="${next.slug}.html" class="group rounded-xl border border-slate-200 px-4 py-3 text-right transition hover:border-slate-300 hover:bg-slate-50"><span class="block text-[11px] uppercase tracking-wider text-slate-400">Next</span><span class="mt-0.5 block text-sm font-medium text-slate-800">${next.title}</span></a>` : '<span></span>'}
			</nav>
		</main>

		<aside class="hidden w-56 shrink-0 xl:block">
			<div class="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8">
				<p class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">On this page</p>
				<ul class="space-y-1 border-l border-slate-200 text-sm">
					${toc.map((h) => `<li><a href="#${h.id}" class="block border-l-2 border-transparent py-1 pl-3 text-slate-500 transition hover:border-slate-300 hover:text-slate-900">${h.text}</a></li>`).join('')}
				</ul>
			</div>
		</aside>
	</div>
</div>

${footer()}
</body>
</html>`

// ---------------------------------------------------------------- build
rmSync(outDir, { recursive: true, force: true })
mkdirSync(resolve(outDir, 'docs'), { recursive: true })
mkdirSync(resolve(outDir, 'assets'), { recursive: true })

cpSync(resolve(srcDir, 'assets'), resolve(outDir, 'assets'), { recursive: true })
cpSync(resolve(srcDir, 'vendor'), resolve(outDir, 'assets'), { recursive: true })

// Optional: loose files (robots.txt, CNAME, ...). Git does not track empty
// directories, so a clean checkout has no docs-src/static — skip it rather
// than failing the build.
const staticDir = resolve(srcDir, 'static')
if (existsSync(staticDir)) cpSync(staticDir, resolve(outDir), { recursive: true })

const pages = flatNav.map((item) => {
	const file = resolve(srcDir, 'content', `${item.slug}.md`)
	let raw
	try {
		raw = readFileSync(file, 'utf8')
	} catch {
		throw new Error(`Missing content file: docs-src/content/${item.slug}.md`)
	}
	headings = []
	const body = marked.parse(raw)
	const title = raw.match(/^#\s+(.+)$/m)?.[1] ?? item.title
	const description = item.blurb
	return { ...item, body, toc: headings, title, description, file }
})

pages.forEach((page, i) => {
	const html = docPage({
		...page,
		prev: pages[i - 1],
		next: pages[i + 1],
	})
	writeFileSync(resolve(outDir, 'docs', `${page.slug}.html`), html)
})

// Landing page.
const landing = readFileSync(resolve(srcDir, 'index.html'), 'utf8')
writeFileSync(resolve(outDir, 'index.html'), landing)

// 404 for GitHub Pages. Every other page uses relative links, but a 404 is
// served from an arbitrary depth, so its links must be absolute. The base is
// the project path on github.io; override it for a custom domain:
//   SITE_BASE=/ npm run site
const siteBase = process.env.SITE_BASE ?? '/Fch/'

writeFileSync(
	resolve(outDir, '404.html'),
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found — Fch</title><link rel="stylesheet" href="${siteBase}assets/tailwind.css"></head>
<body class="grid min-h-screen place-items-center bg-white px-6 text-center font-sans text-slate-900">
<div><p class="font-mono text-sm text-indigo-600">404</p>
<h1 class="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
<p class="mt-2 text-slate-600">That URL does not resolve. Try the documentation.</p>
<a href="${siteBase}docs/getting-started.html" class="mt-6 inline-block rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700">Getting started</a></div>
</body></html>`
)

// llms-full.txt: every doc page concatenated as plain markdown, for agents with
// a large context window. Ordered like the navigation, so it reads as a book.
const fullDoc = [
	`# Fch — full documentation (v${VERSION})`,
	'',
	'> Generated from the documentation pages. Prefer /llms.txt for a short',
	'> overview; this file is the whole manual in one place.',
	'',
	'## Contents',
	'',
	...flatNav.map((item, i) => `${i + 1}. ${item.title}`),
	'',
	...pages.map((page) => {
		// Strip the page's own H1 (it is already the section header below).
		const body = readFileSync(page.file, 'utf8').replace(/^#\s+.+\n/, '');
		return `---\n\n# ${page.title}\n${body}`;
	}),
].join('\n')

writeFileSync(resolve(outDir, 'llms-full.txt'), fullDoc)

// llms.txt lives in docs-src/static and is copied above; fail the build if it
// drifts from the spec (H1 first, a blockquote summary, no stray H1s) or if it
// links a page that does not exist. Agents rely on this file, so a broken one
// is worse than none.
const llmsSrc = resolve(srcDir, 'static/llms.txt')
if (existsSync(llmsSrc)) {
	const llms = readFileSync(llmsSrc, 'utf8')
	const lines = llms.split('\n')
	const firstContent = lines.find((line) => line.trim())

	const problems = []
	if (!firstContent?.startsWith('# ')) problems.push('must start with an H1')
	if (!lines.some((line) => line.startsWith('> '))) problems.push('needs a blockquote summary')
	if (lines.filter((line) => /^# [^#]/.test(line)).length !== 1) problems.push('exactly one H1')

	for (const match of llms.matchAll(/\]\((https:\/\/westtrade\.github\.io\/Fch\/([^)#]+))[^)]*\)/g)) {
		const target = match[2]
		if (target.startsWith('llms') || target.startsWith('ROADMAP')) continue
		if (!existsSync(resolve(outDir, target))) problems.push(`broken link: ${target}`)
	}

	if (problems.length) {
		throw new Error(`llms.txt is invalid:\n  ${problems.join('\n  ')}`)
	}
}

console.log(`built ${pages.length + 2} pages + llms-full.txt`)
