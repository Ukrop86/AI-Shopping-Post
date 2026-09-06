import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import type { VideoTextOverlay } from "./ai-generator";

const execFileAsync = promisify(execFile);

// Шрифт відносно кореня проекту. На Windows ffmpeg приймає forward slashes.
const FONT_PATH = path
  .join(__dirname, "../fonts/Arial-Bold.ttf")
  .replace(/\\/g, "/");
const HAS_FONT = fsSync.existsSync(FONT_PATH);

export type VideoStyle = "minimal" | "fashion" | "premium" | "sale";

export type VideoOverlayInput = {
  inputPath: string;
  uploadsDir: string;
  videoTexts?: VideoTextOverlay[];
  videoStyle?: VideoStyle;
};

type VideoStyleConfig = {
  fontColor: string;
  boxColor: string;
  borderColor: string;
  borderWidth: number;
  boxBorderWidth: number;
  topPrefix?: string;
  centerPrefix?: string;
  bottomPrefix?: string;
};

const VIDEO_STYLES: Record<VideoStyle, VideoStyleConfig> = {
  minimal: {
    fontColor: "white",
    boxColor: "black@0.35",
    borderColor: "white@0.25",
    borderWidth: 1,
    boxBorderWidth: 14,
  },
  fashion: {
    fontColor: "black",
    boxColor: "white@0.88",
    borderColor: "white@0.95",
    borderWidth: 2,
    boxBorderWidth: 18,
    // Без emoji — ffmpeg не рендерить їх без спеціального шрифту
    topPrefix: "",
    centerPrefix: "",
    bottomPrefix: "",
  },
  premium: {
    fontColor: "white",
    boxColor: "black@0.62",
    borderColor: "gold@0.9",
    borderWidth: 2,
    boxBorderWidth: 20,
    topPrefix: "PREMIUM  ",
    centerPrefix: "",
    bottomPrefix: "",
  },
  sale: {
    fontColor: "white",
    boxColor: "red@0.78",
    borderColor: "white@0.95",
    borderWidth: 3,
    boxBorderWidth: 20,
    topPrefix: "SALE  ",
    centerPrefix: "",
    bottomPrefix: "",
  },
};

async function getVideoSize(inputPath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    inputPath,
  ]);

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];

  return {
    width: Number(stream?.width || 720),
    height: Number(stream?.height || 1280),
  };
}

function wrapText(text: string, maxLineLength: number) {
  if (text.length <= maxLineLength) {
    return text;
  }

  return text.slice(0, maxLineLength);
}

function safeText(text: string, videoWidth: number) {
  const cleaned = text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ")
    .trim();

  const maxLineLength = Math.max(8, Math.floor(videoWidth / 28));

  return wrapText(cleaned, maxLineLength);
}

function getY(position: VideoTextOverlay["position"]) {
  // top: нижче верхнього edge (safe zone)
  if (position === "top") return "h*0.10";
  if (position === "center") return "(h-text_h)/2";
  // bottom: вище UI-елементів Instagram/TikTok (safe zone ~80%)
  return "h*0.76";
}

function getFontSize(
  position: VideoTextOverlay["position"],
  videoWidth: number,
  style: VideoStyle
) {
  const scale = Math.max(0.65, Math.min(1.25, videoWidth / 720));

  const styleBoost = style === "sale" ? 1.12 : style === "premium" ? 1.04 : 1;

  if (position === "center") return Math.round(48 * scale * styleBoost);
  if (position === "bottom") return Math.round(38 * scale * styleBoost);
  return Math.round(42 * scale * styleBoost);
}

function normalizeVideoTexts(videoTexts?: VideoTextOverlay[]): VideoTextOverlay[] {
  if (!videoTexts?.length) {
    return [
      {
        text: "Новинка",
        start: 0,
        end: 2.5,
        position: "top",
      },
      {
        text: "Пиши в Direct",
        start: 5,
        end: 8,
        position: "bottom",
      },
    ];
  }

  return videoTexts
    .filter((item) => item.text && item.start >= 0 && item.end > item.start)
    .slice(0, 5)
    .map((item) => ({
      text: String(item.text).slice(0, 22),
      start: Number(item.start),
      end: Number(item.end),
      position: ["top", "center", "bottom"].includes(item.position)
        ? item.position
        : "center",
    }));
}

