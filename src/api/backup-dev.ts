import { createBackupApp } from "./backup-api";

const app = createBackupApp(Bun.env.INSFORGE_URL, Bun.env.INSFORGE_API_KEY);
const server = Bun.serve({
  port: Number(Bun.env.PORT || 3001),
  fetch: app.fetch,
});

console.log(`[backup-api] listening on ${server.url}`);
