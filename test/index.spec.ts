import { describe, expect, it, vi, afterEach } from "vitest";
import worker, {
	type Env,
	type Filters,
	evaluateEvent,
	mentions,
	parseRoutines,
	routeFilters,
	routineText,
	skipReason,
	verifySignature,
} from "../src/index";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("verifySignature", () => {
	const secret = "It's a Secret to Everybody";
	const body = "Hello, World!";
	const rawHex = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

	it("accepts raw hex digest (Linear) and sha256= prefix", async () => {
		expect(await verifySignature(secret, bytes(body), rawHex)).toBe(true);
		expect(await verifySignature(secret, bytes(body), `sha256=${rawHex}`)).toBe(true);
	});

	it("rejects tampered body, wrong secret, and malformed headers", async () => {
		expect(await verifySignature(secret, bytes(body + "!"), rawHex)).toBe(false);
		expect(await verifySignature("nope", bytes(body), rawHex)).toBe(false);
		expect(await verifySignature(secret, bytes(body), null)).toBe(false);
		expect(await verifySignature(secret, bytes(body), "abc")).toBe(false);
		expect(await verifySignature("", bytes(body), rawHex)).toBe(false);
	});
});

describe("mentions", () => {
	it("matches whole handle only", () => {
		expect(mentions("hey @boticorn fix this", "@boticorn")).toBe(true);
		expect(mentions("@BotiCorn, please", "@boticorn")).toBe(true);
		expect(mentions("@boticorn-dev", "@boticorn")).toBe(false);
		expect(mentions("me@boticorn.com", "@boticorn")).toBe(false);
		expect(mentions("npm i @boticorn/cli", "@boticorn")).toBe(false);
	});
});

describe("evaluateEvent / skipReason", () => {
	const f: Filters = {
		ALLOWED_ACTORS: ["David"],
		COMMENT_KEYWORDS: ["@boticorn"],
		LABELS: ["claude"],
		ASSIGNEES: ["Boticorn"],
		IGNORED_SENDERS: ["Boticorn"],
	};
	const david = { name: "David", type: "user" };
	const stranger = { name: "Stranger", type: "user" };

	it("Comment: forwards keyword mentions on create and newly added on update", () => {
		expect(
			evaluateEvent(
				"Comment",
				{ action: "create", actor: david, data: { body: "hey @boticorn", user: david } },
				f,
			),
		).toEqual({ trigger: "comment_mentioned" });

		expect(
			skipReason("Comment", { action: "create", actor: david, data: { body: "hello", user: david } }, f),
		).toBe("no keyword");

		expect(
			evaluateEvent(
				"Comment",
				{
					action: "update",
					actor: david,
					data: { body: "hey @boticorn", user: david },
					updatedFrom: { body: "hey" },
				},
				f,
			),
		).toEqual({ trigger: "comment_mentioned" });

		expect(
			skipReason(
				"Comment",
				{
					action: "update",
					actor: david,
					data: { body: "hey @boticorn typo", user: david },
					updatedFrom: { body: "hey @boticorn" },
				},
				f,
			),
		).toBe("keyword already present");

		expect(
			skipReason("Comment", { action: "remove", actor: david, data: { body: "@boticorn", user: david } }, f),
		).toBe("action remove");
	});

	it("Issue: forwards newly delegated or assigned issues", () => {
		expect(
			evaluateEvent(
				"Issue",
				{
					action: "update",
					actor: david,
					data: { delegateId: "b1", delegate: { name: "Boticorn" } },
					updatedFrom: { delegateId: null },
				},
				f,
			),
		).toEqual({ trigger: "assigned" });

		// Unrelated update when already delegated does not re-trigger
		expect(
			skipReason(
				"Issue",
				{
					action: "update",
					actor: david,
					data: { delegateId: "b1", delegate: { name: "Boticorn" }, priority: 2 },
					updatedFrom: { updatedAt: "2026-11-04T00:00:00Z" },
				},
				f,
			),
		).toBe("no trigger matched");
	});

	it("Issue: forwards newly added watched labels", () => {
		expect(
			evaluateEvent(
				"Issue",
				{
					action: "update",
					actor: david,
					data: { labels: [{ id: "l1", name: "claude" }] },
					updatedFrom: { labelIds: [] },
				},
				f,
			),
		).toEqual({ trigger: "labeled", labels: ["claude"] });

		const two = { ...f, LABELS: ["claude", "claude-investigate"] };
		const both = [
			{ id: "l2", name: "Claude-Investigate" },
			{ id: "l1", name: "claude" },
		];

		// Reports only the newly added label, in its configured spelling
		expect(
			evaluateEvent(
				"Issue",
				{ action: "update", actor: david, data: { labels: both }, updatedFrom: { labelIds: ["l1"] } },
				two,
			),
		).toEqual({ trigger: "labeled", labels: ["claude-investigate"] });

		// Reports every watched label a create adds, in config order
		expect(evaluateEvent("Issue", { action: "create", actor: david, data: { labels: both } }, two)).toEqual({
			trigger: "labeled",
			labels: ["claude", "claude-investigate"],
		});

		// Carries added labels on an assignment in the same event
		expect(
			evaluateEvent(
				"Issue",
				{ action: "create", actor: david, data: { delegate: { name: "Boticorn" }, labels: both } },
				two,
			),
		).toEqual({ trigger: "assigned", labels: ["claude", "claude-investigate"] });

		// Label already present
		expect(
			skipReason(
				"Issue",
				{
					action: "update",
					actor: david,
					data: { labels: [{ id: "l1", name: "claude" }] },
					updatedFrom: { labelIds: ["l1"] },
				},
				f,
			),
		).toBe("no trigger matched");
	});

	it("Issue: forwards description mentions", () => {
		expect(
			evaluateEvent(
				"Issue",
				{
					action: "create",
					actor: david,
					data: { description: "Please check this @boticorn" },
				},
				f,
			),
		).toEqual({ trigger: "issue_mentioned" });
	});

	it("drops ignored senders, app actors, and non-allowed actors", () => {
		expect(
			skipReason("Issue", { action: "create", actor: { name: "Boticorn" }, data: {} }, f),
		).toBe("ignored sender");
		expect(
			skipReason("Issue", { action: "create", actor: { name: "SomeApp", type: "app" }, data: {} }, f),
		).toBe("bot sender");
		expect(
			skipReason("Issue", { action: "create", actor: stranger, data: { description: "@boticorn" } }, f),
		).toBe("actor not allowed");
	});
});