function getTextPrefix(
  position: VideoTextOverlay["position"],
  styleConfig: VideoStyleConfig
) {
  if (position === "top") return styleConfig.topPrefix || "";
  if (position === "center") return styleConfig.centerPrefix || "";
  return styleConfig.bottomPrefix || "";
}

function buildDrawTextFilter(
  item: VideoTextOverlay,
  videoWidth: number,
  style: VideoStyle
) {
  const styleConfig = VIDEO_STYLES[style];
  const prefix = getTextPrefix(item.position, styleConfig);
  const text = safeText(`${prefix}${item.text}`, videoWidth);
  const y = getY(item.position);
  const fontSize = getFontSize(item.position, videoWidth, style);

  const parts = [`drawtext=text='${text}'`];
  if (HAS_FONT) parts.push(`fontfile='${FONT_PATH}'`);
  parts.push(
    `fontcolor=${styleConfig.fontColor}`,
    `fontsize=${fontSize}`,
    `box=1`,
    `boxcolor=${styleConfig.boxColor}`,
    `boxborderw=${styleConfig.boxBorderWidth}`,
    `borderw=${styleConfig.borderWidth}`,
    `bordercolor=${styleConfig.borderColor}`,
    `x=(w-text_w)/2`,
    `y=${y}`,
    `line_spacing=10`,
    `enable='between(t,${item.start},${item.end})'`
  );
  return parts.join(":");
}

export async function createReelsStyleVideo(input: VideoOverlayInput) {
  await fs.mkdir(input.uploadsDir, { recursive: true });

  const outputName = `processed-${Date.now()}.mp4`;
  const outputPath = path.join(input.uploadsDir, outputName);

  const videoSize = await getVideoSize(input.inputPath);
  const texts = normalizeVideoTexts(input.videoTexts);

  const videoStyle: VideoStyle = input.videoStyle || "fashion";

  const filters = texts.map((item) =>
    buildDrawTextFilter(item, videoSize.width, videoStyle)
  );

  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    input.inputPath,
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    // Обов'язково для Instagram/TikTok — без цього відео можуть відхилити
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  return {
    outputPath,
    outputName,
    videoStyle,
  };
}

export function filePathToPublicUrl(filePath: string) {
  const baseUrl = process.env.PUBLIC_BASE_URL;

  if (!baseUrl) {
    throw new Error("PUBLIC_BASE_URL missing");
  }

  const fileName = path.basename(filePath);

  return `${baseUrl.replace(/\/$/, "")}/uploads/${fileName}`;
}
// ── Slideshow Reels (фото → вертикальне відео) ───────────────────────────────
// Товари без відеозйомки інакше не потрапляють у Reels взагалі — а Reels це
// єдиний формат, що дає охоплення поза підписниками. Тут з фото товару
// збирається вертикальний ролик 1080×1920 з повільним зумом і перетинами,
// поверх якого лягає той самий текстовий оверлей, що й на звичайних Reels.

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;
const SLIDESHOW_FPS = 30;
const SLIDESHOW_XFADE_SEC = 0.5;
const MAX_SLIDESHOW_PHOTOS = 6;

export type SlideshowReelInput = {
  photoPaths: string[];
  uploadsDir: string;
  videoTexts?: VideoTextOverlay[];
  videoStyle?: VideoStyle;
  secondsPerPhoto?: number;
};

