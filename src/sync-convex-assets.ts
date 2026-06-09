import { ConvexHttpClient } from "convex/browser";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ASSETS_ROOT } from "./constants";
import type { Manifest, ManifestMedia } from "./types";
import {
  canonicalHandle,
  normalizeHandle,
  parseArgs,
  safeHandleFolder,
  stringArg,
} from "./utils";

const VERBOSE_LOGS =
  Bun.env.VERBOSE_LOGS === "1" || Bun.env.DEBUG_LOGS === "1";

function verboseLog(message: string): void {
  if (VERBOSE_LOGS) {
    console.log(message);
  }
}

type UploadedAsset = {
  postIndex: number;
  assetKey: string;
  storageId: Id<"_storage">;
  fileName: string;
  originalFileName: string;
  mediaType: "image" | "video";
  contentType?: string;
  sourceUrl: string;
  postUrl: string;
  directUrl: string;
  downloadedAt: string;
};

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function contentTypeFor(media: ManifestMedia): string {
  const extension = extname(media.fileName).toLowerCase();

  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".avif") return "image/avif";
  return "image/jpeg";
}

function remoteFileName(handle: string, postIndex: number, media: ManifestMedia): string {
  const extension = extname(media.fileName).toLowerCase();
  return `${safeHandleFolder(handle)}-post-${String(postIndex + 1).padStart(2, "0")}${extension}`;
}

function assetKey(handle: string, postIndex: number): string {
  return `${safeHandleFolder(handle)}-post-${String(postIndex + 1).padStart(2, "0")}`;
}

async function listManifestPaths(handle?: string): Promise<string[]> {
  if (!existsSync(ASSETS_ROOT)) {
    return [];
  }

  if (handle) {
    const manifestPath = join(
      ASSETS_ROOT,
      safeHandleFolder(handle),
      "manifest.json",
    );
    return existsSync(manifestPath) ? [manifestPath] : [];
  }

  const entries = await readdir(ASSETS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ASSETS_ROOT, entry.name, "manifest.json"))
    .filter((manifestPath) => existsSync(manifestPath));
}

async function uploadFile(
  convex: ConvexHttpClient,
  filePath: string,
  contentType: string,
): Promise<Id<"_storage">> {
  const uploadUrl = await convex.mutation(api.assets.generateUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
    },
    body: Bun.file(filePath),
  });

  if (!response.ok) {
    throw new Error(`Convex upload failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as { storageId?: string };
  if (!body.storageId) {
    throw new Error("Convex upload response did not include storageId");
  }

  return body.storageId as Id<"_storage">;
}

async function syncManifest(
  convex: ConvexHttpClient,
  manifestPath: string,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const handle = normalizeHandle(manifest.handle);
  const handleDir = join(ASSETS_ROOT, safeHandleFolder(handle));
  const syncedAt = new Date().toISOString();
  const assets: UploadedAsset[] = [];

  console.log(`[convex] syncing ${canonicalHandle(handle)}`);
  verboseLog(`[convex-debug] manifest=${manifestPath}`);

  for (let postIndex = 0; postIndex < manifest.posts.length; postIndex += 1) {
    const post = manifest.posts[postIndex]!;
    const media = post.images[0];
    if (!media) {
      console.warn(
        `[convex] skipping ${canonicalHandle(handle)} post ${postIndex + 1}: no asset`,
      );
      continue;
    }

    const localFilePath = join(handleDir, media.fileName);
    const fileStat = await stat(localFilePath).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new Error(`Missing local asset file: ${localFilePath}`);
    }

    const contentType = contentTypeFor(media);
    const storageId = await uploadFile(convex, localFilePath, contentType);
    const key = assetKey(handle, postIndex);
    const fileName = remoteFileName(handle, postIndex, media);

    assets.push({
      postIndex,
      assetKey: key,
      storageId,
      fileName,
      originalFileName: media.fileName,
      mediaType: media.mediaType,
      contentType,
      sourceUrl: media.sourceUrl,
      postUrl: post.postUrl,
      directUrl: post.directUrl,
      downloadedAt: post.downloadedAt,
    });

    verboseLog(`[convex] uploaded ${key} (${fileName})`);
  }

  const result = await convex.mutation(api.assets.replaceHandleAssets, {
    handle,
    scrapedAt: manifest.scrapedAt,
    syncedAt,
    assets,
  });

  console.log(
    `[convex] ${canonicalHandle(handle)} replaced ${result.replaced}, inserted ${result.inserted}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const handle = stringArg(args.handle);
  const convex = new ConvexHttpClient(requiredEnv("CONVEX_URL"));
  const manifestPaths = await listManifestPaths(handle);

  if (manifestPaths.length === 0) {
    console.log(
      handle
        ? `[convex] no local manifest found for ${canonicalHandle(handle)}`
        : "[convex] no local manifests found; nothing to sync",
    );
    return;
  }

  for (const manifestPath of manifestPaths) {
    await syncManifest(convex, manifestPath);
  }

  console.log(`[convex] synced ${manifestPaths.length} manifest(s)`);
}

main().catch((error) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
