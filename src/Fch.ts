/**
 * Logger interface for handling log messages.
 *
 * @public
 * @typedef {Object} Logger
 */
export interface Logger {
	/** Logs informational messages. */
	info(...args: unknown[]): void;
	/** Logs warning messages. */
	warn(...args: unknown[]): void;
	/** Logs error messages. */
	error(...args: unknown[]): void;
	/** Logs debug messages (only emitted when `debug: true`). */
	debug?(...args: unknown[]): void;
}

/**
 * Supported HTTP methods.
 * @public
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Configuration options for fetch requests, extending standard RequestInit.
 *
 * @public
 * @typedef {Object} FetchRequestOptions
 * @extends RequestInit
 *
 * @property {number}          [retries=0]         - Number of retry attempts after the initial request.
 *                                                   `retries=1` means 1 initial + 1 retry = 2 total attempts.
 * @property {number}          [retryDelay=1000]   - Base delay (ms) between retry attempts.
 *                                                   Used with exponential backoff (`base * 2^(attempt-1)`).
 * @property {number}          [maxRetryDelay=30000] - Cap for exponential retry delay (ms).
 * @property {number}          [timeout=30000]     - Request timeout in milliseconds.
 * @property {AbortSignal}     [signal]            - External AbortSignal. Combined with internal
 *                                                   timeout and master abort controller.
 * @property {Logger}          [logger]            - Logger implementation for request logging.
 * @property {boolean}         [debug=false]       - Enable debug-level logging.
 * @property {boolean}         [dedupe=false]      - Enable instance-level in-flight deduplication
 *                                                   for concurrent identical requests.
 * @property {string|Function} [dedupeKey]         - Explicit idempotency key for mutating methods
 *                                                   (POST/PUT/PATCH/DELETE). Sent as `Idempotency-Key` header.
 *                                                   Can be a static string or a factory `() => string`.
 * @property {Function}        [retryOn]           - Unified retry predicate called for both HTTP
 *                                                   responses and network/timeout errors.
 */
export interface FetchRequestOptions extends RequestInit {
	retries?: number;
	retryDelay?: number;
	/** @deprecated Use `retryDelay`. */
	retryTimeout?: number;
	maxRetryDelay?: number;
	timeout?: number;
	/** @deprecated Use `signal` instead. */
	abortController?: AbortController;
	logger?: Logger;
	debug?: boolean;
	dedupe?: boolean;
	dedupeKey?: string | (() => string);
	/** @deprecated Alias for `dedupeKey`. */
	idempotencyKey?: string | (() => string);
	retryOn?: (
		response: Response | null,
		error: unknown | null,
		attempt: number
	) => boolean;
}

const SAFE_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS']);
const MUTATING_METHODS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Upper-case and validate an HTTP method. Shared by the constructor and
 * {@link Fch.setMethod} so `{ method: 'FOO' }` fails exactly like `setMethod('FOO')`.
 */
function normalizeMethod(method: string): HttpMethod {
	const normalized = method.toUpperCase();
	if (!(HTTP_METHODS as readonly string[]).includes(normalized)) {
		throw new TypeError(`Unsupported HTTP method: ${method}`);
	}
	return normalized as HttpMethod;
}

/**
 * A `<form>` element, a submit event, or anything else with a `target`/`currentTarget`
 * that points at a form. Typed structurally (`nodeType === 1`, `tagName === 'FORM'`)
 * so the library stays usable in Node, where `HTMLFormElement`/`SubmitEvent` do not exist.
 */
export interface FormLike {
	tagName?: string;
	nodeType?: number;
	method?: string;
	action?: string;
	enctype?: string;
	target?: unknown;
	currentTarget?: unknown;
	submitter?: unknown;
}

/**
 * A request body. In addition to everything `fetch()` accepts, `Fch` understands a
 * `<form>` element and a submit `Event` and converts them to `FormData` for you.
 */
export type FchBody = BodyInit | FormLike | null;

/**
 * A shortcut body: anything {@link FchBody} accepts, plus a plain object/array,
 * which is JSON-encoded with `Content-Type: application/json` for you.
 */
export type FchBodyInput =
	| BodyInit
	| FormLike
	| Record<string, unknown>
	| unknown[]
	| null;

/** Any DOM element (a form, but also the button that submitted it). */
const isElement = (value: unknown): value is FormLike =>
	!!value && typeof value === 'object' && (value as FormLike).nodeType === 1;

const isFormElement = (value: unknown): value is FormLike =>
	isElement(value) && String((value as FormLike).tagName).toUpperCase() === 'FORM';

/**
 * Resolve an `Event` (`submit`), a `<form>`, or a `FormData` into a `FormData`.
 * Returns `null` when the value is not form-like, so callers can fall back to
 * passing it to `fetch()` untouched.
 *
 * Handles the four spellings of the same intent:
 * `new FormData(form)` · `event` · `event.target` · `form`.
 */
export function toFormData(value: unknown): FormData | null {
	if (typeof FormData === 'undefined' || value == null) return null;
	if (value instanceof FormData) return value;

	const form = resolveForm(value);
	return form ? buildFormData(form, resolveSubmitter(value)) : null;
}

/** Extract the `<form>` from a form element or from an event that targets one. */
export function resolveForm(value: unknown): FormLike | null {
	if (isFormElement(value)) return value;

	if (value && typeof value === 'object') {
		const event = value as FormLike;
		// `target` is the form during a submit event; `currentTarget` covers
		// listeners bound to the form, and survives `target` being retargeted.
		for (const candidate of [event.target, event.currentTarget]) {
			if (isFormElement(candidate)) return candidate;
		}
	}
	return null;
}

/** The button that triggered a submit, so its name/value is included. */
function resolveSubmitter(value: unknown): FormLike | null {
	if (value && typeof value === 'object') {
		// A submitter is a submit button (or `<input type=submit>`), not a form.
		const submitter = (value as FormLike).submitter;
		if (isElement(submitter) && !isFormElement(submitter)) return submitter;
	}
	return null;
}

function buildFormData(form: FormLike, submitter: FormLike | null): FormData {
	try {
		// The native constructor knows about disabled fields, unchecked boxes,
		// multi-selects and file inputs — never reimplement it.
		return new FormData(
			form as unknown as HTMLFormElement,
			submitter as unknown as HTMLElement
		);
	} catch {
		try {
			// Engines that reject the second argument still accept the form alone.
			return new FormData(form as unknown as HTMLFormElement);
		} catch {
			// The object merely looked like a form (right `nodeType`/`tagName`) but is
			// not a real element of this realm — do not silently send a wrong body.
			throw new TypeError(
				'Could not read the form: the value is not a real <form> element of this ' +
					'environment. In Node, parse the HTML with a DOM (e.g. jsdom) and pass the ' +
					'element from that same window.'
			);
		}
	}
}

