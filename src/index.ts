// Forwards Linear webhook deliveries to a Claude Code routine fire endpoint.

export interface Env {
	ALLOWED_ACTORS: readonly string[];
	IGNORED_SENDERS: readonly string[];
	ROUTE_FILTERS?: unknown;
	LINEAR_WEBHOOK_SECRET?: string;
	CLOUDFLARE_WEBHOOK_SIGNING_SECRET?: string;
	LINEAR_APP_TOKEN?: string;
	ROUTINES?: string;
}

export interface Filters {
	ALLOWED_ACTORS: readonly string[];
	COMMENT_KEYWORDS: readonly string[];
	LABELS: readonly string[];
	ASSIGNEES: readonly string[];
	IGNORED_SENDERS: readonly string[];
}

export type RouteTriggers = Partial<Pick<Filters, "COMMENT_KEYWORDS" | "LABELS" | "ASSIGNEES">>;
type GlobalFilters = Omit<Filters, keyof RouteTriggers> & { ROUTE_FILTERS?: unknown };

export type TriggerReason = "comment_mentioned" | "issue_mentioned" | "assigned" | "labeled";

interface User {
	id?: string;
	name?: string;
	email?: string;
	type?: string;
}

interface Label {
	id?: string;
	name?: string;
}

interface ProjectResource {
	label?: string;
	url?: string;
}

interface Project {
	id?: string;
	name?: string;
	url?: string;
	summary?: string;
	description?: string | null;
	resources?: ProjectResource[];
}

interface Team {
	id?: string;
	key?: string;
	name?: string;
}

interface State {
	id?: string;
	name?: string;
	type?: string;
}

interface IssueData {
	id?: string;
	identifier?: string;
	number?: number;
	title?: string;
	description?: string | null;
	url?: string;
	priority?: number;
	priorityLabel?: string;
	state?: State;
	team?: Team;
	project?: Project | null;
	assigneeId?: string | null;
	assignee?: User | null;
	delegateId?: string | null;
	delegate?: User | null;
	labelIds?: string[];
	labels?: Label[];
	// Present on Comment events:
	body?: string;
	user?: User | null;
	issue?: {
		id?: string;
		identifier?: string;
		title?: string;
		url?: string;
		team?: Team;
	};
}

export interface WebhookPayload {
	action?: string;
	type?: string;
	organizationId?: string;
	webhookTimestamp?: number;
	url?: string;
	actor?: User;
	data?: IssueData;
	updatedFrom?: {
		body?: string;
		description?: string | null;
		assigneeId?: string | null;
		delegateId?: string | null;
		labelIds?: string[];
		stateId?: string;
		projectId?: string | null;
	};
}

