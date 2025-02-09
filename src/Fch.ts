/**
 * Configuration options for fetch requests, extending standard RequestInit.
 * @typedef {Object} FetchRequestOptions
 * @extends RequestInit
 * @property {number} [retries=1] - Number of retry attempts for failed requests.
 * @property {number} [retryTimeout=0] - Delay (ms) between retry attempts.
 * @property {number} [timeout=5000] - Request timeout in milliseconds.
 * @property {AbortController} [abortController] - Custom AbortController instance.
 * @property {Logger} [logger] - Logger implementation for request logging.
 */
export interface FetchRequestOptions extends RequestInit {
	retries?: number;
	retryTimeout?: number;
	timeout?: number;
	abortController?: AbortController;
	logger?: Logger;
	debug?: boolean;
}

/**
 * Logger interface for handling log messages.
 * @typedef {Object} Logger
 * @property {function(string): void} info - Logs informational messages.
 * @property {function(string): void} warn - Logs warning messages.
 * @property {function(string): void} error - Logs error messages.
 */
export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/**
 * Enhanced fetch client extending URL with advanced request handling capabilities.
 * Supports retries, timeouts, interceptors, logging, and various data formats.
 *
 * @class Fch
 * @extends URL
 *
 * @example
 * const api = new Fch('https://api.example.com', { timeout: 3000 });
 * api.setHeaders({ 'Content-Type': 'application/json' }).get();
 */
export default class Fch extends URL {
	// Properties documentation

	/**
	 * FormData payload for the request
	 * @type {FormData|null}
	 */
	formData: FormData | null = null;

	/**
	 * Request headers instance
	 * @type {Headers}
	 */
	headers: Headers;

	/**
	 * Number of remaining retry attempts
	 * @type {number}
	 */
	fetchOptions: RequestInit;
	controller: AbortController;
	timeoutController: AbortController;
	retries: number;
	retryTimeout: number;
	timeout: number;

	private logger: Logger;
	private isLoggingEnabled = true;

	private requestInterceptors: ((request: Fch) => void)[] = [];
	private responseInterceptors: ((
		response: Response
	) => Response | Promise<Response>)[] = [];

	/**
	 * Add request interceptor
	 * @param {function(Fch): void} interceptor - Interceptor function
	 * @returns {Fch} Current instance for chaining
	 */
	addRequestInterceptor(interceptor: (request: Fch) => void) {
		this.requestInterceptors.push(interceptor);
		return this;
	}

	addResponseInterceptor(
		interceptor: (response: Response) => Response | Promise<Response>
	) {
		this.responseInterceptors.push(interceptor);
		return this;
	}

	/**
	 * @constructor
	 * @param {string|URL} url - Base URL for the request
	 * @param {FetchRequestOptions} [options] - Configuration options
	 */
	constructor(
		url: string | URL,
		{
			retries = 1,
			timeout = 5000,
			abortController,
			retryTimeout = 0,
			logger,
			debug = false,
			headers,
			...options
		}: FetchRequestOptions = {}
	) {
		super(url); // передаем базовый URL в конструктор родительского класса URL

		this.headers = new Headers(headers);
		this.fetchOptions = {
			...options,
			method: options.method || "GET",
			body: this.formData,
		};

		this.retries = retries;
		this.retryTimeout = retryTimeout;
		this.timeout = timeout;
		this.controller = abortController || new AbortController();
		this.timeoutController = new AbortController();
		this.fetchOptions.signal = this.controller.signal;
		this.logger = this.adaptLogger(logger);
		this.isLoggingEnabled = debug;
	}

	private adaptLogger(logger?: Logger): Logger {
		if (!logger) {
			return this.createDefaultLogger();
		}

		if (
			typeof logger.info === "function" &&
			typeof logger.warn === "function" &&
			typeof logger.error === "function"
		) {
			return logger as Logger;
		}

		return this.createDefaultLogger();
	}

	private createDefaultLogger(): Logger {
		return {
			info: (message: string) => console.log(`[INFO] ${message}`),
			warn: (message: string) => console.warn(`[WARN] ${message}`),
			error: (message: string) => console.error(`[ERROR] ${message}`),
		};
	}

	get aborted() {
		return this.controller.signal.aborted;
	}

	enableLogging() {
		this.isLoggingEnabled = true;
		return this;
	}

