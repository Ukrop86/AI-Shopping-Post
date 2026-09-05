import { publishInstagramPost } from "../instagram";
import { sendTelegramPost } from "../telegram";
import { publishFacebookPost } from "../facebook";
import { publishToShafa, mapProductToShafa, ShafaSessionExpiredError, shafaSessionPathForUser, shafaDebugPrefixForUser } from "../shafa";
import { publishTikTokVideo, publishTikTokPhotos } from "../tiktok";
import { publishPromPost } from "../prom";
import { publishOlxPost } from "../olx";
import { publishRozetkaPost } from "../rozetka";
import { publishKastaPost } from "../kasta";
import { SHAFA_COLORS } from "../shafa/shafa.types";
import { PlatformId, ProductInput, PublishingPlatform } from "../platform-types";

const bannedPhrases = `
- "must have";
- "виглядає дорого";
- "без зайвих деталей";
- "збирає погляди";
- "база гардеробу";
- "на всі випадки життя";
- "ідеально під все";
- "тренд сезону";
- "родзинка образу".
`;

function productFacts(product: ProductInput) {
  return `
Назва: ${product.title || "не вказано"}
Модель/артикул: ${product.model || "не вказано"}
Ціна: ${product.price || "не вказано"}
Дроп ціна: ${product.dropPrice || "не вказано"}
Розміри: ${product.sizes || "не вказано"}
Кольори: ${product.colors || "не вказано"}
Тканина/матеріал: ${product.fabric || "не вказано"}
Додатковий опис: ${product.description || "не вказано"}
`.trim();
}

function shopContext(product?: ProductInput) {
  const name = product?.shopName || process.env.SHOP_NAME || "";
  const desc = product?.shopDescription || process.env.SHOP_DESCRIPTION || "магазину жіночого одягу";
  const lang = product?.shopLanguage || process.env.SHOP_LANGUAGE || "uk";
  const shopLabel = name ? `магазину «${name}» (${desc})` : desc;
  const langRule = lang === "ru"
    ? "Пиши тільки російською мовою."
    : lang === "en"
      ? "Write only in English."
      : "Пиши тільки українською мовою.";
  return { shopLabel, langRule };
}

function commonRules(product: ProductInput) {
  const { shopLabel, langRule } = shopContext(product);
  return `
Ти — SMM-копірайтер для живого ${shopLabel}.

Дані товару:
${productFacts(product)}

Фото товару додані як візуальний контекст. Використовуй їх обережно: можна врахувати загальне враження, але не вигадуй тканину, склад, розміри, кольори, модель чи інші характеристики, якщо цього немає у текстових даних.

Загальні правила:
- ${langRule}
- Не використовуй англійські фрази.
- Не використовуй ці фрази:
${bannedPhrases}
- Не вигадуй характеристик, яких немає в даних.
- Не перебільшуй і не роби шаблонний рекламний текст.
- Пиши природно для ${shopLabel}.
`.trim();
}

export const telegramPlatform: PublishingPlatform = {
  id: "telegram",
  name: "Telegram",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Створи готовий пост для Telegram.

Правила Telegram:
- Можна використовувати HTML Telegram.
- Дозволені тільки теги <b>, <i>, <u>, <s>, <code>.
- Не використовуй markdown.
- Не використовуй <br>, <p>, <div>, <span>, <ul>, <li>.
- Для нового рядка використовуй звичайний перенос рядка.
- Не додавай посилання і не згадуй кнопку замовлення.

Емодзі (обов'язково, сучасні й доречні до товару):
- Перед назвою постав доречний емодзі (наприклад 👗, 🧥, 👚 — за типом товару).
- У КІНЦІ назви ОБОВ'ЯЗКОВО постав емодзі + знак оклику (наприклад "...🔥!" або "...✨!"). Це правило порушувати не можна.
- Перед ціною постав емодзі (💰 або 💵), перед дроп-ціною — 🔥 або 🏷 (щоб виділити вигоду).
- Перед характеристиками (розміри, кольори, тканина) став доречні емодзі (📏 розміри, 🎨 кольори, 🧵 тканина).
- Перед закликом до замовлення — доречний емодзі (🛒, 📩, 👇).
- Не перевантажуй: 1 емодзі на рядок/пункт, не став кілька підряд.

Структура:
1. Короткий заголовок: емодзі + назва + емодзі + знак оклику в кінці.
2. Продаючий опис.
3. Характеристики (з емодзі перед кожною).
4. Ціна / дроп ціна (з емодзі).
5. Заклик до замовлення без фраз "пишіть в дірект" і "для замовлення звертайтесь".
6. 3-5 релевантних українських хештегів.

Поверни тільки готовий текст поста.
`.trim();
  },
  async publish({ text, photoPaths, videoPath, extras }) {
    const creds = (extras?.userTokens as any)?.telegram;
    const result = await sendTelegramPost(
      text,
      photoPaths[0],
      videoPath,
      photoPaths,
      creds
    );

    return {
      externalChatId: result.chatId,
      externalPostId: String(result.messageId),
      raw: result,
    };
  },
};

export const instagramPlatform: PublishingPlatform = {
  id: "instagram",
  name: "Instagram",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Створи готовий пост для Instagram.

Правила Instagram:
- Без HTML і markdown.
- Текст коротший, теплий і емоційний, але без перебільшень.
- Використовуй нормальні абзаци.
- CTA без "пишіть в дірект", якщо це не вказано користувачем.
- 5-10 релевантних українських хештегів.
- Не використовуй англійські фрази.

Поверни тільки готовий текст поста.
`.trim();
  },
  async publish({ text, imageUrls, videoUrl, extras }) {
    if (!videoUrl && !imageUrls[0]) {
      throw new Error("Instagram потребує фото або відео товару для публікації");
    }
    const creds = (extras?.userTokens as any)?.instagram;
    const result = await publishInstagramPost(imageUrls[0], text, videoUrl, imageUrls, creds);
    return { externalPostId: result.id, raw: result };
  },
};

