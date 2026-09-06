import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { getPlatform } from "./platforms";
import { PlatformId, ProductInput } from "./platform-types";

dotenv.config();

const model = process.env.OPENAI_MODEL || "gpt-4o";
const maxVisionImages = 4;
let openai: OpenAI | null = null;

const mimeByExt: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type VideoTextOverlay = {
  text: string;
  start: number;
  end: number;
  position: "top" | "center" | "bottom";
};

export type GeneratedVideoTexts = {
  videoTexts: VideoTextOverlay[];
};

export function imageToDataUrl(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeByExt[ext] || "image/jpeg";
  const base64 = fs.readFileSync(filePath).toString("base64");

  return `data:${mime};base64,${base64}`;
}

export async function generatePlatformPost(
  product: ProductInput,
  platformId: PlatformId
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задано в .env");
  }

  openai ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const platform = getPlatform(platformId);
  return generateWithPrompt(product, platform.generatePrompt(product));
}

// Той самий виклик, але з довільним промптом — потрібен там, де текст пишеться
// не «під платформу», а під конкретний формат поста (Instagram-студія).
export async function generateWithPrompt(product: ProductInput, prompt: string) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задано в .env");
  }

  openai ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const imageInputs = product.photoPaths
    .filter((photoPath) => fs.existsSync(photoPath))
    .slice(0, maxVisionImages)
    .map((photoPath) => ({
      type: "input_image" as const,
      image_url: imageToDataUrl(photoPath),
      detail: "auto" as const,
    }));

  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt,
          },
          ...imageInputs,
        ],
      },
    ],
  });

  return response.output_text.trim();
}

// Applies a percentage change to a price string, preserving whatever currency
// text surrounds the number (e.g. "980 грн" + 10% → "1078 грн", -15% → "833 грн").
// pct may be positive (markup) or negative (discount). Handles spaces as thousand
// separators and comma/dot decimals; rounds to a whole unit and never goes below 0.
// Returns the input unchanged when there's no change (0) or no parseable number.
export function applyPriceMarkup(price: string | undefined, pct: number): string {
  const raw = (price ?? "").toString();
  if (!raw || !pct) return raw;
  const match = raw.match(/\d[\d\s.,]*\d|\d/);
  if (!match) return raw;
  const numStr = match[0];
  const value = parseFloat(numStr.replace(/\s/g, "").replace(",", "."));
  if (!isFinite(value)) return raw;
  const marked = Math.max(0, Math.round(value * (1 + pct / 100)));
  return raw.replace(numStr, String(marked));
}

export function applyProductMarkup(product: ProductInput, pct?: number): ProductInput {
  if (!pct) return product;
  return {
    ...product,
    price: applyPriceMarkup(product.price, pct),
    dropPrice: product.dropPrice ? applyPriceMarkup(product.dropPrice, pct) : product.dropPrice,
  };
}

export async function generatePostsForPlatforms(
  product: ProductInput,
  platformIds: PlatformId[],
  markups?: Partial<Record<PlatformId, number>>
) {
  const uniquePlatformIds = Array.from(new Set(platformIds));
  const posts = await Promise.all(
    uniquePlatformIds.map(async (platform) => ({
      platform,
      text: await generatePlatformPost(applyProductMarkup(product, markups?.[platform]), platform),
      status: "draft" as const,
    }))
  );

  return posts;
}

export async function generatePost(
  product: Omit<ProductInput, "imageUrls" | "photoPaths"> & {
    imageUrls?: string[];
    photoPaths?: string[];
  }
) {
  return generatePlatformPost(
    {
      ...product,
      imageUrls: product.imageUrls || [],
      photoPaths: product.photoPaths || [],
    },
    "telegram"
  );
}

export async function generateVideoTexts(product: ProductInput) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задано в .env");
  }

  openai ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const prompt = `
Ти створюєш короткі написи для відео Reels українською мовою.

Товар:
Назва: ${product.title || ""}
Опис: ${product.description || ""}
Ціна: ${product.price || ""}

Поверни строго JSON без markdown, без пояснень:

{
  "videoTexts": [
    {
      "text": "Новинка",
      "start": 0,
      "end": 2.5,
      "position": "top"
    },
    {
      "text": "3000 грн",
      "start": 2.5,
      "end": 5,
      "position": "center"
    },
    {
      "text": "Замовляй",
      "start": 5,
      "end": 8,
      "position": "bottom"
    }
  ]
}

Правила:
- текст українською;
- кожен напис максимум 2–3 слова;
- максимум 16 символів в одному написі;
- не використовуй довгі речення;
- не використовуй перенос рядка;
- не використовуй крапки в кінці;
- не пиши "для тебе";
- не пиши "вже сьогодні";
- не пиши "ціна лише";
- ціну пиши коротко, наприклад: "3000 грн";
- CTA пиши коротко, наприклад: "Замовляй" або "Пиши нам";
- позиції тільки: top, center, bottom.
`;

  const imageInputs = product.photoPaths
    .filter((photoPath) => fs.existsSync(photoPath))
    .slice(0, maxVisionImages)
    .map((photoPath) => ({
      type: "input_image" as const,
      image_url: imageToDataUrl(photoPath),
      detail: "auto" as const,
    }));

  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt,
          },
          ...imageInputs,
        ],
      },
    ],
  });

  const raw = response.output_text.trim();

  try {
    const parsed = JSON.parse(raw) as GeneratedVideoTexts;

    if (!Array.isArray(parsed.videoTexts)) {
      throw new Error("videoTexts is not array");
    }

    return parsed.videoTexts;
  } catch {
    return [
      {
        text: "🔥 Новинка",
        start: 0,
        end: 2.5,
        position: "top" as const,
      },
      {
        text: product.price ? `💰 ${product.price}` : "Гарний вибір",
        start: 2.5,
        end: 5,
        position: "center" as const,
      },
      {
        text: "📩 Пиши в Direct",
        start: 5,
        end: 8,
        position: "bottom" as const,
      },
    ];
  }
}
