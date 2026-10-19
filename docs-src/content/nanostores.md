# Nano Stores

The request **is** a store. Attach the plugin and the `Fch` instance gains the
NanoStore contract — `get()`, `value`, `listen()`, `subscribe()` — so the same
object drives React, Preact, Vue, Svelte, Solid, Lit and Angular through the
standard `@nanostores/*` adapters, with no wrapper to install.

```ts
import { Fch } from "@westtrade/fch";
import { nanostores } from "@westtrade/fch/plugins/nanostores";

const req = new Fch("https://api.example.com/houses/1").use(nanostores());

req.get(); // { loading: false }
await req.json<House>(); // fills req.get().data
```

The state is:

```ts
interface StoreState<T> {
	loading: boolean; // true between request start and settle
	data?: T; // the parsed body
	error?: Error; // a normalised Error
	response?: Response; // the raw Response, when one arrived
}
```

There is no dependency on nanostores: the instance only implements the contract,
which is `get()`, a `value` property, and `listen()`. That is exactly what
`useStore()` needs.

## A form that works in every framework

One store, one submit handler, and the framework only renders it. The form is
the same everywhere; only the template changes.

```ts
// house-store.ts — framework-agnostic
import { Fch } from "@westtrade/fch";
import { nanostores } from "@westtrade/fch/plugins/nanostores";

export interface House {
	id: number;
	name: string;
	rooms: number;
}

// A fresh request per submit; the store lives on the instance.
export function createHouse() {
	return new Fch("https://api.example.com/houses", { method: "POST" }).use(
		nanostores(),
	);
}

export async function submitHouse(req: Fch, form: HTMLFormElement) {
	const [house] = await req.setFormData(form).json<House>();
	return house;
}
```

Every example below renders the same two things: `loading` and either `data` or
`error`. `useStore()` re-renders when the store changes, so nothing else is
needed.

### React & Preact

```tsx
import { useStore } from "@nanostores/react"; // or "@nanostores/preact"
import { useRef } from "react";
import { createHouse, submitHouse } from "./house-store";

export function HouseForm() {
	const req = useRef(createHouse()).current;
	const { loading, data, error } = useStore(req);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				submitHouse(req, e.currentTarget);
			}}
		>
			<input name="name" required />
			<input name="rooms" type="number" required />
			<button disabled={loading}>{loading ? "Saving…" : "Save"}</button>

			{error && <p role="alert">{error.message}</p>}
			{data && <p>Created house #{data.id}</p>}
		</form>
	);
}
```

### Vue

```vue
<script setup>
import { useStore } from '@nanostores/vue'
import { createHouse, submitHouse } from './house-store'

const req = createHouse()
const state = useStore(req)

function onSubmit(e) {
  submitHouse(req, e.target)
}
</script>

<template>
  <form @submit.prevent="onSubmit">
    <input name="name" required />
    <input name="rooms" type="number" required />
    <button :disabled="state.loading">
      {{ state.loading ? 'Saving…' : 'Save' }}
    </button>

    <p v-if="state.error" role="alert">{{ state.error.message }}</p>
    <p v-else-if="state.data">Created house #{{ state.data.id }}</p>
  </form>
</template>
```

### Svelte

Svelte reads the store with `$` because the instance satisfies the store
contract, including the immediate call that `subscribe()` must make:

```svelte
<script>
  import { createHouse, submitHouse } from './house-store'

  const req = createHouse()

  function onSubmit(e) {
    submitHouse(req, e.target)
  }
</script>

<form on:submit|preventDefault={onSubmit}>
  <input name="name" required />
  <input name="rooms" type="number" required />
  <button disabled={$req.loading}>
    {$req.loading ? 'Saving…' : 'Save'}
  </button>

  {#if $req.error}
    <p role="alert">{$req.error.message}</p>
  {:else if $req.data}
    <p>Created house #{$req.data.id}</p>
  {/if}
</form>
```

### Solid

```jsx
import { useStore } from "@nanostores/solid";
import { createHouse, submitHouse } from "./house-store";

export function HouseForm() {
	const req = createHouse();
	const state = useStore(req);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				submitHouse(req, e.currentTarget);
			}}
		>
			<input name="name" required />
			<input name="rooms" type="number" required />
			<button disabled={state().loading}>
				{state().loading ? "Saving…" : "Save"}
			</button>

			{state().error && <p role="alert">{state().error.message}</p>}
			{state().data && <p>Created house #{state().data.id}</p>}
		</form>
	);
}
```

### Lit