/** Base64-encode text as UTF-8 — `btoa` alone rejects non-Latin-1 characters. */
function base64Encode(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** True for values `fetch()` can serialise itself, so we pass them straight through. */
function isNativeBody(value: unknown): boolean {
	if (typeof value === 'string') return true;
	if (typeof FormData !== 'undefined' && value instanceof FormData) return true;
	if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return true;
	if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
	if (typeof ArrayBuffer !== 'undefined') {
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
	}
	if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return true;
	return false;
}


/**
 * URL and `fetch` combined into a single object.
 *
 * The class **extends the native `URL`**, so an instance is a real, mutable URL
 * (`pathname`, `host`, `searchParams`, `hash`, `toString()` all work normally) and
 * at the same time the request that targets it. There is no separate
 * "build a URL, then hand it to a client" step — the same object is both.
 *
 * Supports retries, timeouts, interceptors, logging, deduplication, and various
 * data formats.
 *
 * **Core contract:** Every call to `await`, `.then()`, `.catch()`, `.finally()`, `.json()`, etc.
 * initiates a NEW independent HTTP request. The instance is a reusable request *builder*, not a
 * cached promise.
 *
 * @class Fch
 * @extends URL
 *
 * @example
 * const req = new Fch('https://api.example.com/v1/search', { timeout: 3000 });
 *
 * // It is a URL — the standard API drives the request target.
 * req.pathname = '/v2/search';
 * req.searchParams.set('q', 'hello');
 *
 * // It is also the request.
 * const [users, response] = await req.json<User[]>();
 */
export class Fch extends URL {
	// ============================================================
	// Public state (kept for backward compatibility with original API)
	// ============================================================

	/**
	 * FormData payload for the request.
	 * @type {FormData|null}
	 */
	formData: FormData | null = null;

	/**
	 * Request headers instance.
	 * @type {Headers}
	 */
	headers: Headers;

	/**
	 * Internal fetch options passed to the underlying `fetch()` call.
	 * @type {RequestInit}
	 */
	fetchOptions: RequestInit;

	/**
	 * External AbortController.
	 * @deprecated Prefer using `signal` option and `abort()` method.
	 * @type {AbortController}
	 */
	controller: AbortController;

	/** Number of retry attempts (1-based meaning: retries=1 → 2 total attempts). */
	retries: number;
	/** Base delay between retries (ms). */
	retryDelay: number;
	/** Request timeout (ms). */
	timeout: number;

	// ============================================================
	// Private state
	// ============================================================

	private logger: Logger;
	private debug = false;
	private dedupe = false;
	private dedupeKey: string | (() => string) | null = null;
	private maxRetryDelay = 30000;

	/** User-supplied external signal. Never refreshed (unlike our own controller). */
	private userSignal?: AbortSignal;

	/** The caller's signal if given, else our own controller's (which `abort()` refreshes). */
	private get externalSignal(): AbortSignal {
		return this.userSignal ?? this.controller.signal;
	}

	/** True when `abortController` was not supplied and we created the controller. */
	private ownsController = true;

	/**
	 * True when a request on this instance timed out. Reset when the next
	 * request starts — NOT when a concurrent request happens to succeed, which
	 * would erase the timeout of the request that is still in flight.
	 */
	private timedOut = false;

	private retryOn?: (
		response: Response | null,
		error: unknown | null,
		attempt: number
	) => boolean;

	private requestInterceptors: ((request: Fch) => void | Promise<void>)[] = [];
	private responseInterceptors: ((
		response: Response
	) => Response | Promise<Response>)[] = [];

	/** Instance-level in-flight cache (isolated per instance). */
	private inFlight = new Map<string, Promise<Response>>();

	/**
	 * Request started eagerly by {@link Fch.start} or by a shortcut, so that
	 * fire-and-forget usage still sends immediately. `makeRequest` reuses it.
	 */
	private eagerRequest: Promise<Response> | null = null;

	/** Master controller: aborts in-flight requests AND pending retry delays. */
	private masterController = new AbortController();

	// ============================================================
	// Constructor
	// ============================================================

	/**
	 * Creates a new Fch instance.
	 *
	 * @constructor
	 * @param {string|URL} url - Base URL for the request.
	 * @param {FetchRequestOptions} [options] - Configuration options.
	 * @throws {TypeError} If the URL is invalid.
	 *
	 * @example
	 * const api = new Fch('https://api.example.com', {
	 *   timeout: 5000,
	 *   retries: 2,
	 *   retryDelay: 1000,
	 *   debug: true,
	 * });
	 */
	constructor(
		url: string | URL,
		{
			retries = 0,
			timeout = 30000,
			retryDelay,
			retryTimeout,
			maxRetryDelay = 30000,
			abortController,
			signal,
			logger,
			debug = false,
			dedupe = false,
			dedupeKey,
			idempotencyKey,
			retryOn,
			headers,
			...options
		}: FetchRequestOptions = {}
	) {
		// A relative path cannot be represented by `URL`; fail with a clear message
		// instead of a bare "Invalid URL" from the parent constructor.
		if (typeof url === 'string') assertAbsolute(url);

		super(url.toString());

		this.headers = new Headers(headers);
		this.fetchOptions = {
			...options,
			// Normalize here so `{ method: 'post' }` behaves exactly like
			// `setMethod('POST')` (idempotency/dedupe checks are case-sensitive) —
			// including rejecting an unsupported method instead of sending it.
			method: normalizeMethod(options.method ? String(options.method) : 'GET'),
		};

		this.retries = retries;
		this.retryDelay = retryDelay ?? retryTimeout ?? 1000;
		this.maxRetryDelay = maxRetryDelay;
		// Same rule as setTimeout(): a negative or NaN timeout is a mistake, not
		// a way to disable the timeout (use 0 for that).
		if (!Number.isFinite(timeout) || timeout < 0) {
			throw new Error(`Invalid timeout: ${timeout}`);
		}
		this.timeout = timeout;
		this.controller = abortController || new AbortController();
		this.ownsController = !abortController;
		this.userSignal = signal ?? undefined;

		this.logger = this.adaptLogger(logger);
		this.debug = debug;
		this.dedupe = dedupe;
		this.dedupeKey = dedupeKey ?? idempotencyKey ?? null;
		this.retryOn = retryOn;
	}

	/**
	 * Validate a caller-supplied logger, falling back to the default one when the
	 * object does not implement the full interface. Without this check an invalid
	 * logger (e.g. `{ info: 'nope' }`) is accepted and then silently swallows
	 * every log line.
	 */
	private adaptLogger(logger?: Logger): Logger {
		if (!logger) return this.createDefaultLogger();

		const hasRequiredMethods =
			typeof logger.info === 'function' &&
			typeof logger.warn === 'function' &&
			typeof logger.error === 'function';

		return hasRequiredMethods ? logger : this.createDefaultLogger();
	}

	private createDefaultLogger(): Logger {
		return {
			info: console.log.bind(console, '[INFO]'),
			warn: console.warn.bind(console, '[WARN]'),
			error: console.error.bind(console, '[ERROR]'),
			debug: console.debug.bind(console, '[DEBUG]'),
		};
	}

	// ============================================================
	// Logging
	// ============================================================

	/**
	 * Whether the request was aborted — either explicitly via {@link Fch.abort}
	 * or because the per-attempt timeout fired.
	 *
	 * Timeout state is cleared when the next request starts, so a concurrent
	 * request finishing cannot mask a timeout that already happened.
	 * @returns {boolean}
	 */
	get aborted(): boolean {
		return this.masterController.signal.aborted || this.timedOut;
	}

	/**
	 * Enable debug-level logging.
	 * @returns {Fch} Current instance for chaining.
	 * @example
	 * api.enableLogging();
	 */
	enableLogging(): this {
		this.debug = true;
		return this;
	}

	/**
	 * Disable debug-level logging.
	 * @returns {Fch} Current instance for chaining.
	 */
	disableLogging(): this {
		this.debug = false;
		return this;
	}

	/**
	 * Replace the logger implementation. The value is validated the same way as
	 * the constructor option, so an incomplete logger cannot silently swallow logs.
	 * @param {Logger} logger - New logger.
	 * @returns {Fch} Current instance for chaining.
	 */
	setLogger(logger: Logger): this {
		this.logger = this.adaptLogger(logger);
		return this;
	}

	/**
	 * Returns a logger wrapper. `error` and `warn` always emit; `info` and `debug`
	 * are suppressed unless debug logging is enabled.
	 * @returns {Logger} Wrapped logger.
	 */
	getLogger(): Logger {
		// Thin wrappers over the private {@link Fch.log}; the debug-aware
		// gating lives in exactly one place.
		return {
			info: (...args) => this.log('info', ...args),
			warn: (...args) => this.log('warn', ...args),
			error: (...args) => this.log('error', ...args),
			debug: (...args) => this.log('debug', ...args),
		};
	}

	/**
	 * `error`/`warn` are always emitted — diagnostics must not depend on the
	 * debug flag. `info`/`debug` are chatty and stay opt-in.
	 */
	private shouldLog(level: keyof Logger): boolean {
		if (level === 'error' || level === 'warn') return true;
		return this.debug;
	}

	private log(level: keyof Logger, ...args: unknown[]) {
		if (!this.shouldLog(level)) return;
		const fn = this.logger[level];
		if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
	}

	// ============================================================
	// URL / search params
	// ============================================================

	/**
	 * Replace the search params for the request: the query string is cleared
	 * first, so `?page=1` + `setSearchParams({ page: 2 })` is `?page=2` and not
	 * `?page=2&page=1`. Use {@link Fch.appendSearchParams} to add instead.
	 * @param {Record<string, string|number|boolean>} params - Key/value pairs.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setSearchParams({ key: 'value', page: 1 });
	 */
	setSearchParams(params: Record<string, string | number | boolean>): this {
		this.search = '';
		for (const [key, value] of Object.entries(params)) {
			this.searchParams.set(key, String(value));
		}
		return this;
	}

	/**
	 * Append search params. Arrays produce multiple entries for the same key.
	 * @param {Record<string, string|string[]>} params - Key/value pairs.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.appendSearchParams({ tag: ['a', 'b'], q: 'hello' });
	 * // -> ?tag=a&tag=b&q=hello
	 */
	appendSearchParams(params: Record<string, string | string[]>): this {
		for (const [key, value] of Object.entries(params)) {
			if (Array.isArray(value)) {
				value.forEach((v) => this.searchParams.append(key, v));
			} else {
				this.searchParams.append(key, value);
			}
		}
		return this;
	}

	// ============================================================
	// Body helpers
	// ============================================================

	/**
	 * Append data to FormData. Creates FormData on first call.
	 * Switches method to POST unless already PUT.
	 * Content-Type (multipart/form-data with boundary) is set automatically by the browser.
	 *
	 * @param {string} key - Key.
	 * @param {string|Blob} value - Value.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.appendToFormData('file', fileBlob);
	 */
	appendToFormData(key: string, value: string | Blob): this {
		if (!this.formData) this.formData = new FormData();
		this.formData.append(key, value);
		this.fetchOptions.body = this.formData;
		this.headers.delete('Content-Type');
		if (this.fetchOptions.method !== 'PUT') this.fetchOptions.method = 'POST';
		return this;
	}

	/**
	 * Set the form body from `FormData`, a `<form>` element, or a submit `Event`.
	 *
	 * All four spellings of the same intent work:
	 *
	 * ```ts
	 * form.onsubmit = (e) => api.setFormData(new FormData(e.target as HTMLFormElement));
	 * form.onsubmit = (e) => api.setFormData(e);          // the event itself
	 * form.onsubmit = (e) => api.setFormData(e.target);   // the <form>
	 * form.onsubmit = (e) => api.setFormData(form);       // the element
	 * ```
	 *
	 * The HTTP method is taken from the form's `method` attribute when it is not the
	 * default `GET` (so a `<form method="post">` posts, and `method="get"`/absent
	 * keeps the normal form semantics). `Content-Type` is cleared so the runtime can
	 * set the correct `multipart/form-data; boundary=…`.
	 *
	 * @param {FormData|HTMLFormElement|Event} formData - Form data, a form, or a submit event.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * form.onsubmit = (e) => { e.preventDefault(); api.setFormData(e).send(); };
	 */
	setFormData(formData: FormData | FormLike): this {
		const data = toFormData(formData);
		if (!data) {
			throw new TypeError(
				'setFormData() expects FormData, a <form> element, or a submit event.'
			);
		}

		const form = resolveForm(formData);
		const declared = form?.method?.toLowerCase();

		// Adopt the form's own method when it declares something other than GET.
		if (declared && declared !== 'get') this.setMethod(declared);

		// HTML semantics: a GET form encodes its fields into the query string and
		// sends no body. This also keeps `api.get(url, form)` honest.
		if (this.method === 'GET' || this.method === 'HEAD') {
			if (form) return this.appendFormToQuery(data);
			// Raw FormData with no form element and no method: an explicit body
			// implies a write, so default to POST.
			this.fetchOptions.method = 'POST';
		}

		this.formData = data;
		this.fetchOptions.body = data;
		// Let fetch() generate the multipart boundary itself.
		this.headers.delete('Content-Type');
		return this;
	}

	/**
	 * Serialise form fields into the URL query string, as a browser GET submit does.
	 * File inputs contribute their filename, since a query string cannot carry bytes.
	 * @param {FormData} data - Fields to append.
	 * @returns {Fch} Current instance for chaining.
	 */
	appendFormToQuery(data: FormData): this {
		for (const [key, value] of data.entries()) {
			this.searchParams.append(key, typeof value === 'string' ? value : value.name);
		}
		return this;
	}

	/**
	 * Set raw request body. Clears any existing FormData.
	 *
	 * Also accepts a `<form>` element or a submit `Event`, which are converted to
	 * `FormData` (see {@link Fch.setFormData}).
	 *
	 * @param {FchBody} body - Request body.
	 * @param {string} [contentType] - Optional Content-Type header.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setBody('{"key":"value"}', 'application/json');
	 * form.onsubmit = (e) => api.setBody(e).send();
	 */
	setBody(body: FchBody, contentType?: string): this {
		// A form/event is not a valid fetch body — convert it, and take the method
		// from the form when it declares one.
		const asFormData = toFormData(body);
		if (asFormData) {
			return this.setFormData(asFormData);
		}

		this.formData = null;
		this.fetchOptions.body = body as BodyInit | null;

		if (contentType) {
			this.headers.set('Content-Type', contentType);
		} else {
			// A native body either carries its own content type (Blob) or must
			// not have one set by us (FormData/URLSearchParams/streams) — either
			// way we do not impose a header.
			this.headers.delete('Content-Type');
		}
		return this;
	}

	/**
	 * Set `application/x-www-form-urlencoded` body. Arrays produce multiple entries.
	 *
	 * @param {Record<string, string|number|boolean|Array<string|number|boolean>>} data - Data to encode.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setFormUrlEncodedBody({ username: 'user', tags: ['a', 'b'] });
	 */
	setFormUrlEncodedBody(
		data: Record<string, string | number | boolean | Array<string | number | boolean>>
	): this {
		const urlSearchParams = new URLSearchParams();
		for (const [key, value] of Object.entries(data)) {
			if (Array.isArray(value)) {
				for (const v of value) urlSearchParams.append(key, String(v));
			} else {
				urlSearchParams.append(key, String(value));
			}
		}
		return this.setBody(urlSearchParams, 'application/x-www-form-urlencoded');
	}

	/**
	 * Set JSON request body with `Content-Type: application/json`.
	 *
	 * @template T
	 * @param {T} json - JSON-serializable object.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setJsonBody({ name: 'Alice', age: 30 });
	 */
	setJsonBody<T>(json: T): this {
		return this.setBody(JSON.stringify(json), 'application/json');
	}

	// ============================================================
	// Headers
	// ============================================================

	/**
	 * Set multiple headers. Merges with existing headers (does NOT replace).
	 *
	 * @param {Record<string, string>} headers - Key/value pairs.
	 * @returns {Fch} Current instance for chaining.
	 */
	setHeaders(headers: Record<string, string>): this {
		for (const [key, value] of Object.entries(headers)) {
			this.headers.set(key, value);
		}
		return this;
	}

	/**
	 * Set a single header.
	 * @param {string} name - Header name.
	 * @param {string} value - Header value.
	 * @returns {Fch} Current instance for chaining.
	 */
	setHeader(name: string, value: string): this {
		this.headers.set(name, value);
		return this;
	}

	/**
	 * Get header value by name.
	 * @param {string} name - Header name.
	 * @returns {string|null} Header value or null if absent.
	 */
	getHeader(name: string): string | null {
		return this.headers.get(name);
	}

	/**
	 * Delete a header by name.
	 * @param {string} name - Header name.
	 * @returns {Fch} Current instance for chaining.
	 */
	deleteHeader(name: string): this {
		this.headers.delete(name);
		return this;
	}

	/**
	 * Set Authorization header with a Bearer token.
	 * @param {string} token - Bearer token.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setAuthToken('my-jwt-token');
	 */
	setAuthToken(token: string): this {
		this.headers.set('Authorization', `Bearer ${token}`);
		return this;
	}

	/**
	 * Set Authorization header with Basic auth (base64).
	 * @param {string} username - Username.
	 * @param {string} password - Password.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setBasicAuth('user', 'pass');
	 */
	setBasicAuth(username: string, password: string): this {
		this.headers.set('Authorization', `Basic ${base64Encode(`${username}:${password}`)}`);
		return this;
	}

	/**
	 * Set explicit dedupe/idempotency key for mutating methods.
	 * - Sent as `Idempotency-Key` header on POST/PUT/PATCH/DELETE.
	 * - Used as dedupe identity when `dedupe: true`.
	 *
	 * Accepts a static string or a factory function (called per request).
	 *
	 * @param {string|Function} key - Key or factory.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setDedupeKey(() => crypto.randomUUID());
	 */
	setDedupeKey(key: string | (() => string)): this {
		this.dedupeKey = key;
		return this;
	}

	/** @deprecated Use `setDedupeKey`. */
	setIdempotencyKey(key: string | (() => string)): this {
		return this.setDedupeKey(key);
	}

	// ============================================================
	// Fetch options
	// ============================================================

	/**
	 * Set HTTP method.
	 * @param {string} method - HTTP method (case-insensitive).
	 * @returns {Fch} Current instance for chaining.
	 * @throws {TypeError} If method is not a recognized HTTP method.
	 *
	 * @example
	 * api.setMethod('POST');
	 */
	setMethod(method: string): this {
		this.fetchOptions.method = normalizeMethod(method);
		return this;
	}

	get method(): string {
		return (this.fetchOptions.method as string) || 'GET';
	}

	set method(value: string) {
		this.fetchOptions.method = normalizeMethod(value);
	}

	/**
	 * Set CORS mode.
	 * @param {RequestMode} mode - CORS mode (`cors`, `no-cors`, `same-origin`, `navigate`).
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setCORS('cors');
	 */
	setCORS(mode: RequestMode): this {
		this.fetchOptions.mode = mode;
		return this;
	}

	/**
	 * Disable cache (sets `cache: 'no-store'`).
	 * @returns {Fch} Current instance for chaining.
	 */
	disableCache(): this {
		this.fetchOptions.cache = 'no-store';
		return this;
	}

	/**
	 * Merge `RequestInit` options into the current configuration.
	 *
	 * Headers are special-cased: requests are sent with `this.headers`, so a
	 * `headers` entry would otherwise be silently dropped. They are merged into
	 * `this.headers` (consistent with {@link Fch.setHeaders}) instead.
	 *
	 * @param {RequestInit} options - Fetch options.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setFetchOptions({ credentials: 'include' });
	 * api.setFetchOptions({ headers: { 'X-Trace-Id': 'abc' } });
	 */
	setFetchOptions(options: RequestInit): this {
		const { headers, ...rest } = options;
		this.fetchOptions = { ...this.fetchOptions, ...rest };

		// `method` gets the same validation as `setMethod`/the constructor, so
		// this door cannot smuggle in a method those two would reject.
		if (rest.method !== undefined) {
			this.fetchOptions.method = normalizeMethod(String(rest.method));
		}

		if (headers !== undefined) {
			new Headers(headers).forEach((value, key) => {
				this.headers.set(key, value);
			});
		}

		return this;
	}

	/**
	 * Set request timeout (ms).
	 * @param {number} timeout - Timeout in milliseconds (>= 0).
	 * @returns {Fch} Current instance for chaining.
	 * @throws {Error} If value is invalid.
	 */
	setTimeout(timeout: number): this {
		if (!Number.isFinite(timeout) || timeout < 0) throw new Error(`Invalid timeout: ${timeout}`);
		this.timeout = timeout;
		return this;
	}

	/**
	 * Set number of retries (after the initial attempt).
	 *
	 * `retries=1` → 2 total attempts. `retries=3` → 4 total attempts.
	 *
	 * @param {number} retries - Number of retries (>= 0).
	 * @returns {Fch} Current instance for chaining.
	 * @throws {Error} If value is invalid.
	 */
	setRetries(retries: number): this {
		if (!Number.isInteger(retries) || retries < 0) throw new Error(`Invalid retries: ${retries}`);
		this.retries = retries;
		return this;
	}

	/**
	 * Set base delay between retries (ms). Used with exponential backoff.
	 * @param {number} ms - Base delay (>= 0).
	 * @returns {Fch} Current instance for chaining.
	 */
	setRetryDelay(ms: number): this {
		if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid retryDelay: ${ms}`);
		this.retryDelay = ms;
		return this;
	}

	/** @deprecated Use `setRetryDelay`. */
	setRetryTimeout(ms: number): this {
		return this.setRetryDelay(ms);
	}

	/**
	 * Set cap for exponential retry delay (ms).
	 * @param {number} ms - Maximum delay.
	 * @returns {Fch} Current instance for chaining.
	 */
	setMaxRetryDelay(ms: number): this {
		if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid maxRetryDelay: ${ms}`);
		this.maxRetryDelay = ms;
		return this;
	}

	/**
	 * Unified retry predicate. Called for both HTTP responses and network/timeout errors.
	 *
	 * - For HTTP errors: `response` is set, `error` is null.
	 * - For network/timeout errors: `response` is null, `error` is set.
	 * - `attempt` is 1-based (1, 2, 3, ...).
	 *
	 * Return `true` to retry, `false` to stop.
	 *
	 * @param {(response: Response|null, error: unknown|null, attempt: number) => boolean} fn - Predicate.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setRetryOn((response, error, attempt) => {
	 *   if (response) return response.status === 429 || response.status >= 500;
	 *   if (error instanceof DOMException && error.name === 'AbortError') return false;
	 *   return attempt < 3;
	 * });
	 */
	setRetryOn(fn: (response: Response | null, error: unknown | null, attempt: number) => boolean): this {
		this.retryOn = fn;
		return this;
	}

	// ============================================================
	// Interceptors
	// ============================================================

	/**
	 * Register a **request** hook, called before every attempt (including retries)
	 * so it can refresh credentials, request ids, or any other per-attempt state.
	 * May mutate the Fch instance (headers, URL, body).
	 *
	 * Several hooks may be registered; they run in registration order.
	 *
	 * @param {(request: Fch) => void|Promise<void>} interceptor - Hook function.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.before((req) => {
	 *   req.setHeader('X-Request-Id', crypto.randomUUID());
	 * });
	 */
	before(interceptor: (request: Fch) => void | Promise<void>): this {
		this.requestInterceptors.push(interceptor);
		return this;
	}

	/**
	 * Register a **response** hook, applied to the response before it is returned.
	 * Must NOT consume the response body (use `response.clone()` if needed).
	 *
	 * Several hooks may be registered; they run in registration order, each
	 * receiving the previous hook's result.
	 *
	 * @param {(response: Response) => Response|Promise<Response>} interceptor - Hook.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.after(async (res) => {
	 *   if (res.status === 401) throw new Error('Unauthorized');
	 *   return res;
	 * });
	 */
	after(interceptor: (response: Response) => Response | Promise<Response>): this {
		this.responseInterceptors.push(interceptor);
		return this;
	}

	/**
	 * @deprecated Use {@link Fch.before} instead.
	 * @param {(request: Fch) => void|Promise<void>} interceptor - Hook function.
	 * @returns {Fch} Current instance for chaining.
	 */
	addRequestInterceptor(interceptor: (request: Fch) => void | Promise<void>): this {
		return this.before(interceptor);
	}

	/**
	 * @deprecated Use {@link Fch.after} instead.
	 * @param {(response: Response) => Response|Promise<Response>} interceptor - Hook.
	 * @returns {Fch} Current instance for chaining.
	 */
	addResponseInterceptor(
		interceptor: (response: Response) => Response | Promise<Response>
	): this {
		return this.after(interceptor);
	}

	// ============================================================
	// Request execution
	// ============================================================

	/**
	 * Execute the configured request with retry logic.
	 *
	 * Each call initiates a NEW independent request. Configuration is snapshotted at call time,
	 * so subsequent mutations to the Fch instance do NOT affect in-flight requests.
	 *
	 * Uses this instance's `retries` and `retryDelay`; change them with
	 * {@link Fch.setRetries}/{@link Fch.setRetryDelay}. (The old positional
	 * overrides were unreachable once `start()` had memoised a request.)
	 *
	 * @returns {Promise<Response>} Fetch response.
	 * @throws {Error} When request fails after all retries.
	 * @throws {TypeError} When `retries > 0` and body is a ReadableStream.
	 */
	async makeRequest(): Promise<Response> {
		// A request started by `start()` (or a shortcut) is reused, so `await req`,
		// `req.json()`, `req.send()` etc. all observe the SAME request instead of
		// firing a new one.
		const eager = this.eagerRequest;
		// Each caller gets its own clone: a Response body can be read once, so
		// two awaits of a memoised request would otherwise race and the second
		// body read would fail with "Body is unusable". The dedupe path below
		// clones for the same reason.
		if (eager) return eager.then((response) => response.clone());

		return this.executeRequest(this.retries, this.retryDelay);
	}

	/**
	 * The retry/timeout/dedupe machinery, starting a genuinely fresh request.
	 * {@link Fch.makeRequest} returns the memoised eager request when there is
	 * one; {@link Fch.poll} calls this directly, because polling must never keep
	 * re-yielding one already-started response.
	 */
	private async executeRequest(
		retries: number,
		retryTimeout: number
	): Promise<Response> {
		// `abort()` cancels in-flight work, but it must not leave the builder
		// permanently unusable: start a fresh abort generation for this request.
		if (this.masterController.signal.aborted) {
			this.masterController = new AbortController();
			if (this.ownsController) this.controller = new AbortController();
		}

		// A new request clears the previous request's timeout state. Only this
		// point resets it — an attempt succeeding must not, or a concurrent
		// success would erase the timeout of a request still in flight.
		this.timedOut = false;

		if (!Number.isInteger(retries) || retries < 0) {
			throw new Error(`Invalid retries: ${retries}`);
		}

		// Capture this request's abort generation. Concurrent requests on the
		// same instance must not observe each other's controllers when one of
		// them is aborted or when `abort()` later swaps in a new generation.
		const master = this.masterController;
		// `signal` may arrive through the constructor OR through
		// `setFetchOptions({ signal })`; both must cancel the request. The
		// fetchOptions one used to be overwritten by the combined signal below,
		// so it silently did nothing.
		const external = this.fetchOptions.signal ?? this.externalSignal;

		const totalAttempts = retries + 1;

		// Dedupe identity is derived from the configuration at CALL time: request
		// interceptors now run per attempt (below), so they cannot be part of an
		// identity that must be known before the first attempt starts.
		const callMethod = (this.fetchOptions.method as string) || 'GET';
		const callUrl = this.toString();

		// Resolve the idempotency/dedupe key once per request. A factory key must
		// yield the same value for the `Idempotency-Key` header and for the dedupe
		// identity, otherwise retries of one logical request would be sent with
		// different keys. Eager on purpose: the value is needed for every attempt.
		const explicitKey: string | null = !this.dedupeKey
			? null
			: typeof this.dedupeKey === 'function'
				? this.dedupeKey()
				: this.dedupeKey;

		const dedupeKey = this.resolveDedupeKey(callMethod, callUrl, explicitKey);

		if (dedupeKey !== null) {
			const existing = this.inFlight.get(dedupeKey);
			if (existing) {
				this.log('debug', 'Deduped concurrent in-flight request:', dedupeKey);
				// Clone as soon as the shared response settles, so a late joiner
				// can never race the first caller's body read.
				return existing.then((response) => response.clone());
			}
		}

		const requestPromise = (async () => {
			let lastError: unknown = null;

			for (let attempt = 1; attempt <= totalAttempts; attempt++) {
				// Request interceptors run before EVERY attempt (including
				// retries) so they can refresh credentials or request ids.
				for (const interceptor of this.requestInterceptors) {
					// `Fch` is thenable, so a concise arrow that returns a chaining
					// call (`(req) => req.setHeader(...)`) would otherwise resolve
					// the instance itself and start another request — recursively,
					// until the heap dies. Only await genuine promises.
					const result: unknown = interceptor(this);
					if (
						result !== (this as unknown) &&
						result &&
						typeof (result as PromiseLike<unknown>).then === 'function'
					) {
						await result;
					}
				}

				// Per-attempt snapshot: isolates this attempt from later mutations
				// (including those made by the next interceptor run).
				const snapshot = {
					method: (this.fetchOptions.method as string) || 'GET',
					url: this.toString(),
					headers: new Headers(this.headers),
					body: this.fetchOptions.body ?? null,
					fetchOptions: { ...this.fetchOptions },
				};

				// Apply Idempotency-Key to snapshot headers (does not mutate this.headers)
				this.applyIdempotencyKey(snapshot, explicitKey);

				// Replayability check — fatal only when a retry could follow.
				if (
					retries > 0 &&
					typeof ReadableStream !== 'undefined' &&
					snapshot.body instanceof ReadableStream
				) {
					throw new TypeError('Cannot retry requests with ReadableStream body. Set retries to 0.');
				}

				this.log('info', `Making request to ${snapshot.url} with method ${snapshot.method}`);

				const timeoutController = new AbortController();
				let timeoutId: ReturnType<typeof setTimeout> | undefined;

				// Per-attempt flag: classifying this attempt's error must not be
				// influenced by a concurrent request on the same instance.
				let attemptTimedOut = false;

				if (this.timeout > 0) {
					timeoutId = setTimeout(() => {
						attemptTimedOut = true;
						this.timedOut = true;
						timeoutController.abort(new DOMException('Request timeout', 'TimeoutError'));
					}, this.timeout);
				}

				const { signal: combinedSignal, disconnect } = this.combineSignals(
					timeoutController.signal,
					master,
					external
				);

				// Set when a response interceptor throws: such a failure is a logic
				// error, not a transport error, and must never be retried — otherwise
				// a throwing `after()` hook would replay a POST on every attempt.
				let interceptorError = false;

				try {
					const response = await fetch(snapshot.url, {
						...snapshot.fetchOptions,
						method: snapshot.method,
						headers: snapshot.headers,
						body: snapshot.body,
						signal: combinedSignal,
					});

					// Note: a successful attempt deliberately does NOT clear
					// `this.timedOut` — a concurrent request may have timed out, and
					// erasing that would misreport it. The next request resets it.
					if (timeoutId) clearTimeout(timeoutId);

					// Retry policy for HTTP responses
					const shouldRetry = this.retryOn
						? this.retryOn(response, null, attempt)
						: false;

					if (shouldRetry && attempt < totalAttempts) {
						this.log('warn', `Retry triggered for status ${response.status}`);
						await this.sleepWithJitter(retryTimeout, attempt, master);
						continue;
					}

					// Response interceptors. One try around the whole chain: a
					// throwing hook is a logic error, not a transport error, and
					// `interceptorError` keeps the retry policy below from replaying
					// a POST on every attempt.
					let processed = response;
					try {
						for (const interceptor of this.responseInterceptors) {
							processed = await interceptor(processed);
						}
					} catch (error) {
						interceptorError = true;
						const errMsg = error instanceof Error ? error.message : String(error);
						this.log('error', `Response interceptor failed:`, errMsg);
						throw error;
					}

					this.log('info', `Received response with status ${response.status}`);
					return processed;
				} catch (error) {
					if (timeoutId) clearTimeout(timeoutId);

					// The response was fine; the hook was not. Propagate as final.
					if (interceptorError) throw error;

					// A deliberate abort (master controller via `abort()`, an
					// external signal, or a bare AbortError) must never be retried.
					// A timeout is NOT a user abort — it falls through to the
					// retry policy below.
					const isUserAbort =
						master.signal.aborted ||
						external?.aborted === true ||
						(!attemptTimedOut &&
							error instanceof DOMException &&
							error.name === 'AbortError');

					lastError = error;
					const errMsg = error instanceof Error ? error.message : String(error);
					this.log('error', `Request failed (attempt ${attempt}):`, errMsg);

					if (isUserAbort) throw error;

					// Unified retry policy for network/timeout errors
					const shouldRetryError = this.retryOn
						? this.retryOn(null, error, attempt)
						: true;

					if (shouldRetryError && attempt < totalAttempts) {
						await this.sleepWithJitter(retryTimeout, attempt, master);
						continue;
					}

					throw error;
				} finally {
					// Unhook the manual abort wiring (fallback path only).
					disconnect();
				}
			}

			throw lastError ?? new Error('Request failed');
		})();

		if (dedupeKey !== null) {
			this.inFlight.set(dedupeKey, requestPromise);
			try {
				// Hand the caller a clone; the shared response body stays unread,
				// so late joiners can still clone it (reading it would make
				// `clone()` throw "body already read").
				return await requestPromise.then((response) => response.clone());
			} finally {
				this.inFlight.delete(dedupeKey);
			}
		}

		return requestPromise;
	}

	private resolveDedupeKey(
		method: string,
		url: string,
		explicitKey: string | null
	): string | null {
		if (!this.dedupe) return null;

		if (SAFE_METHODS.has(method as HttpMethod)) {
			return `${method}:${url}`;
		}
		if (MUTATING_METHODS.has(method as HttpMethod)) {
			// Mutating without an explicit key — never dedupe.
			return explicitKey;
		}
		return null;
	}

	private applyIdempotencyKey(
		snapshot: { method: string; headers: Headers },
		key: string | null
	): void {
		if (!MUTATING_METHODS.has(snapshot.method as HttpMethod)) return;
		if (snapshot.headers.has('Idempotency-Key')) return;

		if (key) {
			snapshot.headers.set('Idempotency-Key', key);
		}
	}

	/**
	 * Sleep for a fixed delay, rejecting if `master` aborts. Shared by the retry
	 * backoff and by `poll()`, which wants an exact, user-supplied interval.
	 */
	private sleep(ms: number, master: AbortController = this.masterController): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (master.signal.aborted) {
				reject(master.signal.reason);
				return;
			}

			const timer = setTimeout(() => {
				master.signal.removeEventListener('abort', onAbort);
				resolve();
			}, ms);

			const onAbort = () => {
				clearTimeout(timer);
				reject(master.signal.reason);
			};

			master.signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	/**
	 * Exponential backoff with jitter, capped by `maxRetryDelay`. The cap applies
	 * to the delay before jitter, so the actual wait may exceed it by up to 20% —
	 * that is what keeps a fleet of clients from retrying in lockstep.
	 */
	private sleepWithJitter(
		baseMs: number,
		attempt: number,
		master: AbortController = this.masterController
	): Promise<void> {
		const expDelay = baseMs * Math.pow(2, attempt - 1);
		const cappedDelay = Math.min(this.maxRetryDelay, expDelay);
		const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
		return this.sleep(Math.max(0, cappedDelay + jitter), master);
	}

	private combineSignals(
		timeoutSignal: AbortSignal,
		master: AbortController = this.masterController,
		external: AbortSignal | undefined = this.externalSignal
	): { signal: AbortSignal; disconnect: () => void } {
		const signals: AbortSignal[] = [master.signal, timeoutSignal];
		if (external) signals.push(external);

		const noop = () => {};

		// Modern runtimes
		if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
			return {
				signal: (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals),
				disconnect: noop,
			};
		}

		// Fallback: wire the aborts by hand. The listeners are unhooked again once
		// the attempt settles (`disconnect`), so a long-lived instance does not
		// accumulate one listener per attempt on its master signal.
		const combined = new AbortController();
		const handlers: Array<[AbortSignal, () => void]> = [];
		const disconnect = () => {
			for (const [signal, handler] of handlers) signal.removeEventListener('abort', handler);
			handlers.length = 0;
		};

		for (const s of signals) {
			if (s.aborted) {
				// Bail out early, but still hand back `disconnect`: the listeners
				// already registered above must be released too, or every attempt
				// on a pre-aborted signal leaks one per remaining source.
				combined.abort(s.reason);
				disconnect();
				return { signal: combined.signal, disconnect: noop };
			}
			const handler = () => combined.abort(s.reason);
			handlers.push([s, handler]);
			s.addEventListener('abort', handler, { once: true });
		}
		return { signal: combined.signal, disconnect };
	}

	// ============================================================
	// Thenable API — each call initiates a NEW request
	// ============================================================

	/**
	 * Makes Fch thenable. **Every call initiates a NEW HTTP request.**
	 * @param {Function} onFulfilled - Success callback.
	 * @param {Function} [onRejected] - Error callback.
	 * @returns {Promise} Promise for chaining.
	 */
	then<TResult1 = Response, TResult2 = never>(
		onFulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null,
		onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return this.makeRequest().then(onFulfilled, onRejected);
	}

	/**
	 * **Every call initiates a NEW HTTP request.**
	 * @param {Function} onRejected - Error callback.
	 * @returns {Promise} Promise for chaining.
	 */
	catch<TResult = never>(
		onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
	): Promise<Response | TResult> {
		return this.makeRequest().catch(async (error) => {
			// Debug, not error: `makeRequest` already logged this failure once
			// (`Request failed (attempt N)`), and a second [ERROR] line for the
			// same error only doubles the noise. Logging happens here rather
			// than eagerly, since `.catch()` is also used on successful requests.
			this.log('debug', 'Caught an error during the request:', error);
			if (!onRejected) throw error;
			return onRejected(error);
		});
	}

	/**
	 * **Every call initiates a NEW HTTP request.**
	 * @param {Function} onFinally - Cleanup callback.
	 * @returns {Promise<Response>}
	 */
	finally(onFinally?: (() => void) | null): Promise<Response> {
		return this.makeRequest().finally(onFinally);
	}

	// ============================================================
	// Convenience methods (return [data, response] tuples)
	// ============================================================

	/**
	 * Run the request and read its body from a *clone*, so the returned
	 * `Response` stays readable for the caller — and so a second call (e.g. after
	 * `start()` memoised a single request) does not hit "Body already read".
	 *
	 * ponytail: the body is buffered twice (clone + original), which doubles peak
	 * memory for large payloads. `json`/`text` need the buffer anyway; for
	 * `blob()` on big downloads, read `await api.send()` and consume it directly.
	 */
	private tuple<T>(read: (response: Response) => Promise<T>): Promise<[T, Response]> {
		return this.makeRequest().then(async (response) => [await read(response.clone()), response]);
	}

	/**
	 * Execute request and parse body as JSON. Returns tuple `[data, response]`.
	 *
	 * @template T - Expected data type.
	 * @returns {Promise<[T, Response]>} Tuple of parsed JSON and raw Response.
	 * @throws {SyntaxError} If response is not valid JSON.
	 *
	 * @example
	 * const [users, response] = await api.json<User[]>();
	 */
	json<T = unknown>(): Promise<[T, Response]> {
		return this.tuple((response) => response.json() as Promise<T>);
	}

	/**
	 * Execute request and return body as string. Returns tuple `[text, response]`.
	 * @returns {Promise<[string, Response]>}
	 */
	text(): Promise<[string, Response]> {
		return this.tuple((response) => response.text());
	}

	/**
	 * Execute request and return body as Blob. Returns tuple `[blob, response]`.
	 * @returns {Promise<[Blob, Response]>}
	 */
	blob(): Promise<[Blob, Response]> {
		return this.tuple((response) => response.blob());
	}

	/**
	 * Execute request and return raw Response (no tuple).
	 * @returns {Promise<Response>}
	 */
	send(): Promise<Response> {
		return this.makeRequest();
	}

	// ============================================================
	// Abort / clone / poll
	// ============================================================

	/**
	 * Abort ALL currently active HTTP requests AND pending retry delays for this instance.
	 *
	 * Only in-flight work is cancelled — the instance stays usable, and the next
	 * {@link Fch.makeRequest} starts with a fresh abort generation. A caller-supplied
	 * `AbortController` is owned by the caller and is never aborted here.
	 *
	 * @param {unknown} [reason] - Abort reason.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * const req = fch('/api').setRetries(5);
	 * req.send();
	 * setTimeout(() => req.abort(), 100);
	 * // a later request still works
	 * await req.send();
	 */
	abort(reason?: unknown): this {
		const abortReason = reason ?? new DOMException('User aborted', 'AbortError');
		this.masterController.abort(abortReason);
		this.eagerRequest = null;
		// Legacy controller stays in sync only when we own it; makeRequest swaps
		// in a fresh one so the abort does not poison future requests.
		if (this.ownsController) {
			this.controller.abort(abortReason);
		}
		return this;
	}

	/**
	 * Create a deep copy of this Fch instance with the same configuration.
	 * Active controllers are NOT shared; the clone gets fresh abort state.
	 *
	 * @returns {Fch} New Fch instance.
	 */
	clone(): Fch {
		// `signal` is deliberately not carried over: `fetchOptions.signal` is the
		// caller's lifetime, and a clone that inherited it would abort whenever
		// the original was cancelled. Everything else is copied below.
		const { signal: _signal, ...transferable } = this.fetchOptions;
		const clone = new Fch(this.toString(), { ...transferable });
		clone.setHeaders(Object.fromEntries(this.headers.entries()));
		// `toString()` already carries every search param, including repeated
		// values. Do not round-trip through a Record: that would collapse
		// `?tag=a&tag=b` to `?tag=b`.
		clone.setTimeout(this.timeout);
		clone.setRetries(this.retries);
		clone.setRetryDelay(this.retryDelay);
		clone.setMaxRetryDelay(this.maxRetryDelay);
		clone.debug = this.debug;
		clone.dedupe = this.dedupe;
		clone.dedupeKey = this.dedupeKey;
		clone.retryOn = this.retryOn;
		clone.logger = this.logger;
		clone.requestInterceptors = [...this.requestInterceptors];
		clone.responseInterceptors = [...this.responseInterceptors];

		const body = this.fetchOptions.body;
		const contentType = this.headers.get('Content-Type') ?? undefined;

		if (typeof FormData !== 'undefined' && body instanceof FormData) {
			const formDataCopy = new FormData();
			body.forEach((value, key) =>
				formDataCopy.append(key, value as string | Blob)
			);
			clone.setFormData(formDataCopy);
		} else if (typeof body === 'string') {
			// Pass the header explicitly: `setBody(value)` alone DELETES
			// Content-Type, so a cloned JSON request would go out untyped.
			clone.setBody(body, contentType);
		} else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
			clone.setBody(new URLSearchParams(body), contentType);
		} else if (typeof Blob !== 'undefined' && body instanceof Blob) {
			clone.setBody(body.slice(0, body.size, body.type), contentType);
		} else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
			// Copy the bytes; the original buffer may be reused by the caller.
			clone.setBody(structuredClone(body), contentType);
		} else if (body) {
			this.log('warn', 'Cannot clone non-serializable body');
		}

		return clone;
	}

	/**
	 * Create a long-polling async generator. Yields responses (or errors) indefinitely
	 * until aborted or the controller fires.
	 *
	 * @param {number} [delay=300] - Delay between polls (ms).
	 * @param {AbortController} [abortController] - Controller for termination.
	 * @yields {Response|Error} Response or caught error.
	 *
	 * @example
	 * const stream = api.poll(500);
	 * for await (const response of stream) {
	 *   console.log(response);
	 * }
	 */
	async *poll(delay = 300, abortController: AbortController = this.controller): AsyncGenerator<Response | Error> {
		while (!abortController.signal.aborted && !this.masterController.signal.aborted) {
			try {
				const response = await this.executeRequest(this.retries, this.retryDelay);
				yield response;
			} catch (error) {
				yield error as Error;
			}

			if (abortController.signal.aborted || this.masterController.signal.aborted) break;

			// The poll interval is the caller's, not a retry backoff: `sleep()`
			// keeps it exact instead of clamping it to `maxRetryDelay`.
			// An abort landing in this window rejects the sleep; that is a clean
			// stop, not a failure, so it must not escape the generator.
			try {
				await this.sleep(delay);
			} catch {
				break;
			}
		}
	}

	/**
	 * Begin the request immediately instead of on first `await`/`.then()`.
	 *
	 * Useful for fire-and-forget handlers, where the returned value is never
	 * awaited:
	 *
	 * ```ts
	 * form.onsubmit = (e) => { e.preventDefault(); api.setFormData(e).start(); };
	 * ```
	 *
	 * The instance stays awaitable and every helper (`send`, `json`, `text`, …)
	 * resolves against this same request rather than starting another one.
	 *
	 * A failed eager request does NOT poison the builder: the memo is dropped so
	 * the next call starts a fresh attempt, as {@link Fch.makeRequest} documents.
	 *
	 * @returns {Fch} Current instance for chaining.
	 */
	start(): this {
		if (!this.eagerRequest) {
			const eager = this.makeRequest();
			this.eagerRequest = eager;
			// A fire-and-forget call has no rejection handler; mark it handled so
			// Node does not report an unhandled rejection. On failure the memo is
			// cleared (only if it is still ours), otherwise one rejected promise
			// would be replayed for the rest of the instance's life.
			eager.catch(() => {
				if (this.eagerRequest === eager) this.eagerRequest = null;
			});
		}
		return this;
	}
}

