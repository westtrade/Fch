// Bundles the library for the browser playground on the landing page.
//
// Output is a classic IIFE exposing `window.FchDemo`, not an ES module: the
// site must also work when opened straight from disk (file://), where browsers
// refuse to load module scripts and block `import()` on CORS grounds.
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')
const outfile = resolve(root, 'docs-src/assets/fch.min.js')

mkdirSync(resolve(root, 'docs-src/assets'), { recursive: true })

await build({
	stdin: {
		contents: `export { Fch } from ${JSON.stringify(resolve(root, 'dist/Fch.js'))};`,
		resolveDir: root,
		loader: 'js',
	},
	bundle: true,
	minify: true,
	format: 'iife',
	globalName: 'FchDemo',
	target: 'es2020',
	outfile,
})

console.log('docs-src/assets/fch.min.js rebuilt')
