// Measures how many tokens each library costs for the same task, with a real
// BPE tokenizer, and checks the numbers recorded in ROADMAP.md.
//
//   node scripts/measure-tokens.mjs          # print the table
//   node scripts/measure-tokens.mjs --check  # fail if ROADMAP.md drifted
//
// Token counts are "code the developer writes", not instruction tokens. Where a
// library has no built-in feature, the helper the caller must write is counted —
// a comment placeholder would flatter Fch for free.
//
// INTERNAL ONLY. These numbers are recorded in ROADMAP.md and are deliberately
// not published on the site or in llms.txt: the suite is still small. Publishing
// is a separate decision, guarded by test/docs.test.ts.
import { encode } from 'gpt-tokenizer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const tokens = (code) => encode(code).length

// One task per row: identical intent, working code for every library.
const SIMPLE = {
	'GET JSON': {
		fch: 'const [u] = await fch`https://a.test/u/1`',
		ofetch: 'const u = await ofetch("https://a.test/u/1")',
		ky: 'const u = await ky("https://a.test/u/1").json()',
		axios: 'const { data: u } = await axios.get("https://a.test/u/1")',
		native: 'const r = await fetch("https://a.test/u/1"); const u = await r.json()',
	},
	'POST JSON': {
		fch: 'fch.post({ name: "Ann" })`https://a.test/u`',
		ofetch: 'await ofetch("https://a.test/u", { method: "POST", body: { name: "Ann" } })',
		ky: 'await ky.post("https://a.test/u", { json: { name: "Ann" } })',
		axios: 'await axios.post("https://a.test/u", { name: "Ann" })',
		native:
			'await fetch("https://a.test/u", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ann" }) })',
	},
	'query params': {
		fch: 'const r = new Fch("https://a.test/u"); r.searchParams.set("page","2"); await r.json()',
		ofetch: 'await ofetch("https://a.test/u", { query: { page: 2 } })',
		ky: 'await ky("https://a.test/u", { searchParams: { page: 2 } }).json()',
		axios: 'await axios.get("https://a.test/u", { params: { page: 2 } })',
		native:
			'const u = new URL("https://a.test/u"); u.searchParams.set("page","2"); await fetch(u)',
	},
	timeout: {
		fch: 'await new Fch("https://a.test/u", { timeout: 5000 }).json()',
		ofetch: 'await ofetch("https://a.test/u", { timeout: 5000 })',
		ky: 'await ky("https://a.test/u", { timeout: 5000 }).json()',
		axios: 'await axios.get("https://a.test/u", { timeout: 5000 })',
		native:
			'const c = new AbortController(); setTimeout(() => c.abort(), 5000); await fetch("https://a.test/u", { signal: c.signal })',
	},
	'form submit': {
		fch: 'fch.post(e)`https://a.test/u`',
		ofetch: 'await ofetch("https://a.test/u", { method: "POST", body: new FormData(e.target) })',
		ky: 'await ky.post("https://a.test/u", { body: new FormData(e.target) })',
		axios: 'await axios.post("https://a.test/u", new FormData(e.target))',
		native: 'await fetch("https://a.test/u", { method: "POST", body: new FormData(e.target) })',
	},
}

// Tasks where the alternatives need a hand-written helper.
const HAND_WRITTEN = `const inflight = new Map(); const dedupe = (k, run) => { const e = inflight.get(k); if (e) return e.then(r => r.clone()); const p = run(); inflight.set(k, p); return p.then(r => r.clone()).finally(() => inflight.delete(k)); }`
const HAND_RETRY = `const withRetry = async (url, n = 3) => { for (let i = 0; i < n; i++) { try { const c = new AbortController(); setTimeout(() => c.abort(), 5000); return await (await fetch(url, { signal: c.signal })).json(); } catch (e) { if (i === n - 1) throw e; await new Promise(r => setTimeout(r, 500 * 2 ** i)); } } }`