describe("routineText", () => {
	it("includes trigger, issue, project resources, and comment", () => {
		const payload = {
			action: "create",
			type: "Comment",
			actor: { name: "David" },
			url: "https://linear.app/digital-vibes/issue/D-652#comment-1",
			data: {
				id: "c1",
				body: "@boticorn fix this",
				user: { name: "David" },
				issue: { id: "i1", identifier: "D-652", title: "Test" },
			},
		};
		const enriched = {
			id: "i1",
			identifier: "D-652",
			number: 652,
			title: "Test Automation Issue",
			url: "https://linear.app/digital-vibes/issue/D-652",
			branchName: "david/d-652-test-automation-issue",
			state: "Backlog",
			priority: "No priority",
			team: { key: "D", name: "David" },
			project: {
				id: "p1",
				name: "mcp-server-stripe-org",
				url: "https://linear.app/digital-vibes/project/mcp-server-stripe-org",
				summary: "Stripe MCP",
				resources: [{ label: "GitHub repo", url: "https://github.com/dvcrn/mcp-server-stripe-org" }],
			},
			assignee: "David",
			delegate: "Boticorn",
			labels: ["claude"],
			description: "Issue body",
		};
		const text = routineText("Comment", "deliv-1", payload, "comment_mentioned", enriched);
		const [header, ...rest] = text.split("\n");
		expect(header).toBe("Linear-Event: Comment");
		const parsed = JSON.parse(rest.join("\n"));
		expect(parsed.trigger).toBe("comment_mentioned");
		expect(parsed.actor).toBe("David");
		expect(parsed.issue.identifier).toBe("D-652");
		expect(parsed.issue.project.resources).toEqual([
			{ label: "GitHub repo", url: "https://github.com/dvcrn/mcp-server-stripe-org" },
		]);
		expect(parsed.comment).toEqual({
			id: "c1",
			author: "David",
			body: "@boticorn fix this",
		});
	});

	it("includes the added labels for labeled events", () => {
		const payload = {
			action: "update",
			type: "Issue",
			actor: { name: "David" },
			data: { id: "i1", identifier: "D-652", labels: [{ id: "l1", name: "claude" }] },
		};
		const text = routineText("Issue", "deliv-2", payload, "labeled", undefined, ["claude"]);
		const parsed = JSON.parse(text.split("\n").slice(1).join("\n"));
		expect(parsed.trigger).toBe("labeled");
		expect(parsed.added_labels).toEqual(["claude"]);
	});
});

