/**
 * Response validation: reject a request whose body does not match a schema.
 *
 * A validation failure is a normal rejection — it reaches `.catch()`, any
 * `onError` hook, and the Nano Stores plugin, exactly like a network error. The
 * request still succeeded on the wire; only the contract was broken.
 *
 * ```ts
 * import { Fch } from "@westtrade/fch";
 * import { validate } from "@westtrade/fch/plugins/validate";
 *
 * const [house] = await new Fch("https://api.example.com/houses/1")
 * 	.use(validate({
 * 		type: "object",
 * 		required: ["id", "name"],
 * 		properties: { id: { type: "number" }, name: { type: "string" } },
 * 	}))
 * 	.json<House>();
 * ```
 *
 * The plugin does not depend on a schema library. Pass a `validate` function for
 * AJV, Zod, Valibot or a hand-written check; the built-in `schema` path is a
 * small JSON-Schema subset so the common case needs no dependency at all.
 */
import type { Fch, Plugin, PluginApi } from '../Fch';

/** A JSON-Schema-like description, for the dependency-free path. */
export interface SimpleSchema {
	/** `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`. */
	type?: string | string[];
	/** Required keys, for `type: "object"`. */
	required?: string[];
	/** Per-key schemas, for `type: "object"`. */
	properties?: Record<string, SimpleSchema>;
	/** Item schema, for `type: "array"`. */
	items?: SimpleSchema;
	/** Reject unknown keys on an object. Default `false`. */
	additionalProperties?: boolean;
	/** Membership test for any type. */
	enum?: unknown[];
	/** Accept `null` as well as the declared type. */
	nullable?: boolean;
	/** Minimum string length / minimum array length / minimum number. */
	minLength?: number;
	minItems?: number;
	minimum?: number;
	/** Maximum counterpart of the above. */
	maxLength?: number;
	maxItems?: number;
	maximum?: number;
	/** String pattern, compiled as a RegExp. */
	pattern?: string;
}

/** Where a validation problem was found. */
export interface ValidationIssue {
	/** Dotted path to the offending value, e.g. `items.0.id`. */
	path: string;
	/** Human-readable reason. */
	message: string;
}

/**
 * Thrown when the body does not match. Extends `TypeError`, so existing
 * `catch` blocks that check for a type error keep working.
 */
export class ValidationError extends TypeError {
	readonly issues: ValidationIssue[];
	/**
	 * The response that carried the invalid body.
	 * `undefined` when a request body (FormData) failed before sending, since no
	 * response exists yet.
	 */
	readonly response: Response | undefined;
	/** What to validate: `formData` failed before sending, `response` after. */
	readonly target: ValidationTarget;
	/** The value that failed, for logging. */
	readonly body: unknown;

	constructor(
		issues: ValidationIssue[],
		target: ValidationTarget,
		response: Response | undefined,
		body: unknown,
	) {
		const summary =
			issues.length === 1
				? `${issues[0].path || 'body'}: ${issues[0].message}`
				: `${issues.length} validation errors, first: ${issues[0].path || 'body'}: ${issues[0].message}`;
		const label = target === 'formData' ? 'FormData' : 'Response';
		super(`${label} validation failed — ${summary}`);
		this.name = 'ValidationError';
		this.issues = issues;
		this.target = target;
		this.response = response;
		this.body = body;
	}
}

/** What to validate: the request body before sending, or the response after. */
export type ValidationTarget = 'formData' | 'response';

export interface ValidateOptions<T = unknown> {
	/** A JSON-Schema-like description, checked by the built-in validator. */
	schema?: SimpleSchema;
	/**
	 * Your own validator. Return `true`/`undefined` when valid, or throw / return
	 * an error / return a list of issues when not.
	 *
	 * ```ts
	 * validate({ validate: (body) => HouseSchema.parse(body) })
	 * validate({ validate: (body) => ajv.validate(schema, body) || ajv.errors })
	 * ```
	 */
	validate?: (body: unknown, response: Response) => unknown;
	/** Run only for these statuses. Default: every non-empty body. */
	when?: (response: Response) => boolean;
	/** Keep the parsed body available on the error. Default `true`. */
	keepBody?: boolean;
}

