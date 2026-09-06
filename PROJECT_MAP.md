# PROJECT_MAP.md — карта проєкту Postly

> Довідник «що і де лежить». Тримати актуальним при змінах.
> Коротка архітектура й правила — у `CLAUDE.md`. Тут — детальна мапа файлів, роутів, БД і фіч.

## Що це

**Postly** (`postly.pp.ua`; npm-пакет досі `ai-shopping-post`) — багатокористувацький SaaS: продавець
завантажує фото товару → AI пише текст під кожну платформу → публікація в **Telegram, Facebook,
Instagram, TikTok, Shafa.ua, Prom.ua, OLX, Rozetka, Kasta.ua**. Деплой на Railway (гілка `main`).

- **Стек:** Node.js + TypeScript + Express, SQLite, OpenAI Responses API, Playwright (лише Shafa), ffmpeg (відео).
- **Без збірки:** сервер бігає через `tsx src/server.ts` (dev = prod). `npm run build` = лише `tsc --noEmit` (перевірка типів) + ребілд sqlite3.
- **Фронтенд:** статичні `public/*.html` + vanilla JS, без бандлера.
- **Запуск:** `npm run dev`. Перевірка типів: `npx tsc --noEmit -p .`.
- **Тестів немає** (немає тест-раннера). `scripts/` — разові діагностичні скрипти для Shafa.

## Мапа файлів

