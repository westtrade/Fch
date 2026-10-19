# Forms & events

A browser `<form>` is the most common way to collect data, and `fetch` cannot
send one. Hand it a form and it stringifies:

```js
// Verified in Chrome:
new Request("/api/houses", { method: "POST", body: form }).text();
// "[object HTMLFormElement]"  with  content-type: text/plain;charset=UTF-8
```

No error. Your server receives a garbage string.

`Fch` accepts a form — or the submit event — anywhere a body goes, and follows
the HTML spec while converting it.

## Four spellings, one intent

```ts
form.onsubmit = (e) => {
	e.preventDefault();

	api.post("/houses", e);                  // the submit event
	api.post("/houses", e.target);           // the form element
	api.post("/houses", form);               // the element, by reference
	api.post("/houses", new FormData(form)); // already a FormData
};
```

All four produce the same request. The builder API accepts them too:

```ts
const req = new Fch("https://api.example.com/houses");
req.setFormData(e);        // event
req.setFormData(form);     // element
req.setFormData(fd);       // FormData
req.setBody(form);         // setBody understands forms as well
await req.send();
```

### By selector

When the form is somewhere else in the document, pass a CSS selector instead of
the element:

```tabs
=== class
const [order] = await new Fch("https://api.example.com/checkout")
	.setFormData("#checkout")
	.json<Order>();
=== function
const [order] = await api.request("/checkout").setFormData("#checkout").json<Order>();
=== literal
await fch`https://api.example.com/checkout`.request
	.setFormData("#checkout")
	.json();
```

`setFormFrom(selector)` is an explicit alias, for when you want the intent to be
obvious in a chain:

```ts
await api.request("/checkout").setFormFrom("#checkout").json();
```

Any selector works — `"#checkout"`, `'form[name="house"]'`, `".js-signup"`. The
matched element must be a `<form>`; anything else is rejected. The error names
the selector:

```text
TypeError: setFormData() found no <form> matching "#checkout".
```

> **Only in `setFormData`.** A string is a perfectly good request body, so
> `setBody("hello #world")` sends that text — it is never treated as a selector.
> That is why the selector lives on `setFormData()` / `setFormFrom()` and not in
> `setBody()`.

## What the conversion does

`Fch` calls the platform's `new FormData(form, submitter)` — it does **not**
reimplement form serialisation. That means the browser's own rules apply:

- disabled fields are excluded;
- unchecked checkboxes and radios are excluded;
- multi-selects produce repeated keys;
- `<input type="file">` contributes a `File`;
- an input's `name` is the key, its value is the value.

Then it adds the two things a browser would do on a real submit:

### The clicked submit button is included

When a submit button triggered the submission, its `name`/`value` pair belongs
in the body. `Fch` reads it from the event's `submitter`:

```html
<form method="post">
	<input name="name" value="Cottage" />
	<button type="submit" name="action" value="publish">Publish</button>
</form>
```

```ts
form.onsubmit = (e) => {
	e.preventDefault();
	api.post("/houses", e);
	// body includes: name=Cottage, action=publish
};
```

Without this, "which button was clicked" is lost — a classic bug in hand-rolled
form handlers.

### The form's own method is honoured

`setFormData` adopts the form's method when it declares something other than
`GET`. HTML only allows `get`, `post` and `dialog` here — the browser normalises
anything else to `get` — so in practice this means `POST`:

```html
<form method="post">   <!-- -> POST -->
<form method="get">    <!-- -> GET: fields go in the query string -->
<form>                 <!-- method defaults to get -> query string -->
```

To send a form body with a different verb, set the method on the builder
yourself; it wins over the form's attribute:

```ts
api.request("/houses/1").setMethod("PUT").setFormData(form).send();
```

### `method="get"` goes to the query string

HTML semantics: a `GET` form encodes its fields into the URL and sends no body.
`Fch` does exactly that:

```html
<form method="get"><input name="q" value="cottage" /></form>
```

```ts
const req = new Fch("https://api.example.com/search").setFormData(form);
req.toString();          // "https://api.example.com/search?q=cottage"
req.fetchOptions.body;   // undefined — no body
```

A form with no `method` attribute defaults to `get` in the browser, so it takes
the same path. File inputs contribute their filename to the query string, since
a URL cannot carry bytes.

### `Content-Type` is left to the runtime

The header is deliberately cleared, so `fetch` can set
`multipart/form-data; boundary=…` with the correct boundary. Setting it yourself
is the most common multipart bug:

```ts
// Wrong — the boundary will be missing and the server cannot parse the body:
req.setHeader("Content-Type", "multipart/form-data");

