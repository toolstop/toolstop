# toolstop

A set of small, stateless MCP servers on Cloudflare Workers, served at
`<name>.toolstop.dev`. This file is the operating manual.

## Adding a server

```
packages/mcp-<name>/
  tools.mjs      the only real work: tool definitions + handlers
  lib.mjs        the logic
  worker.mjs     3 lines, copy verbatim
  index.mjs      3 lines, copy verbatim (the stdio entrypoint)
  wrangler.toml  copy verbatim; only `name` changes
  server.json    name, hostname, description, transport
  package.json   npm metadata
  test.mjs
  README.md
```

Commit and push. CI discovers packages from the filesystem, tests, deploys,
smoke tests, and starts recording traffic. **Never edit a workflow to add a
server.** If that becomes necessary, `scripts/discover.mjs` is what needs
fixing.

`test.mjs` covers `lib.mjs`. Everything about the *tools* is covered by the
shared suites without writing a line, on one condition: every tool declares
`examples`. See below.

**One manual step per server:** attach `<name>.toolstop.dev` as a Worker custom
domain, once, from a session with a full-permission login:

```bash
npx wrangler deploy   # then attach the domain in the dashboard, or via API
```

**Do not put the custom domain in `wrangler.toml`.** Declaring a route makes
wrangler re-assert it on every deploy, which is a *zone-level* API call, and
that forces the CI token to carry `Zone > Workers Routes > Edit` on top of the
account-level script permission. The binding is one-time infrastructure and
survives deploys that declare no routes (verified). The hostname lives in
`server.json` instead.

`workers_dev = false` and `preview_urls = false` are pinned in every
`wrangler.toml`. Without them wrangler re-enables the `workers.dev` URL on each
deploy and the server answers on two addresses.

## Constraints that are not negotiable

**Zero persistent state per server.** No database, no vector index, no metered
upstream API. Per-server storage means per-server setup, migration and ops,
which stops being affordable at three servers. A request must be answerable
from its arguments alone.

**Telemetry records shape and outcome, never argument values.** A check-digit
server logging raw input would be storing real IBANs and card numbers, which is
a liability regardless of intent. `packages/_shared/transport.test.mjs` asserts
no raw value reaches telemetry. That is the test least worth breaking silently.

**A `classify` function forwards bounded codes, never free text.** This is the
subtle version of the rule above and it was violated for a while: `classify`
passed `result.reason` through, and validators build reasons like
`GB IBANs are 22 characters, got 20`, so the country code of a real IBAN went
into Analytics Engine. Prose that interpolates input is still input. Validators
return a `code` from a closed set (`format`, `length`, `unknown_country`,
`checksum`) and that is what gets recorded; `reason` stays in the response,
where the caller is reading their own data. The bounded code is better
telemetry anyway, since it groups in SQL and survives a reworded message.

**The client address is truncated to a network before anything hashes it.**
`sessionIdFrom` covers user agent, date, server name and the caller's IP, then
truncates SHA-256 to 8 bytes. Hashing the *full* IP did not anonymise it: the
IPv4 space is 32 bits and every other input is public, so the space was walkable
and the "anonymous" session id resolved back to one address. A hash does not
hide a value smaller than itself. `networkOf` now reduces to a /24 (IPv4) or
/48 (IPv6) first, so what is recoverable is an ISP allocation rather than a
subscriber.

Two things that look like details and are not. **`networkOf` must fail closed**:
anything it does not recognise returns `""`, because returning the input on a
parse miss puts the raw address straight back into the hash. And **IPv6 must be
expanded before truncation**, since slicing the raw string both malformed the
result (`2001:db8::1` produced `2001:db8:::/48`) and split one network across
two session ids depending on spelling. Four tests in `transport.test.mjs` cover
this; the property is invisible in the output, so nothing else would catch a
regression.

Cost of the fix, accepted deliberately: two callers behind one /24 running the
same client on the same day count as one session, so session counts are a lower
bound.

