# Cafeteria Scrapper API

Bun/TypeScript scraper that reads cafeteria Instagram accounts from Supabase, downloads the latest posts into `assets/`, writes one manifest per account, and exposes those assets through a Hono API.

## Setup

```sh
bun install
```

Create `.env` with:

```sh
IG_USERNAME=
IG_PASSWORD=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CONVEX_URL=
INSFORGE_URL=
INSFORGE_API_KEY=
```

Supabase is read-only. In this project it is only used to load Instagram usernames from my own `cafe_social_links` table, filtering by `platform = "instagram"`.

If you do not use Supabase, replace that lookup with a local list of Instagram handles:

```ts
const instagramHandles = [
  "@cafemagnolio.cl",
  "@theelephantcoffeechile",
  "@dummycoffee",
];
```

The scraper accepts handles with or without `@`.

## Scripts

Full scraping run:

```sh
bun dev
```

Sync downloaded assets to Convex Storage:

```sh
bun run sync:convex
```

Scrape and then sync:

```sh
bun run dev:sync
```

Sync only one local Instagram folder:

```sh
bun run sync:convex -- --handle=@cafetriciclo
```

Sync local assets and metadata to InsForge backup storage:

```sh
bun run sync:insforge-all
```

This deletes and recreates the InsForge `assets` bucket, clears `cafe_media`, uploads local assets again, and repopulates the table from local manifests.

Full scraping run starting from one Instagram handle:

```sh
bun dev -- --start-from=@pausacafeteriacl
```

Debug one account with visible Chromium:

```sh
bun run dev:ig -- --handle=@cafemagnolio.cl --posts=6
```

Enable detailed scraper/sync logs when debugging media extraction:

```sh
VERBOSE_LOGS=1 bun run dev:ig -- --handle=@cafemagnolio.cl --posts=6
```

Open Instagram login only, solve any challenge manually, save the local session, and exit:

```sh
bun run dev:ig -- --login-only
```

Serve Convex-backed assets locally:

```sh
bun run api
```

Serve InsForge-backed backup assets locally:

```sh
bun run backup:api
```

Typecheck:

```sh
bunx tsc --noEmit
```

Run the Cloudflare Worker locally:

```sh
bun run cf:dev
```

Deploy the Cloudflare Worker:

```sh
bun run cf:deploy
```

## Outputs

- `assets/<handle>/manifest.json`: downloaded posts and files. Each post includes `postUrl` and `directUrl` with the Instagram permalink.
- `assets/<handle>/*`: downloaded images and videos.
- Convex Storage records: `<handle>-post-01`, `<handle>-post-02`, etc.
- `scrape-report.json`: batch summary, failures, start time, finish time, and duration.

Each run replaces the previous assets for the scraped handle. The scraper stores up to 6 recent posts per handle, with one asset per post. Carousels keep only their first representative image; reels/videos keep a downloaded MP4.

Convex is used only as file storage plus a small mapping table. Running `sync:convex` again replaces the old files for each synced handle. The API reads Convex through `CONVEX_URL` and returns the full storage URLs.

## API

With `bun run api`:

- `GET /`: status and endpoints.
- `GET /assets/:handle`: flat list of `{ type, url, postUrl }` from Convex.

With `bun run backup:api`:

- `GET /`: status and endpoints.
- `GET /assets/:handle`: flat list of `{ type, url, postUrl }` from InsForge `cafe_media`.

Browser access is CORS-restricted to `http://localhost:3000`, `https://dev-coffeeindex.vercel.app`, and `https://coffeeindex.vercel.app`.
`GET /assets/:handle` is cached at the Cloudflare edge for 1 hour, with a 5 minute browser cache and stale responses allowed for 24 hours while revalidating.

`src/api/index.ts` exports a Cloudflare Worker-compatible `fetch` handler and reads only from Convex. `src/api/dev.ts` is the local Bun server wrapper.
`src/api/backup-api.ts` exports the InsForge backup API and reads `cafe_media`. `src/api/backup-dev.ts` is its local Bun server wrapper.

## Cloudflare

The Worker config lives in `wrangler.toml`. Do not commit `CONVEX_URL` there. Configure it as a Cloudflare secret:

```sh
bunx wrangler secret put CONVEX_URL
```

For local Worker development, put `CONVEX_URL` in `.dev.vars`; that file is gitignored.

Example:

```sh
curl http://localhost:3000/assets/cafemagnolio.cl
```
