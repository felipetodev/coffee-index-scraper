import { createClient } from "@supabase/supabase-js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright-chromium";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCOUNT_DELAY_MS,
  ACTION_DELAY_MS,
  ASSETS_ROOT,
  DEV_POST_DELAY_MS,
  DOWNLOAD_TIMEOUT_MS,
  FAILED_HANDLE_RETRY_ROUNDS,
  INSTAGRAM_ORIGIN,
  MAX_MEDIA_PER_POST,
  MAX_POSTS_PER_HANDLE,
  MIN_VIDEO_BYTES,
  NAVIGATION_TIMEOUT_MS,
  POST_DELAY_MS,
  RETRIES_PER_POST,
  SCRAPE_REPORT_PATH,
  USER_AGENTS,
  VIEWPORTS,
} from "./constants";
import type {
  CafeSocialLink,
  Manifest,
  ManifestMedia,
  ManifestPost,
  MediaCandidate,
  RuntimeConfig,
  ScrapeFailure,
  ScrapeFailureReason,
  ScrapeReport,
} from "./types";
import {
  averageRange,
  canonicalHandle,
  chooseRandom,
  clampPostLimit,
  countManifestMedia,
  countPostsByStatus,
  extensionFromContentType,
  fileUrlFor,
  formatDuration,
  getManifestFailureReason,
  handleAssetsDir,
  looksLikeInstagramMedia,
  normalizeHandle,
  parseArgs,
  randomBetween,
  sleep,
  stringArg,
  timestamp,
  unique,
} from "./utils";

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadConfig(): RuntimeConfig {
  const args = parseArgs();
  const devHandle = stringArg(args.handle) || Bun.env.DEV_HANDLE;
  const devMode = Boolean(args.dev || devHandle || Bun.env.DEV_MODE === "1");

  return {
    instagramUsername: requiredEnv("IG_USERNAME"),
    instagramPassword: requiredEnv("IG_PASSWORD"),
    supabaseUrl: requiredEnv("SUPABASE_URL"),
    supabaseKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    headless: devMode ? false : Bun.env.HEADLESS !== "0",
    devHandle,
    devPosts: clampPostLimit(
      Number(stringArg(args.posts) || Bun.env.DEV_POSTS || 1),
    ),
    devMode,
  };
}

async function rateLimit(
  label: string,
  range: readonly [number, number],
): Promise<void> {
  const ms = randomBetween(range);
  console.log(`[rate-limit] ${label}: waiting ${Math.round(ms / 1000)}s`);
  await sleep(ms);
}

async function fetchInstagramHandles(config: RuntimeConfig): Promise<string[]> {
  const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase
    .from("cafe_social_links")
    .select("handle, platform")
    .eq("platform", "instagram");

  if (error) {
    throw new Error(`Supabase read failed: ${error.message}`);
  }

  const handles = unique(
    ((data || []) as CafeSocialLink[])
      .map((row) => row.handle)
      .filter((handle): handle is string => Boolean(handle))
      .map(normalizeHandle)
      .filter(Boolean),
  );

  console.log(`[supabase] loaded ${handles.length} instagram handles`);
  return handles;
}

type InstagramStorageState = Awaited<
  ReturnType<BrowserContext["storageState"]>
>;

async function createInstagramContext(
  browser: Browser,
  storageState?: InstagramStorageState,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: chooseRandom(USER_AGENTS),
    viewport: chooseRandom(VIEWPORTS),
    locale: "es-CL",
    timezoneId: "America/Santiago",
    javaScriptEnabled: true,
    storageState,
    extraHTTPHeaders: {
      "Accept-Language": "es-CL,es;q=0.9,en;q=0.7",
    },
  });

  context.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  return context;
}

async function clickIfVisible(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  if (!(await locator.isVisible().catch(() => false))) {
    return false;
  }

  await locator.click({ timeout: 5_000 }).catch(() => undefined);
  await rateLimit("after optional click", ACTION_DELAY_MS);
  return true;
}

