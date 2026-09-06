import { getPlatform } from "./platforms";
import { PlatformId, ProductInput } from "./platform-types";
import { getUserTokens, saveUserToken } from "./user-tokens";
import { getTikTokPublishStatus, refreshTikTokTokenRaw, TikTokTokens } from "./tiktok";
import { refreshOlxToken } from "./olx";

type Db = any;

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 5000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
      }
    }
  }
  throw lastError;
}

async function getProductInput(db: Db, productId: number): Promise<ProductInput> {
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  const images = await db.all(
    `SELECT * FROM product_images WHERE productId = ? ORDER BY sortOrder ASC, id ASC`,
    [productId]
  );

  return {
    title: product.title || "",
    model: product.model || "",
    price: product.price || "",
    dropPrice: product.dropPrice || "",
    sizes: product.sizes || "",
    sizeSystem: product.sizeSystem || undefined,
    colors: product.colors || "",
    fabric: product.fabric || "",
    description: product.description || "",
    imageUrls: images.map((image: any) => image.imageUrl),
    photoPaths: images.map((image: any) => image.photoPath),
    videoUrl: product.videoUrl || undefined,
    videoPath: product.videoPath || undefined,
    videoStyle: product.videoStyle || "fashion",
    processedVideoUrl: product.processedVideoUrl || undefined,
    processedVideoPath: product.processedVideoPath || undefined,
    useProcessedVideo: product.useProcessedVideo === 1,
    slideshowVideoUrl: product.slideshowVideoUrl || undefined,
    slideshowVideoPath: product.slideshowVideoPath || undefined,
    storyImageUrl: product.storyImageUrl || undefined,
    storyImagePath: product.storyImagePath || undefined,
    generateVideo: product.generateVideo !== 0,
    shopName: product.shopName || undefined,
    shopDescription: product.shopDescription || undefined,
    shopLanguage: product.shopLanguage || undefined,
  };
}

