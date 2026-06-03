import { createClient } from "@supabase/supabase-js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright-chromium";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCOUNT_DELAY_MS,
  ACTION_DELAY_MS,
  ASSETS_ROOT,
  DEV_POST_DELAY_MS,
  DOWNLOAD_TIMEOUT_MS,
  FAILED_HANDLE_RETRY_ROUNDS,
  INSTAGRAM_STORAGE_STATE_PATH,
  INSTAGRAM_ORIGIN,
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
  PostPreview,
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
  const startFromHandle =
    stringArg(args["start-from"]) || Bun.env.START_FROM_HANDLE;
  const loginOnly = Boolean(args["login-only"] || Bun.env.LOGIN_ONLY === "1");
  const devMode = Boolean(
    args.dev || devHandle || loginOnly || Bun.env.DEV_MODE === "1",
  );

  return {
    instagramUsername: requiredEnv("IG_USERNAME"),
    instagramPassword: requiredEnv("IG_PASSWORD"),
    supabaseUrl: loginOnly ? "" : requiredEnv("SUPABASE_URL"),
    supabaseKey: loginOnly ? "" : requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    headless: devMode ? false : Bun.env.HEADLESS !== "0",
    devHandle,
    startFromHandle,
    devPosts: clampPostLimit(
      Number(stringArg(args.posts) || Bun.env.DEV_POSTS || 1),
    ),
    devMode,
    loginOnly,
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

function sliceHandlesFromStart(
  handles: string[],
  startFromHandle?: string,
): string[] {
  if (!startFromHandle) {
    return handles;
  }

  const normalizedStart = normalizeHandle(startFromHandle);
  const startIndex = handles.findIndex(
    (handle) => normalizeHandle(handle) === normalizedStart,
  );

  if (startIndex === -1) {
    throw new Error(
      `Start handle ${canonicalHandle(startFromHandle)} was not found in the Supabase handle list`,
    );
  }

  const slicedHandles = handles.slice(startIndex);
  console.log(
    `[supabase] starting from ${canonicalHandle(startFromHandle)} at position ${startIndex + 1}/${handles.length}; ${slicedHandles.length} handle(s) remaining`,
  );
  return slicedHandles;
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
  await waitForInstagramSession(context, page, config);

  if (page.url().includes("/accounts/login")) {
    throw new Error(
      "Instagram login did not complete. Check credentials or checkpoint requirements.",
    );
  }

  console.log("[instagram] login completed");
  await saveInstagramStorageState(context);
  await page.close().catch(() => undefined);
}

async function waitForInstagramSession(
  context: BrowserContext,
  page: Page,
  config: RuntimeConfig,
): Promise<void> {
  const deadline = Date.now() + (config.headless ? 20_000 : 180_000);
  let recaptchaLogged = false;

  while (Date.now() < deadline) {
    const cookies = await context.cookies(INSTAGRAM_ORIGIN);
    const hasSession = cookies.some(
      (cookie) => cookie.name === "sessionid" && cookie.value,
    );

    if (hasSession) {
      return;
    }

    if (page.url().includes("/auth_platform/recaptcha") && !recaptchaLogged) {
      console.warn(
        "[instagram] reCAPTCHA challenge detected. Waiting for manual completion in the visible browser.",
      );
      recaptchaLogged = true;
    }

    await sleep(1_000);
  }

  const diagnostics = await page
    .evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: (document.body.textContent || "").slice(0, 500),
    }))
    .catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

  throw new Error(
    `Instagram login did not create a session cookie. Diagnostics: ${JSON.stringify(diagnostics)}`,
  );
}

async function loadInstagramStorageState(): Promise<
  InstagramStorageState | undefined
> {
  try {
    const state = JSON.parse(
      await readFile(INSTAGRAM_STORAGE_STATE_PATH, "utf8"),
    ) as InstagramStorageState;
    console.log(`[instagram] loaded stored session from ${INSTAGRAM_STORAGE_STATE_PATH}`);
    return state;
  } catch {
    return undefined;
  }
}

async function saveInstagramStorageState(
  context: BrowserContext,
): Promise<void> {
  const state = await context.storageState();
  await writeFile(INSTAGRAM_STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`[instagram] saved session to ${INSTAGRAM_STORAGE_STATE_PATH}`);
}

async function contextHasInstagramSession(
  context: BrowserContext,
): Promise<boolean> {
  const cookies = await context.cookies(INSTAGRAM_ORIGIN);
  return cookies.some((cookie) => cookie.name === "sessionid" && cookie.value);
}

function isLoginRedirect(page: Page): boolean {
  return page.url().includes("/accounts/login");
}

