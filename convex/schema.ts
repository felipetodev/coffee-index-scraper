import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  assetFiles: defineTable({
    handle: v.string(),
    canonicalHandle: v.string(),
    postIndex: v.number(),
    assetKey: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    originalFileName: v.string(),
    mediaType: v.union(v.literal("image"), v.literal("video")),
    contentType: v.optional(v.string()),
    sourceUrl: v.string(),
    postUrl: v.string(),
    directUrl: v.string(),
    downloadedAt: v.string(),
    scrapedAt: v.string(),
    syncedAt: v.string(),
  })
    .index("by_handle", ["handle"])
    .index("by_assetKey", ["assetKey"]),
});
