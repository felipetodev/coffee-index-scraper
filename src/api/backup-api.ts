import { createAdminClient } from "@insforge/sdk";
import { Hono } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { normalizeHandle } from "../utils";

type BackupApiEnv = {
  Bindings: {
    INSFORGE_URL?: string;
    INSFORGE_API_KEY?: string;
  };
};

type CafeMediaRow = {
  handle: string;
  post_index: number;
  url: string;
  post_url: string;
  type: "image" | "video";
};

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "https://dev-coffeeindex.vercel.app",
  "https://coffeeindex.vercel.app",
]);
const ASSETS_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const DEFAULT_INSFORGE_URL = "https://anvb3sqr.us-east.insforge.app";

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

function normalizeBaseUrl(url?: string): string {
  return (url || DEFAULT_INSFORGE_URL).replace(/\/+$/, "");
}

async function listCafeMedia(
  baseUrl: string,
  apiKey: string,
  handle: string,
): Promise<CafeMediaRow[]> {
  const admin = createAdminClient({ baseUrl, apiKey });
  const { data, error } = await admin.database
    .from("cafe_media")
    .select("handle, post_index, url, post_url, type")
    .eq("handle", normalizeHandle(handle))
    .order("post_index", { ascending: true });

  if (error) {
    throw new Error(error.message || "InsForge database read failed");
  }

  return (data || []) as CafeMediaRow[];
}

export function createBackupApp(
  insforgeUrl?: string,
  insforgeApiKey?: string,
): Hono<BackupApiEnv> {
  const app = new Hono<BackupApiEnv>();
  const staticBaseUrl = normalizeBaseUrl(insforgeUrl);

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !ALLOWED_ORIGINS.has(normalizeOrigin(origin))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }

    await next();
  });

  app.use(
    "*",
    cors({
      origin: (origin) => {
        const normalizedOrigin = normalizeOrigin(origin);
        return ALLOWED_ORIGINS.has(normalizedOrigin) ? normalizedOrigin : null;
      },
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 86_400,
    }),
  );

  app.get("/", (c) =>
    c.json({
      ok: true,
      endpoints: ["/assets/:handle"],
      source: "insforge",
      table: "cafe_media",
    }),
  );

  app.get(
    "/assets/:handle",
    cache({
      cacheName: "coffee-index-insforge-assets-v2",
      cacheControl: ASSETS_CACHE_CONTROL,
      vary: "Origin",
      cacheableStatusCodes: [200],
      keyGenerator: (c) =>
        new URL(
          `/assets/${normalizeHandle(c.req.param("handle") || "")}`,
          c.req.url,
        ).toString(),
      onCacheNotAvailable: false,
    }),
    async (c) => {
      const apiKey = c.env.INSFORGE_API_KEY || insforgeApiKey;
      if (!apiKey) {
        return c.json({ error: "INSFORGE_API_KEY is not configured" }, 500);
      }

      try {
        const rows = await listCafeMedia(
          normalizeBaseUrl(c.env.INSFORGE_URL || staticBaseUrl),
          apiKey,
          c.req.param("handle"),
        );

        if (rows.length === 0) {
          return c.json([], 404);
        }

        return c.json(
          rows.map((row) => ({
            type: row.type,
            url: row.url,
            postUrl: row.post_url,
          })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
          { error: "Failed to read InsForge media metadata", message },
          500,
        );
      }
    },
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("[backup-api] unhandled error:", error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export default {
  fetch(request: Request, env: BackupApiEnv["Bindings"], executionCtx: unknown) {
    return createBackupApp(env.INSFORGE_URL, env.INSFORGE_API_KEY).fetch(
      request,
      env,
      executionCtx as Parameters<Hono<BackupApiEnv>["fetch"]>[2],
    );
  },
};