const HARD = {
	'dedupe concurrent GET': {
		fch: 'const r = new Fch(u, { dedupe: true }); await Promise.all([r.json(), r.json()])',
		native: `${HAND_WRITTEN}; await Promise.all([dedupe(u, () => fetch(u)), dedupe(u, () => fetch(u))])`,
		ofetch: `${HAND_WRITTEN}; await Promise.all([dedupe(u, () => ofetch(u)), dedupe(u, () => ofetch(u))])`,
		ky: `${HAND_WRITTEN}; await Promise.all([dedupe(u, () => ky(u)), dedupe(u, () => ky(u))])`,
		axios: `${HAND_WRITTEN}; await Promise.all([dedupe(u, () => axios.get(u)), dedupe(u, () => axios.get(u))])`,
	},
	'retry with backoff': {
		fch: 'await new Fch(u, { retries: 3, retryDelay: 500, timeout: 5000 }).json()',
		ofetch: 'await ofetch(u, { retries: 3, retryDelay: 500, timeout: 5000 })',
		ky: 'await ky(u, { retries: 3, timeout: 5000 }).json()',
		// axios has no built-in retry: an addon is the real answer.
		axios: 'await axios.get(u, { timeout: 5000, retry: { retries: 3 } }) /* axios-retry addon */',
		native: `${HAND_RETRY}; await withRetry(u)`,
	},
	'abort + reuse builder': {
		fch: 'const r = new Fch(u, { retries: 5 }); const p = r.send(); r.abort(); await r.send()',
		native:
			'const c = new AbortController(); const p = fetch(u, { signal: c.signal }); c.abort(); await p.catch(() => {}); await fetch(u)',
		// No builder to reuse: each call needs a fresh controller.
		ofetch: 'let c = new AbortController(); await ofetch(u, { signal: c.signal }); c.abort(); c = new AbortController(); await ofetch(u, { signal: c.signal })',
		ky: 'let c = new AbortController(); await ky(u, { signal: c.signal }); c.abort(); c = new AbortController(); await ky(u, { signal: c.signal })',
		axios:
			'let c = new AbortController(); await axios.get(u, { signal: c.signal }); c.abort(); c = new AbortController(); await axios.get(u, { signal: c.signal })',
	},
}

const LIBS = ['fch', 'ofetch', 'ky', 'axios', 'native']

/** Token cost per library for one suite. */
function totals(suite) {
	const out = Object.fromEntries(LIBS.map((lib) => [lib, 0]))
	for (const row of Object.values(suite)) {
		for (const lib of LIBS) out[lib] += tokens(row[lib])
	}
	return out
}

function table(title, suite) {
	const sum = totals(suite)
	console.log(`\n## ${title}\n`)
	console.log('task'.padEnd(24) + LIBS.map((l) => l.padStart(9)).join(''))
	for (const [task, row] of Object.entries(suite)) {
		console.log(
			task.padEnd(24) + LIBS.map((l) => String(tokens(row[l])).padStart(9)).join(''),
		)
	}
	console.log('-'.repeat(24 + 9 * LIBS.length))
	console.log('TOTAL'.padEnd(24) + LIBS.map((l) => String(sum[l]).padStart(9)).join(''))
	return sum
}

const simple = table('Simple tasks (one-liners)', SIMPLE)
const hard = table('Tasks needing dedupe / retry / abort helpers', HARD)

console.log('\n## Summary\n')
console.log(`Fch is NOT cheapest on one-liners: ${LIBS.filter((l) => l !== 'fch').map((l) => `${l} ${simple[l]}`).join(', ')} vs fch ${simple.fch}.`)
console.log(`On hard tasks Fch saves: ${LIBS.filter((l) => l !== 'fch').map((l) => `${l} +${hard[l] - hard.fch}`).join(', ')} tokens.`)

// --check: guard the numbers recorded in ROADMAP.md.
if (process.argv.includes('--check')) {
	const roadmap = readFileSync(resolve(import.meta.dirname, '../ROADMAP.md'), 'utf8')
	const problems = []

	const expect = (needle, why) => {
		if (!roadmap.includes(needle)) problems.push(`${why}: ROADMAP.md does not contain "${needle}"`)
	}

	expect(String(simple.fch), 'simple Fch total')
	expect(String(hard.fch), 'hard Fch total')
	expect(String(simple.native), 'simple native total')
	expect(String(hard.native), 'hard native total')

	// The claim must stay hedged: Fch is not the shortest on one-liners.
	if (!/not\*? the cheapest|NOT cheapest|is \*not\*/i.test(roadmap)) {
		problems.push('ROADMAP.md must state that Fch is not the cheapest on one-liners')
	}

	if (problems.length) {
		console.error('\nROADMAP token numbers are stale:\n  ' + problems.join('\n  '))
		process.exit(1)
	}
	console.log('\nROADMAP.md token table is current.')
}
