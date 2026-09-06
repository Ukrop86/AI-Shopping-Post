import fetch from "node-fetch";

// Instagram is connected via Facebook OAuth (Page's linked Instagram Business Account),
// so publishing must go through graph.facebook.com using that Facebook user/page token.
const GRAPH_API = "https://graph.facebook.com/v25.0";

// Publishing format for one post. "auto" keeps the historical behaviour where the
// format is derived from the uploaded media; the explicit values let the seller
// decide (a product with both a video and photos can be a Reel OR a carousel —
// the choice matters, a carousel with a video first slide never reaches the Reels feed).
export type InstagramFormat = "auto" | "reels" | "slideshow" | "carousel" | "story";

export type InstagramCreds = { userId: string; accessToken: string };

export type InstagramPublishOptions = {
  format?: InstagramFormat;
  // Vertical reel built from the product photos (см. createSlideshowReel) — the only
  // way a photo-only product can reach Reels.
  slideshowVideoUrl?: string;
  // 1080×1920 frame with the price burned in: stories carry no caption, so anything
  // the buyer must read has to be part of the image.
  storyImageUrl?: string;
};

const CONTAINER_POLL_INTERVAL_MS = 5_000;
const IMAGE_CONTAINER_TIMEOUT_MS = 2 * 60_000;
const VIDEO_CONTAINER_TIMEOUT_MS = 10 * 60_000;

export function cleanInstagramCaption(text: string) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assertPublicHttpsUrl(fileUrl: string) {
  const siteUrl = process.env.SITE_URL;

  if (!fileUrl) {
    throw new Error("Instagram потребує фото або відео для публікації");
  }

  if (!siteUrl) {
    throw new Error(
      "Instagram потребує публічний HTTPS SITE_URL. Для локального тесту використай ngrok або деплой."
    );
  }

  const parsedSiteUrl = new URL(siteUrl);
  const isLocalhost =
    parsedSiteUrl.hostname === "localhost" ||
    parsedSiteUrl.hostname === "127.0.0.1" ||
    parsedSiteUrl.hostname === "::1";

  if (parsedSiteUrl.protocol !== "https:" || isLocalhost) {
    throw new Error(
      "Instagram потребує публічний HTTPS SITE_URL. Для локального тесту використай ngrok або деплой."
    );
  }

  const absoluteFileUrl = fileUrl.startsWith("http")
    ? fileUrl
    : `${siteUrl.replace(/\/$/, "")}${fileUrl.startsWith("/") ? "" : "/"}${fileUrl}`;

  const parsedFileUrl = new URL(absoluteFileUrl);

  if (parsedFileUrl.protocol !== "https:") {
    throw new Error(
      "Instagram потребує публічний HTTPS SITE_URL. Для локального тесту використай ngrok або деплой."
    );
  }

  return absoluteFileUrl;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createInstagramMediaContainer(params: URLSearchParams, igUserId: string) {
  const createRes = await fetch(`${GRAPH_API}/${igUserId}/media`, { method: "POST", body: params });
  const data: any = await createRes.json();
  if (!createRes.ok || !data.id) {
    console.error("Instagram create error:", data);
    throw new Error(data.error?.message || "Instagram media create failed");
  }
  return data.id as string;
}

/**
 * Instagram обробляє завантажене медіа асинхронно, і публікувати контейнер можна
 * тільки після статусу FINISHED. Раніше тут стояли фіксовані паузи (60 с на Reels),
 * через що довші/важчі відео падали: пауза закінчувалась раніше за обробку.
 * Опитування статусу прибирає цю гонку — і одночасно не змушує чекати хвилину
 * там, де медіа готове за секунди.
 */
async function waitForContainerReady(
  containerId: string,
  accessToken: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const statusRes = await fetch(
      `${GRAPH_API}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`
    );
    const statusData: any = await statusRes.json();

    if (!statusRes.ok) {
      console.error("Instagram status error:", statusData);
      throw new Error(statusData.error?.message || "Instagram: не вдалося перевірити статус медіа");
    }

    const code = String(statusData.status_code || "");
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      console.error("Instagram container failed:", statusData);
      throw new Error(
        `Instagram не зміг обробити медіа (${code}): ${statusData.status || "без деталей"}`
      );
    }

    lastStatus = statusData.status || code;
    await sleep(CONTAINER_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Instagram не встиг обробити медіа за відведений час (${lastStatus || "IN_PROGRESS"}). ` +
      "Спробуй ще раз або зменш розмір відео."
  );
}

async function publishInstagramContainer(creationId: string, igUserId: string, accessToken: string) {
  const publishRes = await fetch(`${GRAPH_API}/${igUserId}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
  });
  const publishData: any = await publishRes.json();
  if (!publishRes.ok || !publishData.id) {
    console.error("Instagram publish error:", publishData);
    throw new Error(publishData.error?.message || "Instagram publish failed");
  }
  return publishData as { id: string };
}

