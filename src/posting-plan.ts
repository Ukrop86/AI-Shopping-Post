// Тижневий графік публікацій в Instagram — код-версія `POSTING_SCHEDULE.md`.
// Тримати обидва в синхроні: тут — те, за чим реально розставляється час.

export type PlanFormat = "reels" | "slideshow" | "carousel" | "story";

export const PLAN_TIMEZONE = "Europe/Kyiv";

// Слоти стрічки: 0 = неділя. Reels завжди у вечірньому слоті — це формат, який
// дає охоплення поза підписниками; карусель живе в обідньому.
type FeedSlot = { weekday: number; time: string; kind: "reels" | "carousel" };

export const FEED_SLOTS: FeedSlot[] = [
  { weekday: 1, time: "19:30", kind: "reels" },
  { weekday: 2, time: "12:30", kind: "carousel" },
  { weekday: 3, time: "19:30", kind: "reels" },
  { weekday: 4, time: "12:30", kind: "carousel" },
  { weekday: 5, time: "19:30", kind: "reels" },
  { weekday: 6, time: "12:30", kind: "carousel" },
  { weekday: 0, time: "19:30", kind: "reels" },
];

// Сторіз живуть поза слотами стрічки й не конкурують із нею за увагу.
export const STORY_TIMES = ["10:00", "19:00"];

// Reels і слайдшоу претендують на ті самі вечірні слоти — для графіка це один
// формат, різниця лише в тому, з чого зроблене відео.
export function slotKindFor(format: PlanFormat): "reels" | "carousel" | "story" {
  if (format === "story") return "story";
  return format === "carousel" ? "carousel" : "reels";
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asUtc - date.getTime();
}

/**
 * Київський настінний час → UTC. Слоти в графіку задані місцевим часом, а
 * сервер живе в UTC, і зсув змінюється двічі на рік — тому рахуємо його на
 * конкретну дату, а не прибиваємо цвяхом +2 чи +3.
 */
export function kyivTimeToUtc(year: number, month: number, day: number, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, day, hours, minutes, 0);
  let result = new Date(naive - timeZoneOffsetMs(new Date(naive), PLAN_TIMEZONE));
  // Друга ітерація ловить випадок, коли перше наближення потрапило по інший
  // бік переведення годинника.
  result = new Date(naive - timeZoneOffsetMs(result, PLAN_TIMEZONE));
  return result;
}

function kyivParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLAN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
}

export type PlanSlot = { at: Date; kind: "reels" | "carousel" | "story" };

/**
 * Генерує слоти графіка вперед у часі, починаючи з `from`. Повертає лише ті,
 * що ще попереду: минулий слот — не слот.
 */
export function generateSlots(from: Date, days: number): PlanSlot[] {
  const slots: PlanSlot[] = [];
  const startOfDay = new Date(from.getTime());

  for (let offset = 0; offset < days; offset++) {
    const cursor = new Date(startOfDay.getTime() + offset * 24 * 60 * 60_000);
    const { year, month, day } = kyivParts(cursor);
    // День тижня рахуємо за київською датою, а не за UTC-датою курсора.
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    for (const slot of FEED_SLOTS.filter((item) => item.weekday === weekday)) {
      const at = kyivTimeToUtc(year, month, day, slot.time);
      if (at.getTime() > from.getTime()) slots.push({ at, kind: slot.kind });
    }

    for (const time of STORY_TIMES) {
      const at = kyivTimeToUtc(year, month, day, time);
      if (at.getTime() > from.getTime()) slots.push({ at, kind: "story" });
    }
  }

  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}
