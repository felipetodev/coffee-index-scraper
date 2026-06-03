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

Full scraping run starting from one Instagram handle:

```sh
bun dev -- --start-from=@pausacafeteriacl
```

Debug one account with visible Chromium:

```sh
bun run dev:ig -- --handle=@cafemagnolio.cl --posts=6
```

Open Instagram login only, solve any challenge manually, save the local session, and exit:

```sh
bun run dev:ig -- --login-only
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

- `assets/<handle>/manifest.json`: downloaded posts and files. Each post includes `postUrl` and `directUrl` with the Instagram permalink.
- `assets/<handle>/*`: downloaded images and videos.
- `scrape-report.json`: batch summary, failures, start time, finish time, and duration.

Each run replaces the previous assets for the scraped handle. The scraper stores up to 6 recent posts per handle, with one asset per post. Carousels keep only their first representative image; reels/videos keep a downloaded MP4.

## API

With `bun run api`:

- `GET /`: status, endpoints, and latest scraping summary.
- `GET /assets/:handle`: manifest with downloadable URLs.
- `GET /files/:handle/:filename`: downloaded file.

Example:

```sh
curl http://localhost:3000/assets/cafemagnolio.cl
```
