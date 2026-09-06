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