**Every tool declares `readOnlyHint` explicitly. The transport must never
default it.** It used to. `annotations: { readOnlyHint: true, ...t.annotations }`
meant the value was manufactured rather than declared, so the two checks that
"verified" it were reading back a constant and could not fail. The consequence
was not untidiness: the first write tool that forgot the hint would have been
advertised to every client as safe to auto-approve without asking a human.

`assertServerShape` in `_shared/http.mjs` now requires it, and runs once when a
transport is constructed, so a malformed server fails at deploy rather than at
request time. Both transports call it, since `runStdio` bypasses
`createFetchHandler` and would otherwise be ungated. `openWorldHint` still
defaults to `false`, which is honest: no server here has an upstream.

**Tool names are lower `snake_case`, verb first, and at most 21 characters.**
The limit is not arbitrary. Clients namespace as `mcp__<server>__<tool>` against
a hard 64-character cap in the Anthropic API, and an OAuth-connector prefix is
`mcp__` plus a 36-character UUID plus `__`, which is 43. A longer name works
locally and breaks on a directory install, which is the only distribution path
this project is testing. `smoke.mjs` enforces this on the wire.

**Tool descriptions state what a passing result does not mean.** For check
digits that is the whole ballgame: valid arithmetic is not a real account. Aim
for three or four sentences covering what it does, when to use it, what it
returns, and where it stops.

**Routing between tools goes in the server's `instructions`, not in each
description.** When two tools overlap, saying what each one does is not enough;
something has to say how to choose. `instructions` is the field MCP provides for
it, and it is paid once instead of once per tool. Where one tool's output feeds
another's input, say so in both places and make sure the values actually match:
`identify_format` used to return `EAN-13` where `validate_identifier` accepts
only `gtin`, so the documented handoff did not work.

**`instructions` also names the issue tracker, and that is the entire feedback
channel.** There is no `submit_feedback` tool and there should not be one. A sink
for it is per-server state and an upstream, so `openWorldHint: false` stops being
true and it becomes the first tool in the fleet with `readOnlyHint: false`. Worse,
a free-text argument is the one field no `classify` can bound: agents write prose
that interpolates their user's data, which is exactly how a real IBAN reached
Analytics Engine through `result.reason` above. The signal it would collect is
already in telemetry as outcome codes per tool per session, unbiased, and a tool
nobody calls is still paid for in every `tools/list` on every session.

So the agent tells its human and names the URL instead, and the human can be
answered. `conventions.test.mjs` derives the expected URL from `server.json`'s
`repository.url` rather than hardcoding it, so a new server inherits the check
and there is one spelling of the address per package.

**A shared property block is worth writing once and pointing at.** Spreading
`CHECK_RESULT_PROPERTIES` into a nested array schema cost about 1.1k characters
of every `tools/list` response to repeat what the model had already read one
field earlier. Prose in the array's own `description` says the same thing for a
quarter of the size. Schemas are the larger half of the payload, not
descriptions: measure before trimming prose.

**Every tool declares `examples`, and that is what makes it tested.** An
example is `{ args, expect }`, where `expect` is a subset match against
`structuredContent`. Declaring them is not documentation, it is the whole
testing contract for a tool:

- `behavior.test.mjs` calls every example through the HTTP transport, asserts
  the result conforms to the tool's own `outputSchema`, and asserts no argument
  value reaches telemetry.
- `stdio.test.mjs` runs the same examples against `index.mjs` as a child
  process.
- `tarball-check.mjs` runs them again against the installed npm package.
- `smoke.mjs` runs them against the live endpoint after deploy.

Before this existed, the only tools with call coverage were the three named by
hand in `transport.test.mjs`, so server #2 could have shipped with a handler
that threw on first call and CI would have been green: its own `test.mjs` tests
the library under the tools, not the tools. Give at least one example per tool
and prefer a failing case alongside a passing one, since a handler that returns
`valid: true` unconditionally passes any suite that only feeds it good input.
Use real published identifiers: a synthetic one is a valid call that proves
nothing about the answer. `examples` never reaches the wire, because
`tools/list` serializes named fields only.

