import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const mediaType = v.union(v.literal("image"), v.literal("video"));

const uploadedAsset = v.object({
  postIndex: v.number(),
  assetKey: v.string(),
  storageId: v.id("_storage"),
  fileName: v.string(),
  originalFileName: v.string(),
  mediaType,
  contentType: v.optional(v.string()),
  sourceUrl: v.string(),
  postUrl: v.string(),
  directUrl: v.string(),
  downloadedAt: v.string(),
});

function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
}

function canonicalHandle(input: string): string {
  return `@${normalizeHandle(input)}`;
}

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return ctx.storage.generateUploadUrl();
  },
});

export const replaceHandleAssets = mutation({
  args: {
    handle: v.string(),
    scrapedAt: v.string(),
    syncedAt: v.string(),
    assets: v.array(uploadedAsset),
  },
  handler: async (ctx, args) => {
    const handle = normalizeHandle(args.handle);
    const existing = await ctx.db
      .query("assetFiles")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .collect();

    for (const item of existing) {
      await ctx.storage.delete(item.storageId).catch(() => undefined);
      await ctx.db.delete(item._id);
    }

    for (const asset of args.assets) {
      await ctx.db.insert("assetFiles", {
        handle,
        canonicalHandle: canonicalHandle(handle),
        postIndex: asset.postIndex,
        assetKey: asset.assetKey,
        storageId: asset.storageId,
        fileName: asset.fileName,
        originalFileName: asset.originalFileName,
        mediaType: asset.mediaType,
        contentType: asset.contentType,
        sourceUrl: asset.sourceUrl,
        postUrl: asset.postUrl,
        directUrl: asset.directUrl,
        downloadedAt: asset.downloadedAt,
        scrapedAt: args.scrapedAt,
        syncedAt: args.syncedAt,
      });
    }

    return {
      handle,
      canonicalHandle: canonicalHandle(handle),
      replaced: existing.length,
      inserted: args.assets.length,
      syncedAt: args.syncedAt,
    };
  },
});

export const getAssetByKey = query({
  args: {
    assetKey: v.string(),
  },
  handler: async (ctx, args) => {
    const assetKey = args.assetKey.trim().toLowerCase();
    const asset = await ctx.db
      .query("assetFiles")
      .withIndex("by_assetKey", (q) => q.eq("assetKey", assetKey))
      .first();

    if (!asset) {
      return null;
    }

    const url = await ctx.storage.getUrl(asset.storageId);
    if (!url) {
      return null;
    }

    return {
      ...asset,
      url,
    };
  },
});

export const listAssetsByHandle = query({
  args: {
    handle: v.string(),
  },
  handler: async (ctx, args) => {
    const handle = normalizeHandle(args.handle);
    const assets = await ctx.db
      .query("assetFiles")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .collect();

    const sortedAssets = assets.sort(
      (left, right) => left.postIndex - right.postIndex,
    );

    return Promise.all(
      sortedAssets.map(async (asset) => ({
        assetKey: asset.assetKey,
        handle: asset.handle,
        canonicalHandle: asset.canonicalHandle,
        postIndex: asset.postIndex,
        fileName: asset.fileName,
        originalFileName: asset.originalFileName,
        mediaType: asset.mediaType,
        contentType: asset.contentType,
        url: (await ctx.storage.getUrl(asset.storageId)) || "",
        sourceUrl: asset.sourceUrl,
        postUrl: asset.postUrl,
        directUrl: asset.directUrl,
        downloadedAt: asset.downloadedAt,
        scrapedAt: asset.scrapedAt,
        syncedAt: asset.syncedAt,
      })),
    );
  },
});
