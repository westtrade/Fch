# Fch - Enhanced Fetch Client

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A modern, feature-rich fetch client extending the native `URL` class. Supports retries, timeouts, interceptors, logging, and multiple data formats. Designed for robust HTTP communication in TypeScript/JavaScript.

## Features

-   **Retry Logic**: Automatically retry failed requests.
-   **Timeouts**: Configure request and retry timeouts.
-   **Interceptors**: Modify requests/responses globally.
-   **Logging**: Built-in or custom loggers (debug mode supported).
-   **Data Formats**: JSON, FormData, URL-encoded, Blob, and text.
-   **Abort Control**: Cancel requests via `AbortController`.
-   **Extensible**: Custom headers, auth tokens, CORS, and caching policies.
-   **Streaming**: Periodic request streaming with delays.

## Installation

```bash
npm install fch
# or
yarn add fch
```

## Usage

### Basic GET Request

```ts
import { fch } from "fch";

const api = fch("https://api.example.com/data", { timeout: 3000 });
const response = await api;
```

### POST with JSON Body

```ts
const api = fch("https://api.example.com/users").setJsonBody({
	name: "Alice",
	role: "admin",
});

const [data, response] = await api.json();
```

### Advanced Configuration

```ts
const api = fch("https://api.example.com", {
	retries: 3,
	retryTimeout: 1000,
	headers: { "X-Custom-Header": "value" },
})
	.addRequestInterceptor((req) => {
		req.headers.set("Timestamp", Date.now().toString());
	})
	.addResponseInterceptor(async (res) => {
		if (!res.ok) throw new Error("Request failed");
		return res;
	});

try {
	await api.get();
} catch (error) {
	console.error("Request failed after retries:", error);
}
```
