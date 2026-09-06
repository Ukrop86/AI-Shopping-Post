import { getPlatform } from "./platforms";
import { PlatformId, ProductInput } from "./platform-types";
import { saveUserToken } from "./user-tokens";
import { getTikTokPublishStatus, refreshTikTokTokenRaw, TikTokTokens } from "./tiktok";
import { refreshOlxToken } from "./olx";
import { notifyUser, productOwnerId, recentlyNotified } from "./notifications";
import { getUserTokens, tokenExpiryState } from "./user-tokens";
import fs from "fs/promises";

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
    igImageUrls: images.map((image: any) => image.igImageUrl || image.imageUrl),
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

// ── Автопостинг: живучість без нагляду ───────────────────────────────────────

// Публікація Reels чекає на обробку відео в Instagram до 10 хв, Shafa через
// Playwright — до 3 хв. Тому «зависанням» вважаємо тільки те, що триває довше
// за будь-який легальний сценарій.
const STUCK_AFTER_MS = 20 * 60_000;
const MAX_PUBLISH_ATTEMPTS = 3;
// Пауза перед повторами: коротка на випадок мережевого збою, довша — якщо
// платформа справді лежить.
const RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000];
// Запобіжник від залпу: кілька постів, що припали на один час, не повинні
// вилітати підряд за секунди — це ріже охоплення кожному з них.
const MIN_GAP_BETWEEN_POSTS_MS = 15 * 60_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
// Скільки днів тримати похідне медіа (оверлеї, слайдшоу, кадри сторіз) після
// того, як з товаром уже все зроблено. Оригінали продавця не чіпаємо ніколи.
const DERIVED_MEDIA_TTL_DAYS = 30;

/**
 * Контейнер на Railway перезапускається на кожному деплої. Якщо це стається
 * посеред публікації, рядок лишається в статусі `publishing` — і більше ніколи
 * не буде взятий (claim бере тільки те, що НЕ publishing/published).
 *
 * Свідомо НЕ повертаємо такі пости в чергу: якщо публікація насправді дійшла до
 * платформи, а процес помер до запису результату, повтор дав би дубль. Тому
 * позначаємо їх як провалені з поясненням — рішення за людиною.
 */
async function recoverStuckPosts(db: Db) {
  const threshold = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

  // TikTok має власну асинхронну синхронізацію статусу — його не чіпаємо.
  const stuck = await db.all(
    `SELECT id, productId, platform FROM platform_posts
     WHERE status = 'publishing' AND platform != 'tiktok' AND updatedAt <= ?`,
    [threshold]
  );

  for (const post of stuck) {
    await db.run(
      `UPDATE platform_posts
       SET status = 'failed',
           errorMessage = ?,
           updatedAt = ?
       WHERE id = ? AND status = 'publishing'`,
      [
        "Публікацію перервано (перезапуск сервера). Перевір у профілі, чи пост не вийшов, і опублікуй ще раз, якщо ні.",
        new Date().toISOString(),
        post.id,
      ]
    );
    console.error(`[Recovery] Пост ${post.id} (${post.platform}) завис у publishing — позначено як провалений`);

    const userId = await productOwnerId(db, post.productId);
    if (userId) {
      await notifyUser(db, {
        userId,
        kind: "publish_interrupted",
        title: "Публікацію перервано",
        body: `Пост #${post.id} (${post.platform}) лишився в стані «публікується» після перезапуску сервера. Перевір, чи він не вийшов, перш ніж публікувати повторно.`,
        productId: post.productId,
        platformPostId: post.id,
      });
    }
  }

  // Те саме для підготовки медіа в Instagram-студії: без цього товар назавжди
  // лишається в «Готуємо…», а сторінка опитує його вічно.
  const stuckProducts = await db.all(
    `SELECT id, userId FROM products WHERE studioStatus = 'preparing' AND updatedAt <= ?`,
    [threshold]
  );

  for (const product of stuckProducts) {
    await db.run(
      `UPDATE products SET studioStatus = 'failed', studioError = ?, updatedAt = ? WHERE id = ?`,
      [
        "Підготовку перервано (перезапуск сервера). Натисни «Спробувати ще раз».",
        new Date().toISOString(),
        product.id,
      ]
    );
    console.error(`[Recovery] Товар ${product.id} завис у підготовці — позначено як провалений`);

    const userId = await productOwnerId(db, product.id);
    if (userId) {
      await notifyUser(db, {
        userId,
        kind: "studio_failed",
        title: "Підготовку постів перервано",
        body: `Товар #${product.id}: підготовка медіа обірвалась через перезапуск сервера. Відкрий Instagram-студію і натисни «Спробувати ще раз».`,
        productId: product.id,
      });
    }
  }
}