async function dismissInstagramOverlays(page: Page): Promise<void> {
  await clickIfVisible(page, "text=/Not Now|Ahora no|Ahora No/i");
  await clickIfVisible(page, 'button:has-text("Not Now")');
  await clickIfVisible(page, 'button:has-text("Ahora no")');
  await clickIfVisible(page, "text=/Save Info|Guardar información/i");
  await clickIfVisible(page, '[role="dialog"] [aria-label="Cerrar"]');
  await clickIfVisible(page, '[role="dialog"] [aria-label="Close"]');
  await clickIfVisible(
    page,
    '[role="dialog"] div[role="button"]:has([aria-label="Cerrar"])',
  );
  await clickIfVisible(
    page,
    '[role="dialog"] div[role="button"]:has([aria-label="Close"])',
  );
  await removeSignupOverlay(page);
}

async function removeSignupOverlay(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const overlayTextPatterns = [
        "no te pierdas ninguna publicación",
        "regístrate en instagram para estar siempre al día",
        "don't miss any posts",
        "sign up to see",
      ];

      for (const dialog of Array.from(
        document.querySelectorAll('[role="dialog"]'),
      )) {
        const text = (dialog.textContent || "").toLowerCase();
        if (!overlayTextPatterns.some((pattern) => text.includes(pattern))) {
          continue;
        }

        const container =
          dialog.closest(".html-div") ||
          dialog.parentElement?.parentElement?.parentElement ||
          dialog;
        container.remove();
      }
    })
    .catch(() => undefined);
}

async function submitInstagramLogin(
  page: Page,
  passwordInput: ReturnType<Page["locator"]>,
): Promise<void> {
  const submitCandidates = [
    page.locator('button[type="submit"]').first(),
    page.getByRole("button", { name: /iniciar sesión|log in|login/i }).first(),
    page.locator("text=/^\\s*(Iniciar sesión|Log in|Login)\\s*$/i").first(),
    page.locator('div[role="button"]:has-text("Iniciar sesión")').first(),
    page.locator('div[role="button"]:has-text("Log in")').first(),
    page.locator('[role="none"]:has-text("Iniciar sesión")').first(),
  ];

  for (const candidate of submitCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 5_000 });
      return;
    }
  }

  await passwordInput.press("Enter");
}