const ROUTINE_HEADERS = {
	"anthropic-version": "2023-06-01",
	"anthropic-beta": "experimental-cc-routine-2026-04-01",
	"Content-Type": "application/json",
};
const ROUTINE_TIMEOUT_MS = 9_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
		}

		const pathname = new URL(request.url).pathname;
		const route =
			pathname === "/" ? defaultRoute(env) : pathname.match(/^\/webhook\/([A-Za-z0-9_-]+)$/)?.[1];
		if (!route) return new Response("not found", { status: 404 });

		const routines = env.ROUTINES ? parseRoutines(env.ROUTINES) : undefined;
		if (env.ROUTINES && !routines) {
			log("config_invalid", { route });
			return new Response("ROUTINES secret is invalid", { status: 500 });
		}
		const routine = routines && Object.hasOwn(routines, route) ? routines[route] : undefined;
		if (routines && !routine) return new Response("not found", { status: 404 });

		const event = request.headers.get("linear-event");
		const delivery = request.headers.get("linear-delivery");
		const signature = request.headers.get("linear-signature");
		const raw = new Uint8Array(await request.arrayBuffer());

		const secret = env.LINEAR_WEBHOOK_SECRET ?? env.CLOUDFLARE_WEBHOOK_SIGNING_SECRET ?? "";
		if (!(await verifySignature(secret, raw, signature))) {
			log("rejected", { route, event, delivery });
			return new Response("invalid signature", { status: 401 });
		}
		if (!event) return new Response("missing Linear-Event", { status: 400 });

		const payload = parsePayload(raw);
		if (!payload) return new Response("expected a JSON object payload", { status: 400 });

		const decision = evaluateEvent(event, payload, routeFilters(env, route));
		if (decision.skip) {
			log("skipped", { route, event, delivery, action: payload.action, reason: decision.skip });
			return new Response(`skipped: ${decision.skip}`, { status: 202 });
		}

		const issueId = payload.data?.issue?.id ?? payload.data?.id;
		const enrichedIssue =
			env.LINEAR_APP_TOKEN && issueId ? await fetchIssueContext(env.LINEAR_APP_TOKEN, issueId) : undefined;
		const text = routineText(event, delivery, payload, decision.trigger, enrichedIssue, decision.labels);

		if (!routine) {
			log("would_forward", { route, event, delivery, action: payload.action, trigger: decision.trigger, text });
			return new Response(text, { status: 200 });
		}

		try {
			const res = await fetch(routine.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${routine.token}`, ...ROUTINE_HEADERS },
				body: JSON.stringify({ text }),
				signal: AbortSignal.timeout(ROUTINE_TIMEOUT_MS),
			});
			const detail = await res.text();
			log("forwarded", {
				route,
				event,
				delivery,
				action: payload.action,
				trigger: decision.trigger,
				status: res.status,
			});
			return new Response(detail, { status: res.ok ? 200 : 502 });
		} catch (err) {
			log("forward_failed", {
				route,
				event,
				delivery,
				action: payload.action,
				trigger: decision.trigger,
				error: String(err),
			});
			return new Response("routine request failed", { status: 502 });
		}
	},
} satisfies ExportedHandler<Env>;

export interface Routine {
	url: string;
	token: string;
}

export function parseRoutines(raw: string | undefined): Record<string, Routine> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw ?? "");
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	for (const r of Object.values(value)) {
		if (typeof r?.url !== "string" || typeof r?.token !== "string") return undefined;
	}
	return value as Record<string, Routine>;
}

function defaultRoute(env: Env): string | undefined {
	const rf = env.ROUTE_FILTERS;
	if (typeof rf === "object" && rf !== null && !Array.isArray(rf)) {
		const keys = Object.keys(rf);
		if (keys.length === 1) return keys[0];
	}
	return undefined;
}

export function routeFilters(env: GlobalFilters, route: string): Filters {
	const all = env.ROUTE_FILTERS;
	const entry =
		typeof all === "object" && all !== null && Object.hasOwn(all, route)
			? (all as Record<string, RouteTriggers | null | undefined>)[route]
			: undefined;
	return {
		...env,
		COMMENT_KEYWORDS: entry?.COMMENT_KEYWORDS ?? [],
		LABELS: entry?.LABELS ?? [],
		ASSIGNEES: entry?.ASSIGNEES ?? [],
	};
}

function parsePayload(raw: Uint8Array): WebhookPayload | undefined {
	try {
		const value: unknown = JSON.parse(decoder.decode(raw));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as WebhookPayload)
			: undefined;
	} catch {
		return undefined;
	}
}

export function skipReason(event: string, payload: WebhookPayload, f: Filters): string | undefined {
	return evaluateEvent(event, payload, f).skip;
}

export function evaluateEvent(
	event: string,
	payload: WebhookPayload,
	f: Filters,
): { trigger?: TriggerReason; labels?: string[]; skip?: string } {
	const actor = payload.actor;
	if (includesName(f.IGNORED_SENDERS, actor?.name)) return { skip: "ignored sender" };
	if (actor?.type === "app") return { skip: "bot sender" };
	const isActor = (user?: User | null) => includesName(f.ALLOWED_ACTORS, user?.name, actorKey);
	const action = payload.action;
	const data = payload.data;

	switch (event) {
		case "Comment": {
			if (action !== "create" && action !== "update") return { skip: `action ${action}` };
			if (!isActor(actor) || !isActor(data?.user)) return { skip: "actor not allowed" };
			const keywords = Array.isArray(f.COMMENT_KEYWORDS) ? f.COMMENT_KEYWORDS : [];
			const matched = keywords.filter((k) => mentions(data?.body ?? "", k));
			if (matched.length === 0) return { skip: "no keyword" };
			if (action === "update") {
				const prev = payload.updatedFrom?.body;
				if (prev === undefined) return { skip: "body unchanged" };
				if (matched.every((k) => mentions(prev, k))) return { skip: "keyword already present" };
			}
			return { trigger: "comment_mentioned" };
		}

		case "Issue": {
			if (action !== "create" && action !== "update") return { skip: `action ${action}` };
			if (!isActor(actor)) return { skip: "actor not allowed" };

			// Watched labels this event added, in their configured spelling. Every Issue
			// trigger carries them, so a routine sees a label added together with an
			// assignment or mention.
			const prevLabelIds = new Set(payload.updatedFrom?.labelIds ?? []);
			const newLabels = (data?.labels ?? []).filter(
				(l) => action === "create" || (payload.updatedFrom?.labelIds !== undefined && !prevLabelIds.has(l.id ?? "")),
			);
			const addedLabels = (Array.isArray(f.LABELS) ? f.LABELS : []).filter((w) =>
				includesName(newLabels.map((l) => l.name ?? ""), w),
			);
			const labels = addedLabels.length > 0 ? { labels: addedLabels } : {};

			// 1. Mention in issue description
			const keywords = Array.isArray(f.COMMENT_KEYWORDS) ? f.COMMENT_KEYWORDS : [];
			const matchedKeywords = keywords.filter((k) => mentions(data?.description ?? "", k));
			const descMentioned =
				matchedKeywords.length > 0 &&
				(action === "create" ||
					(payload.updatedFrom !== undefined &&
						"description" in payload.updatedFrom &&
						!matchedKeywords.every((k) => mentions(payload.updatedFrom?.description ?? "", k))));
			if (descMentioned) return { trigger: "issue_mentioned", ...labels };

			// 2. Assigned or delegated to watched user/agent
			const assigneeWatched = includesName(f.ASSIGNEES, data?.assignee?.name, actorKey);
			const delegateWatched = includesName(f.ASSIGNEES, data?.delegate?.name, actorKey);
			const newlyAssigned =
				(assigneeWatched &&
					(action === "create" || (payload.updatedFrom !== undefined && "assigneeId" in payload.updatedFrom))) ||
				(delegateWatched &&
					(action === "create" || (payload.updatedFrom !== undefined && "delegateId" in payload.updatedFrom)));
			if (newlyAssigned) return { trigger: "assigned", ...labels };

			// 3. Labeled with watched label
			if (addedLabels.length > 0) return { trigger: "labeled", ...labels };

			return { skip: "no trigger matched" };
		}

		default:
			return { skip: `event ${event}` };
	}
}

export interface EnrichedIssue {
	id: string;
	identifier: string;
	number: number;
	title: string;
	description?: string | null;
	url: string;
	branchName?: string;
	state?: string;
	priority?: string;
	team?: { key?: string; name?: string };
	assignee?: string;
	delegate?: string;
	labels?: string[];
	project?: Project;
}

const ISSUE_CONTEXT_QUERY = `
query IssueContext($id: String!) {
  issue(id: $id) {
    id
    identifier
    number
    title
    description
    url
    branchName
    state { name }
    priorityLabel
    team { key name }
    assignee { name }
    delegate { name }
    labels { nodes { name } }
    project {
      id
      name
      url
      description
      content
      externalLinks {
        nodes {
          label
          url
        }
      }
      documents {
        nodes {
          title
          url
        }
      }
    }
  }
}
`;

export async function fetchIssueContext(token: string, issueId: string): Promise<EnrichedIssue | undefined> {
	try {
		const res = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ query: ISSUE_CONTEXT_QUERY, variables: { id: issueId } }),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as {
			data?: {
				issue?: {
					id: string;
					identifier: string;
					number: number;
					title: string;
					description?: string | null;
					url: string;
					branchName?: string;
					state?: { name?: string };
					priorityLabel?: string;
					team?: { key?: string; name?: string };
					assignee?: { name?: string } | null;
					delegate?: { name?: string } | null;
					labels?: { nodes?: Array<{ name: string }> };
					project?: {
						id: string;
						name: string;
						url: string;
						description?: string;
						content?: string | null;
						externalLinks?: { nodes?: Array<{ label: string; url: string }> };
						documents?: { nodes?: Array<{ title: string; url: string }> };
					} | null;
				};
			};
		};
		const i = body.data?.issue;
		if (!i) return undefined;
		const p = i.project;
		const links = [
			...(p?.externalLinks?.nodes?.map((n) => ({ label: n.label, url: n.url })) ?? []),
			...(p?.documents?.nodes?.map((d) => ({ label: d.title, url: d.url })) ?? []),
		];
		return {
			id: i.id,
			identifier: i.identifier,
			number: i.number,
			title: i.title,
			url: i.url,
			branchName: i.branchName || undefined,
			state: i.state?.name,
			priority: i.priorityLabel,
			team: i.team,
			project: p
				? {
						id: p.id,
						name: p.name,
						url: p.url,
						summary: p.description || undefined,
						description: p.content || undefined,
						resources: links.length > 0 ? links : undefined,
					}
				: undefined,
			assignee: i.assignee?.name,
			delegate: i.delegate?.name,
			labels: i.labels?.nodes?.map((l) => l.name),
			description: i.description,
		};
	} catch {
		return undefined;
	}
}

export function routineText(
	event: string,
	delivery: string | null,
	p: WebhookPayload,
	trigger?: TriggerReason,
	enriched?: EnrichedIssue,
	addedLabels?: string[],
): string {
	return `Linear-Event: ${event}\n${JSON.stringify(slimPayload(delivery, p, trigger, enriched, addedLabels), null, 2)}`;
}

export function slimPayload(
	delivery: string | null,
	p: WebhookPayload,
	trigger?: TriggerReason,
	enriched?: EnrichedIssue,
	addedLabels?: string[],
): object {
	const d = p.data;
	const isComment = p.type === "Comment" || Boolean(d?.issue);
	const issue: IssueData | undefined = isComment ? d?.issue : d;
	return {
		delivery: delivery ?? undefined,
		trigger,
		// Watched labels this event added (unlike `issue.labels`, which lists all of them).
		added_labels: addedLabels,
		action: p.action,
		actor: p.actor?.name,
		url: p.url,
		issue:
			enriched ??
			(issue && {
				id: issue.id,
				identifier: issue.identifier,
				number: issue.number,
				title: issue.title,
				url: issue.url,
				state: issue.state?.name,
				priority: issue.priorityLabel,
				team: issue.team ? { key: issue.team.key, name: issue.team.name } : undefined,
				project: issue.project
					? { id: issue.project.id, name: issue.project.name, url: issue.project.url }
					: undefined,
				assignee: issue.assignee?.name,
				delegate: issue.delegate?.name,
				labels: issue.labels?.map((l) => l.name),
				description: issue.description,
			}),
		comment: isComment
			? {
					id: d?.id,
					author: d?.user?.name,
					body: d?.body,
					previous_body: p.updatedFrom?.body,
				}
			: undefined,
	};
}

const nameKey = (s: unknown) => String(s ?? "").toLowerCase();
const actorKey = (s: unknown) => nameKey(s).replace(/^@/, "");

function includesName(list: readonly string[] | undefined, name: unknown, key = nameKey): boolean {
	const n = key(name);
	return n !== "" && Array.isArray(list) && list.some((x) => key(x) === n);
}

export function mentions(text: string, mention: string): boolean {
	const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w/-])${escaped}(?![\\w/-])`, "i").test(text);
}

export async function verifySignature(
	secret: string,
	body: Uint8Array,
	header: string | null,
): Promise<boolean> {
	if (!secret) return false;
	const hex = header?.match(/^(?:sha256=)?([0-9a-f]{64})$/i)?.[1];
	if (!hex) return false;
	const sig = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, sig, body);
}

function log(msg: string, fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ msg, ...fields }));
}