All of the above is enforced by `packages/_shared/conventions.test.mjs`, which
walks `packages/mcp-*/tools.mjs` off the filesystem the way `discover.mjs` does.
A new server is covered the moment the directory exists, so adding one requires
no edit there either. Two of its checks are heuristics over description text and
will occasionally be wrong; when one misfires, widen the pattern rather than
working around it.

**A server carrying embedded data commits the generator that produced it, and
tests the data against its source rather than the library against the data.**
`export-control` embeds two federal tables. Its first generator was never
committed, only a pair of `curl` lines in the README, so the transformation was
unreviewable and unreproducible. Seven defects shipped and every one was green:
21 entries whose licence requirement is written as prose rather than as a table
lost it entirely and then answered `licenseRequired: false` for every
destination, including implements of torture, whose entry reads "a license is
required for ALL destinations"; XML entities were never decoded, so Türkiye was
stored as `T&#xFC;rkiye` and could not be found by any spelling; and every
string was cut at 220 characters mid-word, which hit 153 titles.

None of that is visible in the output. A truncated sentence still reads as a
sentence, an undecoded name still reads as a name, and an empty control list
renders as a clean negative answer. `test.mjs` covered the library's handling of
the data and could not see any of it, and the one test that would have caught
the reason-code corruption checked a single hand-picked entry that happened to
be clean.

Three rules follow, and they are cheap:

- **The generator asserts before it writes.** `scripts/gen-export-control.mjs`
  fails the build on an entry with a licence section and no control parsed out
  of it, a reason code outside the fourteen, a chart column that is not on the
  chart, or an undecoded entity in any string. A parser that cannot read its
  source must stop rather than emit a plausible table.
- **Data tests iterate the whole table.** Over all 637 entries, not one example.
  The cost is milliseconds and it is the only thing that finds the twentieth
  malformed entry.
- **The generator is named `scripts/gen-<name>.mjs` and runs on a schedule.**
  `refresh-data.yml` discovers generators by that filename, exactly as
  `discover.mjs` discovers servers by directory, so a second data-bearing server
  is covered by writing its generator and needs no workflow edit. It regenerates
  weekly and opens a PR when the tables move, with the version already bumped,
  because a regenerated table that never publishes is a fix nobody receives.

That schedule is not housekeeping. `export-control` shipped the 2026-01-01
edition and was seven months stale inside one release: 23 entries had been
amended, and 9A012 had been split so NS Column 1 no longer covers `.a.1`. The
server was reporting the superseded scope with no way to notice.

Two things about that workflow that look like details:

**`SOURCE_EDITION` is the title's `latest_issue_date`, not the date the
generator ran.** It is quoted back to callers as what the data is current to and
every tool description cites it, so the run date would be a false claim. It also
makes the output stable: labelling with today produces a diff every week, and
the refresh could not tell an amendment from the calendar. `data-diff.mjs`
ignores the edition string for the same reason, since upstream reissues the
whole title whenever any part of it changes.

**A PR opened with `GITHUB_TOKEN` does not run workflows.** GitHub blocks that
to stop a workflow triggering itself, so the refresh job runs the package tests,
the shared suites and the tarball check itself and reports them in the PR body.
The empty checks list on those PRs is expected, not a failure. The alternative
is a stored PAT, which is a standing credential for a weekly job.

**Servers are zero-dependency.** No MCP SDK, no zod. Stateless
request/response MCP makes hand-rolled dispatch small enough that dropping both
is worth it: faster cold starts, and no supply chain.

## Releasing

**Bump the version in `package.json`, `server.json` and `tools.mjs`, and push.**
That is the whole release process. CI publishes to npm and to the MCP registry
when it sees a version npm does not have, and does nothing when it does not, so
an ordinary code push is silent and there is no tag, changelog or release ritual
to remember.