async function loginToInstagram(
  context: BrowserContext,
  config: RuntimeConfig,
): Promise<void> {
  const page = await context.newPage();
  console.log("[instagram] opening login page");
  await page.goto(`${INSTAGRAM_ORIGIN}/accounts/login/`, {
    waitUntil: "domcontentloaded",
  });
  await rateLimit("login page settled", ACTION_DELAY_MS);

  const usernameInput = page
    .locator(
      [
        'input[name="username"]',
        'input[name="email"]',
        'input[autocomplete*="username"]',
        'input[aria-label*="usuario" i]',
        'input[aria-label*="correo" i]',
      ].join(", "),
    )
    .first();
  const passwordInput = page
    .locator(
      [
        'input[name="password"]',
        'input[name="pass"]',
        'input[type="password"]',
        'input[aria-label*="contraseña" i]',
      ].join(", "),
    )
    .first();

  await usernameInput.waitFor({
    state: "visible",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await usernameInput.fill(config.instagramUsername);
  await rateLimit("after username", ACTION_DELAY_MS);
  await passwordInput.waitFor({
    state: "visible",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await passwordInput.fill(config.instagramPassword);
  await rateLimit("after password", ACTION_DELAY_MS);
  await submitInstagramLogin(page, passwordInput);

  await page
    .waitForURL((url) => !url.pathname.includes("/accounts/login"), {
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await rateLimit("after login submit", ACTION_DELAY_MS);
  await dismissInstagramOverlays(page);

  if (page.url().includes("/accounts/login")) {
    throw new Error(
      "Instagram login did not complete. Check credentials or checkpoint requirements.",
    );
  }

  console.log("[instagram] login completed");
  await page.close();
}

async function collectPostUrls(page: Page, handle: string): Promise<string[]> {
  const profileUrl = `${INSTAGRAM_ORIGIN}/${normalizeHandle(handle)}/`;
  console.log(`[instagram] visiting ${canonicalHandle(handle)} profile`);
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await rateLimit(
    `profile ${canonicalHandle(handle)} settled`,
    ACTION_DELAY_MS,
  );
  await dismissInstagramOverlays(page);

  const postUrls = await page
    .locator('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]')
    .evaluateAll((anchors) =>
      anchors
        .map((anchor) =>
          anchor instanceof HTMLAnchorElement ? anchor.href : "",
        )
        .filter(Boolean),
    );

  const normalizedUrls = unique(
    postUrls
      .map((url) => {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      })
      .filter((url) => {
        const pathname = new URL(url).pathname;
        return /\/(?:p|reel|reels)\/[A-Za-z0-9_-]+\/?$/.test(pathname);
      }),
  );

  const selectedUrls = normalizedUrls.slice(0, MAX_POSTS_PER_HANDLE);
  console.log(
    `[instagram] ${canonicalHandle(handle)} selected post urls: ${selectedUrls
      .map((url, index) => `${index + 1}=${url}`)
      .join(" | ")}`,
  );

  return selectedUrls;
}

function dedupeMediaCandidates(items: MediaCandidate[]): MediaCandidate[] {
  const byKey = new Map<string, MediaCandidate>();

  for (const item of items) {
    const key = `${item.mediaType}:${item.sourceUrl}`;
    const existing = byKey.get(key);
    if (existing && (existing.sizeBytes || 0) >= (item.sizeBytes || 0)) {
      continue;
    }

    byKey.set(key, item);
  }

  return [...byKey.values()];
}

function isBlobUrl(url: string): boolean {
  return url.startsWith("blob:");
}

function looksLikeVideoUrl(url: string): boolean {
  return (
    url.includes(".mp4") ||
    url.includes(".mov") ||
    url.includes("video") ||
    url.includes("/o1/v/")
  );
}

function stripByteRangeParams(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.searchParams.delete("bytestart");
  url.searchParams.delete("byteend");
  return url.toString();
}

function hasByteRangeParams(sourceUrl: string): boolean {
  const url = new URL(sourceUrl);
  return url.searchParams.has("bytestart") || url.searchParams.has("byteend");
}

function isPlayableMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }

  const marker = new TextDecoder().decode(bytes.subarray(4, 12));
  return marker.includes("ftyp") || marker.includes("moov");
}

async function transcodeVideoForQuickTime(filePath: string): Promise<void> {
  if (!(await hasVideoStream(filePath))) {
    throw new Error(`downloaded MP4 has no video stream: ${await probeVideo(filePath)}`);
  }

  const tempPath = `${filePath}.h264.tmp.mp4`;
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      tempPath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    const errorOutput = await new Response(process.stderr).text();
    const probeOutput = await probeVideo(filePath);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(
      `ffmpeg transcode failed: ${errorOutput.trim() || exitCode}. ffprobe: ${probeOutput}`,
    );
  }

  await rename(tempPath, filePath);
}

async function hasVideoStream(filePath: string): Promise<boolean> {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-hide_banner",
      "-loglevel",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);

  return exitCode === 0 && stdout.trim().includes("video");
}

async function probeVideo(filePath: string): Promise<string> {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-hide_banner",
      "-loglevel",
      "error",
      "-show_entries",
      "format=duration,size:stream=index,codec_type,codec_name,width,height",
      "-of",
      "compact=p=0:nk=1",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return `exit=${exitCode}; stdout=${stdout.trim() || "empty"}; stderr=${stderr.trim() || "empty"}`;
}

async function encourageVideoLoad(page: Page): Promise<void> {
  const video = page.locator("video").first();
  if (!(await video.isVisible().catch(() => false))) {
    return;
  }

  await video
    .evaluate((element) => {
      const videoElement = element as HTMLVideoElement;
      videoElement.muted = true;
      videoElement.preload = "auto";
      void videoElement.play().catch(() => undefined);
    })
    .catch(() => undefined);
  await rateLimit("video load", ACTION_DELAY_MS);
}

async function extractScriptMedia(page: Page): Promise<MediaCandidate[]> {
  return page
    .evaluate(() => {
      const media: Array<{ sourceUrl: string; mediaType: "image" | "video" }> =
        [];
      const scriptText = Array.from(document.querySelectorAll("script"))
        .map((script) => script.textContent || "")
        .join("\n");
      const videoPatterns = [
        /"video_url"\s*:\s*"([^"]+)"/g,
        /"playable_url"\s*:\s*"([^"]+)"/g,
        /"browser_native_hd_url"\s*:\s*"([^"]+)"/g,
        /"browser_native_sd_url"\s*:\s*"([^"]+)"/g,
      ];
      const imagePatterns = [
        /"display_url"\s*:\s*"([^"]+)"/g,
        /"thumbnail_src"\s*:\s*"([^"]+)"/g,
      ];

      for (const pattern of videoPatterns) {
        for (const match of scriptText.matchAll(pattern)) {
          const rawUrl = match[1];
          if (rawUrl) {
            media.push({
              sourceUrl: decodeEscapedJsonUrl(rawUrl),
              mediaType: "video",
            });
          }
        }
      }

      for (const pattern of imagePatterns) {
        for (const match of scriptText.matchAll(pattern)) {
          const rawUrl = match[1];
          if (rawUrl) {
            media.push({
              sourceUrl: decodeEscapedJsonUrl(rawUrl),
              mediaType: "image",
            });
          }
        }
      }

      return media;

      function decodeEscapedJsonUrl(value: string): string {
        return value
          .replace(/\\u0026/g, "&")
          .replace(/\\\//g, "/")
          .replace(/\\\\/g, "\\");
      }
    })
    .catch(() => []);
}