async function prepareVideoForPublishing(product: ProductInput) {
  if (
    product.useProcessedVideo &&
    product.processedVideoPath &&
    product.processedVideoUrl
  ) {
    return {
      videoPath: product.processedVideoPath,
      videoUrl: product.processedVideoUrl,
    };
  }

  return {
    videoPath: product.videoPath,
    videoUrl: product.videoUrl,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
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

async function getTikTokTokensForPost(db: Db, post: any): Promise<TikTokTokens> {
  const productRow = await db.get(`SELECT userId FROM products WHERE id = ?`, [post.productId]);
  const userId = productRow?.userId && /^\d+$/.test(String(productRow.userId))
    ? parseInt(productRow.userId, 10)
    : null;
  if (!userId) throw new Error("TikTok: не вдалося визначити власника публікації");

  const userTokens = await getUserTokens(db, userId);
  let tokens = userTokens.tiktok;
  if (!tokens) throw new Error("TikTok не підключено. Підключіть акаунт у Налаштуваннях.");
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

export async function syncTikTokPublishingPost(db: Db, postId: number) {
  const post = await db.get(`SELECT * FROM platform_posts WHERE id = ?`, [postId]);
  if (!post || post.platform !== "tiktok" || post.status !== "publishing" || !post.externalPostId) {
    return post;
  }

  const tokens = await getTikTokTokensForPost(db, post);
  const status = await getTikTokPublishStatus(post.externalPostId, tokens);
  const now = new Date().toISOString();
  const statusJson = JSON.stringify(status);

  if (status.status === "PUBLISH_COMPLETE") {
    await db.run(
      `UPDATE platform_posts
       SET status = 'published', publishedAt = ?, platformStatus = ?, errorMessage = NULL, updatedAt = ?
       WHERE id = ?`,
      [now, statusJson, now, postId]
    );
  } else if (status.status === "FAILED") {
    const reason = status.failReason || "Невідома помилка TikTok";
    await db.run(
      `UPDATE platform_posts
       SET status = 'failed', platformStatus = ?, errorMessage = ?, updatedAt = ?
       WHERE id = ?`,
      [statusJson, `TikTok: ${reason}`, now, postId]
    );
  } else {
    await db.run(
      `UPDATE platform_posts SET platformStatus = ?, updatedAt = ? WHERE id = ?`,
      [statusJson, now, postId]
    );
  }

  return db.get(`SELECT * FROM platform_posts WHERE id = ?`, [postId]);
}

async function syncPendingTikTokPosts(db: Db) {
  const posts = await db.all(
    `SELECT id FROM platform_posts
     WHERE platform = 'tiktok' AND status = 'publishing' AND externalPostId IS NOT NULL
     ORDER BY updatedAt ASC LIMIT 20`
  );
  for (const post of posts) {
    try {
      await syncTikTokPublishingPost(db, post.id);
    } catch (error) {
      // Network/API errors are transient. Keep the post in publishing state so
      // the next scheduler tick can retry without creating a duplicate post.
      console.error(`TikTok status sync error for post ${post.id}:`, error);
    }
  }
}

export async function publishPlatformPost(db: Db, postId: number, extras?: Record<string, unknown>) {
  const post = await db.get(`SELECT * FROM platform_posts WHERE id = ?`, [postId]);

  if (!post) {
    throw new Error("Platform post not found");
  }

  // Atomically claim this post before doing any work. Without this, a scheduler
  // tick and a manual "publish now" click (or a double click) racing on the same
  // post would both run platform.publish() concurrently and post the product twice —
  // the WHERE clause makes the claim a single compare-and-swap, not a check-then-act
  // race, since only one UPDATE can match "status NOT IN (...)" before the first
  // writer's status change lands.
  const claimedAt = new Date().toISOString();
  const claim = await db.run(
    `
    UPDATE platform_posts
    SET status = 'publishing',
        errorMessage = NULL,
        updatedAt = ?
    WHERE id = ? AND status NOT IN ('publishing', 'published')
    `,
    [claimedAt, postId]
  );
  if (!claim.changes) {
    throw new Error(
      post.status === "published" ? "Цей пост вже опубліковано" : "Цей пост вже публікується — зачекай"
    );
  }

  const product = await getProductInput(db, post.productId);
  const platform = getPlatform(post.platform as PlatformId);

  // Fetch per-user social tokens (numeric userId only; 'default' uses .env fallback)
  const productRow = await db.get(`SELECT userId FROM products WHERE id = ?`, [post.productId]);
  const numericUserId = productRow?.userId && /^\d+$/.test(String(productRow.userId))
    ? parseInt(productRow.userId, 10) : null;
  const userTokens = numericUserId ? await getUserTokens(db, numericUserId) : null;
  if (numericUserId && userTokens) {
    const settings = await db.get(
      `SELECT telegram_chat_id, telegram_order_login, telegram_social_links FROM user_settings WHERE user_id = ?`,
      [numericUserId]
    );
    if (settings?.telegram_chat_id) {
      let socialLinks: string[] | undefined;
      try {
        const parsed = settings.telegram_social_links ? JSON.parse(settings.telegram_social_links) : null;
        if (Array.isArray(parsed)) socialLinks = parsed.map((s: unknown) => String(s)).filter(Boolean);
      } catch { /* malformed JSON — ignore, just omit social links */ }
      userTokens.telegram = {
        chatId: settings.telegram_chat_id,
        orderLogin: settings.telegram_order_login || undefined,
        socialLinks,
      };
    }
    // TikTok access tokens are short-lived; refresh proactively so scheduled/queued
    // posts don't fail with a stale token for accounts connected a while ago.
    if (userTokens.tiktok && userTokens.tiktok.expiresAt < Date.now() + 60_000) {
      try {
        const refreshed = await refreshTikTokTokenRaw(userTokens.tiktok.refreshToken);
        await saveUserToken(db, numericUserId, "tiktok", {
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          open_id: refreshed.openId,
          expires_at: refreshed.expiresAt,
          refresh_expires_at: refreshed.refreshExpiresAt,
        });
        userTokens.tiktok = refreshed;
      } catch {
        // Leave the stale token in place; publish will fail with a clear TikTok API error.
      }
    }
    // OLX tokens also expire; refresh proactively when we have a refresh token.
    if (userTokens.olx?.refreshToken && userTokens.olx.expiresAt && userTokens.olx.expiresAt < Date.now() + 60_000) {
      try {
        const refreshed = await refreshOlxToken(userTokens.olx.refreshToken);
        await saveUserToken(db, numericUserId, "olx", {
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          expires_at: refreshed.expiresAt,
          meta: { categoryId: userTokens.olx.categoryId },
        });
        userTokens.olx = { ...userTokens.olx, ...refreshed };
      } catch {
        // Leave the stale token in place; publish will fail with a clear OLX API error.
      }
    }
  }

  try {
    const preparedVideo = await prepareVideoForPublishing(product);

    // Shafa uses Playwright (~2 min) — retrying creates duplicate posts, so 1 attempt only
    const isShafa = post.platform === "shafa";
    const isTikTok = post.platform === "tiktok";
    const isInstagram = post.platform === "instagram";
    // Retrying TikTok's init request can create duplicate posts if the first
    // request succeeded but its response was interrupted.
    const maxAttempts = isShafa || isTikTok ? 1 : 3;

    const result = await withRetry(
      () =>
        platform.publish({
          product,
          text: post.text,
          photoPaths: product.photoPaths,
          imageUrls: product.imageUrls,
          videoPath: preparedVideo.videoPath,
          videoUrl: preparedVideo.videoUrl,
          extras: {
            ...extras,
            userTokens,
            numericUserId,
            ...(isTikTok ? { tiktokSettings: parseJsonObject(post.platformSettings) } : {}),
            ...(isInstagram ? { instagramSettings: parseJsonObject(post.platformSettings) } : {}),
          },
        }),
      maxAttempts,
      4000
    );

    const publishedAt = new Date().toISOString();

    if (isTikTok) {
      await db.run(
        `UPDATE platform_posts
         SET status = 'publishing',
             externalPostId = ?,
             platformStatus = ?,
             errorMessage = NULL,
             updatedAt = ?
         WHERE id = ?`,
        [
          result.externalPostId || null,
          JSON.stringify({ status: "PROCESSING_DOWNLOAD", publiclyAvailablePostIds: [] }),
          publishedAt,
          postId,
        ]
      );
      return result;
    }

    await db.run(
      `
      UPDATE platform_posts
      SET status = 'published',
          publishedAt = ?,
          externalPostId = ?,
          externalChatId = ?,
          errorMessage = NULL,
          updatedAt = ?
      WHERE id = ?
      `,
      [
        publishedAt,
        result.externalPostId || null,
        result.externalChatId || null,
        publishedAt,
        postId,
      ]
    );

    if (post.platform === "telegram") {
      await db.run(
        `
        UPDATE products
        SET generatedPost = ?,
            telegramPublished = 1,
            telegramChatId = ?,
            telegramMessageId = ?,
            updatedAt = ?
        WHERE id = ?
        `,
        [
          post.text,
          result.externalChatId || null,
          result.externalPostId || null,
          publishedAt,
          post.productId,
        ]
      );
    }

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Помилка публікації";
    const failedAt = new Date().toISOString();

    await db.run(
      `
      UPDATE platform_posts
      SET status = 'failed',
          errorMessage = ?,
          updatedAt = ?
      WHERE id = ?
      `,
      [message, failedAt, postId]
    );

    throw error;
  }
}

export async function publishDuePosts(db: Db) {
  const duePosts = await db.all(
    `
    SELECT id
    FROM platform_posts
    WHERE status = 'scheduled'
      AND scheduledAt IS NOT NULL
      AND scheduledAt <= ?
    ORDER BY scheduledAt ASC
    LIMIT 10
    `,
    [new Date().toISOString()]
  );

  for (const post of duePosts) {
    try {
      await publishPlatformPost(db, post.id);
    } catch (error) {
      console.error("Scheduled publish error:", error);
    }
  }
}

export function startScheduler(db: Db) {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await publishDuePosts(db);
      await syncPendingTikTokPosts(db);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, 45_000);
  timer.unref?.();
  void tick();

  return timer;
}