	disableLogging() {
		this.isLoggingEnabled = false;
		return this;
	}

	setLogger(logger: Logger) {
		this.logger = logger;
		return this;
	}

	getLogger(): Logger {
		return {
			info: (...args) => {
				if (this.isLoggingEnabled) {
					this.logger.info(...args);
				}
			},
			warn: (...args) => {
				if (this.isLoggingEnabled) {
					this.logger.warn(...args);
				}
			},
			error: (...args) => {
				if (this.isLoggingEnabled) {
					this.logger.error(...args);
				}
			},
		};
	}

	// Устанавливаем параметры поискового запроса
	setSearchParams(params: Record<string, string>) {
		for (const [key, value] of Object.entries(params)) {
			this.searchParams.set(key, value);
		}
		return this;
	}

	appendSearchParams(params: Record<string, string | string[]>) {
		for (const [key, value] of Object.entries(params)) {
			if (Array.isArray(value)) {
				value.forEach((v) => this.searchParams.append(key, v));
			} else {
				this.searchParams.append(key, value);
			}
		}
		return this;
	}

	appendToFormData(key: string, value: string | Blob) {
		if (!this.formData) {
			this.formData = new FormData();
		}
		this.formData.append(key, value);
		if (this.fetchOptions.method !== "PUT") {
			this.fetchOptions.method = "POST";
		}
		return this;
	}

	setFormData(formData: FormData) {
		this.formData = formData;
		if (this.fetchOptions.method !== "PUT") {
			this.fetchOptions.method = "POST";
		}
		this.fetchOptions.body = formData;

		return this;
	}

	/**
	 * Set multiple headers at once
	 * @param {Record<string, string>} headers - Key/value pairs of headers
	 * @returns {Fch} Current instance for chaining
	 */
	setHeaders(headers: Record<string, string>) {
		for (const [key, value] of Object.entries(headers)) {
			this.headers.set(key, value);
		}
		return this;
	}

	setMethod(method: string) {
		this.fetchOptions.method = method.toUpperCase();
		return this;
	}

	setFetchOptions(options: RequestInit) {
		this.fetchOptions = { ...this.fetchOptions, ...options };
		return this;
	}

	get method() {
		return this.fetchOptions.method || "GET";
	}

	set method(value: string) {
		this.fetchOptions.method = value.toUpperCase();
	}

	setTimeout(timeout: number) {
		this.timeout = timeout;
		return this;
	}

	setRetries(retries: number) {
		this.retries = retries;
		return this;
	}

	setAuthToken(token: string) {
		this.headers.set("Authorization", `Bearer ${token}`);
		return this;
	}

	setBasicAuth(username: string, password: string) {
		const auth = btoa(`${username}:${password}`);
		this.headers.set("Authorization", `Basic ${auth}`);
		return this;
	}

	setCORS(mode: RequestMode) {
		this.fetchOptions.mode = mode;
		return this;
	}

	disableCache() {
		this.fetchOptions.cache = "no-store";
		return this;
	}

	setBody(body: string | Blob | null, contentType?: string) {
		this.formData = null;
		this.fetchOptions.body = body;
		if (contentType) {
			this.headers.set("Content-Type", contentType);
		}
		return this;
	}

	setFormUrlEncodedBody(
		data: Record<
			string,
			string | number | boolean | (string | number | boolean)[]
		>
	) {
		const urlSearchParams = new URLSearchParams();
		for (const [key, value] of Object.entries(data)) {
			if (Array.isArray(value)) {
				for (const v of value) {
					urlSearchParams.append(key, String(v));
				}
			} else {
				urlSearchParams.append(key, String(value));
			}
		}
		this.setBody(
			urlSearchParams.toString(),
			"application/x-www-form-urlencoded"
		);
		return this;
	}

	/**
	 * Set JSON request body with proper Content-Type
	 * @template T
	 * @param {Record<string, T>} json - JSON-serializable object
	 * @returns {Fch} Current instance for chaining
	 */
	setJsonBody<T>(json: Record<string, T>) {
		return this.setBody(JSON.stringify(json), "application/json");
	}

	getHeader(name: string) {
		return this.headers.get(name);
	}

	deleteHeader(name: string) {
		this.headers.delete(name);
		return this;
	}

