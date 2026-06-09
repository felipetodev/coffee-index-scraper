import { createApp } from "./index";

const app = createApp(Bun.env.CONVEX_URL);
const server = Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  fetch: app.fetch,
});

console.log(`[server] listening on ${server.url}`);
