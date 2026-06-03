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

Debug one account with visible Chromium:

```sh
bun run dev:ig -- --handle=@cafemagnolio.cl --posts=5
```

Serve existing assets:

```sh
bun run api
```

Typecheck:

```sh
bunx tsc --noEmit
```

## Outputs

- `assets/<handle>/manifest.json`: downloaded posts and files.
- `assets/<handle>/*`: downloaded images and videos.
- `scrape-report.json`: batch summary, failures, start time, finish time, and duration.

Each run replaces the previous assets for the scraped handle.

## API

With `bun run api`:

- `GET /`: status, endpoints, and latest scraping summary.
- `GET /assets/:handle`: manifest with downloadable URLs.
- `GET /files/:handle/:filename`: downloaded file.

Example:

```sh
curl http://localhost:3000/assets/cafemagnolio.cl
```
