import crypto from "crypto";

export interface FbCreds { pageId: string; accessToken: string; pageName: string }
export interface IgCreds { userId: string; accessToken: string }
export interface TtCreds { accessToken: string; refreshToken: string; openId: string; expiresAt: number; refreshExpiresAt: number }
export interface TelegramCreds { chatId: string; orderLogin?: string; socialLinks?: string[] }
export interface PromCreds { accessToken: string; categoryId?: number; categoryName?: string }
export interface OlxCreds { accessToken: string; refreshToken?: string; expiresAt?: number; categoryId?: number }
export interface RozetkaCreds { accessToken: string; categoryId?: number; categoryName?: string }
export interface KastaCreds { accessToken: string; kindId?: number; affiliationId?: number; categoryName?: string }

export interface SocialTokens {
  facebook?: FbCreds;
  instagram?: IgCreds;
  tiktok?: TtCreds;
  telegram?: TelegramCreds;
  prom?: PromCreds;
  olx?: OlxCreds;
  rozetka?: RozetkaCreds;
  kasta?: KastaCreds;
}

function parseMeta(raw: unknown): Record<string, any> {
  if (typeof raw !== "string" || !raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

const ENC_PREFIX = "enc:v1:";

function encryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || "dev-secret-please-change-in-production";
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptValue(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (!value.startsWith(ENC_PREFIX)) return value;
  try {
    const packed = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export async function getUserTokens(db: any, userId: number): Promise<SocialTokens> {
  const rows = await db.all("SELECT * FROM user_social_tokens WHERE user_id = ?", [userId]);
  const result: SocialTokens = {};
  for (const r of rows) {
    const accessToken = decryptValue(r.access_token);
    const refreshToken = decryptValue(r.refresh_token);
    if (r.platform === "facebook" && r.page_id && accessToken) {
      result.facebook = { pageId: r.page_id, accessToken, pageName: r.page_name || "" };
    } else if (r.platform === "instagram" && r.instagram_user_id && accessToken) {
      result.instagram = { userId: r.instagram_user_id, accessToken };
    } else if (r.platform === "tiktok" && accessToken) {
      result.tiktok = {
        accessToken,
        refreshToken,
        openId: r.open_id || "",
        expiresAt: r.expires_at || 0,
        refreshExpiresAt: r.refresh_expires_at || 0,
      };
    } else if (r.platform === "prom" && accessToken) {
      const meta = parseMeta(r.meta);
      result.prom = { accessToken, categoryId: meta.categoryId, categoryName: meta.categoryName };
    } else if (r.platform === "olx" && accessToken) {
      const meta = parseMeta(r.meta);
      result.olx = { accessToken, refreshToken: refreshToken || undefined, expiresAt: r.expires_at || undefined, categoryId: meta.categoryId };
    } else if (r.platform === "rozetka" && accessToken) {
      const meta = parseMeta(r.meta);
      result.rozetka = { accessToken, categoryId: meta.categoryId, categoryName: meta.categoryName };
    } else if (r.platform === "kasta" && accessToken) {
      const meta = parseMeta(r.meta);
      result.kasta = { accessToken, kindId: meta.kindId, affiliationId: meta.affiliationId, categoryName: meta.categoryName };
    }
  }
  return result;
}

const DUPLICATE_ACCOUNT_MESSAGES: Record<string, string> = {
  page_id: "Ця Facebook-сторінка вже підключена до іншого акаунта Postly.",
  instagram_user_id: "Цей Instagram-акаунт вже підключено до іншого акаунта Postly.",
  open_id: "Цей TikTok-акаунт вже підключено до іншого акаунта Postly.",
};

const DUPLICATE_PLATFORM_MESSAGES: Record<string, string> = {
  prom: "Цей акаунт Prom.ua вже підключено до іншого акаунта Postly.",
  olx: "Цей акаунт OLX вже підключено до іншого акаунта Postly.",
  rozetka: "Цей акаунт Rozetka вже підключено до іншого акаунта Postly.",
  kasta: "Цей акаунт Kasta.ua вже підключено до іншого акаунта Postly.",
  shafa: "Цей акаунт Shafa.ua вже підключено до іншого акаунта Postly.",
};

// Stable identity signal for platforms whose access token never changes for the
// lifetime of the connection (Prom/Rozetka personal API tokens) — unlike OAuth
// access tokens that rotate on refresh, hashing these directly is a reliable proxy
// for "same external account" without needing an extra API call to fetch a real ID.
export function hashForIdentity(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function saveUserToken(db: any, userId: number, platform: string, data: Record<string, any>) {
  const now = new Date().toISOString();
  const meta = data.meta !== undefined ? JSON.stringify(data.meta) : null;
  try {
    await db.run(`
      INSERT INTO user_social_tokens
        (user_id, platform, access_token, refresh_token, page_id, page_name, open_id, instagram_user_id, instagram_username, expires_at, refresh_expires_at, login, meta, external_account_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, platform) DO UPDATE SET
        access_token       = excluded.access_token,
        refresh_token      = excluded.refresh_token,
        page_id            = excluded.page_id,
        page_name          = excluded.page_name,
        open_id            = excluded.open_id,
        instagram_user_id  = excluded.instagram_user_id,
        instagram_username = excluded.instagram_username,
        expires_at         = excluded.expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        login              = excluded.login,
        meta               = excluded.meta,
        external_account_id = excluded.external_account_id,
        updated_at         = excluded.updated_at
    `, [
      userId, platform,
      encryptValue(data.access_token), encryptValue(data.refresh_token),
      data.page_id ?? null, data.page_name ?? null,
      data.open_id ?? null, data.instagram_user_id ?? null, data.instagram_username ?? null,
      data.expires_at ?? null, data.refresh_expires_at ?? null,
      data.login ?? null, meta, data.external_account_id ?? null,
      now, now,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed")) {
      const column = Object.keys(DUPLICATE_ACCOUNT_MESSAGES).find((col) => msg.includes(col));
      throw new Error(
        (column && DUPLICATE_ACCOUNT_MESSAGES[column]) ||
        DUPLICATE_PLATFORM_MESSAGES[platform] ||
        "Цей акаунт платформи вже підключено до іншого користувача Postly."
      );
    }
    throw err;
  }
}

export async function deleteUserToken(db: any, userId: number, platform: string) {
  await db.run("DELETE FROM user_social_tokens WHERE user_id = ? AND platform = ?", [userId, platform]);
}

// Updates just the `meta` JSON blob for an existing token row (e.g. a saved default
// category) without touching access_token/refresh_token — saveUserToken overwrites
// every column on conflict, so it isn't safe for a partial update like this one.
export async function updateUserTokenMeta(db: any, userId: number, platform: string, meta: Record<string, any>) {
  await db.run(
    "UPDATE user_social_tokens SET meta = ?, updated_at = ? WHERE user_id = ? AND platform = ?",
    [JSON.stringify(meta), new Date().toISOString(), userId, platform]
  );
}

export async function getUserSocialStatus(db: any, userId: number) {
  const tokens = await getUserTokens(db, userId);
  return {
    facebook: !!tokens.facebook,
    facebookPageName: tokens.facebook?.pageName || null,
    instagram: !!tokens.instagram,
    tiktok: !!tokens.tiktok && (tokens.tiktok.expiresAt > Date.now()),
    prom: !!tokens.prom,
    promCategoryName: tokens.prom?.categoryName || null,
    olx: !!tokens.olx,
    rozetka: !!tokens.rozetka,
    kasta: !!tokens.kasta,
    kastaCategoryName: tokens.kasta?.categoryName || null,
  };
}
