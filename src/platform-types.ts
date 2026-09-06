export type PlatformId =
  | "telegram"
  | "instagram"
  | "facebook"
  | "viber"
  | "tiktok"
  | "prom"
  | "rozetka"
  | "olx"
  | "kasta"
  | "shafa";

export type PlatformPostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed";

export type ProductInput = {
  title: string;
  model?: string;
  price: string;
  dropPrice?: string;
  // Product-level price markup % (positive = markup, negative = discount), added
  // on top of any per-platform markup from settings. 0/undefined = no change.
  priceMarkup?: number;
  sizes?: string;
  sizeSystem?: string;
  colors?: string;
  fabric?: string;
  description?: string;
  imageUrls: string[];
  photoPaths: string[];
  videoUrl?: string;
  videoPath?: string;
  videoStyle?: string;
  processedVideoUrl?: string;
  processedVideoPath?: string;
  useProcessedVideo?: boolean;
  generateVideo?: boolean;
  // Reels, зібраний із фото товару (для позицій без відеозйомки), і кадр 9:16
  // із запеченою ціною для сторіз. Готуються на вимогу через
  // POST /api/products/:id/instagram-media і зберігаються на товарі, щоб
  // заплановані публікації не чекали на ffmpeg у момент слоту.
  slideshowVideoUrl?: string;
  slideshowVideoPath?: string;
  storyImageUrl?: string;
  storyImagePath?: string;
  shopName?: string;
  shopDescription?: string;
  shopLanguage?: string;
};

export type GeneratedPlatformPost = {
  platform: PlatformId;
  text: string;
  status: PlatformPostStatus;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  externalPostId?: string | null;
  externalChatId?: string | null;
  errorMessage?: string | null;
};

export interface PublishingPlatform {
  id: PlatformId;
  name: string;
  supportsPublishing: boolean;
  generatePrompt(product: ProductInput): string;
  publish(params: {
    product: ProductInput;
    text: string;
    photoPaths: string[];
    imageUrls: string[];
    videoPath?: string;
    videoUrl?: string;
    extras?: Record<string, unknown>;
  }): Promise<{
    externalPostId?: string;
    externalChatId?: string;
    raw?: unknown;
  }>;
}