```ts
import { StoreController } from "@nanostores/lit";
import { LitElement, html } from "lit";
import { createHouse, submitHouse } from "./house-store";

class HouseForm extends LitElement {
	// `store.current` is the state; the controller re-renders on change.
	private store = new StoreController(this, createHouse());

	private onSubmit(e: SubmitEvent) {
		e.preventDefault();
		submitHouse(this.store.store, e.target as HTMLFormElement);
	}

	render() {
		const { loading, data, error } = this.store.value;

		return html`
			<form @submit=${this.onSubmit}>
				<input name="name" required />
				<input name="rooms" type="number" required />
				<button ?disabled=${loading}>${loading ? "Saving…" : "Save"}</button>

				${error ? html`<p role="alert">${error.message}</p>` : ""}
				${data ? html`<p>Created house #${data.id}</p>` : ""}
			</form>
		`;
	}
}

customElements.define("house-form", HouseForm);
```

### Angular

`@nanostores/angular` exposes the store as an `Observable`, which fits
`async`:

```ts
import { Component } from "@angular/core";
import { NanostoresService } from "@nanostores/angular";
import { Observable } from "rxjs";
import { createHouse, submitHouse, House } from "./house-store";

@Component({
	selector: "app-house-form",
	template: `
		<form (submit)="onSubmit($event)">
			<input name="name" required />
			<input name="rooms" type="number" required />
			<button [disabled]="(state$ | async)?.loading">
				{{ (state$ | async)?.loading ? "Saving…" : "Save" }}
			</button>

			@if ((state$ | async)?.error; as error) {
				<p role="alert">{{ error.message }}</p>
			}
			@if ((state$ | async)?.data; as data) {
				<p>Created house #{{ data.id }}</p>
			}
		</form>
	`,
})
export class HouseFormComponent {
	private req = createHouse();
	state$: Observable<unknown> = this.nanostores.useStore(this.req);

	constructor(private nanostores: NanostoresService) {}

	onSubmit(e: Event) {
		e.preventDefault();
		submitHouse(this.req, e.target as HTMLFormElement);
	}
}
```

## Vanilla JS

No framework and no adapter: `listen()` is all you need. This is the same form
with a render function.

```html
<form id="house-form">
	<input name="name" required />
	<input name="rooms" type="number" required />
	<button type="submit">Save</button>
	<p id="status"></p>
</form>

<script type="module">
	import { Fch } from "@westtrade/fch";
	import { nanostores } from "@westtrade/fch/plugins/nanostores";

	const form = document.getElementById("house-form");
	const status = document.getElementById("status");

	const req = new Fch("https://api.example.com/houses", {
		method: "POST",
	}).use(nanostores());

	// Render on every change: loading, then data or error.
	req.listen(({ loading, data, error }) => {
		status.textContent = loading
			? "Saving…"
			: error
				? error.message
				: data
					? `Created house #${data.id}`
					: "";
		form.querySelector("button").disabled = loading;
	});

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		// Fire and forget: the store reports the outcome.
		req.setFormData(form).json();
	});
</script>
```

`listen()` returns an unsubscribe function, which matters for a component that
mounts and unmounts:

```js
const off = req.listen(render);
// later
off();
```

## Mirroring into your own store

The request is a store, but sometimes a view should receive state without
holding the request object. Pass an existing store:

```ts
import { map } from "nanostores";

export const $house = map({ loading: false });

const req = new Fch("https://api.example.com/houses/1").use(
	nanostores({ store: $house }),
);

await req.json();
// $house.get() -> { loading: false, data: {...}, error: undefined, response }
```

A `map()` is patched key by key, so a subscriber to `data` is not woken when only
`loading` changes. An `atom()` is replaced wholesale on each change.

Both this store and the request stay in sync; the request is still the one that
runs.

### Keeping old data while reloading

By default `data` is cleared when a new request starts, so a view never shows
stale data next to a fresh error. To keep it (a common pattern for pagination):

```ts
const req = new Fch(url).use(nanostores({ clearOnRequest: false }));
```

`loading: true` plus the previous `data` lets a UI dim the old list instead of
blanking it.

## One request per submit

A `Fch` instance is a builder, and every execution sends a new request. So a
store on the instance is a fine place for "the current submit", not for a list:

```ts
// one store per submit, created fresh
const [house] = await new Fch("/houses", { method: "POST" })
	.use(nanostores())
	.setJsonBody(input)
	.json<House>();
```

If you need the state to outlive one request, pass your own store with
`{ store }` — that store is yours to keep.

## Caveats

- **The store lives on the instance.** Two requests on one instance share it;
  the second overwrites the first. For concurrent requests, use one instance per
  request, or separate stores.
- **`loading` is per execution.** A retried request stays `loading: true`
  throughout its retries, because they belong to one execution.
- **`data` is the parsed body.** For a binary response use `.blob()` and read the
  `response` in the state; `data` will be the text form.
- **`response` is the caller's response.** Do not consume its body; read `data`
  instead.
