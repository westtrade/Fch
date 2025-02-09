// src/mocks/handlers.js
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const handlers = [
	http.get("https://api.example.com/test", ({ request }) => {
		return HttpResponse.json([
			{ query: new URL(request.url).searchParams.toString() },
		]);
	}),

	http.get("https://api.example.com/status/200", ({ request }) => {
		return HttpResponse.text("ok", { status: 200 });
	}),

	http.get("https://api.example.com/status/500", ({ request }) => {
		return HttpResponse.text("error", { status: 500 });
	}),

	http.get("https://api.example.com/header/x-test", ({ request }) => {
		if (request.headers.get("X-Test") === "true") {
			return HttpResponse.text("ok", {
				status: 200,
				headers: { "X-Test-Response": "passed" },
			});
		}

		return HttpResponse.text("ok", {
			status: 400,
		});
	}),
];

export const server = setupServer(...handlers);