async function recoverProfileLoginRedirect(
  page: Page,
  config: RuntimeConfig,
  profileUrl: string,
  handle: string,
): Promise<void> {
  if (!isLoginRedirect(page)) {
    return;
  }

  console.warn(
    `[instagram] ${canonicalHandle(handle)} profile redirected to login; refreshing session once`,
  );
  await loginToInstagram(page.context(), config);
  await rateLimit(
    `after session refresh for ${canonicalHandle(handle)}`,
    ACTION_DELAY_MS,
  );
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  console.log(
    `[instagram] ${canonicalHandle(handle)} profile reloaded after session refresh: ${page.url()}`,
  );
}

async function collectProfilePostPreviews(
  page: Page,
  handle: string,
  config: RuntimeConfig,
): Promise<PostPreview[]> {
  const profileUrl = `${INSTAGRAM_ORIGIN}/${normalizeHandle(handle)}/`;
  console.log(`[instagram] visiting ${canonicalHandle(handle)} profile`);
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  let refreshedSession = false;
  if (isLoginRedirect(page)) {
    await recoverProfileLoginRedirect(page, config, profileUrl, handle);
    refreshedSession = true;
  }
  await rateLimit(
    `profile ${canonicalHandle(handle)} settled`,
    ACTION_DELAY_MS,
  );
  await dismissInstagramOverlays(page);
  if (isLoginRedirect(page)) {
    if (refreshedSession) {
      throw new Error(
        `Instagram kept redirecting ${canonicalHandle(handle)} to login after session refresh`,
      );
    }

    await recoverProfileLoginRedirect(page, config, profileUrl, handle);
  }

  const previews = await page
    .locator('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]')
    .evaluateAll((anchors) => {
      const seen = new Set<string>();
      const previews: Array<{
        postUrl: string;
        isVideoLike: boolean;
        imageCandidateUrl?: string;
      }> = [];

      for (const anchor of anchors) {
        if (!(anchor instanceof HTMLAnchorElement)) {
          continue;
        }

        const parsed = new URL(anchor.href);
        const pathname = parsed.pathname;
        if (!/\/(?:p|reel|reels)\/[A-Za-z0-9_-]+\/?$/.test(pathname)) {
          continue;
        }

        const postUrl = `${parsed.origin}${pathname}`;
        if (seen.has(postUrl)) {
          continue;
        }
        seen.add(postUrl);

        const image = anchor.querySelector("img");
        const labels = Array.from(anchor.querySelectorAll("[aria-label]"))
          .map((element) => element.getAttribute("aria-label") || "")
          .join(" ")
          .toLowerCase();
        const isVideoLike =
          /\/(?:reel|reels)\//.test(pathname) ||
          labels.includes("reel") ||
          labels.includes("clip") ||
          labels.includes("video");

        previews.push({
          postUrl,
          isVideoLike,
          imageCandidateUrl: image?.currentSrc || image?.src || undefined,
        });
      }

      return previews;
    });

  if (previews.length === 0) {
    const diagnostics = await page
      .evaluate(() => ({
        url: window.location.href,
        title: document.title,
        bodyText: (document.body.textContent || "").slice(0, 500),
        anchorCount: document.querySelectorAll("a").length,
        imageCount: document.querySelectorAll("img").length,
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
        hrefSamples: Array.from(document.querySelectorAll("a"))
          .map((anchor) => anchor instanceof HTMLAnchorElement ? anchor.href : "")
          .filter(Boolean)
          .slice(0, 20),
      }))
      .catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    console.warn(
      `[instagram] ${canonicalHandle(handle)} profile yielded no post anchors. Diagnostics: ${JSON.stringify(diagnostics)}`,
    );
  }

  const selectedPreviews = previews.slice(0, MAX_POSTS_PER_HANDLE);
  console.log(
    `[instagram] ${canonicalHandle(handle)} selected post previews: ${selectedPreviews
      .map(
        (preview, index) =>
          `${index + 1}=${preview.postUrl}:${preview.isVideoLike ? "video" : "image"}`,
      )
      .join(" | ")}`,
  );

  return selectedPreviews;
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
    throw new Error(
      `downloaded MP4 has no video stream: ${await probeVideo(filePath)}`,
    );
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

async function waitForPostPage(page: Page, postUrl: string): Promise<void> {
  const expectedPath = new URL(postUrl).pathname.replace(/\/$/, "");

  await page
    .waitForURL(
      (currentUrl) => currentUrl.pathname.replace(/\/$/, "") === expectedPath,
      { timeout: 8_000 },
    )
    .catch(() => undefined);

  const hasVisibleMedia = await page
    .locator(
      '[role="dialog"] img, [role="dialog"] video, main img, main video, img, video',
    )
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (!hasVisibleMedia) {
    const diagnostics = await page
      .evaluate(() => ({
        url: window.location.href,
        title: document.title,
        articleCount: document.querySelectorAll("article").length,
        imageCount: document.querySelectorAll("img").length,
        videoCount: document.querySelectorAll("video").length,
        timeCount: document.querySelectorAll("time").length,
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
      }))
      .catch(() => null);
    console.warn(
      `[media-debug] post page media wait timed out: expected=${postUrl}, diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }

  console.log(
    `[media-debug] post page ready: expected=${postUrl}, current=${page.url()}`,
  );
}

function chooseBestVideoCandidate(
  candidates: MediaCandidate[],
): MediaCandidate | null {
  const deduped = new Map<string, MediaCandidate>();

  for (const candidate of candidates) {
    const previous = deduped.get(candidate.sourceUrl);
    if (
      !previous ||
      Number(Boolean(candidate.dataBase64)) > Number(Boolean(previous.dataBase64)) ||
      (candidate.sizeBytes || 0) > (previous.sizeBytes || 0)
    ) {
      deduped.set(candidate.sourceUrl, candidate);
    }
  }

  return (
    [...deduped.values()].sort((left, right) => {
      const leftHasBody = left.dataBase64 ? 1 : 0;
      const rightHasBody = right.dataBase64 ? 1 : 0;
      return (
        rightHasBody - leftHasBody ||
        (right.sizeBytes || 0) - (left.sizeBytes || 0)
      );
    })[0] || null
  );
}

async function collectVideoFromPostPage(
  page: Page,
  postUrl: string,
): Promise<MediaCandidate | null> {
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

  try {
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    await rateLimit("post settled", ACTION_DELAY_MS);
    await dismissInstagramOverlays(page);
    await waitForPostPage(page, postUrl);
    await encourageVideoLoad(page);
    await sleep(1_500);
  } finally {
    page.off("response", onResponse);
  }

  const selected = chooseBestVideoCandidate(networkMedia);
  console.log(
    `[media-debug] post video candidates: post=${postUrl}, count=${networkMedia.length}, selected=${selected?.sourceUrl || "none"}`,
  );
  return selected;
}

async function selectPrimaryImageFromPostPage(
  page: Page,
  postUrl: string,
): Promise<string | null> {
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  await rateLimit("post image fallback settled", ACTION_DELAY_MS);
  await dismissInstagramOverlays(page);
  await waitForPostPage(page, postUrl);

  return page
    .evaluate(() => {
      const viewportCenterX = window.innerWidth / 2;
      const viewportCenterY = window.innerHeight / 2;
      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>(
          '[role="dialog"] article img, main article img, article img, main img',
        ),
      );

      return (
        images
          .map((image) => {
            const rect = image.getBoundingClientRect();
            const sourceUrl = image.currentSrc || image.src;
            const alt = (image.getAttribute("alt") || "").toLowerCase();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            return {
              sourceUrl,
              alt,
              area: rect.width * rect.height,
              visible:
                rect.width >= 220 &&
                rect.height >= 220 &&
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < window.innerHeight &&
                rect.left < window.innerWidth,
              distanceFromCenter: Math.hypot(
                centerX - viewportCenterX,
                centerY - viewportCenterY,
              ),
            };
          })
          .filter(
            ({ sourceUrl, alt, visible }) =>
              visible &&
              Boolean(sourceUrl) &&
              !alt.includes("profile picture") &&
              !alt.includes("foto del perfil"),
          )
          .sort(
            (left, right) =>
              right.area - left.area ||
              left.distanceFromCenter - right.distanceFromCenter,
          )[0]?.sourceUrl || null
      );
    })
    .catch(() => null);
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
  context: BrowserContext,
  preview: PostPreview,
  targetDir: string,
  handle: string,
  postIndex: number,
): Promise<ManifestPost> {
  for (let attempt = 1; attempt <= RETRIES_PER_POST; attempt += 1) {
    try {
      console.log(
        `[instagram] ${canonicalHandle(handle)} post ${postIndex + 1}: scraping attempt ${attempt}`,
      );
      const image = await scrapeSingleAssetForPost(
        context,
        preview,
        targetDir,
        handle,
        postIndex,
      );
      console.log(
        `[instagram] ${canonicalHandle(handle)} post ${postIndex + 1}: downloaded ${image.mediaType} ${image.fileName}`,
      );

      return {
        postUrl: preview.postUrl,
        directUrl: preview.postUrl,
        images: [image],
        downloadedAt: new Date().toISOString(),
        status: "ok",
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
          postUrl: preview.postUrl,
          directUrl: preview.postUrl,
          images: [],
          downloadedAt: new Date().toISOString(),
          status: "failed",
          error: message,
        };
      }
    }
  }

  return {
    postUrl: preview.postUrl,
    directUrl: preview.postUrl,
    images: [],
    downloadedAt: new Date().toISOString(),
    status: "failed",
    error: "Unexpected retry loop exit",
  };
}

async function scrapeSingleAssetForPost(
  context: BrowserContext,
  preview: PostPreview,
  targetDir: string,
  handle: string,
  postIndex: number,
): Promise<ManifestMedia> {
  if (preview.isVideoLike) {
    const page = await context.newPage();
    try {
      const videoCandidate = await collectVideoFromPostPage(
        page,
        preview.postUrl,
      );
      if (!videoCandidate) {
        throw new Error("No playable video candidate was detected from network");
      }

      console.log(
        `[media-debug] post ${postIndex + 1}: asset=${videoCandidate.sourceUrl}, mediaType=video, source=post-page-video`,
      );
      return downloadMedia(videoCandidate, targetDir, handle, postIndex, 0);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  if (
    preview.imageCandidateUrl &&
    looksLikeInstagramMedia(preview.imageCandidateUrl)
  ) {
    console.log(
      `[media-debug] post ${postIndex + 1}: asset=${preview.imageCandidateUrl}, mediaType=image, source=profile-grid`,
    );
    try {
      return await downloadMedia(
        {
          sourceUrl: preview.imageCandidateUrl,
          mediaType: "image",
        },
        targetDir,
        handle,
        postIndex,
        0,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[media-debug] post ${postIndex + 1}: profile-grid image failed, using post fallback: ${message}`,
      );
    }
  }

  const page = await context.newPage();
  try {
    const imageUrl = await selectPrimaryImageFromPostPage(page, preview.postUrl);
    if (!imageUrl || !looksLikeInstagramMedia(imageUrl)) {
      throw new Error("No primary image candidate was detected from post page");
    }

    console.log(
      `[media-debug] post ${postIndex + 1}: asset=${imageUrl}, mediaType=image, source=post-page-image-fallback`,
    );
    return downloadMedia(
      {
        sourceUrl: imageUrl,
        mediaType: "image",
      },
      targetDir,
      handle,
      postIndex,
      0,
    );
  } finally {
    await page.close().catch(() => undefined);
  }
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
  config: RuntimeConfig,
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
      config,
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
    : sliceHandlesFromStart(
        await fetchInstagramHandles(config),
        config.startFromHandle,
      );
  if (handles.length === 0) {
    console.log("[supabase] no instagram handles found; skipping scraping");
    return;
  }

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: 150,
  });

  try {
    const loginContext = await createInstagramContext(
      browser,
      await loadInstagramStorageState(),
    );
    if (await contextHasInstagramSession(loginContext)) {
      console.log("[instagram] using stored session");
    } else {
      await loginToInstagram(loginContext, config);
    }
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
        config,
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
          config,
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
  config: RuntimeConfig,
  handle: string,
  storageState: InstagramStorageState,
  postLimit = MAX_POSTS_PER_HANDLE,
): Promise<Manifest> {
  const context = await createInstagramContext(browser, storageState);
  const profilePage = await context.newPage();

  try {
    const targetDir = await prepareHandleDir(handle);
    const postPreviews = (
      await collectProfilePostPreviews(profilePage, handle, config)
    ).slice(0, postLimit);
    console.log(
      `[instagram] ${canonicalHandle(handle)} found ${postPreviews.length} recent posts`,
    );
    await profilePage.close().catch(() => undefined);

    const posts: ManifestPost[] = [];
    for (let postIndex = 0; postIndex < postPreviews.length; postIndex += 1) {
      posts.push(
        await scrapePostWithRetries(
          context,
          postPreviews[postIndex]!,
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
    await profilePage.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.loginOnly) {
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
    });

    try {
      const context = await createInstagramContext(
        browser,
        await loadInstagramStorageState(),
      );
      if (await contextHasInstagramSession(context)) {
        console.log("[instagram] stored session is already valid");
        await saveInstagramStorageState(context);
      } else {
        await loginToInstagram(context, config);
      }
      await context.close().catch(() => undefined);
      console.log("[dev] login-only done");
    } finally {
      await browser.close().catch(() => undefined);
    }
    return;
  }

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