// Right — let Fch/fetch do it:
req.setFormData(form);
```

## Shortcut calls

The shortcut API accepts a form as the body, and applies the same rules. For
body-less shortcuts (`get`, `head`, `delete`) a form is serialised into the query
string, exactly as a browser would:

```ts
const api = fch.create({ baseUrl: "https://api.example.com" });

api.post("/houses", e);       // multipart body, form's method honoured
api.get("/search", form);     // ?q=cottage — no body
api.delete("/houses/1", { timeout: 5000 }); // 2nd arg is options, not a body
```

> Note the deliberate asymmetry: for `get`, `head` and `delete`, the second
> argument is **options**. Treating it as a body would silently send
> `{"timeout":5000}` upstream. To send a DELETE payload, use the builder:
> `api.request(url).setMethod("DELETE").setJsonBody(...)`.

## The `event` shapes that work

`Fch` accepts anything with a form in `target`, `currentTarget` or as the element
itself:

| Value | Resolved as |
| --- | --- |
| `HTMLFormElement` | itself |
| `SubmitEvent` (`target` = form) | `event.target` |
| event with `currentTarget` = form | `event.currentTarget` |
| `FormData` | passed through |
| plain object | JSON (shortcut calls only) |

If an object merely *looks* like a form (right `tagName`/`nodeType`) but is not a
real element of the current realm, `Fch` throws a clear `TypeError` instead of
silently sending the wrong body:

```text
TypeError: Could not read the form: the value is not a real <form> element of
this environment. In Node, parse the HTML with a DOM (e.g. jsdom) and pass the
element from that same window.
```

## Uploading files

A file input in the form is handled by the platform:

```html
<form method="post" enctype="multipart/form-data">
	<input name="title" />
	<input type="file" name="photo" accept="image/*" />
</form>
```

```ts
form.onsubmit = async (e) => {
	e.preventDefault();
	const [created] = await api.post("/photos", e).json<Photo>();
};
```

Or build the `FormData` yourself when you are not in a form:

```ts
const fd = new FormData();
fd.append("title", "Cottage");
fd.append("photo", file); // a File from an <input type="file">

await api.post("/photos", fd);
```

For incremental building on a builder:

```ts
const req = new Fch("https://api.example.com/photos");
req.appendToFormData("title", "Cottage")
	.appendToFormData("photo", file);
await req.send();
```

`appendToFormData` switches the method to `POST` (unless it is already `PUT`)
and clears `Content-Type` so the boundary is generated.

## URL-encoded forms

Classic HTML forms post `application/x-www-form-urlencoded` by default. If your
endpoint expects that, be explicit:

```ts
await api.request("/login")
	.setMethod("POST")
	.setFormUrlEncodedBody({ username: "alice", password: "s3cret" })
	.send();
```

Arrays repeat the key: `{ scopes: ["read", "write"] }` becomes
`scopes=read&scopes=write`.

## Recipes

### Progressive enhancement

Keep the plain form working, upgrade it when JS is available:

```html
<form method="post" action="/houses">
	<input name="name" required />
	<button type="submit">Add</button>
</form>
```

```ts
document.querySelector("form")!.onsubmit = async (e) => {
	e.preventDefault();
	const [house] = await api.post<House>("/houses", e);
	render(house);
};
```

The same handler works with `new FormData(form)`, `e.target` or `e` — pick one.

### Validation feedback from the server

```ts
const [result, response] = await api.post("/houses", e).json<{ errors?: FieldErrors }>();

if (response.status === 422) {
	showErrors(result.errors);
}
```

### A form with a GET search

```html
<form method="get" id="search"><input name="q" /></form>
```

```ts
search.onsubmit = async (e) => {
	e.preventDefault();
	const [results] = await api.get<Result[]>("/search", e).json();
};
```