/** Format an issue list from whatever a validator returned. */
function toIssues(result: unknown): ValidationIssue[] | null {
	// Conventional `{ valid: false, errors: [...] }` shapes and AJV's bare list.
	if (Array.isArray(result)) {
		if (!result.length) return null;
		return result.map((entry) => {
			if (entry && typeof entry === 'object') {
				const e = entry as { instancePath?: string; dataPath?: string; message?: string };
				return {
					path: (e.instancePath ?? e.dataPath ?? '').replace(/^\//, '').replace(/\//g, '.'),
					message: e.message ?? 'invalid',
				};
			}
			return { path: '', message: String(entry) };
		});
	}
	if (result === false) return [{ path: '', message: 'validator returned false' }];
	if (result instanceof Error) return [{ path: '', message: result.message }];
	return null;
}

/**
 * Validate the parsed body against a schema or a custom validator.
 *
 * @param options - A schema, a `validate` function, or both.
 */
export function validate<T = unknown>(options: ValidateOptions<T>): Plugin;
export function validate<T = unknown>(
	target: ValidationTarget,
	options: ValidateOptions<T>,
): Plugin;
export function validate<T = unknown>(
	targetOrOptions: ValidationTarget | ValidateOptions<T>,
	maybeOptions?: ValidateOptions<T>,
): Plugin {
	// Two call shapes:
	//   validate('formData', rules)  — explicit, always unambiguous
	//   validate(rules)              — defaults to 'formData', the common case
	const target: ValidationTarget =
		typeof targetOrOptions === 'string' ? targetOrOptions : 'formData';
	const options: ValidateOptions<T> =
		typeof targetOrOptions === 'string'
			? (maybeOptions ?? {})
			: targetOrOptions;

	if (target !== 'formData' && target !== 'response') {
		throw new TypeError(
			`validate() target must be 'formData' or 'response', got "${target}".`,
		);
	}

	if (!options.schema && typeof options.validate !== 'function') {
		throw new TypeError(
			`validate('${target}', …) needs a \`schema\` (JSON-Schema-like) or a ` +
				'`validate(value, response?)` function.',
		);
	}

	// The name carries the target: validating both the form and the response
	// means two use() calls, and use() skips a duplicate name.
	return target === 'formData'
		? formDataPlugin(options)
		: responsePlugin(options);
}

/** Validate the FormData before the request is sent. */
function formDataPlugin<T>(options: ValidateOptions<T>): Plugin {
	return {
		name: 'validate:formData',

		install({ onRequest }: PluginApi): void {
			onRequest((request) => {
				// Only a form body can be validated here. A JSON or binary payload is
				// not FormData. Since 'formData' is the DEFAULT target, skipping
				// silently would let a caller believe the response was checked, so
				// this is reported through the event the logger plugin prints.
				const data = request.formData;
				if (!data) {
					request.emit('validate-skipped', `validate('formData')`, request.toString());
					return;
				}

				const value = Object.fromEntries(
					[...data.entries()].map(([key, entry]) => [
						key,
						// Files carry bytes, not a comparable value; describe them so a
						// schema can still say "a File is required".
						typeof entry === 'string' ? entry : { name: entry.name, size: entry.size, type: entry.type },
					]),
				);

				validateValue(value, options, undefined, 'FormData');
			});
		},
	};
}

/** Validate the parsed response body. */
function responsePlugin<T>(options: ValidateOptions<T>): Plugin {
	return {
		name: 'validate:response',

		install({ onSuccess }: PluginApi): void {
			onSuccess((body, response) => {
				if (options.when && !options.when(response)) return;
				validateValue(body, options, response, 'response');
			});
		},
	};
}

/**
 * Run the configured validator against `value` and throw on failure.
 * Shared by both targets, so schema handling cannot drift between them.
 */
function validateValue<T>(
	value: unknown,
	options: ValidateOptions<T>,
	response: Response | undefined,
	label: string,
): void {
	// A custom validator wins, so AJV/Zod users are not second-guessed.
	const target: ValidationTarget = label === 'FormData' ? 'formData' : 'response';

	if (typeof options.validate === 'function') {
		const result = options.validate(value, response as Response);
		const issues = toIssues(result);
		if (issues) throw rejectWith(issues, target, response, value, options);
		return;
	}

	const issues = checkSchema(value, options.schema!, '');
	if (issues.length) throw rejectWith(issues, target, response, value, options);
}

/** Build the error for a failure on either target. */
function rejectWith<T>(
	issues: ValidationIssue[],
	target: ValidationTarget,
	response: Response | undefined,
	value: unknown,
	options: ValidateOptions<T>,
): ValidationError {
	return new ValidationError(
		issues,
		target,
		response,
		options.keepBody === false ? undefined : value,
	);
}

/** The default target when `validate(rules)` is called without one. */
export const DEFAULT_TARGET: ValidationTarget = 'response';

/**
 * A small JSON-Schema subset, so `validate({ schema })` works with no extra
 * dependency. Deliberately not a full implementation: `oneOf`, `$ref`,
 * `dependentSchemas` and format assertions are out of scope — pass AJV through
 * `validate:` when you need them.
 */
export function checkSchema(
	value: unknown,
	schema: SimpleSchema,
	path: string,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const add = (message: string) => issues.push({ path, message });

	if (value === null) {
		if (schema.nullable) return issues;
		if (schema.type === 'null') return issues;
		if (schema.type && schema.type !== 'null') {
			add(`expected ${describeType(schema.type)}, got null`);
		}
		return issues;
	}

	if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
		add(`expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
	}

	if (schema.type) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const matches = types.some((t) => matchesType(value, t));
		if (!matches) {
			add(`expected ${types.join(' or ')}, got ${actualType(value)}`);
			// A type mismatch makes deeper checks meaningless.
			return issues;
		}
	}

	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			add(`expected at least ${schema.minLength} characters`);
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			add(`expected at most ${schema.maxLength} characters`);
		}
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
			add(`does not match /${schema.pattern}/`);
		}
	}

	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) {
			add(`expected >= ${schema.minimum}`);
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			add(`expected <= ${schema.maximum}`);
		}
	}

	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			add(`expected at least ${schema.minItems} items`);
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			add(`expected at most ${schema.maxItems} items`);
		}
		if (schema.items) {
			value.forEach((item, i) => {
				issues.push(...checkSchema(item, schema.items!, join(path, String(i))));
			});
		}
	}

	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;

		for (const key of schema.required ?? []) {
			if (!(key in record)) issues.push({ path: join(path, key), message: 'is required' });
		}

		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (key in record) {
				issues.push(...checkSchema(record[key], child, join(path, key)));
			}
		}

		if (schema.additionalProperties === false && schema.properties) {
			const known = new Set(Object.keys(schema.properties));
			for (const key of Object.keys(record)) {
				if (!known.has(key)) {
					issues.push({ path: join(path, key), message: 'is not allowed' });
				}
			}
		}
	}

	return issues;
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

const actualType = (value: unknown): string =>
	value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

const describeType = (type: string | string[]): string =>
	Array.isArray(type) ? type.join(' or ') : type;

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'integer':
			return Number.isInteger(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'array':
			return Array.isArray(value);
		case 'null':
			return value === null;
		case 'object':
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		default:
			return true; // unknown type: do not fail on our own ignorance
	}
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

export default validate;
