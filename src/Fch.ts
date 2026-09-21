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

/**
 * Enhanced fetch client extending URL with advanced request handling capabilities.
 * Supports retries, timeouts, interceptors, logging, deduplication, and various data formats.
 *
 * **Core contract:** Every call to `await`, `.then()`, `.catch()`, `.finally()`, `.json()`, etc.
 * initiates a NEW independent HTTP request. The instance is a reusable request *builder*, not a
 * cached promise.
 *
 * @class Fch
 * @extends URL
 *
 * @example
 * const api = new Fch('https://api.example.com', { timeout: 3000 });
 * const [users, response] = await api.setAuthToken(token).json();
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
	private externalSignal?: AbortSignal;

	/** User-supplied external signal. Never refreshed (unlike our own controller). */
	private userSignal?: AbortSignal;

	/** True when `abortController` was not supplied and we created the controller. */
	private ownsController = true;

	/** True when the last attempt failed because the per-attempt timeout fired. */
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
		super(url.toString());

		this.headers = new Headers(headers);
		this.fetchOptions = {
			...options,
			// Normalize here so `{ method: 'post' }` behaves exactly like
			// `setMethod('POST')` (idempotency/dedupe checks are case-sensitive).
			method: (options.method ? String(options.method) : 'GET').toUpperCase(),
		};

		this.retries = retries;
		this.retryDelay = retryDelay ?? retryTimeout ?? 1000;
		this.maxRetryDelay = maxRetryDelay;
		this.timeout = timeout;
		this.controller = abortController || new AbortController();
		this.ownsController = !abortController;
		this.userSignal = signal ?? undefined;
		this.externalSignal = signal ?? this.controller.signal;

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
		const log = (level: keyof Logger, ...args: unknown[]) => {
			if (!this.shouldLog(level)) return;
			const fn = this.logger[level];
			if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
		};
		return {
			info: (...args) => log('info', ...args),
			warn: (...args) => log('warn', ...args),
			error: (...args) => log('error', ...args),
			debug: (...args) => log('debug', ...args),
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
	 * Set (replace) search params for the request.
	 * @param {Record<string, string|number|boolean>} params - Key/value pairs.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setSearchParams({ key: 'value', page: 1 });
	 */
	setSearchParams(params: Record<string, string | number | boolean>): this {
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
	 * Set FormData directly.
	 * @param {FormData} formData - FormData instance.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * const fd = new FormData(); fd.append('key', 'value');
	 * api.setFormData(fd);
	 */
	setFormData(formData: FormData): this {
		this.formData = formData;
		this.fetchOptions.body = formData;
		this.headers.delete('Content-Type');
		if (this.fetchOptions.method !== 'PUT') this.fetchOptions.method = 'POST';
		return this;
	}

	/**
	 * Set raw request body. Clears any existing FormData.
	 *
	 * @param {string|ArrayBuffer|Blob|FormData|URLSearchParams|ReadableStream|null} body - Request body.
	 * @param {string} [contentType] - Optional Content-Type header.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.setBody('{"key":"value"}', 'application/json');
	 */
	setBody(body: BodyInit | null, contentType?: string): this {
		this.formData = null;
		this.fetchOptions.body = body;
		if (contentType) {
			this.headers.set('Content-Type', contentType);
		} else {
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
		const auth = btoa(`${username}:${password}`);
		this.headers.set('Authorization', `Basic ${auth}`);
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
		const normalized = method.toUpperCase();
		if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(normalized)) {
			throw new TypeError(`Unsupported HTTP method: ${method}`);
		}
		this.fetchOptions.method = normalized;
		return this;
	}

	get method(): string {
		return (this.fetchOptions.method as string) || 'GET';
	}

	set method(value: string) {
		this.fetchOptions.method = value.toUpperCase();
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
	 * Add a request interceptor. Runs before every attempt (including retries).
	 * May mutate the Fch instance (headers, URL, body).
	 *
	 * @param {(request: Fch) => void|Promise<void>} interceptor - Interceptor function.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.addRequestInterceptor((req) => {
	 *   req.setHeader('X-Request-Id', crypto.randomUUID());
	 * });
	 */
	addRequestInterceptor(interceptor: (request: Fch) => void | Promise<void>): this {
		this.requestInterceptors.push(interceptor);
		return this;
	}

	/**
	 * Add a response interceptor. Applied before the response is returned.
	 * Must NOT consume the response body (use `response.clone()` if needed).
	 *
	 * @param {(response: Response) => Response|Promise<Response>} interceptor - Interceptor.
	 * @returns {Fch} Current instance for chaining.
	 *
	 * @example
	 * api.addResponseInterceptor(async (res) => {
	 *   if (res.status === 401) throw new Error('Unauthorized');
	 *   return res;
	 * });
	 */
	addResponseInterceptor(
		interceptor: (response: Response) => Response | Promise<Response>
	): this {
		this.responseInterceptors.push(interceptor);
		return this;
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
	 * @param {number} [retries] - Override default retry count.
	 * @param {number} [retryTimeout] - Override default retry delay (ms).
	 * @returns {Promise<Response>} Fetch response.
	 * @throws {Error} When request fails after all retries.
	 * @throws {TypeError} When `retries > 0` and body is a ReadableStream.
	 */
	async makeRequest(
		retries: number = this.retries,
		retryTimeout: number = this.retryDelay
	): Promise<Response> {
		// `abort()` cancels in-flight work, but it must not leave the builder
		// permanently unusable: start a fresh abort generation for this request.
		if (this.masterController.signal.aborted) {
			this.masterController = new AbortController();
			if (this.ownsController) this.controller = new AbortController();
			this.externalSignal = this.userSignal ?? this.controller.signal;
		}

		this.timedOut = false;

		if (!Number.isInteger(retries) || retries < 0) {
			throw new Error(`Invalid retries: ${retries}`);
		}

		// Capture this request's abort generation. Concurrent requests on the
		// same instance must not observe each other's controllers when one of
		// them is aborted or when `abort()` later swaps in a new generation.
		const master = this.masterController;
		const external = this.externalSignal;

		const totalAttempts = retries + 1;

		// Dedupe identity is derived from the configuration at CALL time: request
		// interceptors now run per attempt (below), so they cannot be part of an
		// identity that must be known before the first attempt starts.
		const callMethod = (this.fetchOptions.method as string) || 'GET';
		const callUrl = this.toString();

		// Resolve the idempotency/dedupe key AT MOST ONCE per request. A factory
		// key must yield the same value for the `Idempotency-Key` header and for
		// the dedupe identity, otherwise retries of one logical request would be
		// sent with different keys.
		let cachedKey: string | null | undefined;
		const resolveKey = (): string | null => {
			if (cachedKey === undefined) {
				cachedKey = !this.dedupeKey
					? null
					: typeof this.dedupeKey === 'function'
						? this.dedupeKey()
						: this.dedupeKey;
			}
			return cachedKey;
		};

		const dedupeKey = this.resolveDedupeKey(callMethod, callUrl, resolveKey);

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
					await interceptor(this);
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
				this.applyIdempotencyKey(snapshot, resolveKey());

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

				this.timedOut = false;
				if (this.timeout > 0) {
					timeoutId = setTimeout(() => {
						attemptTimedOut = true;
						this.timedOut = true;
						timeoutController.abort(new DOMException('Request timeout', 'TimeoutError'));
					}, this.timeout);
				}

				const combinedSignal = this.combineSignals(timeoutController.signal, master, external);

				try {
					const response = await fetch(snapshot.url, {
						...snapshot.fetchOptions,
						method: snapshot.method,
						headers: snapshot.headers,
						body: snapshot.body,
						signal: combinedSignal,
					});

					if (timeoutId) clearTimeout(timeoutId);
					this.timedOut = false;

					// Retry policy for HTTP responses
					const shouldRetry = this.retryOn
						? this.retryOn(response, null, attempt)
						: false;

					if (shouldRetry && attempt < totalAttempts) {
						this.log('warn', `Retry triggered for status ${response.status}`);
						await this.sleepWithJitter(retryTimeout, attempt, master);
						continue;
					}

					// Response interceptors
					let processed = response;
					for (const interceptor of this.responseInterceptors) {
						processed = await interceptor(processed);
					}

					this.log('info', `Received response with status ${response.status}`);
					return processed;
				} catch (error) {
					if (timeoutId) clearTimeout(timeoutId);

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
		resolveKey: () => string | null
	): string | null {
		if (!this.dedupe) return null;

		if (SAFE_METHODS.has(method as HttpMethod)) {
			return `${method}:${url}`;
		}
		if (MUTATING_METHODS.has(method as HttpMethod)) {
			// Mutating without an explicit key — never dedupe.
			return resolveKey();
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

	private sleepWithJitter(
		baseMs: number,
		attempt: number,
		master: AbortController = this.masterController
	): Promise<void> {
		const expDelay = baseMs * Math.pow(2, attempt - 1);
		const cappedDelay = Math.min(this.maxRetryDelay, expDelay);
		const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
		const delay = Math.max(0, cappedDelay + jitter);

		return new Promise<void>((resolve, reject) => {
			if (master.signal.aborted) {
				reject(master.signal.reason);
				return;
			}

			const timer = setTimeout(() => {
				master.signal.removeEventListener('abort', onAbort);
				resolve();
			}, delay);

			const onAbort = () => {
				clearTimeout(timer);
				reject(master.signal.reason);
			};

			master.signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private combineSignals(
		timeoutSignal: AbortSignal,
		master: AbortController = this.masterController,
		external: AbortSignal | undefined = this.externalSignal
	): AbortSignal {
		const signals: AbortSignal[] = [master.signal, timeoutSignal];
		if (external) signals.push(external);

		// Modern runtimes
		if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
			return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
		}

		// Fallback
		const combined = new AbortController();
		for (const s of signals) {
			if (s.aborted) {
				combined.abort(s.reason);
				return combined.signal;
			}
			s.addEventListener('abort', () => combined.abort(s.reason), { once: true });
		}
		return combined.signal;
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
		this.log('error', 'Caught an error during the request');
		return this.makeRequest().catch(onRejected);
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
		return this.makeRequest().then(async (response) => [
			(await response.json()) as T,
			response,
		]);
	}

	/**
	 * Execute request and return body as string. Returns tuple `[text, response]`.
	 * @returns {Promise<[string, Response]>}
	 */
	text(): Promise<[string, Response]> {
		return this.makeRequest().then(async (response) => [
			await response.text(),
			response,
		]);
	}

	/**
	 * Execute request and return body as Blob. Returns tuple `[blob, response]`.
	 * @returns {Promise<[Blob, Response]>}
	 */
	blob(): Promise<[Blob, Response]> {
		return this.makeRequest().then(async (response) => [
			await response.blob(),
			response,
		]);
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
		const clone = new Fch(this.toString(), { ...this.fetchOptions });
		clone.setHeaders(Object.fromEntries(this.headers.entries()));
		clone.setSearchParams(Object.fromEntries(this.searchParams.entries()));
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

		if (this.fetchOptions.body instanceof FormData) {
			const formDataCopy = new FormData();
			this.fetchOptions.body.forEach((value, key) =>
				formDataCopy.append(key, value as string | Blob)
			);
			clone.setFormData(formDataCopy);
		} else if (typeof this.fetchOptions.body === 'string') {
			clone.setBody(this.fetchOptions.body);
		} else if (this.fetchOptions.body) {
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
				const response = await this.makeRequest();
				yield response;
			} catch (error) {
				yield error as Error;
			}

			if (abortController.signal.aborted || this.masterController.signal.aborted) break;

			await this.sleepWithJitter(delay, 1); // fixed delay for polling (no backoff)
		}
	}

	toString(): string {
		return super.toString();
	}
}

/**
 * Static factory for quick request creation.
 *
 * @static
 * @param {string|URL} url - Target URL.
 * @param {FetchRequestOptions} [options] - Request configuration.
 * @returns {Fch} New Fch instance.
 *
 * @example
 * const [users, res] = await fch('https://api.example.com/users', {
 *   timeout: 5000,
 *   retries: 2,
 *   dedupe: true,
 * }).setAuthToken(token).json<User[]>();
 */
export const fch = (url: string | URL, options: FetchRequestOptions = {}): Fch => {
	return new Fch(url, options);
};

export default fch;
