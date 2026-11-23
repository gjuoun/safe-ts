import { type Outcome, Pipe, Policy, Runtime, Safe } from "../src/index.ts";

const store = new Map([
	["a", "doc:a"],
	["b", "doc:b"],
	["flaky", "doc:flaky"],
]);
let calls = 0;
const fetchDoc = (id: string) =>
	Safe.call(
		async (s) => {
			calls += 1;
			await s.sleep(20);
			const doc = store.get(id);

			if (doc === undefined || (id === "flaky" && calls < 3)) throw new Error(`no ${id}`);
			return doc;
		},
		() => `fetch_failed:${id}` as const,
	);

const jitter = (d: number) => d * 0.8 + Math.random() * 0.4 * d;
const flakyPolicy = Policy.pipe(Policy.exponential(10), [
	Policy.modifyDelay(jitter),
	Policy.while((s) => s.attempt <= 4),
]);

const fetchFlaky = (id: string) => fetchDoc(id).pipe(Pipe.retry(flakyPolicy), Pipe.timeout(1_000));

const open = (name: string) =>
	Safe.defer(
		Safe.call(() => {
			console.log(`open ${name}`);
			return name;
		}),
		(_r: string, exit) => console.log(`close ${name} (${exit._tag})`),
	);

const show = <A, E>(exit: Outcome<A, E>): string => {
	if (exit._tag === "success") return `ok: ${JSON.stringify(exit.value)}`;
	return exit._tag === "fail" ? `fail: ${JSON.stringify(exit.error)}` : exit._tag;
};

console.log("— retry + policy —");
calls = 0;
console.log(show(await Runtime.run(fetchFlaky("flaky"))), `(${calls} calls)`);

console.log("— timeout bounds the loop —");
const deadline = fetchDoc("zzz").pipe(Pipe.retry(Policy.spaced(500)), Pipe.timeout(30));
console.log(show(await Runtime.run(deadline)));

console.log("— forEach over pipes —");
const bulk = (ids: readonly string[]) =>
	Safe.forEach(ids, (id) => fetchDoc(id).pipe(Pipe.retry(flakyPolicy)), {
		concurrency: 2,
	});
console.log(show(await Runtime.run(bulk(["a", "b", "a", "b"]))));

console.log("— allSettled keeps every outcome —");
const partial = Safe.allSettled([fetchDoc("a"), fetchDoc("zzz"), fetchDoc("b")]);
console.log(show(await Runtime.run(partial)));

console.log("— cleanup composes in the same list —");
const work = Safe.try(function* () {
	yield* open("conn");
	return yield* fetchDoc("a").pipe(Pipe.retry(flakyPolicy));
}).pipe(Pipe.defer(() => console.log("request ended")));
console.log(show(await Runtime.run(work)));

console.log("— interrupt still releases —");
const slowWork = Safe.try(function* () {
	yield* open("slow-conn");
	return yield* Safe.call(async (s) => {
		await s.sleep(500);
		return "never";
	});
});
console.log(show(await Runtime.run(slowWork.pipe(Pipe.timeout(30)))));
