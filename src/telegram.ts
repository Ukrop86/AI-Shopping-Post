import fs from "fs";
import FormData from "form-data";
import fetch from "node-fetch";

type TelegramCredentials = {
  chatId?: string;
  // Contact username the "Написати" button links to (stored as @name, name, or a
  // full t.me URL — normalized below). Falls back to the global ORDER_URL.
  orderLogin?: string;
  // Seller's social/marketplace URLs, shown in the post body before the hashtags.
  socialLinks?: string[];
};

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  result?: any;
};

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Accepts "@name", "name", or a full t.me/telegram.me URL and returns the bare
// username (letters/digits/underscore only), or "" if nothing usable.
function normalizeTelegramLogin(login?: string): string {
  if (!login) return "";
  const v = login.trim();
  if (!v) return "";
  const urlMatch = v.match(/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)/i);
  if (urlMatch) return urlMatch[1];
  return v.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
}

// The order/contact button. Per-user login wins; ORDER_URL is the legacy fallback.
function getReplyMarkup(creds?: TelegramCredentials) {
  const login = normalizeTelegramLogin(creds?.orderLogin);
  const url = login ? `https://t.me/${login}` : (process.env.ORDER_URL || "");
  if (!url) return null;

  return {
    inline_keyboard: [
      [
        {
          text: "✍️ Написати",
          url,
        },
      ],
    ],
  };
}

function socialLabel(rawUrl: string): { emoji: string; name: string } {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    host = "";
  }
  if (host.includes("instagram")) return { emoji: "📸", name: "Instagram" };
  if (host.includes("tiktok")) return { emoji: "🎵", name: "TikTok" };
  if (host.includes("facebook") || host.includes("fb.com") || host.includes("fb.me")) return { emoji: "📘", name: "Facebook" };
  if (host.includes("youtube") || host.includes("youtu.be")) return { emoji: "▶️", name: "YouTube" };
  if (host.includes("t.me") || host.includes("telegram")) return { emoji: "✈️", name: "Telegram" };
  if (host.includes("viber")) return { emoji: "💜", name: "Viber" };
  if (host.includes("shafa")) return { emoji: "🛍", name: "Shafa" };
  if (host.includes("prom.ua")) return { emoji: "🟠", name: "Prom" };
  if (host.includes("rozetka")) return { emoji: "🌹", name: "Rozetka" };
  if (host.includes("olx")) return { emoji: "🟢", name: "OLX" };
  if (host.includes("kasta")) return { emoji: "🛒", name: "Kasta" };
  return { emoji: "🌐", name: host || "Сайт" };
}

function buildSocialBlock(socialLinks?: string[]): string {
  const links = (socialLinks || []).map((s) => String(s).trim()).filter(Boolean);
  if (!links.length) return "";
  const lines = links.map((url) => {
    const httpUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const { emoji, name } = socialLabel(httpUrl);
    return `${emoji} <a href="${escapeHtml(httpUrl)}">${escapeHtml(name)}</a>`;
  });
  return `📲 Ми в соцмережах:\n${lines.join("\n")}`;
}

// Inserts the social-links block right before the trailing hashtags. The block is
// added between the post body and the hashtag run so hashtags stay last (the AI is
// told to end the post with them). If there are no trailing hashtags, appends.
export function injectSocialLinks(text: string, socialLinks?: string[]): string {
  const block = buildSocialBlock(socialLinks);
  if (!block) return text;
  const trimmed = text.replace(/\s+$/, "");
  const match = trimmed.match(/(?:\s*#[^\s#]+)+$/);
  if (match && match.index !== undefined && match.index > 0) {
    const body = trimmed.slice(0, match.index).replace(/\s+$/, "");
    const tail = trimmed.slice(match.index).trim();
    return `${body}\n\n${block}\n\n${tail}`;
  }
  return `${trimmed}\n\n${block}`;
}

function assertTelegramResponse(data: TelegramApiResponse, errorText: string) {
  if (!data.ok) {
    throw new Error(data.description || errorText);
  }
}

async function sendOrderButtonMessage(botToken: string, chatId: string, creds?: TelegramCredentials) {
  const replyMarkup = getReplyMarkup(creds);
  if (!replyMarkup) return null;

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: "🛒 Замовити товар:",
        reply_markup: replyMarkup,
      }),
    }
  );

  const data = (await response.json()) as TelegramApiResponse;
  assertTelegramResponse(data, "Telegram sendMessage error");

  return data.result?.message_id;
}