export const facebookPlatform: PublishingPlatform = {
  id: "facebook",
  name: "Facebook",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Створи готовий пост для Facebook-сторінки.

Правила Facebook:
- Без HTML і markdown.
- Текст природний, короткий і зрозумілий.
- Можна трохи тепліше, ніж Instagram, але без перебільшень.
- Використовуй нормальні абзаци.
- Додай короткий CTA.
- 5-8 релевантних українських хештегів.
- Не використовуй англійські фрази.

Поверни тільки готовий текст поста.
`.trim();
  },
  async publish({ text, imageUrls, videoUrl, videoPath, extras }) {
    if (!videoUrl && !imageUrls[0]) {
      throw new Error("Facebook потребує фото або відео товару для публікації");
    }
    const creds = (extras?.userTokens as any)?.facebook;
    const result = await publishFacebookPost(imageUrls[0], text, videoUrl, videoPath, imageUrls, creds);

    return {
      externalPostId: result.id || result.post_id,
      raw: result,
    };
  },
};

function createFuturePlatform(id: PlatformId, name: string): PublishingPlatform {
  return {
    id,
    name,
    supportsPublishing: false,
    generatePrompt(product) {
      return `
${commonRules(product)}

Підготуй чернетку товарного поста для платформи ${name}. Не вигадуй дані, пиши природно, додай короткий CTA і релевантні українські хештеги, якщо це доречно для платформи.
`.trim();
    },
    async publish() {
      throw new Error(`${name} ще не підключено для публікації`);
    },
  };
}

export const shafaPlatform: PublishingPlatform = {
  id: "shafa",
  name: "Shafa.ua",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Ти заповнюєш картку товару для маркетплейсу Shafa.ua. Поверни ТІЛЬКИ валідний JSON без markdown і без пояснень.

НАЗВА (title):
- Довжина РІВНО 145-148 символів — після генерації ПОРАХУЙ символи і підкоригуй якщо треба
- Обовʼязково: фасон/силует, довжину виробу, матеріал (якщо відомий), колір
- Вкажи акцент якщо є: рукава-буфи, рукава-ліхтарики, широкі рукави, волани, рюші, складки, відкриті плечі, корсетний верх
- Якщо розміри батал (XL+, XXL+, 3XL+, 50+) — вкажи "великий розмір" або "батал"
- Якщо це трендова річ — додай "тренд"
- Назва має максимально охопити пошукові запити покупця

ОПИС (description):
- Мінімум 6-8 речень, розгорнутий і детальний
- Опиши: силует і посадку, відчуття тканини, для яких подій підходить, як поєднувати, догляд за виробом (якщо відомо), чому варто обрати саме цю річ
- Природна мова, без кліше, без хештегів і emoji

КЛЮЧОВІ СЛОВА (keywords):
- Масив мінімум 25-30 слів/фраз — чим більше, тим краще
- Порядок: кольори → фасони → силует → тип пошиття → акценти → тип рукава → матеріал → сезони → події → стиль → тип принту
- Якщо батал — включи "великий розмір", "батал", "plus size"
- Включи синоніми і варіанти написання популярних запитів

КОЛЬОРИ (colors):
- Масив з 1-2 кольорів ТІЛЬКИ з цього списку:
${JSON.stringify([...SHAFA_COLORS])}

РОЗМІРИ (sizes):
- Масив з 2-4 підходящих розмірів із цього списку: "XХS","ХS","S","M","L","XL","XXL","XXXL","4XL","5XL","XXS-XS","XS-S","S-M","M-L","L-XL","XL-XXL","One size"
- Базуйся на даних товару, якщо не вказано — вибери S, M, L

СЕЗОНИ (seasons):
- Масив із: "Весна", "Демісезон", "Зима", "Літо", "Осінь"
- Будь щедрим: літня → ["Літо","Весна","Демісезон"]; зимова → ["Зима","Осінь","Демісезон"]

ДОВЖИНА РУКАВА (sleeveLength):
- ТІЛЬКИ одне з: "Без рукавів", "Довгий", "Короткий", "Три чверті", або null

ФАСОН РУКАВА (sleeveStyle):
- Масив із: "Рукави буфи", "Рукави ліхтарики", "Широкі рукави"
- [] якщо рукав звичайний або відсутній

ОСОБЛИВОСТІ (features):
- Масив із: "Великі розміри", "Коктейльні", "На випускний", "Пишні"
- [] якщо не підходить

МАТЕРІАЛИ (materials):
- Масив матеріалів з опису товару; [] якщо невідомо

СИЛУЕТ (silhouette) — вибір з переліку:
- Масив значень. Точні назви: "Вільні", "З відкритими плечима", "З відкритою спиною", "Обтислі", "Оверсайз", "Приталені", "Прямі", "Розкльошені", "Трапеція"
- Вибери все що підходить до виробу на фото

ФАСОН (fashionCut) — вибір з переліку (для категорії Плаття):
- Масив. Точні назви: "На запах", "Плаття-гольф", "Плаття-кімоно", "Плаття-комбінезон", "Плаття-майка", "Плаття-піджак", "Плаття-поло", "Плаття-светр", "Плаття-сорочка", "Плаття-трапеція", "Плаття-туніка", "Плаття-футболка", "Плаття-футляр", "Плаття-халат", "Плаття-худі"
- Вибери відповідно до виробу

ПРИНТ (print) — вибір з переліку:
- Масив ТІЛЬКИ якщо є реальний принт. Точні назви: "Квітковий", "У горох", "У смужку", "У клітинку", "Абстракція", "Тваринний", "Геометричний", "Зебра", "Леопардовий", "Камуфляж", "Малюнок", "Напис", "Аніме", "Новорічний", "Український"
- [] якщо виріб ОДНОТОННИЙ — не вказуй нічого

СТИЛЬ (style) — вибір з переліку:
- Масив підходящих стилів. ТІЛЬКИ ці точні назви (ніяких англійських слів типу "Casual"): "Повсякденний", "Діловий", "Святковий", "Вечірній", "Романтичний", "Бохо", "Вінтажний", "Готичний", "Класичний", "Спортивний"
- Обов'язково вибери мінімум 1-2 стилі

ДЕКОР (decor) — вибір з переліку:
- Одне значення. Якщо без декору: "Без декору". Точні назви: "Мереживо", "Паєтки", "Вишивка", "Стрази", "Оборки", "Люрекс", "Рюши", "Пір'я", "Бахрома", "Волани", "Ґудзики", "Бант", "Зав'язки"

ОСОБЛИВОСТІ МОДЕЛІ (modelFeatures) — вибір з переліку:
- Масив деталей крою/конструкції. Точні назви: "З декольте", "На бретельках", "З розрізом на нозі", "З поясом", "З кишенями", "З капюшоном", "З коміром", "З корсетом", "На ґудзиках", "На змійці", "На резинці", "На шнурівці", "В рубчик", "В'язані", "Без застібки", "Плісе"

Поверни JSON:
{
  "title": "...",
  "description": "...",
  "keywords": ["...", ...],
  "colors": ["..."],
  "sizes": ["S", "M", "L"],
  "seasons": ["..."],
  "sleeveLength": "..." або null,
  "sleeveStyle": ["..."],
  "features": ["..."],
  "materials": ["..."],
  "silhouette": ["..."],
  "fashionCut": ["..."],
  "print": [],
  "style": ["..."],
  "decor": "...",
  "modelFeatures": ["..."]
}
`.trim();
  },
  async publish({ product, text, photoPaths, extras }) {
    const shafaProduct = mapProductToShafa(product, text);
    shafaProduct.imagePaths = photoPaths.length ? photoPaths : shafaProduct.imagePaths;

    // Поля, які задає користувач вручну в preview
    if (extras) {
      if (extras.brand)         shafaProduct.brand         = String(extras.brand);
      if (extras.condition)     shafaProduct.condition     = extras.condition as typeof shafaProduct.condition;
      if (extras.madeInUkraine) shafaProduct.madeInUkraine = extras.madeInUkraine as typeof shafaProduct.madeInUkraine;
      if (extras.sleeveLength)  shafaProduct.sleeveLength  = String(extras.sleeveLength);
      if (Array.isArray(extras.seasons) && extras.seasons.length) {
        shafaProduct.seasons = extras.seasons as string[];
      } else if (typeof extras.season === "string" && extras.season) {
        shafaProduct.seasons = [extras.season];
      }
      if (Array.isArray(extras.categoryPath) && extras.categoryPath.length) {
        shafaProduct.categoryPath = extras.categoryPath as string[];
      }
    }

    const numericUserId = (extras as any)?.numericUserId as number | null | undefined;
    if (!numericUserId) {
      throw new Error("Shafa вимагає підключеного акаунта користувача. Залогінься в Налаштуваннях.");
    }

    try {
      const sessionPath = shafaSessionPathForUser(numericUserId);
      const debugPrefix = shafaDebugPrefixForUser(numericUserId);
      const result = await publishToShafa(shafaProduct, sessionPath, debugPrefix);
      return { externalPostId: result.externalPostId };
    } catch (err) {
      if (err instanceof ShafaSessionExpiredError) {
        throw new Error("SHAFA_SESSION_EXPIRED");
      }
      throw err;
    }
  },
};