/**
 * Провал запланованої публікації — це ще не кінець: мережа й API платформ
 * падають на хвилини. Повертаємо пост у чергу з паузою, і лише після кількох
 * невдач лишаємо провал остаточним.
 */
async function scheduleRetry(db: Db, postId: number, error: unknown) {
  const post = await db.get(`SELECT * FROM platform_posts WHERE id = ?`, [postId]);
  if (!post) return;

  const attempts = (Number(post.attempts) || 0) + 1;
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();

  if (attempts >= MAX_PUBLISH_ATTEMPTS) {
    await db.run(
      `UPDATE platform_posts SET status = 'failed', attempts = ?, nextAttemptAt = NULL, errorMessage = ?, updatedAt = ? WHERE id = ?`,
      [attempts, message, now, postId]
    );

    const userId = await productOwnerId(db, post.productId);
    if (userId) {
      await notifyUser(db, {
        userId,
        kind: "publish_failed",
        title: "Пост не опублікувався",
        body: `Пост #${postId} (${post.platform}) не вдалося опублікувати за ${attempts} спроби. Причина: ${message}`,
        productId: post.productId,
        platformPostId: postId,
      });
    }
    return;
  }

  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  const nextAttemptAt = new Date(Date.now() + delay).toISOString();
  await db.run(
    `UPDATE platform_posts
     SET status = 'scheduled', attempts = ?, nextAttemptAt = ?, errorMessage = ?, updatedAt = ?
     WHERE id = ?`,
    [attempts, nextAttemptAt, `${message} — повтор ${new Date(nextAttemptAt).toLocaleString("uk-UA")}`, now, postId]
  );
  console.log(`[Retry] Пост ${postId}: спроба ${attempts}, наступна о ${nextAttemptAt}`);
}

// Коли цей акаунт востаннє щось публікував на цю платформу.
async function lastPublishedAt(db: Db, userId: string, platform: string) {
  const row = await db.get(
    `SELECT MAX(pp.publishedAt) AS last
     FROM platform_posts pp
     JOIN products p ON p.id = pp.productId
     WHERE p.userId = ? AND pp.platform = ? AND pp.status = 'published' AND pp.publishedAt IS NOT NULL`,
    [userId, platform]
  );
  return row?.last ? Date.parse(row.last) : 0;
}

/**
 * Похідне медіа (оверлеї, слайдшоу, кадри сторіз, копії фото під Instagram)
 * потрібне лише до публікації. Оригінали продавця не чіпаємо — вони і далі
 * лежать у product_images.photoPath / products.videoPath.
 */
/**
 * Токен Facebook живе ~60 днів і не оновлюється сам. Попереджаємо власника
 * заздалегідь — інакше він дізнається про смерть токена з того, що тиждень
 * постів мовчки не вийшов.
 */
async function warnAboutExpiringTokens(db: Db) {
  const users = await db.all(`SELECT id FROM users`);
  for (const user of users) {
    try {
      const tokens = await getUserTokens(db, user.id);
      const state = tokenExpiryState(tokens.instagram?.expiresAt);
      if (!state.expiringSoon && !state.expired) continue;
      // Нагадуємо не частіше ніж раз на три дні.
      if (await recentlyNotified(db, user.id, "token_expiring", 3 * 24 * 60 * 60_000)) continue;

      await notifyUser(db, {
        userId: user.id,
        kind: "token_expiring",
        title: state.expired ? "Доступ до Instagram закінчився" : "Доступ до Instagram скоро закінчиться",
        body: state.expired
          ? "Заплановані пости в Instagram не публікуватимуться. Перепідключи акаунт у Налаштуваннях."
          : `Залишилось ${state.daysLeft} дн. Перепідключи акаунт у Налаштуваннях, щоб автопостинг не зупинився.`,
      });
    } catch (error) {
      console.error(`[Tokens] Перевірка строку для користувача ${user.id} впала:`, error);
    }
  }
}