Publishing runs after the smoke test, never in parallel with it. The registry
listing advertises the remote URL, so a listing published ahead of a working
endpoint points strangers at a broken server.

The three version strings must agree. `conventions.test.mjs` asserts it, along
with everything else the registry rejects on: the 100-character description cap,
the `<namespace>/<name>` pattern, and `mcpName` matching `server.json`'s `name`.
Those live in a test rather than being discovered at publish time, because a
registry rejection three jobs downstream is illegible.

**Every package is published under the `@toolstop` scope.** That is what makes
publishing scale, and it is load-bearing rather than cosmetic:

- **One credential for the whole portfolio.** `NPM_TOKEN` is a granular token
  scoped to `@toolstop`, so a new server needs no npm setup at all. npm steers
  CI toward trusted publishing instead, and it is right that an "All packages"
  token is too broad, but trusted publishing is configured one package at a time
  from a settings page that only exists *after* the package does. That is a
  manual web step per server plus a chicken-and-egg on every first publish.
  Selecting the scope is that advice in a form that survives server N.
- **Names stop being a land grab.** An unscoped `mcp-<thing>` has to be won
  again for every server and anyone can take the next one. The scope is claimed
  once and everything under it is yours.

Consequences to remember: a scoped package is private by default, so publishing
needs `--access public` or it fails on a free account. `conventions.test.mjs`
asserts the scope, so a server cannot quietly publish outside the token's reach.

Publishing passes `--provenance`, which attaches a signed link from the tarball
back to the commit and workflow run that built it. It needs `id-token: write`
but not OIDC auth, so a token publish keeps it. Worth more here than it sounds,
since the whole product asks strangers to trust an unknown vendor.

**Registry namespace is `dev.toolstop/<server>`, authenticated by a DNS TXT record on the
apex of `toolstop.dev`.** The alternative, `mcp-publisher login github-oidc`,
needs no stored secret at all, and it is the option the upstream docs recommend.
It is not used here because OIDC can only assert `io.github.<org>/*`. Now that
the repo lives in the `toolstop` org that would read as a vendor too, so this is
a closer call than it was, but `dev.toolstop` keys on the domain, which is the
asset actually owned and does not move if the code ever leaves GitHub. Reverse
it by changing two strings and swapping the login step.

The TXT record goes on the **apex**, not a `_mcp-auth` selector. MCP DNS auth is
SPF-style placement, and a selector fails with a generic signature error that
says nothing useful. Rotating keys means deleting the old record too: a stale
one is tried first and fails verification.

`key.pem` is the credential proving ownership of the namespace. It belongs in
the `MCP_PRIVATE_KEY` secret and nowhere in the repo.

## How the npm tarball is built

`bin` and `main` point into `dist/`, which does not exist in the repo. The
`prepack` hook builds it: `scripts/prepack.mjs` copies the server's own files
plus the three `_shared` transport files into `dist/` and rewrites the
`../_shared/` import prefix, because that path resolves in the repo but points
outside the package root, so npm would otherwise ship a tarball with no
transport in it.

```bash
npm pack                                   # from a package dir: the build CI ships
node scripts/tarball-check.mjs mcp-<name>  # pack it, install it, run it
```

`tarball-check.mjs` is the only thing that executes the artifact. It packs,
installs into a throwaway tree with no relationship to this repo, checks that
`bin` and `main` resolve, then speaks MCP to the installed binary over stdio and
asserts each tool answers its examples. Installing rather than running
`node dist/index.mjs` in place is the point: running it in place resolves
through the workspace and hides the exact failure being tested. It runs per
package in CI and again before publish.

Consequence in the repo: the workspace `node_modules/.bin/mcp-<name>` symlink
dangles until something has run prepack. To exercise a server over stdio during
development, run `node packages/mcp-<name>/index.mjs` directly.

Output is plain readable ESM, not a bundle. Someone deciding whether to trust a
server should be able to read exactly what they installed.

