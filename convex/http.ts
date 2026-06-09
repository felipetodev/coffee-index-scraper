import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const assetKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""))
      .replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase();

    if (!assetKey) {
      return new Response("Asset key is required", { status: 400 });
    }

    const asset = await ctx.runQuery(api.assets.getAssetByKey, { assetKey });
    if (!asset) {
      return new Response("Asset not found", { status: 404 });
    }

    return Response.redirect(asset.url, 302);
  }),
});

export default http;