async function collectMediaUrlsFromPost(
  page: Page,
  postUrl: string,
): Promise<MediaCandidate[]> {
  const networkMedia: MediaCandidate[] = [];
  const onResponse = async (response: Response) => {
    const sourceUrl = response.url();
    if (!looksLikeInstagramMedia(sourceUrl)) {
      return;
    }

    const headers = response.headers();
    const contentType = headers["content-type"]
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    const isVideo =
      Boolean(contentType?.startsWith("video/")) ||
      looksLikeVideoUrl(sourceUrl);

    if (!isVideo) {
      return;
    }

    if (
      hasByteRangeParams(sourceUrl) ||
      response.status() === 206 ||
      headers["content-range"]
    ) {
      networkMedia.push({
        sourceUrl: stripByteRangeParams(sourceUrl),
        mediaType: "video",
        contentType: contentType || "video/mp4",
      });
      return;
    }

    const bytes = await response.body().catch(() => null);
    if (!bytes || bytes.byteLength < MIN_VIDEO_BYTES) {
      return;
    }

    networkMedia.push({
      sourceUrl,
      mediaType: "video",
      contentType: contentType || "video/mp4",
      dataBase64: Buffer.from(bytes).toString("base64"),
      sizeBytes: bytes.byteLength,
    });
  };

  page.on("response", onResponse);

  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  await rateLimit("post settled", ACTION_DELAY_MS);
  await dismissInstagramOverlays(page);
  await encourageVideoLoad(page);

  const mediaCandidates: MediaCandidate[] = await extractScriptMedia(page);

  try {
    for (let slide = 0; slide < 12; slide += 1) {
      const currentMedia = await page.evaluate(async () => {
        const article = document.querySelector("article");
        const images = Array.from(
          (article || document).querySelectorAll("img"),
        );
        const videos = Array.from(
          (article || document).querySelectorAll("video"),
        );
        const isLargeVisible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width >= 240 &&
            rect.height >= 240 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          );
        };

        const videoMedia = await Promise.all(
          videos
            .filter(isLargeVisible)
            .flatMap((video) => {
              const sourceUrls = Array.from(video.querySelectorAll("source"))
                .map((source) => source.src)
                .filter(Boolean);
              const directUrl = video.currentSrc || video.src;
              return [directUrl, ...sourceUrls].filter(Boolean);
            })
            .map(async (sourceUrl) => {
              if (!sourceUrl.startsWith("blob:")) {
                return {
                  sourceUrl,
                  mediaType: "video" as const,
                };
              }

              try {
                const response = await fetch(sourceUrl);
                const blob = await response.blob();
                const bytes = new Uint8Array(await blob.arrayBuffer());
                let binary = "";
                const chunkSize = 0x8000;

                for (
                  let offset = 0;
                  offset < bytes.length;
                  offset += chunkSize
                ) {
                  binary += String.fromCharCode(
                    ...bytes.subarray(offset, offset + chunkSize),
                  );
                }

                return {
                  sourceUrl,
                  mediaType: "video" as const,
                  contentType: blob.type || "video/mp4",
                  dataBase64: btoa(binary),
                  sizeBytes: bytes.byteLength,
                };
              } catch {
                return {
                  sourceUrl,
                  mediaType: "video" as const,
                };
              }
            }),
        );

        const imageMedia =
          videoMedia.length > 0
            ? []
            : images
                .filter(isLargeVisible)
                .map((image) => {
                  const alt = imageAlt(image);
                  return {
                    sourceUrl: image.currentSrc || image.src,
                    alt,
                  };
                })
                .filter(({ sourceUrl, alt }) => {
                  if (!sourceUrl) return false;
                  return (
                    !alt.includes("profile picture") &&
                    !alt.includes("foto del perfil")
                  );
                })
                .map(({ sourceUrl }) => ({
                  sourceUrl,
                  mediaType: "image" as const,
                }));

        return [...videoMedia, ...imageMedia];

        function imageAlt(image: HTMLImageElement): string {
          return (image.getAttribute("alt") || "").toLowerCase();
        }
      });

      mediaCandidates.push(
        ...currentMedia.filter(
          (media) =>
            isBlobUrl(media.sourceUrl) ||
            looksLikeInstagramMedia(media.sourceUrl),
        ),
      );

      const nextButton = page
        .locator('button[aria-label="Next"], button[aria-label="Siguiente"]')
        .last();

      if (!(await nextButton.isVisible().catch(() => false))) {
        break;
      }

      await nextButton.click({ timeout: 5_000 }).catch(() => undefined);
      await rateLimit("carousel next", ACTION_DELAY_MS);
      await encourageVideoLoad(page);
    }
  } finally {
    page.off("response", onResponse);
  }

  const downloadedBlobMedia = mediaCandidates.filter(
    (media) =>
      !isBlobUrl(media.sourceUrl) ||
      (media.dataBase64 && (media.sizeBytes || 0) >= MIN_VIDEO_BYTES),
  );
  const largestNetworkVideo = networkMedia
    .sort((left, right) => {
      const leftHasBody = left.dataBase64 ? 1 : 0;
      const rightHasBody = right.dataBase64 ? 1 : 0;
      return (
        rightHasBody - leftHasBody ||
        (right.sizeBytes || 0) - (left.sizeBytes || 0)
      );
    })
    .slice(0, 1);

  return dedupeMediaCandidates([
    ...downloadedBlobMedia,
    ...largestNetworkVideo,
  ]).slice(0, MAX_MEDIA_PER_POST);
}

