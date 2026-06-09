import { Hono } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

type ApiEnv = {
  Bindings: {
    CONVEX_URL?: string;
  };
};

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "https://dev-coffeeindex.vercel.app",
  "https://coffeeindex.vercel.app",
]);
const ASSETS_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

function createConvexClient(convexUrl?: string): ConvexHttpClient | null {
  return convexUrl ? new ConvexHttpClient(convexUrl) : null;
}

export function createApp(convexUrl?: string): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const staticConvex = createConvexClient(convexUrl);

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
      source: "convex",
    }),
  );

  app.get(
    "/assets/:handle",
    cache({
      cacheName: "coffee-index-assets-v1",
      cacheControl: ASSETS_CACHE_CONTROL,
      vary: "Origin",
      cacheableStatusCodes: [200],
      keyGenerator: (c) =>
        new URL(
          `/assets/${(c.req.param("handle") || "").toLowerCase()}`,
          c.req.url,
        ).toString(),
      onCacheNotAvailable: false,
    }),
    async (c) => {
      const convex = staticConvex || createConvexClient(c.env.CONVEX_URL);
      if (!convex) {
        return c.json({ error: "CONVEX_URL is not configured" }, 500);
      }

      try {
        const assets = await convex.query(api.assets.listAssetsByHandle, {
          handle: c.req.param("handle"),
        });

        if (assets.length === 0) {
          return c.json([], 404);
        }

        return c.json(
          assets.map((asset) => ({
            type: asset.mediaType,
            url: asset.url,
            postUrl: asset.postUrl,
          })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: "Failed to read Convex assets", message }, 500);
      }
    },
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("[server] unhandled error:", error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export default {
  fetch(request: Request, env: ApiEnv["Bindings"], executionCtx: unknown) {
    return createApp(env.CONVEX_URL).fetch(
      request,
      env,
      executionCtx as Parameters<Hono<ApiEnv>["fetch"]>[2],
    );
  },
};
