# linear-claude-webhook-bridge

A Cloudflare Worker that receives Linear webhooks and starts a Claude Code routine.

Linear can't call a Claude routine's fire endpoint directly: the endpoint needs an `Authorization: Bearer` header and a `{"text": "..."}` body. This Worker verifies the webhook signature, drops events the routine doesn't act on, enriches the issue and project context from Linear's GraphQL API, and posts the result to the routine.

## Setup

### Create Claude routines

Create one at [claude.ai/code/routines](https://claude.ai/code/routines) for each webhook route you want. The UI may call it a scheduled task. The prompt is what the run does; this Worker only decides whether to fire it. Keep the prompt's keywords, labels, and assignees in sync with the route's `ROUTE_FILTERS` entry in `wrangler.jsonc`.

Edit each routine and add an API trigger. Copy the Fire URL, shaped like `https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire`, and generate a token.

Put them in `config.json`, which maps route name to routine. `/webhook/<name>` forwards to that routine. Start from the example; `config.json` is gitignored:

```sh
cp config.example.json config.json
```

```json
{
  "boticorn": { "url": "https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire", "token": "..." }
}
```

Route names may contain letters, digits, `-` and `_`. Upload it as the `ROUTINES` Worker secret, then upload the webhook secret and Linear app token:

```sh
mise run config:push
npx wrangler secret put LINEAR_WEBHOOK_SECRET
mise run secrets:push
```

Run `mise run config:push` again after editing `config.json`. With fnox, `mise run secrets:push` uploads `LINEAR_APP_TOKEN` from `fnox.toml`. When `LINEAR_APP_TOKEN` is set, the Worker fetches the issue's full metadata and project resources (`externalLinks` and `documents`) so comment webhooks carry the same project and repository links as issue webhooks.

### Add Linear webhooks

In Linear Settings -> API -> Webhooks, add a webhook:

- URL: `https://linear-claude-webhook-bridge.xxxxx.workers.dev/webhook/<name>`
- Signing secret: the same value as `LINEAR_WEBHOOK_SECRET`
- Data change events: **Issues** and **Comments**

### Set `vars` in `wrangler.jsonc`

These lists gate every route. Anything they reject is dropped:

| Var               | Forwards when                                                     |
| ----------------- | ----------------------------------------------------------------- |
| `ALLOWED_ACTORS`  | The actor (and, for comments, the comment author) is in the list  |
| `IGNORED_SENDERS` | Never. Stops the bot from triggering itself                       |

`ROUTE_FILTERS` maps each route name to the triggers that fire its routine, so one comment, label, or assignment only reaches the routes that watch it:

| Key                | Forwards when (`trigger` value)                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `COMMENT_KEYWORDS` | A `Comment` (`comment_mentioned`) or `Issue` description (`issue_mentioned`) adds that word        |
| `LABELS`           | An `Issue` is created with or adds that label (`labeled`)                                          |
| `ASSIGNEES`        | An `Issue` is assigned or delegated to that user or app name (`assigned`)                          |

```jsonc
"ROUTE_FILTERS": {
  "boticorn": { "COMMENT_KEYWORDS": ["@boticorn"], "ASSIGNEES": ["Boticorn"], "LABELS": ["boticorn", "boticorn-investigate"] }
}
```

Every forwarded `Issue` event lists the watched labels it added in `added_labels`, spelled as in `LABELS`, even when an assignment or mention fired it. A route that watches several labels uses it to tell them apart.

`wrangler.jsonc` sets `ALLOWED_ACTORS` to `David` and `IGNORED_SENDERS` to `Boticorn`. A missing list matches nothing. Names match case-insensitively, and `ALLOWED_ACTORS` and `ASSIGNEES` entries may start with `@`.

The checks run in this order:

1. Drop actors in `IGNORED_SENDERS` and app actors (`actor.type` is `app`).
2. `Comment` `create` or `update`: forward when both the actor and the comment author are in `ALLOWED_ACTORS` and the body mentions one of the route's `COMMENT_KEYWORDS`. An edit forwards only if it adds the keyword.
3. `Issue` `create` or `update`: forward when the actor is in `ALLOWED_ACTORS` and the event adds one of the route's `COMMENT_KEYWORDS` to the description, assigns or delegates the issue to one of `ASSIGNEES`, or adds a label in `LABELS`.
4. Drop everything else.

Filtered deliveries get a `202` with `skipped: <reason>` and a `skipped` log line, so they show as successful in Linear's webhook delivery log.

Deploy after changing vars or secrets: `mise run deploy`.

## Development

```sh
npm install
mise run test
mise run typecheck
npm run dev   # reads .dev.vars; copy .dev.vars.example
```

## License

MIT
