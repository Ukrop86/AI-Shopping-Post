// Сповіщення про те, що сталося без участі людини: провалену публікацію,
// перервану підготовку, токен, який ось-ось помре.
//
// ВІДПРАВКИ ТУТ ПОКИ НЕМАЄ — і це навмисно. Користувачів у системі кілька, і
// сповіщення має піти саме власникові товару, а не в спільний канал; куди саме
// (Telegram, пошта) і на яку адресу — вирішує сам користувач, і цю адресу ще
// треба підтвердити. Тому події складаються в чергу `notifications` з
// deliveredAt = NULL, а `deliverNotification` — заглушка з єдиним місцем, куди
// підключити реальний канал (див. TODO нижче).

type Db = any;

export type NotificationKind =
  | "publish_failed"
  | "publish_interrupted"
  | "studio_failed"
  | "token_expiring";

export type NotificationInput = {
  userId: number;
  kind: NotificationKind;
  title: string;
  body: string;
  productId?: number | null;
  platformPostId?: number | null;
};

export type UserNotificationChannel = {
  channel: "none" | "telegram" | "email";
  target: string;
};

export async function getUserNotificationChannel(
  db: Db,
  userId: number
): Promise<UserNotificationChannel> {
  const row = await db.get(
    `SELECT notify_channel, notify_target FROM user_settings WHERE user_id = ?`,
    [userId]
  );
  const channel = String(row?.notify_channel || "none");
  return {
    channel: channel === "telegram" || channel === "email" ? channel : "none",
    target: String(row?.notify_target || ""),
  };
}

/**
 * ЗАГЛУШКА. Тут має бути реальна відправка в канал користувача.
 *
 * Щоб її увімкнути, треба зробити рівно дві речі:
 *  1) дати користувачеві вказати канал і адресу (user_settings.notify_channel /
 *     notify_target) і підтвердити її — інакше сповіщення піде не тій людині;
 *  2) замінити тіло цієї функції на відправку і повернути true при успіху.
 *
 * Поки що повертає false: подія лишається в черзі неврученою, нічого не
 * втрачається, і коли зʼявиться відправник — чергу можна просто розібрати.
 */
async function deliverNotification(
  _channel: UserNotificationChannel,
  _notification: NotificationInput
): Promise<boolean> {
  // TODO: підключити реальний канал (Telegram-бот / пошта) на власника товару.
  return false;
}

export async function notifyUser(db: Db, input: NotificationInput) {
  const now = new Date().toISOString();

  const inserted = await db.run(
    `INSERT INTO notifications (userId, kind, title, body, productId, platformPostId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.kind,
      input.title,
      input.body,
      input.productId ?? null,
      input.platformPostId ?? null,
      now,
    ]
  );

  // У логи пишемо завжди: поки відправки немає, це єдиний спосіб побачити
  // подію, не заходячи в базу.
  console.log(`[Notify] user=${input.userId} ${input.kind}: ${input.title} — ${input.body}`);

  try {
    const channel = await getUserNotificationChannel(db, input.userId);
    if (channel.channel === "none" || !channel.target) return inserted.lastID as number;

    const delivered = await deliverNotification(channel, input);
    if (delivered) {
      await db.run(`UPDATE notifications SET deliveredAt = ? WHERE id = ?`, [
        new Date().toISOString(),
        inserted.lastID,
      ]);
    }
  } catch (error) {
    await db.run(`UPDATE notifications SET deliveryError = ? WHERE id = ?`, [
      (error instanceof Error ? error.message : String(error)).slice(0, 300),
      inserted.lastID,
    ]);
  }

  return inserted.lastID as number;
}

/**
 * Чи слали вже такому користувачеві сповіщення цього типу останнім часом.
 * Потрібно, щоб добові перевірки (скажімо, «токен спливає») не перетворювались
 * на щоденний спам — тим паче що лічильник добового проходу скидається на
 * кожному перезапуску контейнера.
 */
export async function recentlyNotified(
  db: Db,
  userId: number,
  kind: NotificationKind,
  withinMs: number
) {
  const since = new Date(Date.now() - withinMs).toISOString();
  const row = await db.get(
    `SELECT 1 AS found FROM notifications WHERE userId = ? AND kind = ? AND createdAt >= ? LIMIT 1`,
    [userId, kind, since]
  );
  return !!row;
}

export async function listNotifications(db: Db, userId: number, limit = 30) {
  return db.all(
    `SELECT * FROM notifications WHERE userId = ? ORDER BY id DESC LIMIT ?`,
    [userId, Math.min(100, Math.max(1, limit))]
  );
}

// Власник товару — адресат усіх сповіщень про його публікації.
export async function productOwnerId(db: Db, productId: number): Promise<number | null> {
  const row = await db.get(`SELECT userId FROM products WHERE id = ?`, [productId]);
  const raw = row?.userId;
  return raw && /^\d+$/.test(String(raw)) ? parseInt(String(raw), 10) : null;
}