## Architecture

`packages/_shared/` holds everything reusable:

- `http.mjs` carries stateless MCP over `fetch`, plus the exported `dispatch`
  both transports share. Telemetry is emitted here, so every server gets it
  free.
- `telemetry.mjs` writes one row per request into Analytics Engine. Read the
  privacy note before adding fields.
- `stdio.mjs` runs the same dispatch over stdio. Note that stdio traffic is
  **invisible by design**: it runs on the user's machine and deliberately does
  not phone home.

A change under `_shared/` redeploys every server. That is intended.

### A GET is three different questions, and 405 answers only one

Every GET used to return `405 Method Not Allowed` whatever the path, which is
defensible for an endpoint that only speaks POST and was still wrong. Three
unrelated callers arrive by GET and they need different answers:

| Request | Answer | Why |
|---|---|---|
| `GET /` with `Accept: text/event-stream` | **405**, `Allow: POST` | The client is opening the server-initiated SSE stream. The transport spec says a server that does not offer one replies 405, so this is the one case the old behavior got right. |
| `GET /` from a browser | **200**, a small HTML page | A human evaluating an unknown vendor pasted the hostname in. An error page reads as "this is broken", which is the opposite of what the listing is for. |
| `GET /.well-known/…`, or any unknown path | **404** | A client probing `oauth-protected-resource` reads 404 as "no OAuth here" and proceeds. It has no defined reading for a 405, and neither does anything else walking well-known paths. |

`Accept` is the only thing separating the first two, since both are a GET on
`/`. Do not route them on user-agent.

This is measured, not hypothetical: `check-digits.toolstop.dev` served ~167 GET
405s a day, and the paths were agent and MCP discovery conventions being
enumerated by crawlers (`/.well-known/mcp.json`, `/.well-known/agent-card.json`,
`/.well-known/glama.json`, `/llms.txt`, `/openapi.json`, plus both OAuth
documents). 47 a day were bare `/`, some from a real browser.

The landing page is generated in `http.mjs` from the server object alone, so a
new server gets one with no extra file and it cannot drift from the tool list.
It interpolates server-supplied strings into HTML, so **anything added to it
must go through `escapeHtml`**; there is a test that fails if a tool title
escapes unescaped.

## Operations

```bash
npm test                                        # every server + shared transport
node --test packages/mcp-<name>/test.mjs        # one server's library
node --test packages/_shared/*.test.mjs         # every tool, both transports
node scripts/tarball-check.mjs mcp-<name>       # the npm artifact, installed
node scripts/smoke.mjs mcp-<name>               # every tool, live endpoint
npx wrangler deploy                             # from a package dir
```

CI needs exactly one Cloudflare permission: **Workers Scripts: Edit**. Not the
"Edit Cloudflare Workers" template, which bundles KV, R2, Routes and Tail that
nothing here uses. No client IP filtering, because GitHub runner IPs rotate.

Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`MCP_PRIVATE_KEY`, `NPM_TOKEN` (granular, read and write, scoped to the
`@toolstop` **scope** rather than to named packages).

**Secrets never go in `wrangler.toml`.** It is committed.

## Traps

**Analytics Engine lags, but it does converge.** 17 requests read back as 11
minutes after firing, and as all 17 the next day. A fresh reading undercounts;
it is not permanently lossy. Never judge traffic within minutes of generating
it.

**The wrangler OAuth token expires hourly.** A bare `curl` against the Analytics
SQL API will 401 for no obvious reason. Back-to-back SQL queries also 429, so
space them.

**Nothing has quotas yet.** A single agent loop can fire 30 to 80 tool calls per
user prompt. Pure-computation servers are low-exposure; the first server
touching anything metered turns that gap into a bill.

**`git push` needs the `workflow` scope** on the `gh` token to touch
`.github/workflows/`. Git also caches credentials separately from `gh`, so after
`gh auth refresh` a push can still fail with a stale token.