export async function sendTelegramMediaGroup(
  text: string,
  photoPaths: string[],
  creds?: TelegramCredentials
) {
  const botToken = process.env.BOT_TOKEN;
  const chatId = creds?.chatId;

  if (!botToken || !chatId) {
    throw new Error("Telegram не підключено. Вкажи chat_id свого каналу в Налаштуваннях.");
  }

  const photos = photoPaths.filter(Boolean).slice(0, 10);

  if (photos.length < 2) {
    throw new Error("Для media group потрібно мінімум 2 фото");
  }

  const caption = injectSocialLinks(text, creds?.socialLinks);

  const form = new FormData();

  form.append("chat_id", chatId);

  const media = photos.map((_, index) => ({
    type: "photo",
    media: `attach://photo${index}`,
    ...(index === 0
      ? {
          caption,
          parse_mode: "HTML",
        }
      : {}),
  }));

  form.append("media", JSON.stringify(media));

  photos.forEach((photoPath, index) => {
    form.append(`photo${index}`, fs.createReadStream(photoPath));
  });

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMediaGroup`,
    {
      method: "POST",
      body: form as any,
    }
  );

  const data = (await response.json()) as TelegramApiResponse;
  assertTelegramResponse(data, "Telegram sendMediaGroup error");

  const firstMessageId = data.result?.[0]?.message_id;

  // Telegram forbids inline buttons on an album (sendMediaGroup), so the contact
  // button has to be its own message right after it.
  await sendOrderButtonMessage(botToken, chatId, creds);

  return {
    chatId,
    messageId: firstMessageId,
  };
}

export async function sendTelegramMixedMediaGroup(
  text: string,
  videoPath: string,
  photoPaths: string[],
  creds?: TelegramCredentials
) {
  const botToken = process.env.BOT_TOKEN;
  const chatId = creds?.chatId;

  if (!botToken || !chatId) {
    throw new Error("Telegram не підключено. Вкажи chat_id свого каналу в Налаштуваннях.");
  }

  const photos = photoPaths.filter(Boolean).slice(0, 9);

  const caption = injectSocialLinks(text, creds?.socialLinks);

  const form = new FormData();

  form.append("chat_id", chatId);

  const media = [
    {
      type: "video",
      media: "attach://video0",
      caption,
      parse_mode: "HTML",
    },
    ...photos.map((_, index) => ({
      type: "photo",
      media: `attach://photo${index}`,
    })),
  ];

  form.append("media", JSON.stringify(media));

  form.append("video0", fs.createReadStream(videoPath));

  photos.forEach((photoPath, index) => {
    form.append(`photo${index}`, fs.createReadStream(photoPath));
  });

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMediaGroup`,
    {
      method: "POST",
      body: form as any,
    }
  );

  const data = (await response.json()) as TelegramApiResponse;
  assertTelegramResponse(data, "Telegram mixed sendMediaGroup error");

  const firstMessageId = data.result?.[0]?.message_id;

  // Album → button can't attach to it, so send it as a separate message.
  await sendOrderButtonMessage(botToken, chatId, creds);

  return {
    chatId,
    messageId: firstMessageId,
  };
}

export async function sendTelegramPost(
  text: string,
  photoPath?: string,
  videoPath?: string,
  photoPaths?: string[],
  creds?: TelegramCredentials
) {
  const botToken = process.env.BOT_TOKEN;
  const chatId = creds?.chatId;
  const replyMarkup = getReplyMarkup(creds);
  const finalText = injectSocialLinks(text, creds?.socialLinks);

  if (!botToken || !chatId) {
    throw new Error("Telegram не підключено. Вкажи chat_id свого каналу в Налаштуваннях.");
  }

  const allPhotos = photoPaths?.length
    ? photoPaths.filter(Boolean)
    : photoPath
      ? [photoPath]
      : [];

  if (videoPath && allPhotos.length > 0) {
    return sendTelegramMixedMediaGroup(text, videoPath, allPhotos, creds);
  }

  if (videoPath) {
    const form = new FormData();

    form.append("chat_id", chatId);
    form.append("video", fs.createReadStream(videoPath));
    form.append("caption", finalText);
    form.append("parse_mode", "HTML");
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendVideo`,
      {
        method: "POST",
        body: form as any,
      }
    );

    const data = (await response.json()) as TelegramApiResponse;
    assertTelegramResponse(data, "Telegram sendVideo error");

    return {
      chatId,
      messageId: data.result?.message_id,
    };
  }

  if (allPhotos.length > 1) {
    return sendTelegramMediaGroup(text, allPhotos, creds);
  }

  if (allPhotos.length === 1) {
    const form = new FormData();

    form.append("chat_id", chatId);
    form.append("photo", fs.createReadStream(allPhotos[0]));
    form.append("caption", finalText);
    form.append("parse_mode", "HTML");
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendPhoto`,
      {
        method: "POST",
        body: form as any,
      }
    );

    const data = (await response.json()) as TelegramApiResponse;
    assertTelegramResponse(data, "Telegram sendPhoto error");

    return {
      chatId,
      messageId: data.result?.message_id,
    };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: finalText,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    }
  );

  const data = (await response.json()) as TelegramApiResponse;
  assertTelegramResponse(data, "Telegram sendMessage error");

  return {
    chatId,
    messageId: data.result?.message_id,
  };
}

export async function editTelegramPost(
  text: string,
  telegramChatId: string,
  telegramMessageId: string,
  mode: "caption" | "text" = "caption",
  creds?: TelegramCredentials
) {
  const botToken = process.env.BOT_TOKEN;
  const replyMarkup = getReplyMarkup(creds);
  const finalText = injectSocialLinks(text, creds?.socialLinks);

  if (!botToken) {
    throw new Error("Немає BOT_TOKEN в .env");
  }

  const method = mode === "caption" ? "editMessageCaption" : "editMessageText";

  const payload =
    mode === "caption"
      ? {
          chat_id: telegramChatId,
          message_id: Number(telegramMessageId),
          caption: finalText,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }
      : {
          chat_id: telegramChatId,
          message_id: Number(telegramMessageId),
          text: finalText,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        };

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = (await response.json()) as TelegramApiResponse;

  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} error`);
  }

  return data.result;
}
