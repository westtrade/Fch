// Compile site/assets/tailwind.css from the Tailwind classes used in site/.
// Run with: node scripts/build-site-css.mjs
import { compile } from 'tailwindcss'
import { Scanner } from '@tailwindcss/oxide'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const twRoot = resolve(root, 'node_modules/tailwindcss')
const src = resolve(root, 'docs-src/tailwind.src.css')
const out = resolve(root, 'site/assets/tailwind.css')

const loadStylesheet = (id, base) => {
	const file = id === 'tailwindcss' ? resolve(twRoot, 'index.css') : resolve(base, id)
	return { path: file, base: dirname(file), content: readFileSync(file, 'utf8') }
}

const compiler = await compile(readFileSync(src, 'utf8'), {
	base: root,
	onDependency() {},
	loadStylesheet,
	loadModule() { throw new Error('no JS plugins') },
})

const scanner = new Scanner({
	sources: [{ base: resolve(root, 'site'), pattern: '**/*.{html,js,md}', negated: false }],
})

const css = compiler.build(scanner.scan())
writeFileSync(out, css)
console.log(`site/assets/tailwind.css  ${(css.length / 1024).toFixed(1)} kB`)
