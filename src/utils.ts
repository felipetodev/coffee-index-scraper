import { extname, join } from "node:path";
import {
  ASSETS_ROOT,
  IMAGE_EXTENSIONS_BY_CONTENT_TYPE,
  MAX_POSTS_PER_HANDLE,
  VIDEO_EXTENSIONS_BY_CONTENT_TYPE,
} from "./constants";
import type { Manifest, ScrapeFailureReason } from "./types";

export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
}

export function safeHandleFolder(handle: string): string {
  return normalizeHandle(handle).replace(/[^a-z0-9._-]/gi, "_");
}

export function canonicalHandle(handle: string): string {
  return `@${normalizeHandle(handle)}`;
}

export function handleAssetsDir(handle: string): string {
  return join(ASSETS_ROOT, safeHandleFolder(handle));
}

export function fileUrlFor(handle: string, fileName: string): string {
  return `/files/${encodeURIComponent(safeHandleFolder(handle))}/${encodeURIComponent(fileName)}`;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function stringArg(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseArgs(): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};

  for (const arg of Bun.argv.slice(2)) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, value] = arg.slice(2).split("=");
    if (!key) {
      continue;
    }

    parsed[key] = value || true;
  }

  return parsed;
}

export function clampPostLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_POSTS_PER_HANDLE);
}

export function randomBetween([min, max]: readonly [number, number]): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function averageRange([min, max]: readonly [number, number]): number {
  return (min + max) / 2;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function chooseRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function looksLikeInstagramMedia(url: string): boolean {
  return (
    url.includes("cdninstagram.com") ||
    url.includes("fbcdn.net") ||
    url.includes("scontent")
  );
}

export function extensionFromUrl(url: string): string {
  const parsed = new URL(url);
  const extension = extname(parsed.pathname).toLowerCase();
  return extension && extension.length <= 6 ? extension : "";
}

export function extensionFromContentType(
  contentType: string | null,
  sourceUrl: string,
  mediaType: "image" | "video",
): string {
  if (contentType) {
    const normalized = contentType.split(";")[0]?.trim().toLowerCase();
    const extensions =
      mediaType === "video"
        ? VIDEO_EXTENSIONS_BY_CONTENT_TYPE
        : IMAGE_EXTENSIONS_BY_CONTENT_TYPE;
    if (normalized && extensions[normalized]) {
      return extensions[normalized];
    }
  }

  return (
    extensionFromUrl(sourceUrl) || (mediaType === "video" ? ".mp4" : ".jpg")
  );
}

export function countManifestMedia(manifest: Manifest): number {
  return manifest.posts.reduce(
    (total, post) => total + post.images.length,
    0,
  );
}

export function countPostsByStatus(
  manifest: Manifest,
  status: "empty" | "failed",
): number {
  return manifest.posts.filter((post) => post.status === status).length;
}

export function getManifestFailureReason(
  manifest: Manifest,
): ScrapeFailureReason | null {
  if (manifest.posts.length === 0) {
    return "no_posts_found";
  }

  if (countManifestMedia(manifest) === 0) {
    return "no_media_downloaded";
  }

  return null;
}
