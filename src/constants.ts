import { resolve } from "node:path";

export const ASSETS_ROOT = resolve("assets");
export const SCRAPE_REPORT_PATH = resolve("scrape-report.json");
export const INSTAGRAM_STORAGE_STATE_PATH = resolve(
  ".instagram-storage-state.json",
);
export const INSTAGRAM_ORIGIN = "https://www.instagram.com";
export const MAX_POSTS_PER_HANDLE = 6;
export const ACTION_DELAY_MS = [2_500, 6_500] as const;
export const POST_DELAY_MS = [8_000, 18_000] as const;
export const ACCOUNT_DELAY_MS = [45_000, 95_000] as const;
export const DEV_POST_DELAY_MS = [1_000, 2_500] as const;
export const NAVIGATION_TIMEOUT_MS = 45_000;
export const DOWNLOAD_TIMEOUT_MS = 45_000;
export const RETRIES_PER_POST = 2;
export const MIN_VIDEO_BYTES = 100_000;
export const FAILED_HANDLE_RETRY_ROUNDS = 1;

export const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

export const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
];

export const IMAGE_EXTENSIONS_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

export const VIDEO_EXTENSIONS_BY_CONTENT_TYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "application/octet-stream": ".mp4",
};
