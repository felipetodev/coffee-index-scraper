import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { ASSETS_ROOT } from "./constants";
import type { Manifest, ManifestMedia } from "./types";
import {
  canonicalHandle,
  normalizeHandle,
  parseArgs,
  safeHandleFolder,
  stringArg,
} from "./utils";

type CafeMediaRow = {
  handle: string;
  canonicalHandle: string;
  postIndex: number;
  assetKey: string;
  url: string;
  postUrl: string;
  type: "image" | "video";
};

const DEFAULT_INSFORGE_URL = "https://anvb3sqr.us-east.insforge.app";
const BUCKET_NAME = "assets";

function insforgeBaseUrl(): string {
  return (Bun.env.INSFORGE_URL || DEFAULT_INSFORGE_URL).replace(/\/+$/, "");
}

function publicObjectUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/api/storage/buckets/${BUCKET_NAME}/objects/${encodeURIComponent(key)}`;
}

function remoteAssetKey(
  handle: string,
  postIndex: number,
  media: ManifestMedia,
): string {
  const extension = extname(media.fileName).toLowerCase();
  return `${safeHandleFolder(handle)}-post-${String(postIndex + 1).padStart(2, "0")}${extension}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function objectExists(url: string): Promise<boolean> {
  const response = await fetch(url, { method: "HEAD" }).catch(() => null);
  return Boolean(response?.ok);
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

async function runInsForgeQuery(sql: string): Promise<void> {
  const process = Bun.spawn(["npx", "@insforge/cli", "db", "query", sql], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    const errorOutput = await new Response(process.stderr).text();
    throw new Error(errorOutput.trim() || `InsForge query failed: ${exitCode}`);
  }
}

function buildInsertSql(rows: CafeMediaRow[]): string | null {
  const values = rows
    .map(
      (row) =>
        `(${sqlString(row.handle)}, ${sqlString(row.canonicalHandle)}, ${row.postIndex}, ${sqlString(row.assetKey)}, ${sqlString(row.url)}, ${sqlString(row.postUrl)}, ${sqlString(row.type)}, now(), now())`,
    )
    .join(", ");

  return values
    ? `
    insert into cafe_media
      (handle, canonical_handle, post_index, asset_key, url, post_url, type, synced_at, updated_at)
    values ${values};
  `
    : null;
}

async function syncManifest(manifestPath: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const handle = normalizeHandle(manifest.handle);
  const baseUrl = insforgeBaseUrl();
  const rows: CafeMediaRow[] = [];

  for (let postIndex = 0; postIndex < manifest.posts.length; postIndex += 1) {
    const post = manifest.posts[postIndex]!;
    const media = post.images[0];
    if (!media) {
      continue;
    }

    const assetKey = remoteAssetKey(handle, postIndex, media);
    const url = publicObjectUrl(baseUrl, assetKey);
    if (!(await objectExists(url))) {
      console.warn(
        `[insforge] skipping ${canonicalHandle(handle)} post ${postIndex + 1}: storage object missing for ${assetKey}`,
      );
      continue;
    }

    rows.push({
      handle,
      canonicalHandle: canonicalHandle(handle),
      postIndex: postIndex + 1,
      assetKey,
      url,
      postUrl: post.postUrl,
      type: media.mediaType,
    });
  }

  await runInsForgeQuery(
    `delete from cafe_media where handle = ${sqlString(handle)};`,
  );

  const insertSql = buildInsertSql(rows);
  if (insertSql) {
    await runInsForgeQuery(insertSql);
  }

  console.log(
    `[insforge] ${canonicalHandle(handle)} synced ${rows.length} media row(s)`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const handle = stringArg(args.handle);
  const manifestPaths = await listManifestPaths(handle);

  if (manifestPaths.length === 0) {
    console.log(
      handle
        ? `[insforge] no local manifest found for ${canonicalHandle(handle)}`
        : "[insforge] no local manifests found; nothing to sync",
    );
    return;
  }

  for (const manifestPath of manifestPaths) {
    await syncManifest(manifestPath);
  }

  console.log(
    `[insforge] synced metadata for ${manifestPaths.length} manifest(s)`,
  );
}

main().catch((error) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