async function downloadMedia(
  media: MediaCandidate,
  targetDir: string,
  handle: string,
  postIndex: number,
  mediaIndex: number,
): Promise<ManifestMedia> {
  let bytes: Uint8Array;
  let contentType = media.contentType || null;
  const sourceUrl =
    media.mediaType === "video" && hasByteRangeParams(media.sourceUrl)
      ? stripByteRangeParams(media.sourceUrl)
      : media.sourceUrl;

  if (media.dataBase64) {
    bytes = new Uint8Array(Buffer.from(media.dataBase64, "base64"));
  } else {
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: {
        Referer: INSTAGRAM_ORIGIN,
        "User-Agent": chooseRandom(USER_AGENTS),
      },
    });

    if (!response.ok) {
      throw new Error(`Media download failed with HTTP ${response.status}`);
    }

    contentType = response.headers.get("content-type");
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  if (media.mediaType === "video" && !isPlayableMp4(bytes)) {
    throw new Error("Downloaded video is an MP4 fragment, not a playable MP4");
  }

  const extension = extensionFromContentType(
    contentType,
    sourceUrl,
    media.mediaType,
  );
  const fileName = `post-${String(postIndex + 1).padStart(2, "0")}-${media.mediaType}-${String(mediaIndex + 1).padStart(2, "0")}${extension}`;
  const filePath = join(targetDir, fileName);
  await writeFile(filePath, bytes);

  if (media.mediaType === "video") {
    console.log(
      `[media] transcode ${fileName}: bytes=${bytes.byteLength}, contentType=${contentType || "unknown"}, sourceUrl=${sourceUrl}`,
    );
    await transcodeVideoForQuickTime(filePath);
  }

  return {
    fileName,
    filePath,
    url: fileUrlFor(handle, fileName),
    sourceUrl,
    mediaType: media.mediaType,
  };
}

