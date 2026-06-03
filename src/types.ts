export type CafeSocialLink = {
  handle: string | null;
  platform: string | null;
};

export type ManifestMedia = {
  fileName: string;
  filePath: string;
  url: string;
  sourceUrl: string;
  mediaType: "image" | "video";
};

export type ManifestPost = {
  postUrl: string;
  images: ManifestMedia[];
  downloadedAt: string;
  status: "ok" | "empty" | "failed";
  error?: string;
};

export type Manifest = {
  handle: string;
  scrapedAt: string;
  posts: ManifestPost[];
};

export type RuntimeConfig = {
  instagramUsername: string;
  instagramPassword: string;
  supabaseUrl: string;
  supabaseKey: string;
  headless: boolean;
  devHandle?: string;
  devPosts: number;
  devMode: boolean;
};

export type MediaCandidate = {
  sourceUrl: string;
  mediaType: "image" | "video";
  contentType?: string;
  dataBase64?: string;
  sizeBytes?: number;
};

export type ScrapeFailureReason =
  | "no_posts_found"
  | "no_media_downloaded"
  | "scrape_error";

export type ScrapeFailure = {
  handle: string;
  reason: ScrapeFailureReason;
  phase: "initial" | "retry";
  attempts: number;
  postCount: number;
  mediaCount: number;
  failedPostCount: number;
  emptyPostCount: number;
  lastError?: string;
  updatedAt: string;
};

export type ScrapeReport = {
  generatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  duration?: string;
  totalHandles: number;
  successfulHandles: number;
  failedHandles: ScrapeFailure[];
  retryRounds: number;
};