async function publishReel(videoUrl: string, caption: string, creds: InstagramCreds) {
  const publicVideoUrl = assertPublicHttpsUrl(videoUrl);
  console.log("Instagram reel video URL:", publicVideoUrl);

  const creationId = await createInstagramMediaContainer(
    new URLSearchParams({
      media_type: "REELS",
      video_url: publicVideoUrl,
      caption,
      access_token: creds.accessToken,
    }),
    creds.userId
  );

  await waitForContainerReady(creationId, creds.accessToken, VIDEO_CONTAINER_TIMEOUT_MS);
  return publishInstagramContainer(creationId, creds.userId, creds.accessToken);
}

async function publishSinglePhoto(imageUrl: string, caption: string, creds: InstagramCreds) {
  const publicImageUrl = assertPublicHttpsUrl(imageUrl);
  console.log("Instagram image URL:", publicImageUrl);

  const creationId = await createInstagramMediaContainer(
    new URLSearchParams({
      image_url: publicImageUrl,
      caption,
      access_token: creds.accessToken,
    }),
    creds.userId
  );

  await waitForContainerReady(creationId, creds.accessToken, IMAGE_CONTAINER_TIMEOUT_MS);
  return publishInstagramContainer(creationId, creds.userId, creds.accessToken);
}

async function publishCarousel(
  images: string[],
  caption: string,
  creds: InstagramCreds,
  videoUrl?: string
) {
  const children: string[] = [];

  // Instagram не змішує Reels і фото в одному дописі — відео стає першим
  // слайдом каруселі. Така карусель не потрапляє в стрічку Reels, тому це
  // свідомий вибір продавця (формат "auto"), а не спосіб отримати охоплення.
  if (videoUrl) {
    const publicVideoUrl = assertPublicHttpsUrl(videoUrl);
    console.log("Instagram carousel video URL:", publicVideoUrl);
    children.push(
      await createInstagramMediaContainer(
        new URLSearchParams({
          media_type: "VIDEO",
          video_url: publicVideoUrl,
          is_carousel_item: "true",
          access_token: creds.accessToken,
        }),
        creds.userId
      )
    );
  }

  for (const image of images.slice(0, videoUrl ? 9 : 10)) {
    const publicImageUrl = assertPublicHttpsUrl(image);
    console.log("Instagram carousel image URL:", publicImageUrl);
    children.push(
      await createInstagramMediaContainer(
        new URLSearchParams({
          image_url: publicImageUrl,
          is_carousel_item: "true",
          access_token: creds.accessToken,
        }),
        creds.userId
      )
    );
  }

  for (const childId of children) {
    await waitForContainerReady(
      childId,
      creds.accessToken,
      videoUrl ? VIDEO_CONTAINER_TIMEOUT_MS : IMAGE_CONTAINER_TIMEOUT_MS
    );
  }

  const carouselId = await createInstagramMediaContainer(
    new URLSearchParams({
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
      access_token: creds.accessToken,
    }),
    creds.userId
  );

  await waitForContainerReady(carouselId, creds.accessToken, IMAGE_CONTAINER_TIMEOUT_MS);
  return publishInstagramContainer(carouselId, creds.userId, creds.accessToken);
}

