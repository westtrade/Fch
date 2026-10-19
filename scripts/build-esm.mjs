// Emits ESM wrappers for the CommonJS build.
//
// `tsc` produces CommonJS only, so `import fch from "@westtrade/fch"` resolves
// to the module namespace object (an object with `.default`), not the factory —
// which is not what the docs promise. These tiny ESM wrappers re-export the CJS
// entry points with correct default exports.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')

mkdirSync(dist, { recursive: true })
mkdirSync(resolve(dist, 'plugins'), { recursive: true })

writeFileSync(
	resolve(dist, 'Fch.mjs'),
	`// ESM wrapper around the CommonJS build (generated).
import mod from './Fch.js'

export const Fch = mod.Fch
export const fch = mod.fch
export const fchWithCreate = mod.fchWithCreate
export const create = mod.create
export const toFormData = mod.toFormData
export const resolveForm = mod.resolveForm
export const toCall = mod.toCall

export default mod.fch
`,
)

writeFileSync(
	resolve(dist, 'Fch.literal.mjs'),
	`// ESM wrapper around the CommonJS build (generated).
import mod from './Fch.literal.js'

export const fch = mod.fch
export const raw = mod.raw
export const withFetch = mod.withFetch

export default mod.fch
`,
)

writeFileSync(
	resolve(dist, 'plugins/nanostores.mjs'),
	`// ESM wrapper around the CommonJS build (generated).
import mod from './nanostores.js'

export const nanostores = mod.nanostores

export default mod.nanostores
`,
)

console.log('dist/Fch.mjs, dist/Fch.literal.mjs and dist/plugins/nanostores.mjs written')
