import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";

async function ensureColumn(
  db: any,
  tableName: string,
  columnName: string,
  definition: string
) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column: any) => column.name === columnName);

  if (!exists) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

// CREATE UNIQUE INDEX fails outright if data already on disk violates it (e.g. two
// rows that predate this constraint sharing the same page_id from earlier testing).
// That would crash every future startup on a live database, so creation failure here
// is logged and skipped rather than thrown — the constraint just won't be enforced
// until whoever owns the DB manually de-duplicates the offending rows.
async function ensureUniqueIndex(db: any, name: string, sql: string) {
  try {
    await db.exec(sql);
  } catch (err) {
    console.error(
      `[db] Could not create unique index ${name} — likely pre-existing duplicate rows. ` +
      `The app will still run, but this constraint isn't enforced yet. Error: ${err instanceof Error ? err.message : err}`
    );
  }
}

export async function initDb() {
  // Same reasoning as uploadsDir in server.ts: default to the persistent Railway
  // volume when one is mounted, instead of a path inside the ephemeral container
  // filesystem. Relying solely on DB_PATH being set correctly in Railway Variables
  // meant a missing/wrong variable silently wiped every product and post on each
  // redeploy — the uploaded photos on disk survived, but with no DB rows left
  // pointing at them, the app looked like it had lost the photos entirely.
  let dbPath = process.env.DB_PATH || (fs.existsSync("/data") ? "/data/database.sqlite" : "./database.sqlite");

  const stat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
  if (stat && stat.isDirectory()) {
    dbPath = path.join(dbPath, "database.sqlite");
  }

  const dbDir = path.dirname(dbPath);
  if (dbDir && dbDir !== ".") {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  console.log(
    `[db] DB_PATH env: ${process.env.DB_PATH || "(not set)"} | ` +
    `/data exists: ${fs.existsSync("/data")} | ` +
    `resolved dbPath: ${dbPath} | ` +
    `existing file: ${fs.existsSync(dbPath)}`
  );

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await db.exec(`PRAGMA foreign_keys = ON`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_social_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      page_id TEXT,
      page_name TEXT,
      open_id TEXT,
      instagram_user_id TEXT,
      instagram_username TEXT,
      expires_at INTEGER,
      refresh_expires_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, platform),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      shop_name TEXT,
      shop_description TEXT,
      shop_language TEXT DEFAULT 'uk',
      facebook_page_url TEXT,
      instagram_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // One real external account (Facebook Page / Instagram Business account / TikTok
  // account) can only ever be connected to a single Postly user at a time — without
  // this, two different users could both connect the same page and their publishes
  // would silently collide. page_id/instagram_user_id/open_id aren't encrypted (only
  // access_token/refresh_token are), so a plain partial unique index works directly.
  await ensureUniqueIndex(db, "idx_unique_fb_page",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_fb_page
     ON user_social_tokens(page_id) WHERE platform = 'facebook' AND page_id IS NOT NULL`
  );
  await ensureUniqueIndex(db, "idx_unique_ig_user",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_ig_user
     ON user_social_tokens(instagram_user_id) WHERE platform = 'instagram' AND instagram_user_id IS NOT NULL`
  );
  await ensureUniqueIndex(db, "idx_unique_tiktok_open",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_tiktok_open
     ON user_social_tokens(open_id) WHERE platform = 'tiktok' AND open_id IS NOT NULL`
  );

  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT NOT NULL,
      title TEXT,
      price TEXT,
      dropPrice TEXT,
      sizes TEXT,
      colors TEXT,
      fabric TEXT,
      model TEXT,
      imageUrl TEXT,
      photoPath TEXT,
      generatedPost TEXT,
      telegramPublished INTEGER DEFAULT 0,
      telegramChatId TEXT,
      telegramMessageId TEXT
    )
  `);

  await ensureColumn(db, "products", "userId", "TEXT DEFAULT 'default'");
  await ensureColumn(db, "products", "updatedAt", "TEXT");
  await ensureColumn(db, "products", "description", "TEXT");
  await ensureColumn(db, "products", "videoUrl", "TEXT");
  await ensureColumn(db, "products", "videoPath", "TEXT");
  await ensureColumn(db, "products", "videoStyle", "TEXT DEFAULT 'fashion'");
  await ensureColumn(db, "products", "processedVideoUrl", "TEXT");
  await ensureColumn(db, "products", "processedVideoPath", "TEXT");
  await ensureColumn(db, "products", "useProcessedVideo", "INTEGER DEFAULT 1");
  await ensureColumn(db, "products", "generateVideo", "INTEGER DEFAULT 1");
  await ensureColumn(db, "products", "sizeSystem", "TEXT");
  await ensureColumn(db, "products", "shopName", "TEXT");
  await ensureColumn(db, "products", "shopDescription", "TEXT");
  await ensureColumn(db, "products", "shopLanguage", "TEXT");
  await ensureColumn(db, "products", "priceMarkup", "REAL DEFAULT 0");
  // Похідне медіа для Instagram, що готується на вимогу: слайдшоу-Reels із фото
  // товару та кадр 9:16 для сторіз. Зберігаються на товарі, щоб запланована
  // публікація брала готовий файл, а не запускала ffmpeg у момент слоту.
  await ensureColumn(db, "products", "slideshowVideoPath", "TEXT");
  await ensureColumn(db, "products", "slideshowVideoUrl", "TEXT");
  await ensureColumn(db, "products", "storyImagePath", "TEXT");
  await ensureColumn(db, "products", "storyImageUrl", "TEXT");
  // Товар-добірка: JSON-масив id товарів, з фото яких зібрано слайдшоу.
  await ensureColumn(db, "products", "bundleOf", "TEXT");
  // Стан фонової підготовки медіа для Instagram-студії: preparing/ready/failed.
  await ensureColumn(db, "products", "studioStatus", "TEXT");
  await ensureColumn(db, "products", "studioError", "TEXT");
  await ensureColumn(db, "user_settings", "telegram_chat_id", "TEXT");
  // Куди слати сповіщення саме цьому користувачеві: у системі їх кілька, тож
  // канал і адресат зберігаються на кожного окремо.
  await ensureColumn(db, "user_settings", "notify_channel", "TEXT");
  await ensureColumn(db, "user_settings", "notify_target", "TEXT");
  // Telegram post extras: the contact username the "✍️ Написати" button links to,
  // and a JSON array of the seller's social/marketplace URLs shown in the post body
  // (right before the hashtags). Both are Telegram-only and optional.
  await ensureColumn(db, "user_settings", "telegram_order_login", "TEXT");
  await ensureColumn(db, "user_settings", "telegram_social_links", "TEXT");
  // Per-platform price markup: JSON map { platformId: percent } applied to the
  // entered price (and drop price) when generating that platform's post text.
  await ensureColumn(db, "user_settings", "platform_markups", "TEXT");
  await ensureColumn(db, "user_social_tokens", "login", "TEXT");
  await ensureColumn(db, "user_social_tokens", "meta", "TEXT");
  // Generic one-account-one-user identifier for platforms without a dedicated
  // column like page_id/instagram_user_id/open_id: Prom/Rozetka (hash of their
  // static personal API token — stable for the token's whole lifetime, unlike
  // OAuth tokens that rotate), OLX (its own numeric user id from /users/me,
  // since OLX tokens DO rotate on refresh and a token hash would stop matching),
  // and Shafa (the seller username scraped after login — Shafa has no real API,
  // so this is a bookkeeping-only row; the actual session lives in a per-user file).
  await ensureColumn(db, "user_social_tokens", "external_account_id", "TEXT");

  // Same one-account-one-user reasoning as the social platform indexes above —
  // added here, after the column exists, since telegram_chat_id is only added via
  // ensureColumn (ALTER TABLE) rather than being in the original CREATE TABLE.
  await ensureUniqueIndex(db, "idx_unique_telegram_chat",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_telegram_chat
     ON user_settings(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''`
  );
  await ensureUniqueIndex(db, "idx_unique_external_account",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_external_account
     ON user_social_tokens(platform, external_account_id)
     WHERE external_account_id IS NOT NULL AND external_account_id != ''`
  );

  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER NOT NULL,
      imageUrl TEXT NOT NULL,
      photoPath TEXT NOT NULL,
      sortOrder INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS platform_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER NOT NULL,
      platform TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduledAt TEXT,
      publishedAt TEXT,
      externalPostId TEXT,
      externalChatId TEXT,
      errorMessage TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_product_images_product
      ON product_images(productId);

    CREATE INDEX IF NOT EXISTS idx_platform_posts_product
      ON platform_posts(productId);

    CREATE INDEX IF NOT EXISTS idx_platform_posts_schedule
      ON platform_posts(status, scheduledAt);

    -- Черга сповіщень. Відправки ще немає (канал у кожного свій і його треба
    -- підтвердити), тому події складаються сюди з deliveredAt = NULL: коли
    -- зʼявиться реальний відправник, він просто розбере цю чергу.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      productId INTEGER,
      platformPostId INTEGER,
      createdAt TEXT NOT NULL,
      deliveredAt TEXT,
      deliveryError TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(userId, createdAt);

    CREATE INDEX IF NOT EXISTS idx_notifications_undelivered
      ON notifications(deliveredAt, createdAt);
  `);

  // Копія фото під вимоги Instagram (JPEG + співвідношення 4:5…1.91:1).
  // Порожньо = фото ще не оброблялося; якщо оригінал уже підходить, сюди
  // пишеться сам оригінал.
  await ensureColumn(db, "product_images", "igImagePath", "TEXT");
  await ensureColumn(db, "product_images", "igImageUrl", "TEXT");
  // Instagram-студія: кілька постів одного товару (по одному на формат), тому
  // пара (товар, платформа) більше не унікальна — формат розрізняє рядки.
  // Порожньо = пост зі старого кабінету, де формат один на платформу.
  await ensureColumn(db, "platform_posts", "formatKey", "TEXT");
  // Автопостинг: скільки разів планувальник уже намагався опублікувати цей пост
  // і коли можна пробувати наступного разу. Без цього один збій мережі о 19:30
  // означав, що пост не вийде взагалі й ніхто про це не дізнається.
  await ensureColumn(db, "platform_posts", "attempts", "INTEGER DEFAULT 0");
  await ensureColumn(db, "platform_posts", "nextAttemptAt", "TEXT");

  // Platform-specific metadata stays on the individual post so scheduled
  // publishes use the exact settings the creator explicitly approved. TikTok
  // also needs its asynchronous processing state persisted across redeploys.
  await ensureColumn(db, "platform_posts", "platformSettings", "TEXT");
  await ensureColumn(db, "platform_posts", "platformStatus", "TEXT");

  const now = new Date().toISOString();

  await db.run(
    `
    UPDATE products
    SET updatedAt = COALESCE(updatedAt, createdAt, ?),
        userId = COALESCE(userId, 'default'),
        videoStyle = COALESCE(videoStyle, 'fashion'),
        useProcessedVideo = COALESCE(useProcessedVideo, 1),
        generateVideo = COALESCE(generateVideo, 1)
    WHERE updatedAt IS NULL
      OR userId IS NULL
      OR videoStyle IS NULL
      OR useProcessedVideo IS NULL
      OR generateVideo IS NULL
    `,
    [now]
  );

  await db.run(`
    INSERT INTO product_images (productId, imageUrl, photoPath, sortOrder, createdAt)
    SELECT p.id, p.imageUrl, p.photoPath, 0, COALESCE(p.createdAt, datetime('now'))
    FROM products p
    WHERE p.imageUrl IS NOT NULL
      AND p.photoPath IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM product_images pi WHERE pi.productId = p.id
      )
  `);

  await db.run(
    `
    INSERT INTO platform_posts (
      productId,
      platform,
      text,
      status,
      publishedAt,
      externalPostId,
      externalChatId,
      createdAt,
      updatedAt
    )
    SELECT
      p.id,
      'telegram',
      p.generatedPost,
      CASE WHEN p.telegramPublished = 1 THEN 'published' ELSE 'draft' END,
      CASE WHEN p.telegramPublished = 1 THEN COALESCE(p.updatedAt, p.createdAt) ELSE NULL END,
      p.telegramMessageId,
      p.telegramChatId,
      COALESCE(p.createdAt, ?),
      COALESCE(p.updatedAt, p.createdAt, ?)
    FROM products p
    WHERE p.generatedPost IS NOT NULL
      AND p.generatedPost != ''
      AND NOT EXISTS (
        SELECT 1
        FROM platform_posts pp
        WHERE pp.productId = p.id AND pp.platform = 'telegram'
      )
    `,
    [now, now]
  );

  return db;
}
