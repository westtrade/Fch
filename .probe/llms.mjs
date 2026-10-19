// Executes every code sample from llms.txt, in order, against a stub fetch.
import { Fch, fch as factory } from '../dist/Fch.mjs';
import fch from '../dist/Fch.literal.mjs';
import { nanostores } from '../dist/plugins/nanostores.mjs';
import { validate } from '../dist/plugins/validate.mjs';
import { compat } from '../dist/plugins/compat.mjs';

const log = (k, v) => console.log(k.padEnd(44), v);
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  const body = init.body ? JSON.parse(String(init.body)) : {};
  return new Response(JSON.stringify({ id: 1, name: 'Ann', ...body }), { headers: { 'Content-Type': 'application/json' } });
};

// --- three spellings
const [u1] = await new Fch('https://api.test/u/1').json();
log('class', JSON.stringify(u1));
const api = factory.create({ baseUrl: 'https://api.test', timeout: 5000 });
log('client', JSON.stringify((await api.get('/u/1'))[0]));
log('literal', JSON.stringify((await fch.get`https://api.test/u/1`)[0]));

// --- common tasks
log('post object', JSON.stringify((await fch.post({ name: 'Ann' })`https://api.test/users`)[0]));
const req = new Fch('https://api.test/search');
req.searchParams.set('q', 'Tom & Jerry');
log('query encoded', req.toString());
await req.json();
log('retries/timeout opts', typeof new Fch('https://a.test/x', { retries: 3, retryDelay: 500, maxRetryDelay: 10000, timeout: 5000, retryOn: () => false }).retries);
const httpError = (res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res; };
log('after(httpError) ok path', JSON.stringify((await api.request('/users/1').after(httpError).json())[0]));
const r = new Fch('https://a.test/c', { retries: 5 }); const pend = r.send(); r.abort();
await pend.catch(() => {}); log('abort', 'rejected, builder reusable: ' + !r.aborted);
const shared = new Fch('https://a.test/d', { dedupe: true });
const before = calls;
await Promise.all([shared.json(), shared.json()]);
log('dedupe wire calls', calls - before);
log('per-call options', (await api.request('/houses/1', { retries: 5 }).json())[0] !== undefined);
log('idempotency write', (await new Fch('https://a.test/w', { method: 'POST', dedupe: true, dedupeKey: () => crypto.randomUUID() }).setJsonBody({ a: 1 }).send()).status);

// --- plugins
const sreq = new Fch('https://a.test/s').use(nanostores());
log('nanostores store keys', Object.keys(sreq.get()).join(','));
await sreq.json();
log('store data', JSON.stringify(sreq.get().data));
log('validate ok', (await new Fch('https://a.test/v').use(validate({ schema: { type:'object', required:['id'], properties:{ id:{type:'integer'} } } })).json())[0] !== undefined);
log('compat alias', new Fch('https://a.test/c').use(compat()).setRetryTimeout(500).retryDelay);

// --- timers
const t = new Fch('https://a.test/t', { delayMs: 500, timeoutMs: 8000 });
log('timer getters', `${t.delayed}/${t.timedOut}/${t.timer}`);
