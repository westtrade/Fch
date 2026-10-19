// Shared browser launcher for the site check scripts.
//
// Resolves Playwright wherever it happens to be installed instead of hardcoding
// one machine's path: a local install, a global one, or the path in
// PLAYWRIGHT_MODULE. The browser binary likewise comes from
// PLAYWRIGHT_CHROME, else a normal Playwright download, else system Chrome.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

function loadPlaywright() {
	const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)

	for (const id of candidates) {
		try {
			return require(id)
		} catch {
			// try the next one
		}
	}

	throw new Error(
		'Playwright not found. Install it (npm i -D playwright) or set ' +
			'PLAYWRIGHT_MODULE to a playwright-core entry point.',
	)
}

const CHROME_CANDIDATES = [
	process.env.PLAYWRIGHT_CHROME,
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].filter(Boolean)

export async function launch() {
	const { chromium } = loadPlaywright()
	const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))

	return chromium.launch({
		// Playwright's own download is used when no system browser is present.
		...(executablePath ? { executablePath } : {}),
		args: ['--no-sandbox'],
	})
}