const promPlatform: PublishingPlatform = {
  id: "prom",
  name: "Prom.ua",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Ти публікуєш товар на маркетплейсі Prom.ua. Покупці шукають товари через пошук — заголовок, ключові слова та атрибути критично важливі для видимості.

Правила для Prom.ua:
- Назва товару: до 120 символів, точна і пошуко-орієнтована. Включи: тип товару, колір, матеріал, стиль.
- Опис: детальний, 150-400 слів. Можна використовувати HTML (абзаци <p>, списки <ul><li>). Опиши переваги, склад, розміри, догляд.
- Ключові слова: 15-25 слів через кому. Включи синоніми, суміжні запити, розміри.
- Кольори: список кольорів товару з фото (українською).
- Розміри: список розмірів в наявності (XS/S/M/L/XL або 42/44/46...).
- Матеріали: список матеріалів/тканин.
- Сезони: список із [Весна, Літо, Осінь, Зима] — підходящі для цього товару.
- Стиль: список із [Повсякденний, Діловий, Святковий, Вечірній, Романтичний, Бохо, Вінтажний, Класичний, Спортивний].

Поверни тільки JSON (без markdown):
{
  "title": "назва до 120 символів",
  "description": "<p>HTML-опис...</p>",
  "keywords": "ключове1, ключове2, ...",
  "categoryName": "Жіночі сукні",
  "colors": ["чорний", "молочний"],
  "sizes": ["S", "M", "L", "XL"],
  "materials": ["льон", "бавовна"],
  "seasons": ["Весна", "Літо"],
  "style": ["Повсякденний", "Романтичний"]
}
`.trim();
  },
  async publish({ product, text, photoPaths, imageUrls, extras }) {
    const creds = (extras?.userTokens as any)?.prom;
    return publishPromPost({ product, text, photoPaths, imageUrls, extras, creds });
  },
};

const olxPlatform: PublishingPlatform = {
  id: "olx",
  name: "OLX",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Ти публікуєш оголошення на OLX.ua. Це дошка оголошень — покупці шукають через пошук і фільтри.

Правила для OLX:
- Назва: до 70 символів, конкретна і пошукова. Тип товару + колір + матеріал + розмір.
- Опис: 100-300 слів, неформальний і живий. Без зайвих заголовків. Стан товару — новий.
- Ключові слова: 10-15 слів через кому.
- Кольори, розміри, матеріали — списками.

Поверни тільки JSON (без markdown):
{
  "title": "назва до 70 символів",
  "description": "опис оголошення...",
  "keywords": "ключове1, ключове2, ...",
  "colors": ["чорний"],
  "sizes": ["S", "M", "L"],
  "materials": ["льон"]
}
`.trim();
  },
  async publish({ product, text, photoPaths, imageUrls, extras }) {
    const creds = (extras?.userTokens as any)?.olx;
    return publishOlxPost({ product, text, photoPaths, imageUrls, extras, creds });
  },
};