describe("parseRoutines & routeFilters", () => {
	it("parses valid routine map and rejects invalid ones", () => {
		const raw = JSON.stringify({ boticorn: { url: "https://a/fire", token: "t1" } });
		expect(parseRoutines(raw)).toEqual({ boticorn: { url: "https://a/fire", token: "t1" } });
		expect(parseRoutines("nope")).toBeUndefined();
	});

	it("merges route filters with global filters", () => {
		const env = {
			ALLOWED_ACTORS: ["David"],
			IGNORED_SENDERS: ["Boticorn"],
			ROUTE_FILTERS: {
				boticorn: { COMMENT_KEYWORDS: ["@boticorn"], ASSIGNEES: ["Boticorn"], LABELS: ["claude"] },
			},
		};
		expect(routeFilters(env, "boticorn")).toMatchObject({
			ALLOWED_ACTORS: ["David"],
			IGNORED_SENDERS: ["Boticorn"],
			COMMENT_KEYWORDS: ["@boticorn"],
			ASSIGNEES: ["Boticorn"],
			LABELS: ["claude"],
		});
	});
});

describe("worker.fetch", () => {
	const secret = "s3cret";
	const baseEnv: Env = {
		ALLOWED_ACTORS: ["David"],
		IGNORED_SENDERS: ["Boticorn"],
		ROUTE_FILTERS: {
			boticorn: { COMMENT_KEYWORDS: ["@boticorn"], ASSIGNEES: ["Boticorn"], LABELS: ["claude"] },
		},
		LINEAR_WEBHOOK_SECRET: secret,
		ROUTINES: JSON.stringify({ boticorn: { url: "https://api.anthropic.com/v1/fire", token: "tok1" } }),
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function sign(payload: string): Promise<string> {
		const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
		]);
		const sig = await crypto.subtle.sign("HMAC", key, bytes(payload));
		return Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	it("forwards matching events to the configured routine", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fired", { status: 200 }));
		const payload = JSON.stringify({
			action: "create",
			type: "Comment",
			actor: { name: "David" },
			data: { id: "c1", body: "@boticorn do this", user: { name: "David" }, issue: { id: "i1", identifier: "D-652" } },
		});
		const req = new Request("https://bridge.test/webhook/boticorn", {
			method: "POST",
			headers: {
				"linear-event": "Comment",
				"linear-delivery": "d1",
				"linear-signature": await sign(payload),
			},
			body: payload,
		});
		const res = await worker.fetch(req, baseEnv);
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/fire");
	});

	it("forwards the labels an Issue event added", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fired", { status: 200 }));
		const payload = JSON.stringify({
			action: "update",
			type: "Issue",
			actor: { name: "David" },
			data: { id: "i1", identifier: "D-652", labels: [{ id: "l1", name: "claude" }] },
			updatedFrom: { labelIds: [] },
		});
		const req = new Request("https://bridge.test/webhook/boticorn", {
			method: "POST",
			headers: { "linear-event": "Issue", "linear-delivery": "d2", "linear-signature": await sign(payload) },
			body: payload,
		});
		const res = await worker.fetch(req, baseEnv);
		expect(res.status).toBe(200);
		const { text } = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		const forwarded = JSON.parse(text.split("\n").slice(1).join("\n"));
		expect(forwarded.trigger).toBe("labeled");
		expect(forwarded.added_labels).toEqual(["claude"]);
	});
});