### Бекенд `src/`
| Файл | За що відповідає |
|------|------------------|
| `server.ts` | **Головний файл.** Усі Express-роути, multer-завантаження, статика, збирання прев'ю/публікації. Найбільший файл — шукати роути тут. Хелпери: `currentUserId`, `requireUser`, `requireAdmin`, `getUserSettings`, `getPlatformMarkups`, `combineMarkups`, `insertProduct`, `productInputFromBody`, `updateProductFields`. |
| `auth.ts` | JWT-авторизація: `signToken`/`verifyToken` (30 днів), `authMiddleware`, `extractTokenFromQuery`, `signOAuthState`/`verifyOAuthState` (підписаний OAuth state, 15 хв). Секрет — `JWT_SECRET`. |
| `user-tokens.ts` | Пер-юзерні токени соцмереж у `user_social_tokens`: шифрування AES-256-GCM, `getUserTokens`, `saveUserToken`, `getUserSocialStatus`, `hashForIdentity`, `TelegramCreds` (chatId + orderLogin + socialLinks), словники дружніх повідомлень про дублікати акаунтів. |
| `db/sqlite.ts` | Ініціалізація БД, `initDb()`, `ensureColumn` (ідемпотентні ALTER), `ensureUniqueIndex`. Єдине джерело схеми — міграцій-файлів немає. Тут же розв'язується `DB_PATH` (Railway `/data`). |
| `ai-generator.ts` | OpenAI (Responses API): `generatePlatformPost`, `generatePostsForPlatforms(product, ids, markups?)`, `generateVideoTexts`, `applyPriceMarkup`/`applyProductMarkup` (націнка ±%). Модель — `OPENAI_MODEL`. |
| `platforms/index.ts` | **Реєстр платформ.** `platforms: Record<PlatformId, PublishingPlatform>`, `getPlatform`, `enabledPlatformIds`. Кожна платформа = `generatePrompt(product)` + `publish(params)`. Промпти під кожну соцмережу/маркетплейс живуть тут. |
| `platform-types.ts` | Типи: `PlatformId`, `ProductInput` (вкл. `priceMarkup`), `PublishingPlatform`, `GeneratedPlatformPost`. |
| `scheduler.ts` | Фоновий тик (45с) публікує заплановані пости; `publishPlatformPost()` (спільний для «опублікувати зараз»). Атомарний claim від подвійної публікації, `withRetry`, рефреш токенів (TikTok/OLX), збирання Telegram-кредів (chatId+login+соцпосилання). Синк статусів TikTok. |
| `telegram.ts` | Telegram Bot API: `sendTelegramPost` (фото/відео/альбом/текст), `sendTelegramMediaGroup`, `sendTelegramMixedMediaGroup`, `editTelegramPost`. Кнопка «✍️ Написати» (per-user логін), `injectSocialLinks` (соцпосилання перед хештегами). Альбом → кнопка окремим повідомленням (обмеження Telegram). |
| `facebook.ts` | Публікація на Facebook-сторінку (фото/відео/альбом), Graph API v25. |
| `facebook-auth.ts` | Facebook OAuth (code grant): `buildAuthUrl`, `completeFacebookOAuth`, `selectFacebookPage(Manual)`, `getFacebookStatus`, `readEnv`/`writeEnvVars` (читає/пише `/data/.env` для глобального/адмін-конфігу). |
| `instagram.ts` | Публікація в Instagram через Graph API. Формати: `auto/reels/slideshow/carousel/story` (`InstagramFormat`), `publishInstagramStory`, опитування статусу контейнера (`waitForContainerReady`) замість фіксованих пауз. Потребує публічний HTTPS `SITE_URL`. |
| `tiktok.ts` | TikTok Content Posting API: OAuth (`getTikTokAuthUrl`, `exchangeTikTokCode`, `refreshTikTokTokenRaw`), `publishTikTokVideo`, `publishTikTokPhotos`, `getTikTokStatus`. Токени глобальні (у `/data/.env`). |
| `prom.ts` | Prom.ua Marketplace API (особистий токен продавця). `publishPromPost`, тест з'єднання, пошук категорій. |
| `olx.ts` | OLX API v2 (OAuth, токени ротуються). `publishOlxPost`, `olxTestConnection` (повертає `accountId` для унікальності), рефреш. |
| `rozetka.ts` | Rozetka Seller API (особистий токен). `publishRozetkaPost`, пошук категорій, best-effort підбір характеристик (`buildRozetkaParams`). |
| `kasta.ts` | Kasta HUB API (особистий токен, заголовок `Authorization` БЕЗ «Bearer»). `publishKastaPost`, `kastaTestConnection`, `kastaSearchCategories` (kind_id+affiliation_id), завантаження фото, підбір характеристик. |
| `video-overlay.ts` | ffmpeg: `createReelsStyleVideo` (оверлей тексту на відео), `createSlideshowReel` (фото → вертикальний Reels 1080×1920 із зумом і перетинами), `createStoryFrame` (кадр 9:16 із запеченою ціною для сторіз), `createInstagramImage` (фото → JPEG зі співвідношенням 4:5…1.91:1; повертає `null`, якщо оригінал уже підходить), `isHeifImage`/`convertHeifToJpeg` (HEIC з iPhone → JPEG через `heif-convert`), `isReadableImage`. Стилі: `minimal/fashion/premium/sale`. `-pix_fmt yuv420p` обов'язково; шрифт `fonts/Arial-Bold.ttf`. |
| `shafa/index.ts` | Ре-експорти Shafa. |
| `shafa/shafa.types.ts` | `ShafaProduct`, `SHAFA_COLORS`, `SHAFA_SIZES_*`, списки сезонів/рукавів тощо. |
| `shafa/shafa.mapper.ts` | `mapProductToShafa(product, aiJson)` — AI JSON → `ShafaProduct`. Safety-net: дописує додатковий опис в description, якщо AI його не вплів. |
| `shafa/shafa.publisher.ts` | **Playwright-автоматизація Shafa** (немає API). `publishToShafa`, `loginShafaAndSaveSession`, заповнення форми (`fillTitle/Category/Description/Keywords/...`), `selectSizes/Colors`, `fillLabeledTextField`. Виявлення полів категорії: `discoverCategorySchema`/`recordCategorySchema`/`listCategorySchemas` (пише `/data/shafa-schema/`). Сесія — файл на юзера. |
| `shafa/shafa.session.ts` | Збереження/відновлення Playwright-контексту (авторизація Shafa). |

