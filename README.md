# Local SEO

Local SEO is a local-first React + SQLite SEO workstation. It runs as a single
local app with SQLite storage, one local admin account, and optional external
data connectors only when you configure them.

![Local SEO site audit overview for waka.pt](docs/screenshots/local-seo-waka-audit-overview.jpg)

## Features

- Single local admin login
- Local SQLite sites, keywords, rank tracking, scans, AI jobs, config, and cache
- Real local crawler data for technical SEO scans
- Real DuckDuckGo suggestions/search results for free keyword ideas and web SERP checks
- Optional self-hosted OpenSERP or SearXNG for free/local SERP and rank checks
- Google Search Console OAuth, performance querying, and full local syncs of Search Analytics rows
- Search Console × crawl insights, keyword cannibalization, and content decay from stored Search Console rows
- Core Web Vitals from Google PageSpeed Insights (field data only when Google has it)
- Optional scheduled scans and rank checks (off by default) with in-app notifications
- Self-contained HTML scan reports to share with clients
- Local Codex jobs with medium reasoning by default
- Local MCP JSON-RPC endpoint at `/mcp`
- Shadcn-style React UI with a warm Tracking-inspired design system

## Local Workflows

- **Sites:** saved websites with domain, crawl URL preferences, optional keyword tool defaults, and notes.
- **Keyword research:** real DuckDuckGo suggestions, plus keyword metrics CSV import for volume, CPC, difficulty, and intent. Metrics are never generated locally. Imports accept one-column keyword lists, `;`/`,` delimiters, and localized numbers (`1.200`, `0,45`, `1.2K`, `$3.25`); ranges such as `1K – 10K` stay empty, and Search Console impressions are never read as search volume.
- **SERP analysis:** live web result snapshots (OpenSERP, SearXNG, or DuckDuckGo — not Google), active-site ownership, ranking-page tables, and history.
- **Saved keywords:** local canonical keyword list, filtering, managed tags, bulk tag edits, bulk delete, and CSV export.
- **Rank tracking:** local trackers, tracked keyword CRUD, manual checks from real search results, run history, and historical snapshots. Checks run in the background. A keyword whose search fails (for example DuckDuckGo answering HTTP 202 when it rate limits) is recorded as an error on the run instead of a "not ranking" snapshot; a run is `completed` only when every keyword was checked, otherwise `partial` or `failed`, and only completed runs feed the latest positions and the trend. Results page until the tracker depth and each snapshot stores the depth actually checked, so a miss reads "not in the top N checked". The tracker market and language are passed to providers that support them (DuckDuckGo region, SearXNG language, OpenSERP language); none of them can emulate a device.
- **Organic research:** local crawl pages plus organic CSV imports for ranked keywords, top pages, traffic, and keyword counts.
- **Links and backlinks:** local crawl link graph from scans, plus backlink CSV import for web-wide backlink rows, referring domains, and top linked pages. Backlinks are never generated locally. Follow state comes from the export's rel, Nofollow/UGC/Sponsored, or follow columns; rows without it stay unknown and the dofollow ratio covers known rows only.
- **Site scans:** local crawler for titles, descriptions, metadata length, H1/H2, heading hierarchy, canonicals, noindex, robots, sitemap indexes, schema, social tags, page response timing, missing/generic/long image alt text, image dimensions, broken links, broken images, broken CSS/JS assets, duplicate titles/descriptions/content, issue groups, progress, detail inspection, and deletion.
- **Search Console insights:** `GET /api/sites/:id/insights/gsc-crawl` matches stored Search Console pages with a completed crawl (pages with impressions that are noindex, non-200, redirected, canonicalized elsewhere, or blocked; indexable pages without impressions; Search Console pages the crawl never reached or that are missing from the sitemap; and pages whose CTR is under half the site's own median CTR at the same position). `insights/cannibalization` lists queries where two or more pages each earn at least 10% of the impressions (from query + page rows), with the URLs rank checks recorded for that keyword. `insights/decay` compares two windows of stored page data (default: the last 28 stored days vs the 28 before) and shows page changes between the latest two scans. URLs match ignoring protocol, `www`, fragments, and trailing slashes. Without the data they need, these answer `available: false` with the reason and never estimate.
- **Core Web Vitals:** `POST /api/sites/:id/cwv` runs PageSpeed Insights in the background (2 at a time) for chosen URLs, or the latest scan's most linked indexable pages. Field values are the Chrome UX Report p75 values PSI returns for the URL (`null` when Google has none), origin field data is kept separately, and lab values come from Lighthouse.
- **Schedules and notifications:** each site can scan itself and each rank tracker can check its keywords daily, weekly, or monthly while the app is running (`/api/sites/:id/schedule`, `/api/rank-trackers/:id/schedule`). Everything is off until you turn it on. Next run times live in SQLite, so a restart picks them up; a job whose site or tracker is already running skips that slot. Notifications (`/api/notifications`) report scans with regressions against the previous scan, failed scheduled scans, and failed or partial scheduled rank checks; they stay until you delete them.
- **Client report:** `GET /api/scans/:id/report.html` (add `?download=1` to save it) is a single print-friendly HTML file with the scan summary, open issues by severity and category, issue groups with why/how to fix and example URLs, regressions, and a short Search Console summary when data is stored. `GET /api/scans/:id/ai-context` returns a compact brief for a Codex prioritisation job (`POST /api/ai/jobs` with `type`, `scanId`, and `context`).
- **Brand lookup:** real web-search evidence without generated answer-model claims. Per-name numbers are raw counts of results returned for an exact-phrase search (first 10 checked), not a share of voice.
- **Prompt explorer:** local Codex jobs saved in SQLite.
- **Google Search Console:** OAuth connection, property picker, disconnect, live search analytics queries, full syncs stored in SQLite, CSV imports, and a URL inspection helper. Synced and imported rows are read the same way through `GET /api/sites/:id/gsc/rows`.
- **Local AI lab:** Codex-backed SEO coach, clustering, scan prioritization, competitor gaps, and AI visibility jobs.
- **MCP:** local tools for sites, keyword research, saved keywords, organic research, backlinks, SERP, rank trackers, scans and scan issues, GSC performance, syncs, stored GSC rows, Search Console insights, PageSpeed, schedules, notifications, GSC URL inspection, brand lookup, prompt explorer, and Codex jobs.

## Quickstart

```sh
bun install
bun run db:init
bun run dev
```

Open `http://localhost:5173` during development. The API runs on
`http://localhost:3031` by default.

`.env` is optional for the local product. Create it only when connecting
optional data-source credentials such as Google OAuth, a self-hosted OpenSERP
or SearXNG URL, MCP token, or a custom Codex
model. In-app Settings are for app preferences, not secret fields.
If you override storage, `DB_PATH` points to the database directory; the app
owns the `local-seo.sqlite` filename.

The first load lets you create the local admin user in the browser. You can also
create or update it from the terminal:

```sh
bun run admin:create
bun run admin:password
```

## Google Search Console

Create an OAuth client (type "Web application") in Google Cloud, put its id and
secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and register
exactly one authorized redirect URI:

```text
<APP_URL>/api/gsc/callback
```

With the defaults that is `http://localhost:5173/api/gsc/callback`. When you run
the built app with `bun run start`, set `APP_URL` to the address you open it on
(for example `http://localhost:3031`) and register
`http://localhost:3031/api/gsc/callback`. The Search Console status endpoint
(`GET /api/gsc/status/:siteId`) returns the exact `redirectUri` to register.

The sign-in callback only completes in a browser that is signed in to Local SEO,
and only for a single-use state issued by this server within the last 10
minutes; the site comes from that state. Callbacks on the old per-site form
(`/api/gsc/callback?siteId=...`) are still accepted. If Google revokes the
grant, the status reports `needsReconnect: true` until you reconnect.

`POST /api/sites/:id/gsc/sync` with `{ startDate, endDate, dimensions }` pages
through every Search Analytics row (25,000 per request) and stores them as one
local batch. CSV imports are stored the same way, so
`GET /api/sites/:id/gsc/rows?dimensions=query,page&startDate=...&endDate=...&limit=...&offset=...`
reads either.

## Search Providers

SERP analysis, rank checks, and brand lookups use a self-hosted OpenSERP
(`OPENSERP_URL`) or SearXNG (`SEARXNG_URL`) when configured, and otherwise the
built-in DuckDuckGo HTML fallback. A provider that errors or returns an empty
page hands over to the next one; when all fail, the check records the error.
DuckDuckGo requests are paced, since bursts get rate limited.
`DUCKDUCKGO_HTML_URL` overrides the DuckDuckGo endpoint (the smoke test points it
at a local fixture).

## PageSpeed Insights

Core Web Vitals checks call the Google PageSpeed Insights API. It answers
without a key on a small shared quota; set `PAGESPEED_API_KEY` in `.env` for
your own quota (the API reports `keyConfigured`). `PAGESPEED_API_URL` overrides
the endpoint (the smoke test points it at a local stand-in).

## Scheduler

Scheduled scans and rank checks run inside the API process, checked every
`SCHEDULER_TICK_MS` (default 60000). `SCHEDULER_DISABLED=1` turns the
scheduler and its notifications off. There is no hosted cron: nothing runs
while the app is closed, and a slot missed while it was closed runs once on the
next start.

## Security

- The API binds to `127.0.0.1` unless `API_HOST` says otherwise.
- The browser app talks to the API same-origin (through the Vite proxy in
  development). Production sends no CORS headers; development allows only the
  `APP_URL` origin.
- `POST`/`PUT`/`DELETE` requests from another site (by `Origin` or
  `Sec-Fetch-Site`) are refused, and JSON routes require an
  `application/json` body.
- Sessions are stored in SQLite: logging out revokes that session, and
  `bun run admin:password` signs out every session. Repeated failed logins for
  an email are paused for 15 minutes.
- Codex jobs run read-only in an empty temporary directory (never the app
  checkout with `database/` and `.env`), at most `CODEX_MAX_CONCURRENT` (default
  2) at a time, with the prompt passed after `--`.

## Local Data Model

A site is the website/domain being analyzed. The active site feeds scans,
rank trackers, Search Console, keyword saves, AI jobs, and local history. Each
scan run is stored separately in SQLite, even when multiple scans use the same
domain.

SERP and rank checks can use self-hosted OpenSERP, self-hosted SearXNG, or the
built-in DuckDuckGo fallback. External SEO metrics are never generated locally.
Keyword volumes, CPC, keyword difficulty, organic research tables, and backlink
tables can be populated from real CSV imports. Local scans feed technical pages,
internal/external links, images, assets, sitemap, robots, and response timing
into reports. The app shows unavailable states instead of invented rows.

This app is local-first. Hosted product concerns such as billing, teams/orgs,
hosted auth, queues, and hosted cron workflows are not part of this fresh local
app. The product uses SQLite tables, real local crawls, manual run buttons plus
an optional in-process scheduler (off by default), Google OAuth stored locally,
and a custom local MCP endpoint.

The database schema belongs to this version of the app. A database from the
older "projects" era (tables keyed by `project_id`) is refused at startup with a
message naming the affected tables; the file is left untouched. Move it aside or
point `DB_PATH` at a new directory to start fresh.

## MCP

The MCP endpoint is local and custom-built for this app:

```text
POST /mcp
```

It speaks JSON-RPC 2.0 over HTTP POST: notifications get `202 Accepted` with no
body, `ping` is supported, and tool failures come back as tool results with
`isError: true`. In the app, the MCP screen shows the exact local URL for the
current port. If a local MCP token is configured, send:

```text
Authorization: Bearer <MCP_TOKEN>
```

Tools:

- Sites and keywords: `whoami`, `list_sites`, `create_site`, `get_site_summary`,
  `research_keywords`, `list_saved_keywords`, `query_saved_keywords`,
  `save_keywords`, `import_keyword_metrics`, `update_saved_keyword_tags`
- Organic research and backlinks: `get_domain_overview`,
  `get_domain_keyword_suggestions`, `get_domain_keywords_page`,
  `get_domain_pages_page`, `import_organic_research`, `get_backlinks_overview`,
  `get_backlinks_profile`, `import_backlinks`
- SERP and rank tracking: `analyze_serp`, `get_rank_tracker`
- Scans: `start_scan`, `scan_site`, `list_scans`, `get_scan` (summary; pass
  `full: true` for the complete saved result), `get_scan_summary`,
  `get_scan_issues` (filters, up to 200 per page), `get_scan_page`,
  `compare_scans`, `cancel_scan`, `list_issue_types`, `list_issue_ignores`,
  `create_issue_ignore`, `delete_issue_ignore`
- Search Console: `get_gsc_performance`, `gsc_sync`, `gsc_rows`,
  `inspect_urls`, `gsc_crawl_insights`, `cannibalization`, `content_decay`
- PageSpeed: `cwv_run`, `cwv_results`
- Schedules and notifications: `get_schedule`, `set_scan_schedule`,
  `set_tracker_schedule`, `list_notifications`
- Research and Codex: `brand_lookup`, `prompt_explorer`, `start_ai_job`,
  `get_ai_job`

## Verification

```sh
bun x tsc --noEmit
bun run test:smoke
bun run --filter web build
```

The smoke test runs against a temporary SQLite database directory. It does not
write to the local app database at `database/local-seo.sqlite`.
