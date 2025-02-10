import fch from "./Fch";

try {
	let counter = 0;
	const request = fch("https://reqres.in/api/users", {
		debug: true,
	});
	for await (const response of request.stream()) {
		counter = counter + 1;
		request.setSearchParams({
			page: String(counter),
		});
		console.log(await response.json());
	}
} catch (error) {
	console.error(error);
}
