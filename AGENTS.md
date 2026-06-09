# AGENTS.md

## Core Rules

- `src/index.ts` is scraper-only. Do not add API/server code there.
- API/server code lives in `src/api/`; `src/api/index.ts` is the Cloudflare Worker export and `src/api/dev.ts` is the Bun local server.
- InsForge backup API lives in `src/api/backup-api.ts`; `src/api/backup-dev.ts` is its Bun local server.
- Shared app types live in `src/types.ts`; import them type-only across modules.
- Shared constants live in `src/constants.ts`; shared pure helpers live in `src/utils.ts`.
- Use Bun. Verify with `bunx tsc --noEmit`.
- Supabase is read-only: do not delete rows, write rows, or create migrations.
- Query only `cafe_social_links`, select `handle, platform`, filter `platform = "instagram"`.
- Assets live in `assets/<handle>/`; each run replaces that handle's folder.
- Convex is used only for file storage plus an asset mapping table, not for hosting this API.
- Convex asset keys are `<handle>-post-01`, `<handle>-post-02`, etc., without `@`.
- Runtime code only needs `CONVEX_URL`; `CONVEX_DEPLOYMENT` is CLI-managed and `CONVEX_SITE_URL` is not used by this app.
- Cloudflare config lives in `wrangler.toml`; never put `CONVEX_URL` there. Use `wrangler secret put CONVEX_URL`.
- Failed/empty handles are retried once at the end and reported in root `scrape-report.json`.
- API root `GET /` exposes status/endpoints only.
- API `GET /assets/:handle` reads Convex only and returns a flat list of `{ type, url, postUrl }`.
- Backup API `GET /assets/:handle` reads InsForge `cafe_media` and returns `{ type, url, postUrl }`.
- `bun run sync:insforge-all` is intentionally destructive: delete/recreate InsForge `assets`, clear `cafe_media`, upload local assets, then repopulate metadata.
- API `GET /assets/:handle` uses Hono cache middleware: browser max-age 5m, Cloudflare edge s-maxage 1h, stale-while-revalidate 24h.
- Manifest field `images` can contain both images and videos; check `mediaType`.
- Each manifest has up to 6 posts and each post has at most 1 item in `images`.
- Each manifest post includes both `postUrl` and `directUrl`; keep them equal unless the schema is intentionally changed.
- Do not print secrets from `.env`.
- Default logs should stay compact. Use `VERBOSE_LOGS=1` for rate-limit, media URL, and Convex upload debug logs.

## Run Modes

Full run:

```sh
bun dev
```

`bun dev` is a one-shot scraper batch and must exit after scraping. Only `bun run api` / `bun run dev:api` should keep listening.

Fast dev run for one Instagram, browser visible:

```sh
bun run dev:ig -- --handle=@theelephantcoffeechile --posts=6
```

`--posts` accepts `1` to `6`. Dev mode skips Supabase, forces `headless=false`, scrapes only that handle, and exits without starting the server.

Serve existing assets only:

```sh
bun run api
```

Sync local assets to Convex Storage:

```sh
bun run sync:convex
```

Sync one handle for testing:

```sh
bun run sync:convex -- --handle=@cafetriciclo
```

## Critical Instagram DOM Details

Login inputs can be:

- username/email: `input[name="username"]`, `input[name="email"]`, `input[autocomplete*="username"]`
- password: `input[name="password"]`, `input[name="pass"]`, `input[type="password"]`

Submit can be:

- `button[type="submit"]`
- role/text with `Iniciar sesión`, `Log in`, or `Login`
- fallback: press Enter in password

Known blocking overlays:

- `Ahora no` / `Not Now`
- save-login-info prompts
- signup dialog text: `No te pierdas ninguna publicación...`
- close buttons: `aria-label="Cerrar"` or `aria-label="Close"`

Prefer text, role, aria, and input-name selectors. Never rely on Instagram generated class names.

## Video Scraping Gotchas

Instagram video DOM often looks like:

```html
<video preload="none" src="blob:https://www.instagram.com/..."></video>
```

Rules learned the hard way:

- Do not fetch `blob:` URLs from Bun; they only exist inside the browser context.
- Blob reads can produce tiny/incomplete fMP4 data.
- Instagram often serves fragments with `bytestart` and `byteend`.
- Fragment files start with `moof`, are not standalone MP4s, and QuickTime rejects them.
- Use fragment URLs only as clues: strip `bytestart` and `byteend`, then download the full URL.
- Validate video bytes before saving; a playable MP4 should contain early `ftyp`/`moov`, not start as a raw fragment.
- Instagram MP4s can be VP9 (`vp09`), which QuickTime may reject.
- Transcode downloaded videos to H.264/`avc1` with `ffmpeg` for Mac compatibility.

Debug videos with:

```sh
file assets/<handle>/*.mp4
ffprobe -hide_banner assets/<handle>/post-01-video-01.mp4
xxd -l 32 assets/<handle>/post-01-video-01.mp4
```

Broken signs: `file` says `data`, `ffprobe` says `trex/trun`, or `xxd` starts with `moof`.

## Scraping Discipline

- Concurrency must stay conservative: one account at a time, and never more than one video/reel page at a time.
- Keep aggressive random delays between actions, posts, and accounts.
- Rotate user agent and viewport per browser context.
- No proxies are configured, so there is no real IP rotation.
- Full runs log timestamps, duration per handle, progress, ETA, and final total time.
- Treat `posts: []` or zero downloaded media as a scraping failure, not as a valid empty Instagram.
- Do not traverse carousel slides. Download only the first representative asset for each of the latest 6 posts.
- Prefer profile-grid images for image/carousel posts; open a post page only for video/reel MP4 capture or image fallback.
- If changing media extraction, test first with:

```sh
bun run dev:ig -- --handle=@theelephantcoffeechile --posts=6
```

<!-- INSFORGE:START -->
## InsForge backend

This project uses [InsForge](https://insforge.dev): an all-in-one, open-source Postgres-based backend (BaaS) that gives this app a database, authentication, file storage, edge functions, realtime, an AI model gateway, and payments through one platform.

- **Project:** **coffee-index** (API base `https://anvb3sqr.us-east.insforge.app`)
- **Skills:** these InsForge skills are installed for supported coding agents. Reach for them before implementing any InsForge feature instead of guessing the API:
  - `insforge`: app code with the `@insforge/sdk` client (database CRUD, auth, storage, edge functions, realtime, AI, email, and Stripe payments).
  - `insforge-cli`: backend and infrastructure via the `insforge` CLI (projects, SQL, migrations, RLS policies, storage buckets, functions, secrets, payment setup, schedules, deploys).
  - `insforge-debug`: diagnosing failures (SDK/HTTP errors, RLS denials, auth and OAuth issues) and running security or performance audits.
  - `insforge-integrations`: wiring external auth providers (Clerk, Auth0, WorkOS, Better Auth, etc.) for JWT-based RLS, or the OKX x402 payment facilitator.
  - `find-skills`: discovering additional skills on demand.
- **Credentials:** app code reads keys from `.env.local`; the CLI reads `.insforge/project.json`. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `insert([{ ... }])`.
- Reference users with `auth.users(id)`; use `auth.uid()` in RLS policies.
- For storage uploads, persist both the returned `url` and `key`.
<!-- INSFORGE:END -->