	/**
	 * Execute the configured request with retry logic
	 * @param {number} [retries] - Override default retry count
	 * @param {number} [retryTimeout] - Override default retry delay
	 * @returns {Promise<Response>} Fetch response promise
	 * @throws {Error} When request fails after all retries
	 */
	async makeRequest(
		retries: number = this.retries || 1,
		retryTimeout: number = this.retryTimeout
	) {
		this.logger.info(
			`Making request to ${this.toString()} with method ${this.method}`
		);

		// Применяем request interceptors
		for (const interceptor of this.requestInterceptors) {
			interceptor(this);
		}

		const fetchWithTimeout = async () => {
			const timeoutId = setTimeout(
				() => this.controller.abort(),
				this.timeout
			);

			try {
				const response = fetch(this.toString(), {
					...this.fetchOptions,
					signal: this.controller.signal,
				});
				clearTimeout(timeoutId);

				let processedResponse = response;
				for (const interceptor of this.responseInterceptors) {
					processedResponse = await interceptor(processedResponse);
				}

				return processedResponse;
			} catch (error) {
				clearTimeout(timeoutId);

				throw error;
			}
		};

		let attempt = 0;
		while (attempt < retries) {
			if (attempt > 0 && retryTimeout > 0) {
				await new Promise((resolve) =>
					setTimeout(resolve, retryTimeout)
				);
			}

			try {
				const response = await fetchWithTimeout();

				this.logger.info(
					`Received response with status ${response.status}`
				);

				return response;
			} catch (error) {
				this.logger.error(`Request failed: ${error.message}`);

				if (attempt < this.retries - 1) {
					attempt++;
				} else {
					throw error;
				}
			}
		}
	}

	then(onFulfilled: (value: any) => any, onRejected?: (reason: any) => any) {
		return this.makeRequest().then(onFulfilled, onRejected);
	}

	catch(onRejected: (reason: any) => any) {
		this.logger.error("Caught an error during the request");
		return this.makeRequest().catch(onRejected);
	}

	finally(onFinally: () => void) {
		return this.makeRequest().finally(onFinally);
	}

	toString() {
		return super.toString();
	}

	/**
	 * Create request stream with delay between attempts
	 * @param {number} [delay=300] - Delay between requests in milliseconds
	 * @param {AbortController} [abortController] - Controller for stream termination
	 * @yields {Promise<[Response|Error, AbortController]>} Response/error with controller
	 */
	json() {
		return this.makeRequest().then(async (response) => [
			await response.json(),
			response,
		]);
	}

	text() {
		return this.makeRequest().then(async (response) => [
			await response.text(),
			response,
		]);
	}

	blob() {
		return this.makeRequest().then(async (response) => [
			await response.blob(),
			response,
		]);
	}

	abort() {
		this.controller.abort();
	}

	/**
	 * Create new instance with cloned configuration
	 * @returns {Fch} New Fch instance with identical settings
	 */
	clone() {
		const clone = new Fch(this.toString(), { ...this.fetchOptions });
		clone.setHeaders(Object.fromEntries(this.headers.entries()));
		clone.setSearchParams(Object.fromEntries(this.searchParams.entries()));
		clone.setTimeout(this.timeout);
		clone.setRetries(this.retries);
		clone.controller = new AbortController();
		clone.requestInterceptors = [...this.requestInterceptors];
		clone.responseInterceptors = [...this.responseInterceptors];

		if (this.fetchOptions.body) {
			if (this.fetchOptions.body instanceof FormData) {
				const formDataCopy = new FormData();
				this.fetchOptions.body.forEach((value, key) =>
					formDataCopy.append(key, value)
				);
				clone.setFormData(formDataCopy);
			} else if (typeof this.fetchOptions.body === "string") {
				clone.setBody(this.fetchOptions.body);
			} else {
				console.warn("Cannot clone non-serializable body");
			}
		}

		return clone;
	}

	async *stream(
		delay = 300,
		abortController: AbortController = this.controller
	) {
		while (!abortController.signal.aborted) {
			try {
				const response = await this.makeRequest();
				yield response;
			} catch (error) {
				yield error;
			}

			if (abortController.signal.aborted) {
				break;
			}

			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

/**
 * Static factory method for quick request creation
 * @static
 * @param {string} url - Target URL
 * @param {FetchRequestOptions} [options] - Request configuration
 * @returns {Fch} New Fch instance
 */
export const fch = (url: string, options: FetchRequestOptions = {}): Fch => {
	return new Fch(url, options);
};
