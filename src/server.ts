import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { NextFunction } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";

import {
  generatePlatformPost,
  generatePostsForPlatforms,
  generateVideoTexts,
  applyProductMarkup,
} from "./ai-generator";
import { initDb } from "./db/sqlite";
import { editTelegramPost } from "./telegram";
import { enabledPlatformIds, isPlatformId } from "./platforms";
import { PlatformId, ProductInput } from "./platform-types";
import { publishPlatformPost, startScheduler, syncTikTokPublishingPost } from "./scheduler";
import {
  createReelsStyleVideo,
  createSlideshowReel,
  createStoryFrame,
  filePathToPublicUrl,
} from "./video-overlay";
import {
  buildAuthUrl,
  completeFacebookOAuth,
  selectFacebookPage,
  selectFacebookPageManual,
  getFacebookStatus,
  readEnv,
  writeEnvVars,
} from "./facebook-auth";
import { authMiddleware, hashPassword, verifyPassword, signToken, extractTokenFromQuery, signOAuthState, verifyOAuthState } from "./auth";
import { saveUserToken, deleteUserToken, getUserSocialStatus, getUserTokens, updateUserTokenMeta, hashForIdentity } from "./user-tokens";
import {
  getVideoDurationSeconds,
  normalizeTikTokPostSettings,
  queryTikTokCreatorInfo,
  refreshTikTokTokenRaw,
  validateTikTokPostSettings,
} from "./tiktok";

dotenv.config();
// On Railway: load persisted tokens from Volume (survives container restarts)
if (fs.existsSync("/data/.env")) dotenv.config({ path: "/data/.env", override: true });

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_SITE_URL = "https://postly.pp.ua";
process.env.SITE_URL ||= DEFAULT_SITE_URL;
process.env.PUBLIC_BASE_URL ||= process.env.SITE_URL;
// On Railway, /data is the persistent volume — the container filesystem itself
// (including __dirname) is wiped on every redeploy, which was silently deleting
// every previously uploaded photo/video (and breaking their public URLs) each
// time we shipped a fix. Default onto the volume when it's present.
const uploadsDir = process.env.UPLOADS_DIR || (fs.existsSync("/data") ? "/data/uploads" : path.join(__dirname, "uploads"));

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

console.log(
  `[uploads] UPLOADS_DIR env: ${process.env.UPLOADS_DIR || "(not set)"} | ` +
  `/data exists: ${fs.existsSync("/data")} | ` +
  `resolved uploadsDir: ${uploadsDir} | ` +
  `existing files: ${(() => { try { return fs.readdirSync(uploadsDir).length; } catch (e) { return `error: ${e}`; } })()}`
);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

// Uploaded files are served back out publicly from /uploads with no further
// processing — without a type check, anyone could upload an .html or .svg file
// (multer accepts anything by default) and get a same-origin URL that executes
// arbitrary script when opened, turning the app into XSS-payload hosting. Only
// actual image/video content types are accepted; everything else is rejected
// before it ever touches disk.
const ALLOWED_UPLOAD_MIME = /^(image\/(jpeg|png|webp|heic|heif|gif)|video\/(mp4|quicktime|webm))$/;
const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME.test(file.mimetype)) return cb(null, true);
    cb(new Error("Дозволені лише файли зображень або відео"));
  },
});
const uploadPhotos = upload.array("photos", 10);
const uploadCompat = upload.fields([
  { name: "photos", maxCount: 10 },
  { name: "photo", maxCount: 1 },
  { name: "video", maxCount: 1 },
]);

const pendingFacebookOAuth = new Map<number, { userToken: string; expiresAt: number }>();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadsDir));

// ── Auth routes (public) ────────────────────────────────────────────────────

