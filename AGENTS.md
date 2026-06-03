# AGENTS.md

## Core Rules

- `src/index.ts` is scraper-only. Do not add API/server code there.
- API/server code lives in `src/api/`.
- Shared app types live in `src/types.ts`; import them type-only across modules.
- Shared constants live in `src/constants.ts`; shared pure helpers live in `src/utils.ts`.
- Use Bun. Verify with `bunx tsc --noEmit`.
- Supabase is read-only: do not delete rows, write rows, or create migrations.
- Query only `cafe_social_links`, select `handle, platform`, filter `platform = "instagram"`.
- Assets live in `assets/<handle>/`; each run replaces that handle's folder.
- Failed/empty handles are retried once at the end and reported in root `scrape-report.json`.
- API root `GET /` exposes scrape report timing: `startedAt`, `finishedAt`, `durationMs`, and `duration`.
- Manifest field `images` can contain both images and videos; check `mediaType`.
- Do not print secrets from `.env`.

## Run Modes

Full run:

```sh
bun dev
```

`bun dev` is a one-shot scraper batch and must exit after scraping. Only `bun run api` / `bun run dev:api` should keep listening.

Fast dev run for one Instagram, browser visible:

```sh
bun run dev:ig -- --handle=@theelephantcoffeechile --posts=1
```

`--posts` accepts `1` to `5`. Dev mode skips Supabase, forces `headless=false`, scrapes only that handle, and exits without starting the server.

Serve existing assets only:

```sh
bun run api
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

- Concurrency must stay `1`: one account, one post, one media download at a time.
- Keep aggressive random delays between actions, posts, and accounts.
- Rotate user agent and viewport per browser context.
- No proxies are configured, so there is no real IP rotation.
- Full runs log timestamps, duration per handle, progress, ETA, and final total time.
- Treat `posts: []` or zero downloaded media as a scraping failure, not as a valid empty Instagram.
- If changing media extraction, test first with:

```sh
bun run dev:ig -- --handle=@theelephantcoffeechile --posts=1
```
