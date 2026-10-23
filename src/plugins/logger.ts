/**
 * Logging, as a plugin.
 *
 * The core emits semantic events (`request`, `retry`, `failure`, …) and nothing
 * else; this plugin decides the level, the wording and where the line goes.
 *
 * ```ts
 * import { Fch } from "@westtrade/fch";
 * import { logger } from "@westtrade/fch/plugins/logger";
 *
 * const req = new Fch(url).use(logger({ debug: true }));
 * ```
 *
 * `warn` and `error` always print; `info` and `debug` need `debug: true`,
 * because diagnostics should not depend on a flag while chatty lines should.
 */
import type { Fch, Logger, LogEvent, Plugin, PluginApi } from '../Fch';

export interface LoggerOptions {
	/** Where lines go. Defaults to `console` with a `[LEVEL]` prefix. */
	logger?: Logger;
	/** Print `info`/`debug` events. Default `false`. */
	debug?: boolean;
}

/** What the plugin adds to the request. */
export interface LoggerApi {
	/** Change the logger implementation. Falls back to console when invalid. */
	setLogger(logger: Logger): Fch;
	/** The debug-aware logger for this request. */
	getLogger(): Logger;
	/** Turn `info`/`debug` on. */
	enableLogging(): Fch;
	/** Turn `info`/`debug` off. */
	disableLogging(): Fch;
}

/** The events this plugin reports, with their level. */
const LEVELS: Record<LogEvent, keyof Logger> = {
	request: 'info',
	response: 'info',
	retry: 'warn',
	failure: 'error',
	'interceptor-error': 'error',
	dedupe: 'debug',
	caught: 'debug',
	'clone-warning': 'warn',
	'validate-skipped': 'warn',
	'method-warning': 'warn',
};

/** Render one event as a readable line. */
function format(event: LogEvent, args: unknown[]): string {
	switch (event) {
		case 'request':
			return `Making request to ${String(args[0])} with method ${String(args[1])}`;
		case 'response':
			return `Received response with status ${String(args[0])}`;
		case 'retry':
			return `Retry triggered for status ${String(args[0])}`;
		case 'failure':
			return `Request failed (attempt ${String(args[0])}): ${String(args[1])}`;
		case 'interceptor-error':
			return `Response interceptor failed: ${String(args[0])}`;
		case 'dedupe':
			return `Deduped concurrent in-flight request: ${String(args[0])}`;
		case 'caught':
			return 'Caught an error during the request';
		case 'clone-warning':
			return 'Cannot clone non-serializable body';
		case 'validate-skipped':
			return `${String(args[0])} skipped: no form body on ${String(args[1])}`;
		case 'method-warning':
			return String(args[0]);
	}
}

/** A `console`-backed logger with level prefixes. */
export function consoleLogger(): Logger {
	return {
		info: console.log.bind(console, '[INFO]'),
		warn: console.warn.bind(console, '[WARN]'),
		error: console.error.bind(console, '[ERROR]'),
		debug: console.debug.bind(console, '[DEBUG]'),
	};
}

/**
 * Whether a logger implements enough of the interface. An incomplete one would
 * silently swallow every line, so it is replaced by the default instead.
 */
function isValidLogger(logger: Logger): boolean {
	return (
		typeof logger?.info === 'function' &&
		typeof logger?.warn === 'function' &&
		typeof logger?.error === 'function'
	);
}

/**
 * Attach logging to a request.
 *
 * @param options - A logger, `debug`, or both.
 */
export function logger(options: LoggerOptions = {}): Plugin {
	const initial = options.logger && isValidLogger(options.logger) ? options.logger : consoleLogger();

	return {
		name: 'logger',

		install({ request }: PluginApi): void {
			let target: Logger = initial;
			request.debug = options.debug ?? false;

			const shouldLog = (level: keyof Logger): boolean =>
				// Diagnostics must not depend on the debug flag.
				level === 'error' || level === 'warn' ? true : request.debug;

			const write = (level: keyof Logger, ...args: unknown[]): void => {
				if (!shouldLog(level)) return;
				const fn = target[level];
				if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
			};

			request.setLogSink((event, args) => {
				write(LEVELS[event], format(event, args));
			});

			// Mix the public API onto the request, so call sites keep working.
			const api = request as Fch & Partial<LoggerApi>;

			api.setLogger = function (next: Logger) {
				target = isValidLogger(next) ? next : consoleLogger();
				return this;
			};

			api.enableLogging = function () {
				this.debug = true;
				return this;
			};

			api.disableLogging = function () {
				this.debug = false;
				return this;
			};

			api.getLogger = function () {
				return {
					info: (...args) => write('info', ...args),
					warn: (...args) => write('warn', ...args),
					error: (...args) => write('error', ...args),
					debug: (...args) => write('debug', ...args),
				};
			};
		},
	};
}

export default logger;
