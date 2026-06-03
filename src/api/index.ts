import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ASSETS_ROOT, SCRAPE_REPORT_PATH } from "../constants";
import type { Manifest, ScrapeReport } from "../types";
import {
  canonicalHandle,
  fileUrlFor,
  formatDuration,
  handleAssetsDir,
} from "../utils";

async function readManifest(handle: string): Promise<Manifest | null> {
  const manifestPath = join(handleAssetsDir(handle), "manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
}

async function readScrapeReport(): Promise<ScrapeReport | null> {
  if (!existsSync(SCRAPE_REPORT_PATH)) {
    return null;
  }

  return JSON.parse(await readFile(SCRAPE_REPORT_PATH, "utf8")) as ScrapeReport;
}

async function listExistingAssetHandles(): Promise<string[]> {
  if (!existsSync(ASSETS_ROOT)) {
    return [];
  }

  const entries = await readdir(ASSETS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function createApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const report = await readScrapeReport().catch((error) => {
      console.warn("[server] failed to read scrape report:", error);
      return null;
    });

    return c.json({
      ok: true,
      endpoints: ["/assets/:handle", "/files/:handle/:filename"],
      scrape: report
        ? {
            generatedAt: report.generatedAt,
            startedAt: report.startedAt || null,
            finishedAt: report.finishedAt || null,
            durationMs: report.durationMs ?? null,
            duration:
              report.duration ||
              (typeof report.durationMs === "number"
                ? formatDuration(report.durationMs)
                : null),
            totalHandles: report.totalHandles,
            successfulHandles: report.successfulHandles,
            failedHandles: report.failedHandles.length,
            retryRounds: report.retryRounds,
          }
        : null,
    });
  });

  app.get("/assets/:handle", async (c) => {
    const handle = c.req.param("handle");

    try {
      const manifest = await readManifest(handle);
      if (!manifest) {
        return c.json(
          {
            error: "Assets not found for handle",
            handle: canonicalHandle(handle),
          },
          404,
        );
      }

      const posts = manifest.posts.map((post) => ({
        ...post,
        images: post.images.map((image) => ({
          ...image,
          url: fileUrlFor(handle, image.fileName),
        })),
      }));

      return c.json({
        handle: manifest.handle,
        manifest: {
          ...manifest,
          posts,
        },
        images: posts.map((post) => post.images),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to read assets manifest", message }, 500);
    }
  });

  app.get("/files/:handle/:filename", async (c) => {
    const handle = c.req.param("handle");
    const fileName = basename(c.req.param("filename"));
    const filePath = join(handleAssetsDir(handle), fileName);

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return c.json({ error: "File not found" }, 404);
      }

      return new Response(Bun.file(filePath));
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("[server] unhandled error:", error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

async function main(): Promise<void> {
  const app = createApp();
  const server = Bun.serve({
    port: Number(Bun.env.PORT || 3000),
    fetch: app.fetch,
  });

  const handles = await listExistingAssetHandles();
  console.log(`[server] listening on ${server.url}`);
  console.log(`[server] serving ${handles.length} handle asset folders`);
}

main().catch((error) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