const rozеtkaPlatform: PublishingPlatform = {
  id: "rozetka",
  name: "Rozetka",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Ти публікуєш товар на Rozetka.ua — найбільший маркетплейс України. Покупці шукають через пошук і порівнюють характеристики.

Правила для Rozetka:
- Назва: до 255 символів, точна. Бренд/тип + матеріал + колір + розмір.
- Опис: детальний, 200-500 слів, HTML. Абзаци <p>, списки <ul><li>. Склад тканини, догляд, розміри.
- Ключові слова: 15-20 слів через кому.
- Кольори, розміри, матеріали — списками.

Поверни тільки JSON (без markdown):
{
  "title": "назва до 255 символів",
  "description": "<p>HTML-опис...</p>",
  "keywords": "ключове1, ключове2, ...",
  "colors": ["чорний", "молочний"],
  "sizes": ["S", "M", "L", "XL"],
  "materials": ["льон", "бавовна"]
}
`.trim();
  },
  async publish({ product, text, photoPaths, imageUrls, extras }) {
    const creds = (extras?.userTokens as any)?.rozetka;
    return publishRozetkaPost({ product, text, photoPaths, imageUrls, extras, creds });
  },
};

const kastaPlatform: PublishingPlatform = {
  id: "kasta",
  name: "Kasta.ua",
  supportsPublishing: true,
  generatePrompt(product) {
    return `
${commonRules(product)}

Ти публікуєш товар на маркетплейсі Kasta.ua. Це платформа з детальним каталогом — потрібні точні назва, опис, бренд, кольори, розміри і матеріали.

Правила для Kasta.ua:
- Назва: до 200 символів, точна. Тип товару + матеріал + колір.
- Опис: детальний, 150-400 слів. Без HTML — простий текст.
- Бренд: якщо в даних товару є бренд — вкажи його; якщо ні — напиши "Без бренду".
- Ключові слова: 15-20 слів через кому.
- Кольори, розміри, матеріали — списками.

Поверни тільки JSON (без markdown):
{
  "title": "назва до 200 символів",
  "description": "опис товару...",
  "keywords": "ключове1, ключове2, ...",
  "brand": "назва бренду або Без бренду",
  "colors": ["чорний", "молочний"],
  "sizes": ["S", "M", "L", "XL"],
  "materials": ["льон", "бавовна"]
}
`.trim();
  },
  async publish({ product, text, photoPaths, imageUrls, extras }) {
    const creds = (extras?.userTokens as any)?.kasta;
    return publishKastaPost({ product, text, photoPaths, imageUrls, extras, creds });
  },
};

const tiktokPlatform: PublishingPlatform = {
  id: "tiktok",
  name: "TikTok",
  supportsPublishing: true,
  generatePrompt(product) {
    const { shopLabel, langRule } = shopContext(product);
    return `
${commonRules(product)}

Ти пишеш підпис для TikTok-відео або фото-каруселі для ${shopLabel}.

Правила для TikTok:
- Текст: 150-300 символів, живий і невимушений стиль.
- Починай з гачка (питання, факт, або коротка фраза про товар).
- 3-5 хештегів в кінці: загальні (#мода #стиль) + конкретні (#сукня #льон).
- ${langRule}
- Без цін у підписі — ціну підкажи в коментарі.

Поверни ТІЛЬКИ текст підпису, без JSON і без пояснень.
`.trim();
  },
  async publish({ text, videoUrl, videoPath, extras }) {
    if (!videoUrl) throw new Error("TikTok: для публікації потрібне відео (фото-карусель доступна після production approval)");
    const ttCreds = (extras?.userTokens as any)?.tiktok;
    const id = await publishTikTokVideo(
      videoUrl,
      text,
      ttCreds,
      extras?.tiktokSettings,
      videoPath
    );
    return { externalPostId: id, raw: { processing: true } };
  },
};

export const platforms: Record<PlatformId, PublishingPlatform> = {
  telegram: telegramPlatform,
  instagram: instagramPlatform,
  facebook: facebookPlatform,
  tiktok: tiktokPlatform,
  shafa: shafaPlatform,
  prom: promPlatform,
  olx: olxPlatform,
  rozetka: rozеtkaPlatform,
  kasta: kastaPlatform,
  viber: createFuturePlatform("viber", "Viber"),
};

export const enabledPlatformIds: PlatformId[] = ["telegram", "instagram", "facebook", "tiktok", "shafa", "prom", "olx", "rozetka", "kasta"];

export function getPlatform(id: PlatformId) {
  const platform = platforms[id];

  if (!platform) {
    throw new Error(`Невідома платформа: ${id}`);
  }

  return platform;
}

export function isPlatformId(value: string): value is PlatformId {
  return value in platforms;
}
