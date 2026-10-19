/**
 * Deprecated aliases, moved out of the core and into a plugin.
 *
 * These four methods were kept in `Fch` only for backward compatibility, costing
 * every user bytes they never call. They now live here:
 *
 * ```ts
 * import { compat } from "@westtrade/fch/plugins/compat";
 *
 * const req = new Fch(url).use(compat());
 * req.setRetryTimeout(500);            // -> setRetryDelay(500)
 * req.setIdempotencyKey(() => uuid()); // -> setDedupeKey(...)
 * req.addRequestInterceptor(fn);       // -> before(fn)
 * req.addResponseInterceptor(fn);      // -> after(fn)
 * ```
 *
 * The aliases delegate to the current methods, so behaviour is identical — only
 * the name and the place changed.
 */
import type { Fch, Plugin, PluginApi } from '../Fch';

/** The deprecated surface this plugin adds back. */
export interface CompatAliases {
	/** @deprecated Use `setRetryDelay`. */
	setRetryTimeout(ms: number): Fch;
	/** @deprecated Use `setDedupeKey`. */
	setIdempotencyKey(key: string | (() => string)): Fch;
	/** @deprecated Use `before`. */
	addRequestInterceptor(
		interceptor: (request: Fch) => void | Promise<void>,
	): Fch;
	/** @deprecated Use `after`. */
	addResponseInterceptor(
		interceptor: (response: Response) => Response | Promise<Response>,
	): Fch;
}

/** The deprecated member names, in one place for tests and tooling. */
export const DEPRECATED_MEMBERS = [
	'setRetryTimeout',
	'setIdempotencyKey',
	'addRequestInterceptor',
	'addResponseInterceptor',
] as const;

/**
 * Attach the deprecated aliases to a request.
 *
 * Idempotent like every plugin: attaching twice does not replace the methods a
 * second time.
 */
export function compat(): Plugin {
	return {
		name: 'compat',

		install({ request }: PluginApi): void {
			const target = request as Fch & Partial<CompatAliases>;

			// Only define what is missing, so a future core method with the same
			// name is never shadowed by the alias.
			if (typeof target.setRetryTimeout !== 'function') {
				target.setRetryTimeout = function (ms: number) {
					return this.setRetryDelay(ms);
				};
			}

			if (typeof target.setIdempotencyKey !== 'function') {
				target.setIdempotencyKey = function (key: string | (() => string)) {
					return this.setDedupeKey(key);
				};
			}

			if (typeof target.addRequestInterceptor !== 'function') {
				target.addRequestInterceptor = function (
					interceptor: (request: Fch) => void | Promise<void>,
				) {
					return this.before(interceptor);
				};
			}

			if (typeof target.addResponseInterceptor !== 'function') {
				target.addResponseInterceptor = function (
					interceptor: (response: Response) => Response | Promise<Response>,
				) {
					return this.after(interceptor);
				};
			}
		},
	};
}

export default compat;