async function scrapePostWithRetries(
  page: Page,
  postUrl: string,
  targetDir: string,
  handle: string,
  postIndex: number,
): Promise<ManifestPost> {
  for (let attempt = 1; attempt <= RETRIES_PER_POST; attempt += 1) {
    try {
      console.log(
        `[instagram] ${canonicalHandle(handle)} post ${postIndex + 1}: scraping attempt ${attempt}`,
      );
      const mediaItems = await collectMediaUrlsFromPost(page, postUrl);
      console.log(
        `[instagram] ${canonicalHandle(handle)} post ${postIndex + 1}: found ${mediaItems.length} media candidates (${mediaItems.filter((media) => media.mediaType === "video").length} videos)`,
      );
      const images: ManifestMedia[] = [];
      const mediaErrors: string[] = [];

      for (
        let mediaIndex = 0;
        mediaIndex < mediaItems.length;
        mediaIndex += 1
      ) {
        try {
          images.push(
            await downloadMedia(
              mediaItems[mediaIndex]!,
              targetDir,
              handle,
              postIndex,
              mediaIndex,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mediaErrors.push(`candidate ${mediaIndex + 1}: ${message}`);
          console.warn(
            `[instagram] ${canonicalHandle(handle)} post ${postIndex + 1} media candidate ${mediaIndex + 1} failed: ${message}`,
          );
        }
        if (images.length > 0) {
          await rateLimit("between media downloads", ACTION_DELAY_MS);
        }
      }

      if (mediaItems.length > 0 && images.length === 0) {
        throw new Error(
          `all media candidates failed: ${mediaErrors.join(" | ") || "unknown"}`,
        );
      }

      return {
        postUrl,
        images,
        downloadedAt: new Date().toISOString(),
        status: images.length > 0 ? "ok" : "empty",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[instagram] ${canonicalHandle(handle)} post ${postIndex + 1} failed: ${message}`,
      );
      if (attempt < RETRIES_PER_POST) {
        await rateLimit("before post retry", POST_DELAY_MS);
      } else {
        return {
          postUrl,
          images: [],
          downloadedAt: new Date().toISOString(),
          status: "failed",
          error: message,
        };
      }
    }
  }

  return {
    postUrl,
    images: [],
    downloadedAt: new Date().toISOString(),
    status: "failed",
    error: "Unexpected retry loop exit",
  };
}

async function prepareHandleDir(handle: string): Promise<string> {
  const dir = handleAssetsDir(handle);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function buildScrapeFailure(
  handle: string,
  phase: ScrapeFailure["phase"],
  attempts: number,
  reason: ScrapeFailureReason,
  manifest?: Manifest,
  error?: unknown,
): ScrapeFailure {
  return {
    handle: canonicalHandle(handle),
    reason,
    phase,
    attempts,
    postCount: manifest?.posts.length || 0,
    mediaCount: manifest ? countManifestMedia(manifest) : 0,
    failedPostCount: manifest ? countPostsByStatus(manifest, "failed") : 0,
    emptyPostCount: manifest ? countPostsByStatus(manifest, "empty") : 0,
    lastError:
      error instanceof Error
        ? error.message
        : error
          ? String(error)
          : undefined,
    updatedAt: timestamp(),
  };
}

async function writeScrapeReport(
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  totalHandles: number,
  successfulHandles: Set<string>,
  failedHandles: Map<string, ScrapeFailure>,
  retryRounds: number,
): Promise<void> {
  const report: ScrapeReport = {
    generatedAt: finishedAt,
    startedAt,
    finishedAt,
    durationMs,
    duration: formatDuration(durationMs),
    totalHandles,
    successfulHandles: successfulHandles.size,
    failedHandles: [...failedHandles.values()],
    retryRounds,
  };

  await writeFile(SCRAPE_REPORT_PATH, JSON.stringify(report, null, 2));
}

async function scrapeAndTrackHandle(
  browser: Browser,
  handle: string,
  storageState: InstagramStorageState,
  postLimit: number,
  phase: ScrapeFailure["phase"],
  attempt: number,
  successfulHandles: Set<string>,
  failedHandles: Map<string, ScrapeFailure>,
): Promise<void> {
  try {
    const manifest = await scrapeHandleWithState(
      browser,
      handle,
      storageState,
      postLimit,
    );
    const reason = getManifestFailureReason(manifest);

    if (reason) {
      failedHandles.set(
        normalizeHandle(handle),
        buildScrapeFailure(handle, phase, attempt, reason, manifest),
      );
      successfulHandles.delete(normalizeHandle(handle));
      console.warn(
        `[scrape-report] ${canonicalHandle(handle)} marked as ${reason}`,
      );
      return;
    }

    successfulHandles.add(normalizeHandle(handle));
    failedHandles.delete(normalizeHandle(handle));
  } catch (error) {
    failedHandles.set(
      normalizeHandle(handle),
      buildScrapeFailure(
        handle,
        phase,
        attempt,
        "scrape_error",
        undefined,
        error,
      ),
    );
    successfulHandles.delete(normalizeHandle(handle));
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[scrape-report] ${canonicalHandle(handle)} failed: ${message}`,
    );
  }
}

async function scrapeAll(config: RuntimeConfig): Promise<void> {
  console.warn(
    "[anti-ban] Proxy rotation is disabled by configuration; real IP rotation will not happen.",
  );
  await mkdir(ASSETS_ROOT, { recursive: true });

  const handles = config.devHandle
    ? [normalizeHandle(config.devHandle)]
    : await fetchInstagramHandles(config);
  if (handles.length === 0) {
    console.log("[supabase] no instagram handles found; skipping scraping");
    return;
  }

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: 150,
  });

  try {
    const loginContext = await createInstagramContext(browser);
    await loginToInstagram(loginContext, config);
    const storageState = await loginContext.storageState();
    await loginContext.close();
    const scrapeStartedAt = timestamp();
    const startedAt = Date.now();
    const handleDurations: number[] = [];
    const successfulHandles = new Set<string>();
    const failedHandles = new Map<string, ScrapeFailure>();
    const postLimit = config.devHandle ? config.devPosts : MAX_POSTS_PER_HANDLE;

    console.log(
      `[timer] ${scrapeStartedAt} starting scrape for ${handles.length} handle(s)`,
    );

    for (let index = 0; index < handles.length; index += 1) {
      const handle = handles[index]!;
      const handleStartedAt = Date.now();
      const remainingBefore = handles.length - index - 1;
      console.log(
        `[instagram] ${timestamp()} scraping ${canonicalHandle(handle)} (${index + 1}/${handles.length})`,
      );
      await scrapeAndTrackHandle(
        browser,
        handle,
        storageState,
        postLimit,
        "initial",
        1,
        successfulHandles,
        failedHandles,
      );

      const handleDuration = Date.now() - handleStartedAt;
      handleDurations.push(handleDuration);
      const averageDuration =
        handleDurations.reduce((total, duration) => total + duration, 0) /
        handleDurations.length;
      const etaMs =
        averageDuration * remainingBefore +
        averageRange(ACCOUNT_DELAY_MS) * remainingBefore;

      console.log(
        `[timer] ${timestamp()} finished ${canonicalHandle(handle)} in ${formatDuration(handleDuration)}. Progress ${index + 1}/${handles.length}. ETA ${formatDuration(etaMs)}.`,
      );

      if (index < handles.length - 1) {
        await rateLimit(
          `between accounts after ${canonicalHandle(handle)}`,
          ACCOUNT_DELAY_MS,
        );
      }
    }

    for (
      let retryRound = 1;
      retryRound <= FAILED_HANDLE_RETRY_ROUNDS;
      retryRound += 1
    ) {
      const retryHandles = [...failedHandles.values()].map((failure) =>
        normalizeHandle(failure.handle),
      );

      if (retryHandles.length === 0) {
        break;
      }

      console.log(
        `[retry] ${timestamp()} retry round ${retryRound}/${FAILED_HANDLE_RETRY_ROUNDS} for ${retryHandles.length} failed handle(s)`,
      );

      for (let index = 0; index < retryHandles.length; index += 1) {
        const handle = retryHandles[index]!;
        console.log(
          `[retry] ${timestamp()} retrying ${canonicalHandle(handle)} (${index + 1}/${retryHandles.length})`,
        );
        await scrapeAndTrackHandle(
          browser,
          handle,
          storageState,
          postLimit,
          "retry",
          retryRound + 1,
          successfulHandles,
          failedHandles,
        );

        if (index < retryHandles.length - 1) {
          await rateLimit(
            `between retry accounts after ${canonicalHandle(handle)}`,
            ACCOUNT_DELAY_MS,
          );
        }
      }
    }

    const scrapeFinishedAt = timestamp();
    const durationMs = Date.now() - startedAt;

    await writeScrapeReport(
      scrapeStartedAt,
      scrapeFinishedAt,
      durationMs,
      handles.length,
      successfulHandles,
      failedHandles,
      FAILED_HANDLE_RETRY_ROUNDS,
    );

    console.log(
      `[scrape-report] wrote ${SCRAPE_REPORT_PATH} with ${failedHandles.size} failed handle(s)`,
    );
    console.log(
      `[timer] ${scrapeFinishedAt} finished all ${handles.length} handle(s) in ${formatDuration(durationMs)}`,
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function scrapeHandleWithState(
  browser: Browser,
  handle: string,
  storageState: InstagramStorageState,
  postLimit = MAX_POSTS_PER_HANDLE,
): Promise<Manifest> {
  const context = await createInstagramContext(browser, storageState);
  const page = await context.newPage();

  try {
    const targetDir = await prepareHandleDir(handle);
    const postUrls = (await collectPostUrls(page, handle)).slice(0, postLimit);
    console.log(
      `[instagram] ${canonicalHandle(handle)} found ${postUrls.length} recent posts`,
    );

    const posts: ManifestPost[] = [];
    for (let postIndex = 0; postIndex < postUrls.length; postIndex += 1) {
      posts.push(
        await scrapePostWithRetries(
          page,
          postUrls[postIndex]!,
          targetDir,
          handle,
          postIndex,
        ),
      );
      await rateLimit(
        `between posts for ${canonicalHandle(handle)}`,
        postLimit < MAX_POSTS_PER_HANDLE ? DEV_POST_DELAY_MS : POST_DELAY_MS,
      );
    }

    const manifest: Manifest = {
      handle: canonicalHandle(handle),
      scrapedAt: new Date().toISOString(),
      posts,
    };

    await writeFile(
      join(targetDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    return manifest;
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.devMode) {
    if (!config.devHandle) {
      throw new Error(
        "Dev mode requires --handle=@instagram or DEV_HANDLE=@instagram",
      );
    }

    console.log(
      `[dev] scraping only ${canonicalHandle(config.devHandle)} with ${config.devPosts} post attempt(s), headless=false`,
    );
    await scrapeAll(config);
    console.log("[dev] done");
    return;
  }

  await scrapeAll(config);
}

main().catch((error) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