### Фронтенд `public/`
| Файл | За що відповідає |
|------|------------------|
| `index.html` | Публічний лендінг. Якщо є JWT у localStorage → редірект на `/app.html`. OG-теги, логотип, перелік платформ. |
| `app.html` + `app.js` | **Кабінет** — створення товару: завантаження фото/відео, поля (вкл. «Націнка, %» біля ціни), вибір платформ (чекбокси), прев'ю, редагування текстів, публікація. До 10 фото. |
| `setup.html` | **Налаштування** — усі вкладки підключення платформ (OAuth/токени, категорії), Telegram-контакти (логін+соцпосилання), націнка per-platform (інжектиться в кожну вкладку через `injectMarkupControls`). Найбільший фронт-файл. |
| `products.html` + `products.js` | Історія публікацій, фільтри, редагування товарів. Тут же збирається **добірка**: чекбокси «У добірку» на картках + панель `#bundleBar`. |
| `stats.html` | Статистика (KPI, графіки по платформах). `platformMeta` — іконки платформ. |
| `login.html` | Вхід/реєстрація (`?tab=register`). |
| `facebook-setup.html` | Окрема сторінка майстра Facebook OAuth. |
| `style.css` | Спільні стилі (шапка, hamburger-nav, `.logo-icon`, сітки — `minmax(0,1fr)` проти overflow). |
| `privacy/terms/data-deletion.html` | Юридичні сторінки (для рев'ю платформ). |
| `logo-mark.png` / `logo-full.png` / `apple-touch-icon.png` | Логотип: знак «P» (шапка+favicon), повний (футер+OG), apple-touch. |
| `tiktok*.txt` | Верифікаційні файли TikTok-домену. |

### Корінь
| Файл | Що |
|------|----|
| `CLAUDE.md` | Правила/архітектура для Claude Code (авто-завантажується новою сесією). |
| `PROJECT_MAP.md` | Цей файл — детальна мапа. |
| `POSTING_SCHEDULE.md` | Графік публікацій в Instagram: слоти тижня, типи товарів, ліміти, ємність каталогу. |
| `Dockerfile` | Node 22 + ffmpeg + fonts + `libheif-examples` (heif-convert для HEIC). Railway. |
| `nixpacks.toml` | ffmpeg + libheif-examples для Railway-білду. |
| `tsconfig.json`, `package.json` | Конфіг TS / залежності й скрипти. |
| `shafa-form-map.json` | Артефакт дослідження форми Shafa (довідково). |
| `fonts/` | Шрифти для ffmpeg-оверлея. |
| `scripts/` | Разові діагностичні tsx-скрипти (Shafa). Не автотести. |

## Модель даних (SQLite, `src/db/sqlite.ts`)

| Таблиця | Призначення / ключові поля |
|---------|----------------------------|
| `users` | `id, email (UNIQUE), password_hash, created_at`. |
| `user_social_tokens` | Пер-юзерні креди платформ (1 рядок на user+platform). Токени шифровані. Поля: `platform, access_token, refresh_token, page_id, page_name, open_id, instagram_user_id, expires_at, login, meta (JSON), external_account_id`. Унікальність «1 зовнішній акаунт = 1 юзер» через partial unique indexes (`page_id`, `instagram_user_id`, `open_id`, `external_account_id`). |
| `user_settings` | 1 рядок на юзера. `shop_name/description/language`, `facebook_page_url`, `instagram_url`, `telegram_chat_id`, **`telegram_order_login`** (логін для кнопки), **`telegram_social_links`** (JSON-масив), **`platform_markups`** (JSON `{платформа: %}`). Унікальний індекс на `telegram_chat_id`. |
| `products` | Товар. `title, price, dropPrice, sizes, sizeSystem, colors, fabric, description, model, imageUrl, photoPath, video*`, `videoStyle`, `shopName/Description/Language`, **`priceMarkup`** (REAL, ±%), **`slideshowVideoPath/Url`** (Reels із фото), **`storyImagePath/Url`** (кадр для сторіз), **`bundleOf`** (JSON-масив id товарів — ознака добірки), `userId`, `generatedPost` (telegram-чернетка). |
| `product_images` | Фото товару (багато-до-одного): `productId, imageUrl, photoPath, sortOrder`, **`igImagePath/igImageUrl`** (копія під вимоги Instagram; порожньо = ще не оброблено). |
| `platform_posts` | Пост на платформу (1 рядок на product×platform). `platform, text, status (draft/scheduled/publishing/published/failed), scheduledAt, publishedAt, externalPostId, externalChatId, errorMessage, platformSettings (JSON), platformStatus (JSON)`. |

## Каталог API-роутів (`src/server.ts`)

**Публічні (без авторизації):** `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/data-deletion`, `GET /api/facebook/status`, `GET /api/site-url`, статика.
**OAuth-редіректи:** `GET /auth/facebook`, `/auth/facebook/callback`, `GET /auth/tiktok`, `/auth/tiktok/callback` (+ реле `cvz-` state на сестринський проєкт), `GET /auth/olx`, `/auth/olx/callback`.
**Решта `/api/*` — за `...requireUser`.** Адмінські (`requireAdmin`, за `ADMIN_EMAIL`, fail-closed): `POST /api/facebook/save-app`, `/api/facebook/disconnect`, `GET /api/facebook/debug-ig`, `POST /api/tiktok/setup`, `POST /api/olx/save-credentials`, `POST /api/site-url`.

| Група | Роути |
|-------|-------|
| Товари/прев'ю | `POST /api/posts/preview`, `POST /api/posts/:productId/regenerate`, `GET/PUT /api/products/:id`, `GET /api/products`, `PUT /api/products/:id/video-choice`, **`POST /api/products/:id/instagram-media`** (`slideshow` / `story` / `carousel` — збирає слайдшоу-Reels, кадр сторіз або приводить фото до вимог IG), **`POST /api/products/bundle`** (добірка з 2–6 товарів → товар-добірка + слайдшоу + чернетка поста), `POST /api/products/:id/publish`, legacy `/preview-post`, `/publish-preview`, `/products-api`. |
| Пости | `PUT /api/platform-posts/:id`, `POST /api/platform-posts/:id/publish`, `GET /api/platform-posts/:id/status`. |
| Акаунт/статус | `GET /api/user/social-status`, `DELETE /api/user/social/:platform`, `DELETE /api/account`, `GET /api/stats/summary`. |
| Налаштування | `GET/POST /api/settings/shop`, `GET /api/settings/markups`, `POST /api/settings/markup`. |
| Telegram | `GET /api/telegram/status`, `POST /api/telegram/save` (chatId + orderLogin + socialLinks, merge). |
| Facebook/IG | `select-page`, `select-page-manual`, `set-instagram`, `saved-creds`, `verify`, `save-app`, `disconnect`, `debug-ig`. |
| Shafa | `GET /api/shafa/status`, `POST /api/shafa/login`, `POST /api/shafa/disconnect`, `GET /api/shafa/category-schemas`, `GET /api/shafa/debug-screenshot`. |
| TikTok | `GET /api/tiktok/status`, `POST /api/tiktok/setup`, `GET /api/tiktok/creator-info`, `POST /api/tiktok/disconnect`. |
| Prom | `status`, `save`, `verify`, `categories`, `set-default-category`. |
| OLX | `status`, `save-credentials`. |
| Rozetka | `status`, `save`, `verify`, `categories`, `set-default-category`. |
| Kasta | `status`, `save`, `verify`, `categories`, `set-default-category`. |

## Моделі авторизації платформ

| Платформа | Модель | Де токен |
|-----------|--------|----------|
| Facebook, Instagram | OAuth (code grant), спільний dev-app | `user_social_tokens` (пер-юзер) |
| TikTok | OAuth, спільний dev-app | глобально `/data/.env` (один канал) |
| OLX | OAuth (токени ротуються, `accountId` для унікальності) | `user_social_tokens` |
| Prom, Rozetka, Kasta | Особистий токен продавця (без OAuth-застосунку) | `user_social_tokens` (унікальність = хеш токена) |
| Telegram | Bot API, `chat_id` каналу | `user_settings.telegram_chat_id` |
| Shafa | Немає API — Playwright + логін/пароль → сесія-файл на юзера | `/data/shafa-sessions/<userId>.json` |

## Патерни й підводні камені

- **Додати нову платформу** — покроково в `CLAUDE.md` (розділ «To add a new platform»). Головне: усе через реєстр `platforms/index.ts`, не розкидати перевірки платформ.
- **Захист від подвійної публікації:** атомарний claim у `scheduler.ts` (`UPDATE ... WHERE status NOT IN (...)`). Не прибирати.
- **OAuth state** — завжди підписаний JWT (`signOAuthState`). Ніколи не повертати до неписаного base64.
- **`requireAdmin` fail-closed:** без `ADMIN_EMAIL` адмін-роути вимкнені для всіх.
- **`page.evaluate` (Shafa):** НЕ оголошувати іменовані функції-константи всередині — tsx/esbuild інжектить `__name`, якого немає в браузері (зламає). Логіку тримати інлайн/анонімно.
- **Persistence на Railway:** том має бути змонтований на `/data` (директорію), не на вкладений файл — інакше БД/фото не зберігаються між деплоями.
- **Секрети (обов'язково в проді):** `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` (без них — публічний дефолт із коду). Опис змінних — у `CLAUDE.md`.
- **Instagram/TikTok** потребують публічний HTTPS `SITE_URL` для медіа.
- **Формат поста в Instagram** зберігається в `platform_posts.platformSettings` (`{format}`) і обирається у вкладці Instagram. `auto` = історична поведінка (формат за набором медіа). Карусель із відео першим слайдом **не потрапляє в стрічку Reels** — для охоплення потрібен `reels` або `slideshow`.
- **Слайдшоу і кадр сторіз готуються на вимогу** (`/api/products/:id/instagram-media`) і лежать на товарі, щоб публікація за розкладом не чекала на ffmpeg у момент слоту.
- **HEIC (фото з iPhone) ffmpeg у нашому образі не читає взагалі** — конвертуємо на завантаженні через `heif-convert` (`normalizeUploadedPhotos` у `server.ts`). Формат визначається за сигнатурою файлу, а не за mime-типом: браузери регулярно віддають HEIC як `image/jpeg`. Нечитабельні фото відхиляються одразу з поясненням, а не ламають публікацію потім.
- **Instagram приймає тільки JPEG зі співвідношенням 4:5…1.91:1** (і до 8 МБ). PNG/WEBP і звичайне вертикальне фото 9:16 Graph API відхиляє, тому копії готуються у фоні одразу після створення товару (`prepareInstagramImages`) і зберігаються в `product_images.igImage*`. Зайву висоту добиваємо розмитим фоном, не обрізаємо.
- **Добірка — це звичайний товар** із заповненим `bundleOf`: так вона проходить тим самим шляхом товар → пост → планувальник. Фото добірки посилаються на файли вихідних товарів (не копіюються), але сам ролик — окремий самодостатній файл.
- **Ціна+націнка:** база в `products.price` не змінюється; націнка (per-product `priceMarkup` + per-platform з `user_settings.platform_markups`, додаються) застосовується лише до тексту поста при генерації.

## Що додано останнім часом (орієнтир)

- **Instagram — усі чотири формати:** Reels, слайдшоу-Reels із фото, карусель, сторіз. Вибір формату на пості, підготовка похідного медіа через ffmpeg, опитування статусу контейнера замість фіксованих пауз.
- **Фото під вимоги Instagram:** автоматична конвертація в JPEG і приведення співвідношення сторін до 4:5…1.91:1.
- **HEIC з iPhone:** конвертація на завантаженні + зрозуміла відмова, якщо файл не читається.
- **Добірка з кількох товарів:** один Reels зі слайдшоу з фото 2–6 товарів (`/api/products/bundle`, вибір на сторінці товарів).
- **Графік публікацій** — `POSTING_SCHEDULE.md` (слоти тижня, типи товарів, безпечні ліміти).
- **Kasta.ua** — дев'ята платформа.
- **Безпека:** усунено reflected XSS (setup/facebook-setup), закрито незахищені адмін/debug-роути, обмеження типів файлів завантаження, оновлено вразливі залежності.
- **Логотип/брендинг:** знак «P» у шапці, favicon, OG-зображення.
- **TikTok OAuth-реле:** `/auth/tiktok/callback` з `state`, що починається на `cvz-`, робить 302 на сестринський проєкт (`tiktok-chanel-production.up.railway.app`), не споживаючи code.
- **Telegram:** емодзі в постах (обов'язковий емодзі+«!» у кінці назви), кнопка «✍️ Написати» з логіну, соцпосилання перед хештегами.
- **Націнка ±%:** per-platform (у налаштуваннях) + per-product (біля поля ціни), додаються.
- **Фото:** ліміт 6 → 10.
- **Shafa:** запис схеми полів кожної категорії (`/data/shafa-schema/`, роут `category-schemas`); дописування деталей додаткового опису в description.