export async function createSlideshowReel(input: SlideshowReelInput) {
  const photos = input.photoPaths
    .filter((photoPath) => photoPath && fsSync.existsSync(photoPath))
    .slice(0, MAX_SLIDESHOW_PHOTOS);

  if (!photos.length) {
    throw new Error("Для слайдшоу потрібне хоча б одне фото товару");
  }

  await fs.mkdir(input.uploadsDir, { recursive: true });

  const secondsPerPhoto = Math.min(4, Math.max(2, input.secondsPerPhoto || 2.6));
  const xfade = photos.length > 1 ? SLIDESHOW_XFADE_SEC : 0;
  const totalDuration = photos.length * secondsPerPhoto - (photos.length - 1) * xfade;
  const videoStyle: VideoStyle = input.videoStyle || "fashion";

  const outputName = `slideshow-${Date.now()}.mp4`;
  const outputPath = path.join(input.uploadsDir, outputName);

  const args: string[] = ["-y"];
  for (const photo of photos) {
    args.push(
      "-framerate", String(SLIDESHOW_FPS),
      "-loop", "1",
      "-t", String(secondsPerPhoto),
      "-i", photo
    );
  }
  // Мовчазна аудіодоріжка: відео зовсім без аудіопотоку частина клієнтів
  // (у т.ч. завантаження в Reels) обробляє непередбачувано.
  args.push(
    "-f", "lavfi",
    "-t", String(totalDuration),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"
  );

  const chains: string[] = [];
  photos.forEach((_, index) => {
    chains.push(
      `[${index}:v]scale=${REEL_WIDTH}:${REEL_HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1,fps=${SLIDESHOW_FPS},` +
        // d=1 — zoompan накопичує zoom по кадрах вхідного зображення, тож
        // тривалість кадру задає -t на вході, а не параметр d.
        `zoompan=z='min(zoom+0.0008,1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
        `s=${REEL_WIDTH}x${REEL_HEIGHT}:fps=${SLIDESHOW_FPS},format=yuv420p[v${index}]`
    );
  });

  let lastLabel = "v0";
  for (let index = 1; index < photos.length; index++) {
    const offset = (secondsPerPhoto - xfade) * index;
    const label = `x${index}`;
    chains.push(
      `[${lastLabel}][v${index}]xfade=transition=fade:duration=${xfade}:` +
        `offset=${offset.toFixed(2)}[${label}]`
    );
    lastLabel = label;
  }

  const texts = normalizeVideoTexts(input.videoTexts)
    .filter((item) => item.start < totalDuration)
    .map((item) => ({ ...item, end: Math.min(item.end, totalDuration) }));
  const drawFilters = texts.map((item) =>
    buildDrawTextFilter(item, REEL_WIDTH, videoStyle)
  );
  if (drawFilters.length) {
    chains.push(`[${lastLabel}]${drawFilters.join(",")}[out]`);
    lastLabel = "out";
  }

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", `[${lastLabel}]`,
    "-map", `${photos.length}:a`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    // Обов'язково для Instagram/TikTok — без цього відео можуть відхилити
    "-pix_fmt", "yuv420p",
    "-r", String(SLIDESHOW_FPS),
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath
  );

  await execFileAsync("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });

  return {
    outputPath,
    outputName,
    videoStyle,
    photosUsed: photos.length,
    durationSec: Number(totalDuration.toFixed(2)),
  };
}

// ── Кадр для Stories ─────────────────────────────────────────────────────────
// У сторіз немає підпису, тому все, що має прочитати покупець (назва, ціна),
// треба запікати в саме зображення. Заразом приводимо фото будь-яких пропорцій
// до 9:16, щоб Instagram не додавав власні поля.

export type StoryFrameInput = {
  inputPath: string;
  uploadsDir: string;
  overlayText?: string;
  videoStyle?: VideoStyle;
};

export async function createStoryFrame(input: StoryFrameInput) {
  if (!fsSync.existsSync(input.inputPath)) {
    throw new Error("Фото для сторіз не знайдено");
  }

  await fs.mkdir(input.uploadsDir, { recursive: true });

  const videoStyle: VideoStyle = input.videoStyle || "fashion";
  const outputName = `story-${Date.now()}.jpg`;
  const outputPath = path.join(input.uploadsDir, outputName);

  const overlay = input.overlayText?.trim()
    ? buildDrawTextFilter(
        { text: input.overlayText.trim(), start: 0, end: 1, position: "bottom" },
        REEL_WIDTH,
        videoStyle
      )
    : "";

  const chains = [
    `[0:v]scale=${REEL_WIDTH}:${REEL_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${REEL_WIDTH}:${REEL_HEIGHT},boxblur=20:3,eq=brightness=-0.06[bg]`,
    `[0:v]scale=${REEL_WIDTH}:${REEL_HEIGHT}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${overlay ? `,${overlay}` : ""}[out]`,
  ];

  await execFileAsync("ffmpeg", [
    "-y",
    "-i", input.inputPath,
    "-filter_complex", chains.join(";"),
    "-map", "[out]",
    "-frames:v", "1",
    "-q:v", "3",
    outputPath,
  ]);

  return { outputPath, outputName };
}

// ── Зображення під вимоги Instagram ──────────────────────────────────────────
// Instagram приймає для стрічки ТІЛЬКИ JPEG і тільки зі співвідношенням сторін
// від 4:5 до 1.91:1 (плюс ліміт 8 МБ). PNG/WEBP/HEIC і будь-яке вертикальне фото
// вище за 4:5 — а це звичайне фото з телефона — Graph API просто відхиляє.
// Тому для Instagram готуємо окрему копію: формат приводимо до JPEG, а зайву
// висоту добиваємо розмитим фоном, а не обрізаємо (обрізка з'їдає взуття й голову).

const IG_MIN_RATIO = 0.8; // 4:5
const IG_MAX_RATIO = 1.91; // 1.91:1
const IG_MAX_WIDTH = 1440;
const IG_MIN_WIDTH = 320;
const IG_MAX_BYTES = 8 * 1024 * 1024;

async function probeImage(inputPath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name",
    "-of", "json",
    inputPath,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  return {
    width: Number(stream?.width || 0),
    height: Number(stream?.height || 0),
    codec: String(stream?.codec_name || ""),
  };
}

export type InstagramImageInput = {
  inputPath: string;
  uploadsDir: string;
  index?: number;
  // Напис, який треба запекти у фото (перший і останній слайди каруселі).
  // Якщо він заданий, копія робиться завжди — навіть коли оригінал і так
  // відповідає вимогам Instagram.
  overlayText?: string;
  videoStyle?: VideoStyle;
  // Точні пропорції, до яких треба привести кадр. Потрібні для каруселі:
  // Instagram обрізає ВСІ слайди під співвідношення першого, тож різні
  // пропорції всередині однієї каруселі означають зрізані боки на решті кадрів.
  targetRatio?: number;
};

export async function imageAspectRatio(filePath: string) {
  const image = await probeImage(filePath);
  if (!image.width || !image.height) throw new Error("Не вдалося прочитати розміри фото");
  return image.width / image.height;
}

export function clampInstagramRatio(ratio: number) {
  return Math.min(IG_MAX_RATIO, Math.max(IG_MIN_RATIO, ratio));
}

/**
 * Повертає null, якщо фото вже відповідає вимогам Instagram — тоді публікуємо
 * оригінал і не плодимо зайвих файлів на диску.
 */
export async function createInstagramImage(input: InstagramImageInput) {
  if (!fsSync.existsSync(input.inputPath)) {
    throw new Error("Фото не знайдено");
  }

  const { size } = await fs.stat(input.inputPath);
  const image = await probeImage(input.inputPath);

  if (!image.width || !image.height) {
    throw new Error("Не вдалося прочитати розміри фото");
  }

  const ratio = image.width / image.height;
  const isJpeg = image.codec === "mjpeg";
  const target = input.targetRatio ? clampInstagramRatio(input.targetRatio) : null;
  const ratioOk = target
    ? Math.abs(ratio - target) < 0.005
    : ratio >= IG_MIN_RATIO && ratio <= IG_MAX_RATIO;

  const overlayText = input.overlayText?.trim();

  if (!overlayText && isJpeg && ratioOk && size <= IG_MAX_BYTES && image.width <= IG_MAX_WIDTH) {
    return null;
  }

  let width = image.width;
  let height = image.height;

  // Без targetRatio правимо лише вихід за дозволені межі; з ним — доводимо
  // кадр рівно до потрібних пропорцій. В обох випадках добиваємо полями,
  // а не обрізаємо: обрізка з'їдає взуття й голову.
  const wanted = target ?? clampInstagramRatio(ratio);
  if (ratio < wanted) {
    width = Math.ceil(height * wanted);
  } else if (ratio > wanted) {
    height = Math.ceil(width / wanted);
  }

  if (width > IG_MAX_WIDTH) {
    height = Math.round((height * IG_MAX_WIDTH) / width);
    width = IG_MAX_WIDTH;
  }
  if (width < IG_MIN_WIDTH) {
    height = Math.round((height * IG_MIN_WIDTH) / width);
    width = IG_MIN_WIDTH;
  }

  await fs.mkdir(input.uploadsDir, { recursive: true });
  const outputName = `ig-${Date.now()}-${input.index ?? 0}.jpg`;
  const outputPath = path.join(input.uploadsDir, outputName);

  const overlay = overlayText
    ? buildDrawTextFilter(
        { text: overlayText, start: 0, end: 1, position: "bottom" },
        width,
        input.videoStyle || "fashion"
      )
    : "";

  const chains = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},boxblur=20:3[bg]`,
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${overlay ? `,${overlay}` : ""}[out]`,
  ];

  const render = async (quality: number) => {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", input.inputPath,
      "-filter_complex", chains.join(";"),
      "-map", "[out]",
      "-frames:v", "1",
      "-q:v", String(quality),
      outputPath,
    ]);
    return (await fs.stat(outputPath)).size;
  };

  // 8 МБ на такій ширині майже недосяжні, але дешевше перестрахуватись, ніж
  // отримати відмову Graph API вже під час публікації за розкладом.
  if ((await render(3)) > IG_MAX_BYTES) {
    await render(8);
  }

  return { outputPath, outputName, width, height };
}

// ── HEIC/HEIF (фото з iPhone) ────────────────────────────────────────────────
// ffmpeg у нашому образі HEIF-контейнер не демуксить узагалі («moov atom not
// found»), тому такі фото не пройдуть ні в Instagram, ні деінде. Декодуємо їх
// через heif-convert (libheif-examples, стоїть у Dockerfile), а ffmpeg лишаємо
// запасним варіантом на випадок новішого збирання, яке HEIF уже вміє.

const HEIF_BRANDS = new Set([
  "heic", "heix", "heim", "heis", "hevc", "hevm", "hevs", "mif1", "msf1", "avif", "avis",
]);

/**
 * Визначає HEIC/HEIF/AVIF за сигнатурою файлу, а не за розширенням чи
 * mime-типом від клієнта — браузери й застосунки регулярно позначають такі
 * фото як image/jpeg.
 */
export async function isHeifImage(filePath: string) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 12) return false;
    if (buffer.toString("latin1", 4, 8) !== "ftyp") return false;
    return HEIF_BRANDS.has(buffer.toString("latin1", 8, 12).toLowerCase());
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export async function convertHeifToJpeg(inputPath: string, uploadsDir: string) {
  await fs.mkdir(uploadsDir, { recursive: true });

  // Суфікс обов'язковий: HEIC часто приходить із розширенням .jpg (браузери
  // й застосунки постійно так роблять), і без нього шлях виходу збігся б зі
  // шляхом входу — конвертер писав би у файл, який сам читає, а виклик згори
  // потім видалив би єдину копію фото.
  const outputName = `${path.parse(inputPath).name}-heic.jpg`;
  const outputPath = path.join(uploadsDir, outputName);

  try {
    await execFileAsync("heif-convert", ["-q", "92", inputPath, outputPath]);
    return { outputPath, outputName };
  } catch (heifError) {
    console.error("heif-convert failed, trying ffmpeg:", heifError);
    try {
      await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-q:v", "2", outputPath]);
      return { outputPath, outputName };
    } catch (ffmpegError) {
      await fs.rm(outputPath, { force: true });
      throw new Error(
        "Не вдалося прочитати фото у форматі HEIC. " +
          "На iPhone: Налаштування → Камера → Формати → «Найсумісніший», або збережи фото як JPEG."
      );
    }
  }
}

/**
 * Фото, яке не читає ffprobe, не прочитає й жодна платформа. Ловимо це на
 * завантаженні, щоб товар не створювався з непридатним фото, а продавець не
 * дізнавався про проблему з провалу публікації.
 */
export async function isReadableImage(filePath: string) {
  try {
    const image = await probeImage(filePath);
    return image.width > 0 && image.height > 0;
  } catch {
    return false;
  }
}