app.post("/api/auth/register", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email і пароль (мін. 6 символів) обовʼязкові" });
  }
  try {
    const db = await initDb();
    const existing = await db.get("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
    if (existing) return res.status(400).json({ error: "Email вже зареєстрований" });
    const hash = await hashPassword(password);
    const result = await db.run(
      "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
      [email.toLowerCase(), hash, new Date().toISOString()]
    );
    const token = signToken(result.lastID as number);
    res.json({ token, userId: result.lastID, email: email.toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
  }
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) return res.status(400).json({ error: "Email і пароль обовʼязкові" });
  try {
    const db = await initDb();
    const user = await db.get("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: "Невірний email або пароль" });
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Невірний email або пароль" });
    const token = signToken(user.id);
    res.json({ token, userId: user.id, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
  }
});
app.get("/products", (_req: Request, res: Response) => {
  res.redirect("/products.html");
});
app.get("/products/", (_req: Request, res: Response) => {
  res.redirect("/products.html");
});
app.use(express.static(path.join(__dirname, "../public"), {
  // HTML shells change on every deploy (landing/cabinet/settings pages) — never let
  // browsers or intermediate caches serve a stale one; still lets them revalidate
  // cheaply via ETag. Other static assets (css/js) keep express.static's defaults.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function currentUserId(req: Request) {
  return (req as any).userId as number;
}

function publicSiteUrl() {
  return (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, "");
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminEmail = toText(process.env.ADMIN_EMAIL).toLowerCase();
  // Fail closed, not open: if ADMIN_EMAIL isn't configured, no one is admin — these
  // routes manage shared/global platform config (TikTok/OLX app secrets, site URL),
  // so an unset ADMIN_EMAIL must never make them accessible to every logged-in user.
  if (!adminEmail) return res.status(403).json({ success: false, message: "Адмінська функція недоступна: ADMIN_EMAIL не налаштовано" });
  try {
    const db = await initDb();
    const user = await db.get(`SELECT email FROM users WHERE id = ?`, [currentUserId(req)]);
    if (String(user?.email || "").toLowerCase() === adminEmail) return next();
  } catch {
    // fall through to forbidden
  }
  return res.status(403).json({ success: false, message: "Доступ тільки для адміністратора" });
}

async function requireExistingUser(req: Request, res: Response, next: NextFunction) {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const db = await initDb();
    const user = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
    if (user) return next();
  } catch {
    // fall through to invalid session
  }
  return res.status(401).json({ error: "User no longer exists" });
}

const requireUser = [authMiddleware, requireExistingUser];

function parsePlatforms(value: unknown): PlatformId[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.startsWith("[")
        ? JSON.parse(value)
        : value.split(",")
      : [];
  const platforms = (rawValues as unknown[])
    .map((item: unknown) => String(item).trim())
    .filter(isPlatformId)
    .filter((platform: PlatformId) => enabledPlatformIds.includes(platform));

  return platforms.length ? Array.from(new Set(platforms)) : ["telegram"];
}

function getUploadedFiles(req: Request) {
  if (Array.isArray(req.files)) {
    return req.files;
  }

  const groupedFiles = req.files as
    | Record<string, Express.Multer.File[]>
    | undefined;

  return [
    ...(groupedFiles?.photos || []),
    ...(groupedFiles?.photo || []),
  ].slice(0, 10);
}

function getUploadedVideo(req: Request) {
  if (Array.isArray(req.files)) {
    return undefined;
  }

  const groupedFiles = req.files as
    | Record<string, Express.Multer.File[]>
    | undefined;

  return groupedFiles?.video?.[0];
}

function filesToImages(files: Express.Multer.File[]) {
  return files.map((file, index) => ({
    imageUrl: `/uploads/${file.filename}`,
    photoPath: file.path,
    sortOrder: index,
  }));
}

function fileToVideo(file?: Express.Multer.File) {
  if (!file) {
    return {};
  }

  return {
    videoUrl: `/uploads/${file.filename}`,
    videoPath: file.path,
  };
}

function productInputFromBody(
  body: Record<string, unknown>,
  images: { imageUrl: string; photoPath: string }[],
  video?: { videoUrl?: string; videoPath?: string }
): ProductInput {
  return {
    title: toText(body.title),
    model: toText(body.model),
    price: toText(body.price),
    dropPrice: toText(body.dropPrice),
    sizes: toText(body.sizes),
    sizeSystem: toText(body.sizeSystem) || undefined,
    colors: toText(body.colors),
    fabric: toText(body.fabric),
    description: toText(body.description),
    priceMarkup: Number(body.priceMarkup) || 0,
    imageUrls: images.map((image) => image.imageUrl),
    photoPaths: images.map((image) => image.photoPath),
    videoUrl: video?.videoUrl || toText(body.videoUrl) || undefined,
    videoPath: video?.videoPath || toText(body.videoPath) || undefined,

    videoStyle: toText(body.videoStyle) || "fashion",
    processedVideoUrl: toText(body.processedVideoUrl) || undefined,
    processedVideoPath: toText(body.processedVideoPath) || undefined,
    generateVideo: body.generateVideo !== "off" && body.generateVideo !== "0",
    useProcessedVideo: body.useProcessedVideo !== "0" && body.useProcessedVideo !== false,
    shopName: toText(body.shopName) || undefined,
    shopDescription: toText(body.shopDescription) || undefined,
    shopLanguage: toText(body.shopLanguage) || undefined,
  };
}

async function getImages(db: any, productId: number) {
  return db.all(
    `
    SELECT *
    FROM product_images
    WHERE productId = ?
    ORDER BY sortOrder ASC, id ASC
    `,
    [productId]
  );
}

async function getPlatformPosts(db: any, productId: number) {
  const posts = await db.all(
    `
    SELECT *
    FROM platform_posts
    WHERE productId = ?
    ORDER BY id ASC
    `,
    [productId]
  );
  return posts.map(presentPlatformPost);
}

function parseStoredObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Формат публікації в Instagram зберігається на самому пості (platformSettings),
// бо з одного набору медіа виходять різні публікації: відео + фото — це або Reels,
// або карусель із відео першим слайдом, і лише перше дає охоплення поза підписниками.
const INSTAGRAM_FORMATS = ["auto", "reels", "slideshow", "carousel", "story"] as const;
type InstagramPostFormat = (typeof INSTAGRAM_FORMATS)[number];

function normalizeInstagramPostSettings(raw: unknown): { format: InstagramPostFormat } {
  const source = parseStoredObject(raw);
  const format = String(source.format || "auto") as InstagramPostFormat;
  return { format: INSTAGRAM_FORMATS.includes(format) ? format : "auto" };
}

function presentPlatformPost(post: any) {
  if (!post) return post;
  return {
    ...post,
    platformSettings: parseStoredObject(post.platformSettings),
    platformStatus: parseStoredObject(post.platformStatus),
  };
}

async function getProductDetails(db: any, productId: number) {
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);

  if (!product) {
    return null;
  }

  return {
    product,
    images: await getImages(db, productId),
    platformPosts: await getPlatformPosts(db, productId),
  };
}

async function getOwnedProductDetails(db: any, productId: number, userId: number) {
  const details = await getProductDetails(db, productId);
  if (!details || String(details.product.userId) !== String(userId)) return null;
  return details;
}

async function getOwnedPlatformPost(db: any, postId: number, userId: number) {
  return db.get(
    `
    SELECT pp.*
    FROM platform_posts pp
    JOIN products p ON p.id = pp.productId
    WHERE pp.id = ? AND p.userId = ?
    `,
    [postId, String(userId)]
  );
}

function parseSocialLinks(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Parses the per-platform markup map. Values may be positive (markup) or negative
// (discount); 0/absent means no change. Keeps finite non-zero numbers only.
function parsePlatformMarkups(raw: unknown): Record<string, number> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (isFinite(n) && n !== 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

async function getPlatformMarkups(db: any, userId: number): Promise<Record<string, number>> {
  const row = await db.get(`SELECT platform_markups FROM user_settings WHERE user_id = ?`, [userId]);
  return parsePlatformMarkups(row?.platform_markups);
}

// Total markup per platform = the product-level markup (entered next to the price)
// plus that platform's own markup from settings. Both may be positive or negative.
function combineMarkups(
  productMarkup: number,
  platformMarkups: Record<string, number>,
  platformIds: PlatformId[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of platformIds) {
    const total = (productMarkup || 0) + (platformMarkups[p] || 0);
    if (total) out[p] = total;
  }
  return out;
}

async function getUserSettings(db: any, userId: number) {
  const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
  const env = readEnv();
  const g = (k: string) => env[k] || process.env[k] || "";
  return {
    shopName: settings?.shop_name || g("SHOP_NAME"),
    shopDescription: settings?.shop_description || g("SHOP_DESCRIPTION"),
    shopLanguage: settings?.shop_language || g("SHOP_LANGUAGE") || "uk",
    facebookPageUrl: settings?.facebook_page_url || g("FACEBOOK_PAGE_URL"),
    instagramUrl: settings?.instagram_url || g("INSTAGRAM_URL"),
    telegramChatId: settings?.telegram_chat_id || "",
    telegramOrderLogin: settings?.telegram_order_login || "",
    telegramSocialLinks: parseSocialLinks(settings?.telegram_social_links),
  };
}

async function getValidUserTikTokTokens(db: any, userId: number) {
  const userTokens = await getUserTokens(db, userId);
  let tokens = userTokens.tiktok;
  if (!tokens) {
    throw new Error("TikTok не підключено. Підключіть свій акаунт у Налаштуваннях.");
  }
  if (tokens.expiresAt < Date.now() + 60_000) {
    const refreshed = await refreshTikTokTokenRaw(tokens.refreshToken);
    await saveUserToken(db, userId, "tiktok", {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      open_id: refreshed.openId,
      expires_at: refreshed.expiresAt,
      refresh_expires_at: refreshed.refreshExpiresAt,
    });
    tokens = refreshed;
  }
  return tokens;
}

async function withUserSettings(db: any, userId: number, product: ProductInput): Promise<ProductInput> {
  const settings = await getUserSettings(db, userId);
  return {
    ...product,
    shopName: settings.shopName || product.shopName,
    shopDescription: settings.shopDescription || product.shopDescription,
    shopLanguage: settings.shopLanguage || product.shopLanguage,
  };
}

async function insertProduct(
  db: any,
  userId: number,
  product: ProductInput,
  images: { imageUrl: string; photoPath: string; sortOrder: number }[],
  platformIds: PlatformId[]
) {
  const now = new Date().toISOString();
  const productWithSettings = await withUserSettings(db, userId, product);
  const platformMarkups = await getPlatformMarkups(db, userId);
  const markups = combineMarkups(Number(product.priceMarkup) || 0, platformMarkups, platformIds);
  const generatedPosts = await generatePostsForPlatforms(productWithSettings, platformIds, markups as any);
  const telegramDraft = generatedPosts.find((post) => post.platform === "telegram");
  const firstImage = images[0];
  const result = await db.run(
    `
    INSERT INTO products (
      userId,
      createdAt,
      updatedAt,
      title,
      model,
      price,
      dropPrice,
      sizes,
      sizeSystem,
      colors,
      fabric,
      description,
      imageUrl,
      photoPath,
      videoUrl,
      videoPath,
      videoStyle,
      processedVideoUrl,
      processedVideoPath,
      useProcessedVideo,
      generateVideo,
      shopName,
      shopDescription,
      shopLanguage,
      priceMarkup,
      generatedPost,
      telegramPublished,
      telegramChatId,
      telegramMessageId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
    `,
    [
      String(userId),
      now,
      now,
      productWithSettings.title,
      productWithSettings.model,
      productWithSettings.price,
      productWithSettings.dropPrice,
      productWithSettings.sizes,
      productWithSettings.sizeSystem || null,
      productWithSettings.colors,
      productWithSettings.fabric,
      productWithSettings.description,
      firstImage?.imageUrl || null,
      firstImage?.photoPath || null,
      productWithSettings.videoUrl || null,
      productWithSettings.videoPath || null,
      productWithSettings.videoStyle || "fashion",
      productWithSettings.processedVideoUrl || null,
      productWithSettings.processedVideoPath || null,
      productWithSettings.useProcessedVideo === false ? 0 : 1,
      productWithSettings.generateVideo === false ? 0 : 1,
      productWithSettings.shopName || null,
      productWithSettings.shopDescription || null,
      productWithSettings.shopLanguage || "uk",
      Number(productWithSettings.priceMarkup) || 0,
      telegramDraft?.text || null,
    ]
  );
  const productId = result.lastID;

  for (const image of images) {
    await db.run(
      `
      INSERT INTO product_images (productId, imageUrl, photoPath, sortOrder, createdAt)
      VALUES (?, ?, ?, ?, ?)
      `,
      [productId, image.imageUrl, image.photoPath, image.sortOrder, now]
    );
  }

  for (const post of generatedPosts) {
    await db.run(
      `
      INSERT INTO platform_posts (
        productId,
        platform,
        text,
        status,
        createdAt,
        updatedAt
      ) VALUES (?, ?, ?, 'draft', ?, ?)
      `,
      [productId, post.platform, post.text, now, now]
    );
  }

  return productId;
}

async function updateProductFields(db: any, productId: number, body: any) {
  const now = new Date().toISOString();

  await db.run(
    `
    UPDATE products
    SET title = ?,
        model = ?,
        price = ?,
        dropPrice = ?,
        sizes = ?,
        sizeSystem = ?,
        colors = ?,
        fabric = ?,
        description = ?,
        priceMarkup = ?,
        videoStyle = ?,
        useProcessedVideo = ?,
        generateVideo = ?,
        updatedAt = ?
    WHERE id = ?
    `,
    [
      toText(body.title),
      toText(body.model),
      toText(body.price),
      toText(body.dropPrice),
      toText(body.sizes),
      toText(body.sizeSystem) || null,
      toText(body.colors),
      toText(body.fabric),
      toText(body.description),
      Number(body.priceMarkup) || 0,
      toText(body.videoStyle) || "fashion",
      body.useProcessedVideo === "0" || body.useProcessedVideo === false ? 0 : 1,
      body.generateVideo === "off" || body.generateVideo === "0" ? 0 : 1,
      now,
      productId,
    ]
  );
}

async function generateProcessedVideo(product: ProductInput) {
  if (!product.videoPath || product.generateVideo === false) {
    return null;
  }

  // Ціна, запечена в кадр, має збігатися з ціною в тексті поста. Це відео одне
  // на всі платформи, тому застосовуємо лише націнку рівня товару — платформену
  // не можна, вона в кожної платформи своя.
  const videoTexts = await generateVideoTexts(
    applyProductMarkup(product, Number(product.priceMarkup) || 0)
  );

  const processedVideo = await createReelsStyleVideo({
    inputPath: product.videoPath,
    uploadsDir,
    videoTexts,
    videoStyle: product.videoStyle as any,
  });

  return {
    processedVideoPath: processedVideo.outputPath,
    processedVideoUrl: filePathToPublicUrl(processedVideo.outputPath),
  };
}

async function startServer() {
  const db = await initDb();

  startScheduler(db);

  app.post(
    "/api/posts/preview",
    ...requireUser,
    uploadCompat,
    async (req: Request, res: Response) => {
      try {
        const files = getUploadedFiles(req);
        const video = fileToVideo(getUploadedVideo(req));

        if (!files.length && !video.videoUrl) {
          return res.status(400).json({
            success: false,
            message: "Завантаж хоча б одне фото або відео товару",
          });
        }

        const images = filesToImages(files);
        const product = productInputFromBody(req.body, images, video);
        const platformIds = parsePlatforms(req.body.selectedPlatforms);
        const productId = await insertProduct(db, currentUserId(req), product, images, platformIds);

        const details = await getProductDetails(db, productId);

        // Return response immediately — don't block on FFmpeg video processing
        res.json({ success: true, ...details, productId, videoProcessing: !!product.videoPath });

        // Process video in background after response is sent
        if (product.videoPath) {
          generateProcessedVideo(product).then(async processedVideo => {
            if (!processedVideo) return;
            await db.run(
              `UPDATE products SET processedVideoPath=?, processedVideoUrl=?, useProcessedVideo=1, updatedAt=? WHERE id=?`,
              [processedVideo.processedVideoPath, processedVideo.processedVideoUrl, new Date().toISOString(), productId]
            );
            console.log(`[Video] Background processing done for product ${productId}: ${processedVideo.processedVideoUrl}`);
          }).catch(err => {
            console.error(`[Video] Background processing failed for product ${productId}:`, err);
          });
        }
      } catch (error) {
        console.error("Preview error:", error);
        const raw = error instanceof Error ? error.message : String(error);
        const friendly = raw.includes("API key") || raw.includes("401") || raw.includes("403")
          ? "OpenAI: недійсний або прострочений API-ключ. Перевір OPENAI_API_KEY у .env"
          : raw.includes("rate") || raw.includes("429")
            ? "OpenAI: перевищено ліміт запитів. Спробуй через хвилину."
            : raw.includes("JSON") || raw.includes("parse") || raw.includes("Unexpected")
              ? `Помилка розбору відповіді AI: ${raw.slice(0, 120)}`
              : raw || "Помилка генерації попереднього перегляду";
        return res.status(500).json({ success: false, message: friendly });
      }
    }
  );

  app.post(
    "/api/posts/:productId/regenerate",
    ...requireUser,
    async (req: Request, res: Response) => {
      try {
        const productId = Number(req.params.productId);
        const details = await getOwnedProductDetails(db, productId, currentUserId(req));

        if (!details) {
          return res.status(404).json({
            success: false,
            message: "Товар не знайдено",
          });
        }

        await updateProductFields(db, productId, {
          ...details.product,
          ...req.body,
        });

        const nextDetails = await getProductDetails(db, productId);
        const platformIds = parsePlatforms(
          req.body.platforms || req.body.platform || req.body.selectedPlatforms
        );
        const product = await withUserSettings(db, currentUserId(req), productInputFromBody(
          nextDetails!.product,
          nextDetails!.images,
          {
            videoUrl: nextDetails!.product.videoUrl,
            videoPath: nextDetails!.product.videoPath,
          }
        ));
        const now = new Date().toISOString();
        const platformMarkups = await getPlatformMarkups(db, currentUserId(req));
        const productMarkup = Number(product.priceMarkup) || 0;
        const updatedPosts = [];

        for (const platform of platformIds) {
          const totalMarkup = productMarkup + (platformMarkups[platform] || 0);
          const text = await generatePlatformPost(applyProductMarkup(product, totalMarkup), platform);
          const existing = nextDetails!.platformPosts.find(
            (post: any) => post.platform === platform
          );

          if (existing) {
            await db.run(
              `
              UPDATE platform_posts
              SET text = ?,
                  status = CASE WHEN status = 'published' THEN status ELSE 'draft' END,
                  errorMessage = NULL,
                  updatedAt = ?
              WHERE id = ?
              `,
              [text, now, existing.id]
            );
          } else {
            await db.run(
              `
              INSERT INTO platform_posts (
                productId,
                platform,
                text,
                status,
                createdAt,
                updatedAt
              ) VALUES (?, ?, ?, 'draft', ?, ?)
              `,
              [productId, platform, text, now, now]
            );
          }

          updatedPosts.push(platform);
        }

        const responseDetails = await getProductDetails(db, productId);

        return res.json({
          success: true,
          updatedPosts,
          ...responseDetails,
        });
      } catch (error) {
        console.error("Regenerate error:", error);

        return res.status(500).json({
          success: false,
          message: error instanceof Error ? error.message : "Помилка перегенерації",
        });
      }
    }
  );

  app.put("/api/platform-posts/:id", ...requireUser, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const post = await getOwnedPlatformPost(db, id, currentUserId(req));

      if (!post) {
        return res.status(404).json({
          success: false,
          message: "Пост платформи не знайдено",
        });
      }

      const text = toText(req.body.text) || post.text;
      const status = toText(req.body.status) || post.status;
      const scheduledAt = req.body.scheduledAt
        ? new Date(String(req.body.scheduledAt)).toISOString()
        : null;
      let platformSettings = post.platformSettings || null;
      if (post.platform === "instagram" && req.body.platformSettings !== undefined) {
        platformSettings = JSON.stringify(normalizeInstagramPostSettings(req.body.platformSettings));
      }
      if (post.platform === "tiktok" && req.body.platformSettings !== undefined) {
        const settings = normalizeTikTokPostSettings(req.body.platformSettings);
        if (status === "scheduled") validateTikTokPostSettings(settings);
        platformSettings = JSON.stringify(settings);
      }
      const now = new Date().toISOString();

      await db.run(
        `
        UPDATE platform_posts
        SET text = ?,
            status = ?,
            scheduledAt = ?,
            platformSettings = ?,
            errorMessage = NULL,
            updatedAt = ?
        WHERE id = ?
        `,
        [text, status, scheduledAt, platformSettings, now, id]
      );

      if (
        post.platform === "telegram" &&
        post.status === "published" &&
        post.externalChatId &&
        post.externalPostId
      ) {
        const s = await getUserSettings(db, currentUserId(req));
        await editTelegramPost(text, post.externalChatId, post.externalPostId, "caption", {
          chatId: s.telegramChatId,
          orderLogin: s.telegramOrderLogin,
          socialLinks: s.telegramSocialLinks,
        });
      }

      const updated = await db.get(`SELECT * FROM platform_posts WHERE id = ?`, [
        id,
      ]);

      return res.json({
        success: true,
        platformPost: presentPlatformPost(updated),
      });
    } catch (error) {
      console.error("Update platform post error:", error);

      return res.status(500).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Помилка оновлення поста платформи",
      });
    }
  });

  app.post("/api/platform-posts/:id/publish", ...requireUser, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const post = await getOwnedPlatformPost(db, id, currentUserId(req));
      if (!post) {
        return res.status(404).json({ success: false, message: "Пост платформи не знайдено" });
      }

      const settingsProvided = req.body.platformSettings !== undefined;
      if (req.body.text || ((post.platform === "tiktok" || post.platform === "instagram") && settingsProvided)) {
        const platformSettings = settingsProvided && post.platform === "tiktok"
          ? JSON.stringify(validateTikTokPostSettings(req.body.platformSettings))
          : settingsProvided && post.platform === "instagram"
            ? JSON.stringify(normalizeInstagramPostSettings(req.body.platformSettings))
            : post.platformSettings;
        await db.run(
          `
          UPDATE platform_posts
          SET text = ?,
              platformSettings = ?,
              updatedAt = ?
          WHERE id = ?
          `,
          [toText(req.body.text) || post.text, platformSettings, new Date().toISOString(), id]
        );
      }

      const extras = req.body.extras && typeof req.body.extras === "object"
        ? req.body.extras as Record<string, unknown>
        : undefined;
      const result = await publishPlatformPost(db, id, extras);
      const platformPost = await db.get(`SELECT * FROM platform_posts WHERE id = ?`, [
        id,
      ]);

      return res.json({
        success: true,
        result,
        platformPost: presentPlatformPost(platformPost),
      });
    } catch (error) {
      console.error("Publish platform post error:", error);

      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Помилка публікації",
      });
    }
  });

  app.get("/api/platform-posts/:id/status", ...requireUser, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      let post = await getOwnedPlatformPost(db, id, currentUserId(req));
      if (!post) {
        return res.status(404).json({ success: false, message: "Пост платформи не знайдено" });
      }
      if (post.platform === "tiktok" && post.status === "publishing") {
        await syncTikTokPublishingPost(db, id);
        post = await getOwnedPlatformPost(db, id, currentUserId(req));
      }
      return res.json({ success: true, platformPost: presentPlatformPost(post) });
    } catch (error) {
      console.error("Platform post status error:", error);
      return res.status(502).json({
        success: false,
        message: error instanceof Error ? error.message : "Не вдалося перевірити статус публікації",
      });
    }
  });

  app.get("/api/products/:id", ...requireUser, async (req: Request, res: Response) => {
    const details = await getOwnedProductDetails(db, Number(req.params.id), currentUserId(req));
    if (!details) return res.status(404).json({ success: false, message: "Товар не знайдено" });
    res.json({ success: true, ...details });
  });

  app.post("/api/products/:id/publish", ...requireUser, async (req: Request, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const details = await getOwnedProductDetails(db, productId, currentUserId(req));
      if (!details) {
        return res.status(404).json({ success: false, message: "Товар не знайдено" });
      }
      const platformIds = parsePlatforms(req.body.platforms || req.body.platform);
      const posts = details.platformPosts;
      const results = [];

      for (const platform of platformIds) {
        const post = posts.find((item: any) => item.platform === platform);

        if (!post) {
          throw new Error(`Для платформи ${platform} немає згенерованого поста`);
        }

        results.push({
          platform,
          result: await publishPlatformPost(db, post.id),
        });
      }

      return res.json({
        success: true,
        results,
        ...(await getProductDetails(db, productId)),
      });
    } catch (error) {
      console.error("Publish product error:", error);

      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Помилка публікації",
      });
    }
  });

  app.get("/api/products", ...requireUser, async (req: Request, res: Response) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const query = toText(req.query.query);
    const platform = toText(req.query.platform);
    const status = toText(req.query.status);

    where.push(`p.userId = ?`);
    params.push(String(currentUserId(req)));

    if (query) {
      where.push(`(LOWER(p.title) LIKE ? OR LOWER(p.model) LIKE ?)`);
      params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
    }

    if (platform && isPlatformId(platform)) {
      where.push(
        `EXISTS (SELECT 1 FROM platform_posts pp WHERE pp.productId = p.id AND pp.platform = ?)`
      );
      params.push(platform);
    }

    if (status) {
      where.push(
        `EXISTS (SELECT 1 FROM platform_posts pp WHERE pp.productId = p.id AND pp.status = ?)`
      );
      params.push(status);
    }

    const products = await db.all(
      `
      SELECT p.*
      FROM products p
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.id DESC
      `,
      params
    );

    const hydrated = await Promise.all(
      products.map(async (product: any) => ({
        ...product,
        images: await getImages(db, product.id),
        platformPosts: await getPlatformPosts(db, product.id),
      }))
    );

    return res.json({
      success: true,
      products: hydrated,
    });
  });

  app.get("/api/products/:id", ...requireUser, async (req: Request, res: Response) => {
    const productId = Number(req.params.id);
    const details = await getOwnedProductDetails(db, productId, currentUserId(req));

    if (!details) {
      return res.status(404).json({
        success: false,
        message: "Товар не знайдено",
      });
    }

    return res.json({
      success: true,
      ...details,
    });
  });

  app.put("/api/products/:id", ...requireUser, async (req: Request, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const details = await getOwnedProductDetails(db, productId, currentUserId(req));

      if (!details) {
        return res.status(404).json({
          success: false,
          message: "Товар не знайдено",
        });
      }

      await updateProductFields(db, productId, {
        ...details.product,
        ...req.body,
      });

      return res.json({
        success: true,
        ...(await getProductDetails(db, productId)),
      });
    } catch (error) {
      console.error("Update product error:", error);

      return res.status(500).json({
        success: false,
        message: "Помилка оновлення товару",
      });
    }
  });

  app.post("/preview-post", ...requireUser, uploadCompat, async (req: Request, res: Response) => {
    try {
      const files = getUploadedFiles(req);
      const video = fileToVideo(getUploadedVideo(req));

      if (!files.length && !video.videoUrl) {
        return res.status(400).json({
          success: false,
          message: "Завантаж хоча б одне фото або відео товару",
        });
      }

      const images = filesToImages(files);
      const product = productInputFromBody(req.body, images, video);
      const productId = await insertProduct(db, currentUserId(req), product, images, ["telegram"]);
      const details = await getProductDetails(db, productId);
      const telegramPost = details!.platformPosts.find(
        (post: any) => post.platform === "telegram"
      );

      return res.json({
        success: true,
        productId,
        generatedText: telegramPost?.text || "",
        imageUrl: details!.images[0]?.imageUrl,
        photoPath: details!.images[0]?.photoPath,
        product: details!.product,
      });
    } catch (error) {
      console.error("Legacy preview error:", error);

      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Помилка генерації",
      });
    }
  });

  app.post("/publish-preview", ...requireUser, async (req: Request, res: Response) => {
    try {
      const productId = Number(req.body.productId);
      const text = toText(req.body.text);

      if (!productId || !text) {
        return res.status(400).json({
          success: false,
          message: "Немає productId або тексту для публікації",
        });
      }

      const details = await getOwnedProductDetails(db, productId, currentUserId(req));
      if (!details) {
        return res.status(404).json({ success: false, message: "Товар не знайдено" });
      }
      const posts = details.platformPosts;
      const telegramPost = posts.find((post: any) => post.platform === "telegram");

      if (!telegramPost) {
        return res.status(400).json({
          success: false,
          message: "Для товару немає Telegram-поста",
        });
      }

      await db.run(
        `
        UPDATE platform_posts
        SET text = ?,
            updatedAt = ?
        WHERE id = ?
        `,
        [text, new Date().toISOString(), telegramPost.id]
      );

      await publishPlatformPost(db, telegramPost.id);

      return res.json({ success: true });
    } catch (error) {
      console.error("Legacy publish error:", error);

      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Помилка публікації",
      });
    }
  });

  app.get("/products-api", ...requireUser, async (req: Request, res: Response) => {
    const products = await db.all(`
      SELECT *
      FROM products
      WHERE userId = ?
      ORDER BY id DESC
    `, [String(currentUserId(req))]);

    return res.json({
      success: true,
      products,
    });
  });

  app.put("/products-api/:id", ...requireUser, async (req: Request, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const details = await getOwnedProductDetails(db, productId, currentUserId(req));

      if (!details) {
        return res.status(404).json({
          success: false,
          message: "Товар не знайдено",
        });
      }

      await updateProductFields(db, productId, {
        ...details.product,
        ...req.body,
      });

      const telegramPost = details.platformPosts.find(
        (post: any) => post.platform === "telegram"
      );

      if (telegramPost && req.body.generatedPost) {
        await db.run(
          `
          UPDATE platform_posts
          SET text = ?,
              updatedAt = ?
          WHERE id = ?
          `,
          [toText(req.body.generatedPost), new Date().toISOString(), telegramPost.id]
        );
      }

      if (
        telegramPost?.status === "published" &&
        telegramPost.externalChatId &&
        telegramPost.externalPostId
      ) {
        const s = await getUserSettings(db, currentUserId(req));
        await editTelegramPost(
          toText(req.body.generatedPost),
          telegramPost.externalChatId,
          telegramPost.externalPostId,
          "caption",
          { chatId: s.telegramChatId, orderLogin: s.telegramOrderLogin, socialLinks: s.telegramSocialLinks }
        );
      }

      return res.json({
        success: true,
        message: "Збережено. Якщо Telegram-пост був опублікований, caption оновлено.",
      });
    } catch (error) {
      console.error("Legacy update product error:", error);

      return res.status(500).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Помилка оновлення товару або Telegram-поста",
      });
    }
  });

  // ── Statistics ───────────────────────────────────────────────────────────────

  app.get("/api/stats/summary", ...requireUser, async (req: Request, res: Response) => {
    const numericUserId = currentUserId(req);
    const userId = String(numericUserId);

    const totalsRow = await db.get(
      `SELECT COUNT(*) AS totalProducts FROM products WHERE userId = ?`,
      [userId]
    );

    const byPlatformStatus = await db.all(
      `
      SELECT pp.platform, pp.status, COUNT(*) AS cnt
      FROM platform_posts pp
      JOIN products p ON p.id = pp.productId
      WHERE p.userId = ?
      GROUP BY pp.platform, pp.status
      `,
      [userId]
    );

    const byPlatform: Record<string, { platform: string; total: number; published: number; failed: number; pending: number }> = {};
    for (const row of byPlatformStatus) {
      const entry = (byPlatform[row.platform] ||= { platform: row.platform, total: 0, published: 0, failed: 0, pending: 0 });
      entry.total += row.cnt;
      if (row.status === "published") entry.published += row.cnt;
      else if (row.status === "failed") entry.failed += row.cnt;
      else entry.pending += row.cnt;
    }

    const byStatusRows = await db.all(
      `
      SELECT pp.status, COUNT(*) AS cnt
      FROM platform_posts pp
      JOIN products p ON p.id = pp.productId
      WHERE p.userId = ?
      GROUP BY pp.status
      `,
      [userId]
    );
    const byStatus: Record<string, number> = { draft: 0, scheduled: 0, publishing: 0, published: 0, failed: 0 };
    for (const row of byStatusRows) byStatus[row.status] = row.cnt;

    const dailyRows = await db.all(
      `
      SELECT substr(pp.publishedAt, 1, 10) AS day, COUNT(*) AS cnt
      FROM platform_posts pp
      JOIN products p ON p.id = pp.productId
      WHERE p.userId = ? AND pp.status = 'published' AND pp.publishedAt IS NOT NULL
      GROUP BY day
      ORDER BY day ASC
      `,
      [userId]
    );

    const socialStatus = await getUserSocialStatus(db, numericUserId);
    const settings = await getUserSettings(db, numericUserId);
    // Shafa's connection status isn't tracked per-user the way OAuth platforms are
    // (it's session-cookie based), so it's excluded from this connected/total count
    // rather than guessed at.
    const platformKeys = ["facebook", "instagram", "tiktok", "prom", "olx", "rozetka", "kasta"] as const;
    const connectedCount =
      platformKeys.filter((k) => (socialStatus as any)[k]).length +
      (settings.telegramChatId ? 1 : 0);

    res.json({
      totalProducts: totalsRow?.totalProducts || 0,
      totalPosts: byStatusRows.reduce((sum: number, r: any) => sum + r.cnt, 0),
      byPlatform: Object.values(byPlatform).sort((a, b) => b.total - a.total),
      byStatus,
      daily: dailyRows,
      connectedPlatforms: connectedCount,
      totalPlatforms: platformKeys.length + 1, // + Telegram
    });
  });

  // ── Facebook OAuth ─────────────────────────────────────────────────────────

  // ── Per-user social token endpoints ────────────────────────────────────────

  app.get("/api/user/social-status", ...requireUser, async (req: Request, res: Response) => {
    const userId = (req as any).userId as number;
    const status = await getUserSocialStatus(db, userId);
    const settings = await getUserSettings(db, userId);
    res.json({
      ...status,
      telegram: !!settings.telegramChatId,
      telegramChatId: settings.telegramChatId || null,
    });
  });

  app.delete("/api/user/social/:platform", ...requireUser, async (req: Request, res: Response) => {
    const userId = (req as any).userId as number;
    await deleteUserToken(db, userId, String(req.params.platform));
    res.json({ success: true });
  });

  // GET /api/facebook/status — current token info
  app.get("/api/facebook/status", (_req: Request, res: Response) => {
    res.json(getFacebookStatus());
  });

  function extractFbPageId(url: string): string {
    if (!url) return "";
    // Numeric ID in URL path (e.g. /profile.php?id=123 or /123)
    const numericMatch = url.match(/(?:profile\.php\?id=|\/|^)(\d{10,20})/);
    if (numericMatch) return numericMatch[1];
    // Named page slug (e.g. facebook.com/MerilyShop) — return slug to try as page identifier
    const slugMatch = url.match(/facebook\.com\/([^/?&#]+)/i);
    return slugMatch ? slugMatch[1] : "";
  }

  function getBaseUrl(req: Request): string {
    const proto = (req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim();
    const host = req.get("x-forwarded-host") || req.get("host") || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }

  function getFbRedirectUri(req: Request): string {
    return `${getBaseUrl(req)}/auth/facebook/callback`;
  }

  // GET /auth/facebook — start OAuth (requires ?appId=&appSecret= or they're in .env)
  app.get("/auth/facebook", (req: Request, res: Response) => {
    const appId = (req.query.appId as string) || process.env.FACEBOOK_APP_ID || "";
    const appSecret = (req.query.appSecret as string) || process.env.FACEBOOK_APP_SECRET || "";
    if (!appId || !appSecret) {
      return res.status(400).send("Потрібні App ID та App Secret. Введи їх на сторінці налаштувань.");
    }
    const redirectUri = getFbRedirectUri(req);
    const userId = extractTokenFromQuery(req);
    const state = signOAuthState({ appId, redirectUri, userId });
    const url = buildAuthUrl({ appId, appSecret, redirectUri }, state);
    res.redirect(url);
  });

  // GET /auth/facebook/callback — Facebook redirects here after user approves
  app.get("/auth/facebook/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      return res.redirect(`/setup.html?fbError=${encodeURIComponent(req.query.error_description as string || error)}`);
    }
    if (!code || !state) {
      return res.redirect("/setup.html?fbError=missing_code");
    }

    try {
      const parsed = verifyOAuthState<{ appId: string; redirectUri: string; userId?: number }>(state);
      const { appId, redirectUri: savedRedirectUri, userId: stateUserId } = parsed;
      const appSecret = readEnv().FACEBOOK_APP_SECRET || process.env.FACEBOOK_APP_SECRET || "";
      const redirectUri = savedRedirectUri || getFbRedirectUri(req);
      const { pages, userToken, userTokenExpiresAt } = await completeFacebookOAuth({ appId, appSecret, redirectUri }, code);
      if (stateUserId) pendingFacebookOAuth.set(Number(stateUserId), { userToken, expiresAt: userTokenExpiresAt });

      const savePerUser = async (pageResult: any) => {
        if (!stateUserId) return;
        const fbToken = pageResult.page.token || userToken;
        await saveUserToken(db, stateUserId, "facebook", {
          access_token: fbToken,
          page_id: pageResult.page.id,
          page_name: pageResult.page.name,
          expires_at: userTokenExpiresAt,
        });
        if (pageResult.instagram) {
          // For NPE pages the user token (not page token) is needed for Instagram Graph API
          const igToken = userToken || fbToken;
          await saveUserToken(db, stateUserId, "instagram", {
            access_token: igToken,
            instagram_user_id: pageResult.instagram.id,
            instagram_username: pageResult.instagram.username || "",
            expires_at: userTokenExpiresAt,
          });
        }
      };

      if (pages.length === 0) {
        const env = readEnv();
        const pageUrl = env.FACEBOOK_PAGE_URL || process.env.FACEBOOK_PAGE_URL || "";
        const pageId = extractFbPageId(pageUrl);
        if (pageId) {
          try {
            const result = await selectFacebookPageManual(pageId, userToken, false);
            await savePerUser(result);
            const igPart = result.instagram
              ? `&igName=${encodeURIComponent(result.instagram.username || "")}`
              : `&igReason=${encodeURIComponent(result.instagramError || "no_ig_linked")}`;
            return res.redirect(`/setup.html?fbSuccess=1&pageName=${encodeURIComponent(result.page.name)}${igPart}`);
          } catch { /* fall through to manual entry */ }
        }
        return res.redirect("/setup.html?needsPageId=1");
      }

      if (pages.length === 1) {
        const result = await selectFacebookPage(pages[0].id, userToken, false);
        await savePerUser(result);
        const igPart = result.instagram
          ? `&igId=${result.instagram.id}&igName=${encodeURIComponent(result.instagram.username || "")}`
          : `&igReason=${encodeURIComponent(result.instagramError || "no_ig_linked")}`;
        return res.redirect(`/setup.html?fbSuccess=1&pageId=${pages[0].id}&pageName=${encodeURIComponent(pages[0].name)}${igPart}`);
      }

      const pagesParam = encodeURIComponent(JSON.stringify(pages.map((p: any) => ({ ...p, _userId: stateUserId }))));
      res.redirect(`/setup.html?choosePage=1&pages=${pagesParam}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.redirect(`/setup.html?fbError=${encodeURIComponent(msg)}`);
    }
  });

  // POST /api/facebook/select-page — user picks a page from dropdown
  app.post("/api/facebook/select-page", ...requireUser, async (req: Request, res: Response) => {
    const { pageId } = req.body as { pageId: string };
    try {
      const pending = pendingFacebookOAuth.get(currentUserId(req));
      if (!pending) {
        return res.status(400).json({ success: false, message: "OAuth сесія не знайдена. Підключи Facebook ще раз." });
      }
      const result = await selectFacebookPage(pageId, pending.userToken, false);
      await saveUserToken(db, currentUserId(req), "facebook", {
        access_token: result.page.token || pending.userToken,
        page_id: result.page.id,
        page_name: result.page.name,
        expires_at: pending.expiresAt,
      });
      if (result.instagram) {
        await saveUserToken(db, currentUserId(req), "instagram", {
          access_token: pending.userToken,
          instagram_user_id: result.instagram.id,
          instagram_username: result.instagram.username || "",
          expires_at: pending.expiresAt,
        });
      }
      pendingFacebookOAuth.delete(currentUserId(req));
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Готує похідне медіа для Instagram: слайдшоу-Reels із фото товару або кадр
  // 9:16 для сторіз. Робиться на вимогу (а не при кожному завантаженні товару),
  // і результат зберігається на товарі — щоб публікація за розкладом брала
  // готовий файл, а не запускала ffmpeg у момент слоту.
  app.post("/api/products/:id/instagram-media", ...requireUser, async (req: Request, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const userId = currentUserId(req);
      const details = await getOwnedProductDetails(db, productId, userId);
      if (!details) {
        return res.status(404).json({ success: false, message: "Товар не знайдено" });
      }

      const format = toText(req.body.format);
      if (format !== "slideshow" && format !== "story") {
        return res.status(400).json({
          success: false,
          message: "Готувати медіа треба лише для форматів «слайдшоу» і «сторіз»",
        });
      }

      const photoPaths = details.images
        .map((image: any) => String(image.photoPath || ""))
        .filter(Boolean);
      if (!photoPaths.length) {
        return res.status(400).json({ success: false, message: "Спочатку завантаж фото товару" });
      }

      const product = details.product;
      const videoStyle = (product.videoStyle || "fashion") as any;
      // Обидва артефакти — суто інстаграмні, тож ціна на них рахується з обома
      // націнками: рівня товару і платформи.
      const platformMarkups = await getPlatformMarkups(db, userId);
      const markup = (Number(product.priceMarkup) || 0) + (platformMarkups.instagram || 0);
      const productForTexts = applyProductMarkup(
        {
          title: product.title || "",
          price: product.price || "",
          dropPrice: product.dropPrice || "",
          description: product.description || "",
          imageUrls: details.images.map((image: any) => image.imageUrl),
          photoPaths,
        },
        markup
      );
      const now = new Date().toISOString();

      if (format === "slideshow") {
        // Написи — той самий AI-генератор, що й для звичайних Reels. Якщо OpenAI
        // недоступний, слайдшоу все одно збереться з дефолтними написами.
        let videoTexts;
        try {
          videoTexts = await generateVideoTexts(productForTexts);
        } catch (error) {
          console.error("Slideshow texts failed, using defaults:", error);
        }

        const slideshow = await createSlideshowReel({
          photoPaths,
          uploadsDir,
          videoTexts,
          videoStyle,
        });
        const slideshowVideoUrl = filePathToPublicUrl(slideshow.outputPath);
        await db.run(
          `UPDATE products SET slideshowVideoPath = ?, slideshowVideoUrl = ?, updatedAt = ? WHERE id = ?`,
          [slideshow.outputPath, slideshowVideoUrl, now, productId]
        );

        return res.json({
          success: true,
          slideshow: {
            url: slideshowVideoUrl,
            durationSec: slideshow.durationSec,
            photosUsed: slideshow.photosUsed,
          },
          ...(await getProductDetails(db, productId)),
        });
      }

      const priceLine = [productForTexts.title, productForTexts.price]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" - ");
      const story = await createStoryFrame({
        inputPath: photoPaths[0],
        uploadsDir,
        overlayText: priceLine,
        videoStyle,
      });
      const storyImageUrl = filePathToPublicUrl(story.outputPath);
      await db.run(
        `UPDATE products SET storyImagePath = ?, storyImageUrl = ?, updatedAt = ? WHERE id = ?`,
        [story.outputPath, storyImageUrl, now, productId]
      );

      return res.json({
        success: true,
        story: { url: storyImageUrl },
        ...(await getProductDetails(db, productId)),
      });
    } catch (error) {
      console.error("Instagram media error:", error);
      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Не вдалося підготувати медіа для Instagram",
      });
    }
  });

  app.put("/api/products/:id/video-choice", ...requireUser, async (req: Request, res: Response) => {
    try {
      const productId = Number(req.params.id);
      const details = await getOwnedProductDetails(db, productId, currentUserId(req));
      if (!details) {
        return res.status(404).json({ success: false, message: "Товар не знайдено" });
      }
      await db.run(
        `UPDATE products SET useProcessedVideo = ?, updatedAt = ? WHERE id = ? AND userId = ?`,
        [req.body.useProcessedVideo === false ? 0 : 1, new Date().toISOString(), productId, String(currentUserId(req))]
      );
      return res.json({ success: true, ...(await getOwnedProductDetails(db, productId, currentUserId(req))) });
    } catch (error) {
      return res.status(500).json({ success: false, message: error instanceof Error ? error.message : "Помилка оновлення відео" });
    }
  });

  app.delete("/api/account", ...requireUser, async (req: Request, res: Response) => {
    const userId = currentUserId(req);
    const files = await db.all(
      `
      SELECT pi.photoPath AS path
      FROM product_images pi
      JOIN products p ON p.id = pi.productId
      WHERE p.userId = ?
      UNION
      SELECT videoPath AS path FROM products WHERE userId = ? AND videoPath IS NOT NULL
      UNION
      SELECT processedVideoPath AS path FROM products WHERE userId = ? AND processedVideoPath IS NOT NULL
      `,
      [String(userId), String(userId), String(userId)]
    );
    for (const file of files) {
      const filePath = String(file.path || "");
      if (!filePath) continue;
      try {
        const resolved = path.resolve(filePath);
        if (resolved.startsWith(path.resolve(uploadsDir))) fs.unlinkSync(resolved);
      } catch {
        // File may already be gone; DB cleanup is the source of truth.
      }
    }
    await db.run(`DELETE FROM users WHERE id = ?`, [userId]);
    res.json({
      success: true,
      message: "Акаунт, товари, пости, налаштування і токени видалено",
    });
  });

  app.post("/api/data-deletion", async (req: Request, res: Response) => {
    const signedRequest = toText(req.body.signed_request);
    res.json({
      url: `${publicSiteUrl()}/data-deletion.html`,
      confirmation_code: signedRequest ? `postly-${Date.now()}` : "postly-manual-request",
    });
  });

  // POST /api/facebook/select-page-manual — fetch page directly by ID (New Page Experience fallback)
  // Requires auth like every other per-user token endpoint — this used to also accept
  // unauthenticated calls and, in that case, wrote the selected Facebook Page's access
  // token into the shared /data/.env admin config (and echoed that token back in the
  // response). Any caller who knew this path could silently repoint the legacy global
  // Facebook config, and — if an admin had ever used it — potentially read the page's
  // access token back out. The manual-entry UI already always sends a Bearer token, so
  // there was no legitimate use of the unauthenticated branch.
  app.post("/api/facebook/select-page-manual", ...requireUser, async (req: Request, res: Response) => {
    const { pageId } = req.body as { pageId: string };
    if (!pageId) return res.status(400).json({ success: false, message: "Потрібен Page ID" });
    try {
      const userId = currentUserId(req);
      const pending = pendingFacebookOAuth.get(userId);
      const result = await selectFacebookPageManual(pageId.trim(), pending?.userToken, false);
      if (result.page.token) {
        await saveUserToken(db, userId, "facebook", {
          access_token: result.page.token,
          page_id: result.page.id,
          page_name: result.page.name,
          expires_at: pending?.expiresAt || null,
        });
        if (result.instagram) {
          const igToken = pending?.userToken || result.page.token;
          await saveUserToken(db, userId, "instagram", {
            access_token: igToken,
            instagram_user_id: result.instagram.id,
            instagram_username: result.instagram.username || "",
            expires_at: pending?.expiresAt || null,
          });
        }
        pendingFacebookOAuth.delete(userId);
      }
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/facebook/set-instagram — manually save Instagram Business Account ID
  app.post("/api/facebook/set-instagram", ...requireUser, async (req: Request, res: Response) => {
    const { instagramId, instagramUsername } = req.body as { instagramId: string; instagramUsername?: string };
    if (!instagramId) return res.status(400).json({ success: false, message: "Потрібен Instagram ID" });
    try {
      const tokens = await import("./user-tokens").then(m => m.getUserTokens(db, currentUserId(req)));
      const fbToken = tokens.facebook?.accessToken;
      if (!fbToken) return res.status(400).json({ success: false, message: "Спочатку підключи Facebook" });
      await saveUserToken(db, currentUserId(req), "instagram", {
        access_token: fbToken,
        instagram_user_id: instagramId.trim(),
        instagram_username: instagramUsername?.trim().replace(/^@/, "") || "",
      });
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/facebook/saved-creds — return saved App ID (not secret) for pre-filling form
  app.get("/api/facebook/saved-creds", ...requireUser, async (req: Request, res: Response) => {
    const env = readEnv();
    const adminEmail = toText(process.env.ADMIN_EMAIL).toLowerCase();
    const user = await db.get(`SELECT email FROM users WHERE id = ?`, [currentUserId(req)]);
    const isAdmin = !adminEmail || String(user?.email || "").toLowerCase() === adminEmail;
    res.json({
      appId: env.FACEBOOK_APP_ID || process.env.FACEBOOK_APP_ID || "",
      hasSecret: !!(env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_APP_SECRET),
      igAppId: env.INSTAGRAM_APP_ID || process.env.INSTAGRAM_APP_ID || "",
      hasIgSecret: !!(env.INSTAGRAM_APP_SECRET || process.env.INSTAGRAM_APP_SECRET),
      isAdmin,
    });
  });

  // POST /api/facebook/save-app — save App ID + App Secret without starting OAuth
  app.post("/api/facebook/save-app", ...requireUser, requireAdmin, (req: Request, res: Response) => {
    const { appId, appSecret } = req.body as { appId: string; appSecret: string };
    if (!appId || !appSecret) return res.status(400).json({ success: false, message: "Потрібні App ID та App Secret" });
    if (!/^\d+$/.test(appId)) return res.status(400).json({ success: false, message: "App ID повинен містити тільки цифри" });
    if (appSecret.length < 20) return res.status(400).json({ success: false, message: "App Secret занадто короткий" });
    writeEnvVars({
      FACEBOOK_APP_ID: appId,
      FACEBOOK_APP_SECRET: appSecret,
      INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID || appId,
      INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET || appSecret,
      SITE_URL: publicSiteUrl(),
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || publicSiteUrl(),
    });
    res.json({ success: true });
  });

  // POST /api/facebook/disconnect — clear all Facebook/Instagram tokens
  app.post("/api/facebook/disconnect", ...requireUser, requireAdmin, (_req: Request, res: Response) => {
    writeEnvVars({
      FACEBOOK_USER_TOKEN: "", FACEBOOK_USER_TOKEN_EXPIRES: "",
      FACEBOOK_PAGE_ID: "", FACEBOOK_PAGE_NAME: "", FACEBOOK_ACCESS_TOKEN: "",
      INSTAGRAM_USER_ID: "", INSTAGRAM_USERNAME: "", INSTAGRAM_ACCESS_TOKEN: "",
    });
    res.json({ success: true });
  });

  // GET /api/facebook/debug-ig — full Instagram publishing diagnostics
  // Diagnostic-only endpoint (not called from any page) — was reachable by anyone,
  // no login required, and leaked the first 20 chars of the shared Facebook/Instagram
  // tokens plus live Graph API responses (page/IG ids, granted permissions). Gated
  // behind admin like the other shared-config routes.
  app.get("/api/facebook/debug-ig", ...requireUser, requireAdmin, async (_req: Request, res: Response) => {
    const env = readEnv();
    const g = (k: string) => env[k] || process.env[k] || "";
    const userToken  = g("FACEBOOK_USER_TOKEN");
    const pageToken  = g("FACEBOOK_ACCESS_TOKEN");
    const igToken    = g("INSTAGRAM_ACCESS_TOKEN");
    const igId       = g("INSTAGRAM_USER_ID");
    const pageId     = g("FACEBOOK_PAGE_ID");
    const G = "https://graph.facebook.com/v25.0";

    const out: Record<string, any> = {
      saved: {
        igId, pageId,
        igTokenType: igToken === userToken ? "user_token" : igToken === pageToken ? "page_token" : "other",
        igTokenFirst20: igToken.slice(0, 20) + "...",
        userTokenFirst20: userToken.slice(0, 20) + "...",
      }
    };

    if (!userToken) return res.json({ error: "No user token", ...out });

    const [permR, meR, pageIgR] = await Promise.all([
      fetch(`${G}/me/permissions?access_token=${userToken}`).then(r => r.json()),
      fetch(`${G}/me?fields=id,name&access_token=${userToken}`).then(r => r.json()),
      pageId ? fetch(`${G}/${pageId}?fields=instagram_business_account&access_token=${userToken}`).then(r => r.json()) : Promise.resolve(null),
    ]);
    out.me = meR;
    out.permissions = permR?.data?.filter((p: any) => p.status === "granted").map((p: any) => p.permission);
    out.pageIgAccount = pageIgR;

    // Try to find Instagram accounts via user-level endpoints
    const [meIgR, userAccountsIgR, igViaPageTokenR] = await Promise.all([
      fetch(`${G}/me?fields=id,name,instagram_business_accounts{id,username}&access_token=${userToken}`).then(r => r.json()),
      fetch(`${G}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${userToken}`).then(r => r.json()),
      pageToken && igId ? fetch(`${G}/${igId}?fields=id,username&access_token=${pageToken}`).then(r => r.json()) : Promise.resolve("no-page-token"),
    ]);
    out.meInstagramAccounts = meIgR;
    out.userAccountsWithIg = userAccountsIgR;
    out.igViaPageToken = igViaPageTokenR;

    if (igId && igToken) {
      const igMeR = await fetch(`${G}/${igId}?fields=id,username,name&access_token=${igToken}`).then(r => r.json());
      out.igAccountViaUserToken = igMeR;

      // Try with page token
      if (pageToken) {
        const igMePageR = await fetch(`${G}/${igId}?fields=id,username,name&access_token=${pageToken}`).then(r => r.json());
        out.igAccountViaPageToken = igMePageR;
      }
    }

    res.json(out);
  });

  // POST /api/facebook/verify — test if current tokens actually work
  app.post("/api/facebook/verify", ...requireUser, async (req: Request, res: Response) => {
    const userTokens = await getUserSocialStatus(db, currentUserId(req));
    if (userTokens.facebook) {
      const tokens = await import("./user-tokens").then(m => m.getUserTokens(db, currentUserId(req)));
      const fb = tokens.facebook;
      if (!fb) return res.json({ ok: false, reason: "not_connected" });
      try {
        const r = await fetch(`https://graph.facebook.com/v25.0/${fb.pageId}?fields=name,fan_count&access_token=${fb.accessToken}`);
        const d = await r.json() as any;
        if (d.error) return res.json({ ok: false, reason: d.error.message });
        return res.json({ ok: true, pageName: d.name, fans: d.fan_count });
      } catch (e) {
        return res.json({ ok: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    const status = getFacebookStatus();
    if (!status.connected) return res.json({ ok: false, reason: "not_connected" });
    try {
      const token = process.env.FACEBOOK_ACCESS_TOKEN || "";
      const pageId = process.env.FACEBOOK_PAGE_ID || "";
      const r = await fetch(`https://graph.facebook.com/v25.0/${pageId}?fields=name,fan_count&access_token=${token}`);
      const d = await r.json() as any;
      if (d.error) return res.json({ ok: false, reason: d.error.message });
      res.json({ ok: true, pageName: d.name, fans: d.fan_count });
    } catch (e) {
      res.json({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Shop settings ──────────────────────────────────────────────────────────

  app.get("/api/settings/shop", ...requireUser, async (req: Request, res: Response) => {
    res.json(await getUserSettings(db, currentUserId(req)));
  });

  app.post("/api/settings/shop", ...requireUser, async (req: Request, res: Response) => {
    const { shopName, shopDescription, shopLanguage, facebookPageUrl, instagramUrl } = req.body as Record<string, string>;
    const now = new Date().toISOString();
    await db.run(
      `
      INSERT INTO user_settings (
        user_id, shop_name, shop_description, shop_language, facebook_page_url, instagram_url, telegram_chat_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        shop_name = excluded.shop_name,
        shop_description = excluded.shop_description,
        shop_language = excluded.shop_language,
        facebook_page_url = excluded.facebook_page_url,
        instagram_url = excluded.instagram_url,
        telegram_chat_id = COALESCE(user_settings.telegram_chat_id, excluded.telegram_chat_id),
        updated_at = excluded.updated_at
      `,
      [
        currentUserId(req),
        toText(shopName),
        toText(shopDescription),
        toText(shopLanguage) || "uk",
        toText(facebookPageUrl),
        toText(instagramUrl),
        "",
        now,
        now,
      ]
    );
    res.json({ success: true });
  });

  // ── Per-platform price markup ───────────────────────────────────────────────

  app.get("/api/settings/markups", ...requireUser, async (req: Request, res: Response) => {
    res.json({ markups: await getPlatformMarkups(db, currentUserId(req)) });
  });

  app.post("/api/settings/markup", ...requireUser, async (req: Request, res: Response) => {
    const { platform, percent } = req.body as { platform?: string; percent?: unknown };
    if (!platform || !isPlatformId(platform)) {
      return res.status(400).json({ success: false, message: "Невідома платформа" });
    }
    const pct = Number(percent);
    // Negative = discount, positive = markup, 0 = no change. Floor above -100 so a
    // discount can never drive the price to zero or below.
    if (!isFinite(pct) || pct <= -100 || pct > 1000) {
      return res.status(400).json({ success: false, message: "Націнка має бути числом від -99 до 1000" });
    }
    const userId = currentUserId(req);
    const markups = await getPlatformMarkups(db, userId);
    if (pct !== 0) markups[platform] = pct;
    else delete markups[platform]; // 0 = no change, don't store it
    const now = new Date().toISOString();
    await db.run(
      `
      INSERT INTO user_settings (user_id, platform_markups, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        platform_markups = excluded.platform_markups,
        updated_at = excluded.updated_at
      `,
      [userId, JSON.stringify(markups), now, now]
    );
    res.json({ success: true, markups });
  });

  // ── Telegram setup ─────────────────────────────────────────────────────────

  app.get("/api/telegram/status", ...requireUser, async (req: Request, res: Response) => {
    const token = process.env.BOT_TOKEN;
    const settings = await getUserSettings(db, currentUserId(req));
    const chatId = settings.telegramChatId || "";
    const contacts = { orderLogin: settings.telegramOrderLogin, socialLinks: settings.telegramSocialLinks };
    if (!token) return res.json({ connected: false, hasChatId: !!chatId, ...contacts });
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const d = await r.json() as any;
      if (!d.ok) return res.json({ connected: false, hasChatId: !!chatId, error: d.description, ...contacts });

      let chatReachable = false;
      let chatError: string | undefined;
      if (chatId) {
        try {
          const cr = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
          const cd = await cr.json() as any;
          chatReachable = !!cd.ok;
          if (!cd.ok) chatError = cd.description;
        } catch (e) {
          chatError = e instanceof Error ? e.message : String(e);
        }
      }

      res.json({
        connected: true,
        username: d.result.username,
        firstName: d.result.first_name,
        hasChatId: !!chatId,
        chatId,
        chatReachable,
        chatError,
        ...contacts,
      });
    } catch (e) { res.json({ connected: false, hasChatId: !!chatId, ...contacts }); }
  });

  app.post("/api/telegram/save", ...requireUser, async (req: Request, res: Response) => {
    const body = req.body as { chatId?: string; orderLogin?: string; socialLinks?: unknown };
    const userId = currentUserId(req);
    const now = new Date().toISOString();
    // Merge with existing so the separate "save channel" and "save contacts" actions
    // in the UI don't wipe each other's fields when only one is sent.
    const current = await getUserSettings(db, userId);
    const chatId = body.chatId !== undefined ? toText(body.chatId) : current.telegramChatId;
    const orderLogin = body.orderLogin !== undefined ? toText(body.orderLogin) : current.telegramOrderLogin;
    const socialLinks = body.socialLinks !== undefined
      ? JSON.stringify((Array.isArray(body.socialLinks) ? body.socialLinks : []).map((s) => String(s).trim()).filter(Boolean))
      : JSON.stringify(current.telegramSocialLinks);
    try {
      await db.run(
        `
        INSERT INTO user_settings (user_id, telegram_chat_id, telegram_order_login, telegram_social_links, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          telegram_chat_id = excluded.telegram_chat_id,
          telegram_order_login = excluded.telegram_order_login,
          telegram_social_links = excluded.telegram_social_links,
          updated_at = excluded.updated_at
        `,
        [userId, chatId, orderLogin, socialLinks, now, now]
      );
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes("UNIQUE constraint failed")
        ? "Цей Telegram-канал уже підключено до іншого акаунта Postly."
        : msg;
      res.status(400).json({ success: false, message: friendly });
    }
  });

  // ── Shafa setup (per-user Playwright session — no shared dev app) ──────────
  //
  // Unlike the OAuth platforms, Shafa has no API of its own: each user's own
  // login/password drives a real browser session, and that session (and its debug
  // screenshots) live in a file keyed by userId — never a single shared file — so
  // one user's Shafa connection can never publish, or even show status for, another
  // user's account.

  app.get("/api/shafa/status", ...requireUser, async (req: Request, res: Response) => {
    const { shafaSessionPathForUser } = await import("./shafa/shafa.publisher");
    const sessionPath = shafaSessionPathForUser(currentUserId(req));
    let sessionValid = false;
    try {
      const raw = fs.readFileSync(sessionPath, "utf8");
      const s = JSON.parse(raw);
      sessionValid = (Array.isArray(s) && s.length > 0) ||
        (s && typeof s === "object" && s.cookies && Array.isArray(s.cookies) && s.cookies.length > 0);
    } catch { /**/ }
    res.json({ sessionValid });
  });

  app.post("/api/shafa/login", ...requireUser, async (req: Request, res: Response) => {
    const { email: login, password } = req.body as { email?: string; password?: string };
    if (!login || !password) return res.status(400).json({ success: false, message: "Потрібні логін та пароль" });
    const userId = currentUserId(req);
    try {
      const { loginShafaAndSaveSession, shafaSessionPathForUser, shafaDebugPrefixForUser } = await import("./shafa/shafa.publisher");
      const sessionPath = shafaSessionPathForUser(userId);
      // Credentials are NOT saved — only this user's own session cookies are stored
      const result = await loginShafaAndSaveSession(login, password, sessionPath, shafaDebugPrefixForUser(userId));
      // Shafa has no real API, so there's no token to store here — just a bookkeeping
      // row (external_account_id = the scraped seller username) so the same Shafa
      // account can't end up connected under two different Postly users at once.
      if (result.username) {
        try {
          await saveUserToken(db, userId, "shafa", { external_account_id: result.username });
        } catch (dupErr) {
          // Roll back the session file just written — we're rejecting this
          // connection, so it must not be left usable for publishing.
          try { fs.unlinkSync(sessionPath); } catch { /* ok */ }
          throw dupErr;
        }
      }
      res.json({ success: true, username: result.username });
    } catch (err: any) {
      res.json({ success: false, message: err.message || "Помилка логіну" });
    }
  });

  app.post("/api/shafa/disconnect", ...requireUser, async (req: Request, res: Response) => {
    const { shafaSessionPathForUser } = await import("./shafa/shafa.publisher");
    try { fs.unlinkSync(shafaSessionPathForUser(currentUserId(req))); } catch { /* ok */ }
    // Also clear the bookkeeping row so the username frees up for reconnection.
    await deleteUserToken(db, currentUserId(req), "shafa");
    res.json({ success: true });
  });

  // Recorded per-category field snapshots (captured the first time each Shafa
  // category is published to). Lets us inspect which fields a category actually has
  // and tune the AI/mapping later.
  app.get("/api/shafa/category-schemas", ...requireUser, async (req: Request, res: Response) => {
    const { listCategorySchemas } = await import("./shafa/shafa.publisher");
    res.json({ schemas: await listCategorySchemas(currentUserId(req)) });
  });

  // Plain <a target="_blank"> links can't send an Authorization header, so this one
  // route also accepts the JWT as ?token= (same mechanism already used for the OAuth
  // redirect flows) instead of requireUser's Bearer-header-only check.
  app.get("/api/shafa/debug-screenshot", async (req: Request, res: Response) => {
    const userId = extractTokenFromQuery(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { shafaDebugPrefixForUser } = await import("./shafa/shafa.publisher");
    // Only the short screenshot name is client-controlled; the per-user prefix is
    // always derived from the authenticated session, so one user can never fetch
    // another user's debug screenshot by guessing/editing the query param.
    const name = String(req.query.name || "debug-new-page").replace(/[^a-zA-Z0-9-]/g, "");
    const debugPrefix = shafaDebugPrefixForUser(userId);
    const candidates = [
      `/data/${debugPrefix}${name}.png`,
      `./${debugPrefix}${name}.png`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return res.sendFile(path.resolve(p));
    }
    res.status(404).json({ error: "Скріншот не знайдено" });
  });

  // ── TikTok OAuth ──────────────────────────────────────────────────────────

  function getTikTokRedirectUri(req: Request): string {
    return `${getBaseUrl(req)}/auth/tiktok/callback`;
  }

  app.post("/api/tiktok/setup", ...requireUser, requireAdmin, (req: Request, res: Response) => {
    const { clientKey, clientSecret } = req.body as { clientKey: string; clientSecret: string };
    if (!clientKey || !clientSecret) return res.status(400).json({ error: "Потрібні clientKey і clientSecret" });
    writeEnvVars({ TIKTOK_CLIENT_KEY: clientKey, TIKTOK_CLIENT_SECRET: clientSecret });
    res.json({ success: true });
  });

  app.get("/api/tiktok/status", ...requireUser, (req: Request, res: Response) => {
    const { getTikTokStatus } = require("./tiktok");
    const env = readEnv();
    const clientKey = env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_KEY || "";
    const hasKeys = !!clientKey;
    const redirectUri = getTikTokRedirectUri(req);
    res.json({ ...getTikTokStatus(), hasKeys, clientKeyHint: clientKey ? clientKey.slice(0, 6) + "…" : "", redirectUri });
  });

  app.get("/api/tiktok/creator-info", ...requireUser, async (req: Request, res: Response) => {
    try {
      const userId = currentUserId(req);
      const tokens = await getValidUserTikTokTokens(db, userId);
      const creatorInfo = await queryTikTokCreatorInfo(tokens);
      let videoDurationSec: number | null = null;

      const productId = Number(req.query.productId || 0);
      if (productId) {
        const details = await getOwnedProductDetails(db, productId, userId);
        if (!details) {
          return res.status(404).json({ success: false, message: "Товар не знайдено" });
        }
        const product = details.product;
        const videoPath = product.useProcessedVideo !== 0 && product.processedVideoPath
          ? product.processedVideoPath
          : product.videoPath;
        if (videoPath) videoDurationSec = await getVideoDurationSeconds(videoPath);
      }

      return res.json({ success: true, creatorInfo, videoDurationSec });
    } catch (error) {
      console.error("TikTok creator info error:", error);
      return res.status(502).json({
        success: false,
        message: error instanceof Error ? error.message : "Не вдалося отримати дані TikTok-акаунта",
      });
    }
  });

  app.get("/auth/tiktok", (req: Request, res: Response) => {
    const { getTikTokAuthUrl } = require("./tiktok");
    const key = readEnv().TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_KEY || "";
    if (!key) {
      return res.send(`<html><body style="font-family:sans-serif;padding:40px;max-width:500px">
        <h2>❌ Client Key не знайдено</h2>
        <p>Спочатку введи <b>Client Key</b> і <b>Client Secret</b> в Налаштування → TikTok і натисни <b>«Зберегти ключі»</b>.</p>
        <p>Потім знову натисни «Підключити TikTok».</p>
        <button onclick="window.close()">Закрити</button>
      </body></html>`);
    }
    const redirectUri = getTikTokRedirectUri(req);
    const userId = extractTokenFromQuery(req);
    // encode userId in state so callback knows which user to save tokens for
    const stateData = signOAuthState({ userId });
    res.redirect(getTikTokAuthUrl(redirectUri, stateData));
  });

  app.get("/auth/tiktok/callback", async (req: Request, res: Response) => {
    const stateRaw = req.query.state as string;

    // Cross-project OAuth relay. The TikTok Developer Portal locks the redirect URI
    // to Postly's single reviewed callback, so a separate project (the "Чи Знали Ви?"
    // TikTok mini-app on tiktok-chanel-production.up.railway.app) runs its consent
    // flow through here and we simply bounce TikTok's response straight back to it,
    // untouched. We do NOT exchange the one-time code or persist anything — that
    // project owns the token exchange; consuming the code here would break it with
    // "code already used". Its states are namespaced with a "cvz-" prefix so they
    // never collide with Postly's own signed-JWT states. Forward the RAW query string
    // exactly as received (code, state, scopes, error, error_description — everything,
    // especially state, which the far side verifies). Nothing is logged: code and
    // state are one-time secrets.
    if (typeof stateRaw === "string" && stateRaw.startsWith("cvz-")) {
      const qIndex = req.originalUrl.indexOf("?");
      const rawQuery = qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : "";
      return res.redirect(302, `https://tiktok-chanel-production.up.railway.app/tiktok/callback?${rawQuery}`);
    }

    const code = req.query.code as string;
    const error = req.query.error as string;
    if (error || !code) {
      return res.send(`<script>window.opener?.postMessage({type:'tiktok-auth',error:'${error||"no_code"}'},'*');window.close();</script>`);
    }
    try {
      const { exchangeTikTokCode } = await import("./tiktok");
      const tokens = await exchangeTikTokCode(code, getTikTokRedirectUri(req));
      // Save per-user token if userId was in state. State parsing/verification
      // failure is expected and ignorable (no state was passed at all) — but a
      // save failure (e.g. this TikTok account is already connected to another
      // Postly user) must surface to the user, not be silently swallowed here.
      let stateUserId: number | undefined;
      try {
        stateUserId = verifyOAuthState<{ userId?: number }>(stateRaw || "").userId;
      } catch { /* no/invalid state — proceed without per-user save */ }
      if (stateUserId) {
        await saveUserToken(db, stateUserId, "tiktok", {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          open_id: tokens.openId,
          expires_at: tokens.expiresAt,
          refresh_expires_at: tokens.refreshExpiresAt,
        });
      }
      res.send(`<script>window.opener?.postMessage({type:'tiktok-auth',success:true},'*');window.close();</script>`);
    } catch (err: any) {
      res.send(`<script>window.opener?.postMessage({type:'tiktok-auth',error:${JSON.stringify(err.message||'error')}},'*');window.close();</script>`);
    }
  });

  // Was reachable by anyone with no login required — any anonymous visitor could
  // wipe the shared TikTok connection (persisted to disk via writeEnvVars) for the
  // whole app. Gated behind login same as every other mutation here.
  app.post("/api/tiktok/disconnect", ...requireUser, (_req: Request, res: Response) => {
    const { disconnectTikTok } = require("./tiktok");
    disconnectTikTok();
    res.json({ success: true });
  });

  // ── Site URL ───────────────────────────────────────────────────────────────

  app.get("/api/site-url", (_req: Request, res: Response) => {
    res.json({ url: publicSiteUrl() });
  });

  app.post("/api/site-url", ...requireUser, requireAdmin, (req: Request, res: Response) => {
    const { url } = req.body as { url: string };
    const { writeEnvVars } = require("./facebook-auth");
    writeEnvVars({ SITE_URL: url || "" });
    res.json({ success: true });
  });

  // ── Prom.ua setup (per-user API token, no dev app involved) ────────────────

  app.get("/api/prom/status", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.prom) return res.json({ connected: false, hasToken: false });
    const { promTestConnection } = await import("./prom");
    const result = await promTestConnection(tokens.prom.accessToken);
    res.json({ connected: result.ok, hasToken: true, shopName: result.shopName, error: result.error, categoryName: tokens.prom.categoryName || null });
  });

  app.post("/api/prom/save", ...requireUser, async (req: Request, res: Response) => {
    const { token } = req.body as { token: string };
    if (!token || token.length < 10) return res.status(400).json({ success: false, message: "Токен занадто короткий" });
    try {
      // Save unconditionally — the verification call (/products/list) can fail for reasons
      // unrelated to whether the token actually works for publishing (e.g. narrower scope,
      // a transient block on that specific endpoint), so a failed check here shouldn't block
      // saving a token that may well work fine for real publishing.
      // external_account_id: Prom's personal API token is static for the life of the
      // connection (no OAuth refresh rotation), so its hash reliably identifies "the
      // same Prom shop" without needing a separate account-info API call.
      await saveUserToken(db, currentUserId(req), "prom", { access_token: token, external_account_id: hashForIdentity(token) });
      const { promTestConnection } = await import("./prom");
      const result = await promTestConnection(token);
      res.json({ success: true, verified: result.ok, verifyWarning: result.ok ? undefined : result.error });
    } catch (err) {
      res.status(400).json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/prom/verify", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.prom) return res.json({ ok: false, error: "Prom.ua не підключено" });
    const { promTestConnection } = await import("./prom");
    const result = await promTestConnection(tokens.prom.accessToken);
    res.json(result);
  });

  app.get("/api/prom/categories", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.prom) return res.status(400).json({ categories: [], message: "Спочатку підключи Prom.ua" });
    const { promSearchCategories } = await import("./prom");
    const q = String(req.query.q || "");
    if (!q || q.length < 2) return res.json({ categories: [] });
    const cats = await promSearchCategories(tokens.prom.accessToken, q);
    res.json({ categories: cats });
  });

  app.post("/api/prom/set-default-category", ...requireUser, async (req: Request, res: Response) => {
    const { categoryId, categoryName } = req.body as { categoryId: number; categoryName: string };
    await updateUserTokenMeta(db, currentUserId(req), "prom", { categoryId: categoryId || undefined, categoryName: categoryName || undefined });
    res.json({ success: true });
  });

  // ── OLX (per-user OAuth; Client ID/Secret is the shared dev app) ────────────

  app.get("/api/olx/status", ...requireUser, async (req: Request, res: Response) => {
    const hasCredentials = !!(process.env.OLX_CLIENT_ID && process.env.OLX_CLIENT_SECRET);
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.olx) return res.json({ connected: false, hasToken: false, hasCredentials });
    const { olxTestConnection } = await import("./olx");
    const result = await olxTestConnection(tokens.olx.accessToken);
    res.json({ connected: result.ok, hasToken: true, hasCredentials, name: result.name, error: result.error });
  });

  app.post("/api/olx/save-credentials", ...requireUser, requireAdmin, (req: Request, res: Response) => {
    const { clientId, clientSecret } = req.body as { clientId: string; clientSecret: string };
    if (!clientId || !clientSecret) return res.status(400).json({ success: false, message: "Потрібні Client ID і Client Secret" });
    const { writeEnvVars } = require("./facebook-auth");
    const siteUrl = process.env.SITE_URL || "http://localhost:3000";
    writeEnvVars({
      OLX_CLIENT_ID: clientId,
      OLX_CLIENT_SECRET: clientSecret,
      OLX_REDIRECT_URI: `${siteUrl}/auth/olx/callback`,
    });
    res.json({ success: true });
  });

  app.get("/auth/olx", (req: Request, res: Response) => {
    const { getOlxAuthUrl } = require("./olx");
    const userId = extractTokenFromQuery(req);
    const state = signOAuthState({ userId });
    res.redirect(getOlxAuthUrl(state));
  });

  app.get("/auth/olx/callback", async (req: Request, res: Response) => {
    const { code, error, state } = req.query as { code?: string; error?: string; state?: string };
    if (error || !code) {
      return res.redirect(`/setup.html?tab=olx&olxError=${encodeURIComponent(error || "no code")}`);
    }
    try {
      const { completeOlxOAuth, olxTestConnection } = await import("./olx");
      const tokens = await completeOlxOAuth(code);
      // State parsing failure is expected/ignorable (no state passed at all) — but a
      // save failure (e.g. this OLX account already connected elsewhere) must surface
      // to the user, not be silently swallowed here.
      let stateUserId: number | undefined;
      try {
        stateUserId = verifyOAuthState<{ userId?: number }>(state || "").userId;
      } catch { /* no/invalid state — proceed without per-user save */ }
      if (stateUserId) {
        const check = await olxTestConnection(tokens.accessToken);
        await saveUserToken(db, stateUserId, "olx", {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_at: tokens.expiresAt,
          external_account_id: check.accountId,
        });
      }
      res.redirect("/setup.html?tab=olx&olxSuccess=1");
    } catch (e) {
      res.redirect(`/setup.html?tab=olx&olxError=${encodeURIComponent((e as Error).message)}`);
    }
  });

  // ── ROZETKA (per-user long-lived API token, no dev app) ─────────────────────

  app.get("/api/rozetka/status", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.rozetka) return res.json({ connected: false, hasToken: false });
    const { rozetkaTestConnection } = await import("./rozetka");
    const result = await rozetkaTestConnection(tokens.rozetka.accessToken);
    res.json({ connected: result.ok, hasToken: true, error: result.error, categoryName: tokens.rozetka.categoryName || null });
  });

  app.post("/api/rozetka/save", ...requireUser, async (req: Request, res: Response) => {
    const { token } = req.body as { token: string };
    if (!token || token.length < 10) return res.status(400).json({ success: false, message: "Токен занадто короткий" });
    try {
      // Save unconditionally, same reasoning as Prom — a failed check call shouldn't
      // block saving a token that may well work fine for real publishing.
      await saveUserToken(db, currentUserId(req), "rozetka", { access_token: token, external_account_id: hashForIdentity(token) });
      const { rozetkaTestConnection } = await import("./rozetka");
      const result = await rozetkaTestConnection(token);
      res.json({ success: true, verified: result.ok, verifyWarning: result.ok ? undefined : result.error });
    } catch (err) {
      res.status(400).json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/rozetka/verify", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.rozetka) return res.json({ ok: false, error: "Rozetka не підключено" });
    const { rozetkaTestConnection } = await import("./rozetka");
    const result = await rozetkaTestConnection(tokens.rozetka.accessToken);
    res.json(result);
  });

  app.get("/api/rozetka/categories", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.rozetka) return res.status(400).json({ categories: [], message: "Спочатку підключи Rozetka" });
    const { rozetkaSearchCategories } = await import("./rozetka");
    const q = String(req.query.q || "");
    if (!q || q.length < 2) return res.json({ categories: [] });
    try {
      const cats = await rozetkaSearchCategories(tokens.rozetka.accessToken, q);
      res.json({ categories: cats });
    } catch (e) {
      res.status(400).json({ categories: [], message: (e as Error).message });
    }
  });

  app.post("/api/rozetka/set-default-category", ...requireUser, async (req: Request, res: Response) => {
    const { categoryId, categoryName } = req.body as { categoryId: number; categoryName: string };
    await updateUserTokenMeta(db, currentUserId(req), "rozetka", { categoryId: categoryId || undefined, categoryName: categoryName || undefined });
    res.json({ success: true });
  });

  app.get("/api/kasta/status", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.kasta) return res.json({ connected: false, hasToken: false });
    const { kastaTestConnection } = await import("./kasta");
    const result = await kastaTestConnection(tokens.kasta.accessToken);
    res.json({ connected: result.ok, hasToken: true, error: result.error, categoryName: tokens.kasta.categoryName || null });
  });

  app.post("/api/kasta/save", ...requireUser, async (req: Request, res: Response) => {
    const { token } = req.body as { token: string };
    if (!token || token.length < 10) return res.status(400).json({ success: false, message: "Токен занадто короткий" });
    try {
      // Save unconditionally, same reasoning as Prom/Rozetka — a failed check call
      // shouldn't block saving a token that may well work fine for real publishing.
      await saveUserToken(db, currentUserId(req), "kasta", { access_token: token, external_account_id: hashForIdentity(token) });
      const { kastaTestConnection } = await import("./kasta");
      const result = await kastaTestConnection(token);
      res.json({ success: true, verified: result.ok, verifyWarning: result.ok ? undefined : result.error });
    } catch (err) {
      res.status(400).json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/kasta/verify", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.kasta) return res.json({ ok: false, error: "Kasta не підключено" });
    const { kastaTestConnection } = await import("./kasta");
    const result = await kastaTestConnection(tokens.kasta.accessToken);
    res.json(result);
  });

  app.get("/api/kasta/categories", ...requireUser, async (req: Request, res: Response) => {
    const tokens = await getUserTokens(db, currentUserId(req));
    if (!tokens.kasta) return res.status(400).json({ categories: [], message: "Спочатку підключи Kasta" });
    const { kastaSearchCategories } = await import("./kasta");
    const q = String(req.query.q || "");
    if (!q || q.length < 2) return res.json({ categories: [] });
    try {
      const cats = await kastaSearchCategories(tokens.kasta.accessToken, q);
      res.json({ categories: cats.map((c) => ({ kindId: c.kindId, affiliationId: c.affiliationId, name: c.name })) });
    } catch (e) {
      res.status(400).json({ categories: [], message: (e as Error).message });
    }
  });

  app.post("/api/kasta/set-default-category", ...requireUser, async (req: Request, res: Response) => {
    const { kindId, affiliationId, categoryName } = req.body as { kindId: number; affiliationId: number; categoryName: string };
    await updateUserTokenMeta(db, currentUserId(req), "kasta", {
      kindId: kindId || undefined,
      affiliationId: affiliationId || undefined,
      categoryName: categoryName || undefined,
    });
    res.json({ success: true });
  });

  // ── End Facebook OAuth ──────────────────────────────────────────────────────

  // Catches errors thrown/passed to next() by any route or middleware above
  // (e.g. multer rejecting an upload) that weren't already handled with their own
  // try/catch + JSON response. Without this, Express's default handler sends back
  // the raw error stack — including absolute server file paths — to the client.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled route error:", err);
    if (res.headersSent) return;
    res.status(400).json({ success: false, message: err.message || "Помилка сервера" });
  });

  const server = app.listen(PORT, () => {
    console.log(`Server started: http://localhost:${PORT}`);
  });
  // Large video uploads need longer timeout (Railway proxy default is ~300s)
  server.setTimeout(600_000); // 10 minutes
  server.keepAliveTimeout = 605_000;
}

startServer();