async function cleanupDerivedMedia(db: Db) {
  const cutoff = new Date(Date.now() - DERIVED_MEDIA_TTL_DAYS * 24 * 60 * 60_000).toISOString();

  const products = await db.all(
    `SELECT id, processedVideoPath, slideshowVideoPath, storyImagePath
     FROM products
     WHERE updatedAt <= ?
       AND (processedVideoPath IS NOT NULL OR slideshowVideoPath IS NOT NULL OR storyImagePath IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM platform_posts pp
         WHERE pp.productId = products.id AND pp.status IN ('draft', 'scheduled', 'publishing')
       )
     LIMIT 50`,
    [cutoff]
  );

  let removed = 0;
  for (const product of products) {
    for (const field of ["processedVideoPath", "slideshowVideoPath", "storyImagePath"] as const) {
      const filePath = String(product[field] || "");
      if (!filePath) continue;
      try {
        await fs.rm(filePath, { force: true });
        removed += 1;
      } catch (error) {
        console.error(`[Cleanup] Не вдалося видалити ${filePath}:`, error);
      }
    }
    await db.run(
      `UPDATE products
       SET processedVideoPath = NULL, processedVideoUrl = NULL,
           slideshowVideoPath = NULL, slideshowVideoUrl = NULL,
           storyImagePath = NULL, storyImageUrl = NULL
       WHERE id = ?`,
      [product.id]
    );
  }

  const images = await db.all(
    `SELECT pi.id, pi.igImagePath, pi.photoPath
     FROM product_images pi
     JOIN products p ON p.id = pi.productId
     WHERE p.updatedAt <= ? AND pi.igImagePath IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM platform_posts pp
         WHERE pp.productId = p.id AND pp.status IN ('draft', 'scheduled', 'publishing')
       )
     LIMIT 200`,
    [cutoff]
  );

  for (const image of images) {
    const igPath = String(image.igImagePath || "");
    // Якщо конвертація не знадобилась, у колонці лежить сам оригінал — його не чіпаємо.
    if (igPath && igPath !== String(image.photoPath || "")) {
      try {
        await fs.rm(igPath, { force: true });
        removed += 1;
      } catch (error) {
        console.error(`[Cleanup] Не вдалося видалити ${igPath}:`, error);
      }
    }
    await db.run(`UPDATE product_images SET igImagePath = NULL, igImageUrl = NULL WHERE id = ?`, [image.id]);
  }

  if (removed) console.log(`[Cleanup] Видалено ${removed} похідних файлів`);
}

export async function publishDuePosts(db: Db) {
  const now = new Date().toISOString();
  const duePosts = await db.all(
    `
    SELECT pp.id, pp.platform, pp.productId, p.userId
    FROM platform_posts pp
    JOIN products p ON p.id = pp.productId
    WHERE pp.status = 'scheduled'
      AND pp.scheduledAt IS NOT NULL
      AND pp.scheduledAt <= ?
      AND (pp.nextAttemptAt IS NULL OR pp.nextAttemptAt <= ?)
    ORDER BY pp.scheduledAt ASC
    LIMIT 10
    `,
    [now, now]
  );

  // Один акаунт × одна платформа — не більше одного поста за прохід, і не
  // раніше ніж через MIN_GAP_BETWEEN_POSTS_MS після попереднього. Інакше
  // кілька постів, що припали на один час, вилітають підряд за секунди.
  const publishedThisTick = new Set<string>();

  for (const post of duePosts) {
    const key = `${post.userId}:${post.platform}`;
    if (publishedThisTick.has(key)) continue;

    const last = await lastPublishedAt(db, String(post.userId), post.platform);
    if (last && Date.now() - last < MIN_GAP_BETWEEN_POSTS_MS) {
      const nextAttemptAt = new Date(last + MIN_GAP_BETWEEN_POSTS_MS).toISOString();
      await db.run(`UPDATE platform_posts SET nextAttemptAt = ? WHERE id = ?`, [nextAttemptAt, post.id]);
      console.log(`[Spacing] Пост ${post.id} відкладено до ${nextAttemptAt} — зарано після попередньої публікації`);
      continue;
    }

    try {
      await publishPlatformPost(db, post.id);
      publishedThisTick.add(key);
    } catch (error) {
      console.error("Scheduled publish error:", error);
      await scheduleRetry(db, post.id, error);
    }
  }
}

export function startScheduler(db: Db) {
  let running = false;

  let lastCleanup = 0;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await recoverStuckPosts(db);
      await publishDuePosts(db);
      await syncPendingTikTokPosts(db);

      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        lastCleanup = Date.now();
        await warnAboutExpiringTokens(db);
        await cleanupDerivedMedia(db);
      }
    } catch (error) {
      // Тік не має падати: наступний має відпрацювати попри збій у будь-якому кроці.
      console.error("Scheduler tick error:", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, 45_000);
  timer.unref?.();
  void tick();

  return timer;
}