/** Plain factory; `fch` below is this function with `create()` attached. */
const fchFn = (url: string | URL, options: FetchRequestOptions = {}): Fch => {
	return new Fch(url, options);
};

/** Options accepted by the `fch.create()` factory and by every shortcut. */
export interface FchInstanceOptions extends FetchRequestOptions {
	/** Base URL prepended to relative request paths. */
	baseUrl?: string;
	/** Alias for `baseUrl`. */
	baseURL?: string;
}

/** True for a URL that carries its own scheme (`https:`, `data:`, `mailto:`). */
function isAbsoluteUrl(url: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/**
 * Resolve `url` against an optional base, so `api.post('/houses', form)` works.
 *
 * The base itself must be absolute: a relative `baseUrl` ("/api") would be handed
 * to `new URL()` as a base and fail with an opaque "Invalid URL" further down, so
 * it is rejected here with the same message the constructor uses.
 */
function resolveUrl(url: string | URL, baseUrl?: string): string | URL {
	if (baseUrl == null || url instanceof URL) return url;

	if (!isAbsoluteUrl(baseUrl) && !baseUrl.startsWith('//')) {
		throw new TypeError(
			`Fch requires an absolute \`baseUrl\`, got "${baseUrl}". ` +
				`Pass a full URL, e.g. \`fch.create({ baseUrl: 'https://api.example.com' })\`.`
		);
	}

	// Absolute URLs (with a scheme) ignore the base.
	if (isAbsoluteUrl(url)) return url;

	if (url.startsWith('//')) {
		// Protocol-relative: resolvable only against a base. Without one, leave
		// it for `assertAbsolute`, which explains the problem instead of letting
		// `new URL()` fail with an opaque "Invalid URL".
		return baseUrl ? new URL(url, baseUrl).toString() : url;
	}

	return new URL(url.replace(/^\//, ''), baseUrl.replace(/\/?$/, '/')).toString();
}

/**
 * `URL` cannot represent a relative path, and `Fch` extends `URL`. Rather than
 * letting `fetch()` fail later with an opaque error, say exactly what is missing.
 */
function assertAbsolute(url: string): void {
	if (isAbsoluteUrl(url)) return;

	if (url.startsWith('//')) {
		throw new TypeError(
			`Fch cannot resolve a protocol-relative URL ("${url}") without a base. ` +
				`Pass a full URL, or set \`baseUrl\` via fch.create({ baseUrl }).`
		);
	}

	const hint =
		typeof location !== 'undefined' && location.origin
			? ` or resolve it against the page origin (${location.origin})`
			: '';

	throw new TypeError(
		`Fch requires an absolute URL, got "${url}". ` +
			`Pass a full URL${hint}, or set \`baseUrl\` via fch.create({ baseUrl }).`
	);
}

/**
 * A shortcut call. The request starts **immediately**, so fire-and-forget handlers
 * work without `await`:
 *
 * ```ts
 * form.onsubmit = (e) => { e.preventDefault(); api.post('/houses', e); };
 * ```
 *
 * The returned value is still thenable and exposes the usual helpers
 * (`json()`, `text()`, `send()`, …), all resolving against that same request.
 */
export interface FchCall<T = unknown> extends Promise<[T, Response]> {
	json<R = T>(): Promise<[R, Response]>;
	text(): Promise<[string, Response]>;
	blob(): Promise<[Blob, Response]>;
	send(): Promise<Response>;
	/** The instance handling this call, for further configuration or `abort()`. */
	request: Fch;
}

/**
 * Parse a response the way the reference "body" output does: JSON when the server
 * says so, plain text otherwise. The body is read from a clone so the caller can
 * still use `response.json()`/`text()` afterwards.
 */
async function parseBody<T>(response: Response): Promise<T> {
	const clone = response.clone();
	const contentType = clone.headers.get('content-type') ?? '';

	if (contentType.includes('json')) {
		const text = await clone.text();
		return (text ? JSON.parse(text) : null) as T;
	}

	return (await clone.text()) as unknown as T;
}

/** Attach the tuple/promise helpers to an eagerly started instance. */
/** Shared with the tagged-template entry point in `Fch.literal.ts`. */
export function toCall<T>(instance: Fch): FchCall<T> {
	// Start once, now: `start()` memoises the in-flight request, so every helper
	// below (and `abort()`) observes that single request instead of firing another.
	instance.start();

	const promise = instance
		.makeRequest()
		.then(async (response): Promise<[T, Response]> => [await parseBody<T>(response), response]);

	// A fire-and-forget call has no rejection handler; keep Node quiet.
	promise.catch(() => {});

	// The instance helpers already read the body from a clone, so the shared
	// eager response stays unread and several helpers work on the same call.
	return Object.assign(promise, {
		json: instance.json.bind(instance),
		text: instance.text.bind(instance),
		blob: instance.blob.bind(instance),
		send: instance.send.bind(instance),
		request: instance,
	}) as unknown as FchCall<T>;
}

const SHORTCUT_METHODS = ['get', 'head', 'delete', 'post', 'put', 'patch'] as const;
type ShortcutMethod = (typeof SHORTCUT_METHODS)[number];

// `delete(url, options)` — the second argument carries options, not a body: a
// DELETE payload is rare, and `api.request(url).setMethod('DELETE').setJsonBody(…)`
// still covers it. Treating it as a body silently sent `{"timeout":100}` upstream.
const BODYLESS_METHODS: ReadonlySet<ShortcutMethod> = new Set(['get', 'head', 'delete']);

/**
 * Fold the `baseURL` spelling into `baseUrl` once, at the API boundary, so the
 * rest of the file reads a single property. `baseURL` is a shipped alias
 * (v1.1.0) and stays public; it just no longer has to be re-checked everywhere.
 */
function withBaseAlias(options: FchInstanceOptions = {}): FchInstanceOptions {
	const { baseURL, ...rest } = options;
	return baseURL !== undefined && rest.baseUrl === undefined
		? { ...rest, baseUrl: baseURL }
		: rest;
}

/** Drop shortcut-only keys so they never reach `fetch()`. */
function toRequestOptions(options?: FchInstanceOptions): FetchRequestOptions {
	if (!options) return {};
	const { baseUrl, ...rest } = options;
	return rest;
}

/** Overlay header sets left-to-right, so shared defaults and per-call headers both apply. */
function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
	const merged = new Headers();
	for (const source of sources) {
		if (source) new Headers(source).forEach((value, key) => merged.set(key, value));
	}
	return merged;
}

/** Build the convenience methods shared by the default export and `create()`. */
function withShortcuts(baseUrl: string | undefined, defaults: FetchRequestOptions) {
	const shortcuts = {} as {
		[M in ShortcutMethod]: <T = unknown>(url: string | URL, ...rest: unknown[]) => FchCall<T>;
	};

	for (const method of SHORTCUT_METHODS) {
		shortcuts[method] = <T>(url: string | URL, ...rest: unknown[]) => {
			// `get(url, options)` / `post(url, body, options)`
			const hasBody = !BODYLESS_METHODS.has(method);
			const first = rest[0] as FchBodyInput | undefined;

			// A form is accepted anywhere a body goes, including the body-less
			// shortcuts: HTML says a GET form contributes its fields to the query
			// string. Without this `api.get(url, form)` sent nothing at all and
			// leaked the form's own properties into the `fetch()` init object.
			const form = !hasBody && first != null ? toFormData(first) : null;
			const options = withBaseAlias(
				(form || hasBody ? rest[1] : rest[0]) as FchInstanceOptions | undefined
			);

			const request = new Fch(resolveUrl(url, options.baseUrl ?? baseUrl), {
				// Shared defaults from `create()` first, then the per-call overrides.
				...defaults,
				...toRequestOptions(options),
				headers: mergeHeaders(defaults.headers, options.headers),
				method: method.toUpperCase(),
			});

			if (form) {
				// Put the fields in the query string, exactly as a GET form submit
				// does. No body, and no form-object properties reach `fetch()`.
				request.appendFormToQuery(form);
			} else if (hasBody && first !== undefined && first !== null) {
				applyShortcutBody(request, first);
			}

			return toCall<T>(request);
		};
	}

	return shortcuts;
}

/**
 * Encode a shortcut body:
 * - `<form>` / submit event → `FormData` (the shortcut's method wins over the
 *   form's `method` attribute, since the caller asked for it explicitly)
 * - plain object / array → JSON with `Content-Type: application/json`
 * - anything else → handed to `fetch()` as-is
 */
function applyShortcutBody(request: Fch, body: FchBodyInput): void {
	// Build the FormData once: `setFormData` would otherwise call `toFormData`
	// again, reading the whole form a second time on every submit.
	const formData = toFormData(body);
	if (formData) {
		const intendedMethod = request.method;
		request.setFormData(formData);
		request.setMethod(intendedMethod);
		return;
	}

	// `isNativeBody` already covers ArrayBuffer and every ArrayBuffer view, so
	// only the Node-stream shape needs its own check here.
	const isPlainData =
		typeof body === 'object' &&
		!isNativeBody(body) &&
		typeof (body as { pipe?: unknown }).pipe !== 'function';

	if (isPlainData) {
		request.setJsonBody(body);
		return;
	}

	request.setBody(body as FchBody);

	// Node requires `duplex: 'half'` for any streamed request body.
	if (isStreamBody(body)) {
		request.setFetchOptions({ duplex: 'half' } as RequestInit);
	}
}

const isStreamBody = (body: unknown): boolean =>
	!!body &&
	typeof body === 'object' &&
	((typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
		typeof (body as { pipe?: unknown }).pipe === 'function');

/**
 * Create a configured shorthand API. Its methods start their request immediately,
 * so fire-and-forget handlers work without `await`:
 *
 * ```ts
 * const api = fch.create({ baseUrl: 'https://api.example.com' });
 *
 * form.onsubmit = (e) => { e.preventDefault(); api.post('/houses', e); };
 * ```
 *
 * @param {FchInstanceOptions} [options] - Shared defaults, including `baseUrl`.
 * @returns Shortcut methods (`get`, `post`, `put`, `patch`, `delete`, `head`) plus
 * `request()` for a fresh builder with the same defaults.
 */
export function create(options: FchInstanceOptions = {}) {
	const { baseUrl, ...defaults } = withBaseAlias(options);
	const base = baseUrl;

	return {
		...withShortcuts(base, defaults),
		/** A fresh builder carrying the shared defaults, for chaining. */
		request: (url: string | URL, extra: FchInstanceOptions = {}) => {
			const merged = withBaseAlias(extra);
			return new Fch(resolveUrl(url, merged.baseUrl ?? base), {
				...defaults,
				...toRequestOptions(merged),
				headers: mergeHeaders(defaults.headers, merged.headers),
			});
		},
		/** The shared defaults this instance was created with. */
		defaults,
	};
}

export type FchApi = ReturnType<typeof create>;

// `fch.create(...)` mirrors the ergonomics of the reference implementation without
// giving up the URL-first behaviour of the class. `fch` is the factory WITH
// `create()` — the same object as the default export — so named and default
// imports expose an identical API.
export const fch = Object.assign(fchFn, { create });

/** The shape of {@link fch}: the factory plus the `create()` shorthand API. */
export type FchFactory = typeof fch;

/** Deprecated alias; kept because the factory has always carried `create()`. */
export { fch as fchWithCreate };

export default fch;