/**
 * Сторіз. Підпису в сторіз немає — текст має бути запечений у сам кадр
 * (див. createStoryFrame). Інтерактивні наліпки (опитування, посилання,
 * локація, музика) через API недоступні взагалі — тільки вручну в застосунку.
 */
export async function publishInstagramStory(
  mediaUrl: string,
  creds: InstagramCreds,
  isVideo = false
) {
  const publicMediaUrl = assertPublicHttpsUrl(mediaUrl);
  console.log("Instagram story URL:", publicMediaUrl);

  const creationId = await createInstagramMediaContainer(
    new URLSearchParams({
      media_type: "STORIES",
      ...(isVideo ? { video_url: publicMediaUrl } : { image_url: publicMediaUrl }),
      access_token: creds.accessToken,
    }),
    creds.userId
  );

  await waitForContainerReady(
    creationId,
    creds.accessToken,
    isVideo ? VIDEO_CONTAINER_TIMEOUT_MS : IMAGE_CONTAINER_TIMEOUT_MS
  );
  return publishInstagramContainer(creationId, creds.userId, creds.accessToken);
}

export async function publishInstagramPost(
  imageUrl: string | undefined,
  caption: string,
  videoUrl?: string,
  imageUrls: string[] = [],
  creds?: InstagramCreds,
  options: InstagramPublishOptions = {}
) {
  if (!creds?.userId || !creds?.accessToken) {
    throw new Error(
      "Instagram не підключено. Відкрий Налаштування → вкладка Instagram → Підключити Instagram."
    );
  }

  const cleanCaption = cleanInstagramCaption(caption);
  const allImages = imageUrls.length > 0 ? imageUrls.filter(Boolean) : imageUrl ? [imageUrl] : [];
  const format: InstagramFormat = options.format || "auto";

  if (format === "reels") {
    if (!videoUrl) {
      throw new Error(
        "Формат Reels потребує відео товару. Завантаж відео або обери «Слайдшоу з фото»."
      );
    }
    return publishReel(videoUrl, cleanCaption, creds);
  }

  if (format === "slideshow") {
    if (!options.slideshowVideoUrl) {
      throw new Error(
        "Слайдшоу ще не зібрано. Натисни «Зібрати слайдшоу» у вкладці Instagram перед публікацією."
      );
    }
    return publishReel(options.slideshowVideoUrl, cleanCaption, creds);
  }

  if (format === "carousel") {
    if (!allImages.length) {
      throw new Error("Формат каруселі потребує фото товару");
    }
    return allImages.length > 1
      ? publishCarousel(allImages, cleanCaption, creds)
      : publishSinglePhoto(allImages[0], cleanCaption, creds);
  }

  if (format === "story") {
    const storyUrl = options.storyImageUrl || allImages[0] || videoUrl;
    if (!storyUrl) {
      throw new Error("Для сторіз потрібне фото або відео товару");
    }
    const isVideo = !options.storyImageUrl && !allImages.length;
    return publishInstagramStory(storyUrl, creds, isVideo);
  }

  // format === "auto" — формат виводиться з набору медіа (історична поведінка).
  if (videoUrl && allImages.length > 0) {
    return publishCarousel(allImages, cleanCaption, creds, videoUrl);
  }
  if (videoUrl) {
    return publishReel(videoUrl, cleanCaption, creds);
  }
  if (allImages.length > 1) {
    return publishCarousel(allImages, cleanCaption, creds);
  }
  if (allImages.length === 1) {
    return publishSinglePhoto(allImages[0], cleanCaption, creds);
  }

  throw new Error("Instagram потребує фото або відео товару для публікації");
}
