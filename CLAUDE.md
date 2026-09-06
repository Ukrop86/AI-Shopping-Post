# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Read `PROJECT_MAP.md` first** for the detailed "what lives where" map — full file-by-file
> annotations, the API-route catalog, the data model, per-platform auth models, and a list of
> recently added features. This file (CLAUDE.md) covers architecture and working rules; PROJECT_MAP.md
> is the navigation index. Keep both up to date when the structure changes.

## What this is

**Postly** (product/domain name `postly.pp.ua`; package name is still `ai-shopping-post`) — a multi-tenant SaaS
where sellers upload product photos, AI generates per-platform post text, and the app publishes to Telegram,
Facebook, Instagram, TikTok, Shafa.ua, Prom.ua, OLX, Rozetka and Kasta.ua. Deployed on Railway.

## Commands

```bash
npm run dev             # Run the server (tsx, no separate build step needed for local dev)
npm start                # Same as dev — both just run tsx src/server.ts
npm run build            # Rebuilds sqlite3 native bindings + `tsc --noEmit` (type-check only, no JS is emitted/run from it)
npx tsc --noEmit -p .    # Type-check only, fastest way to verify a change compiles
```

There is no test runner/framework configured. `scripts/` contains ad-hoc `tsx` debug scripts used while
building the Shafa Playwright integration (e.g. `npm run test:shafa`, `npm run inspect:shafa`, and various
`scripts/check-*.ts` one-offs) — these are manual diagnostic tools, not an automated suite.

Production runs via the `Dockerfile` (Node 22 + ffmpeg + fonts-dejavu-core + libheif-examples) on Railway.

## Architecture

### Request flow
`public/*.html` (no build step — plain HTML/CSS/JS served via `express.static`) → Express routes in
`src/server.ts` → per-platform modules → SQLite (`src/db/sqlite.ts`).

- `public/index.html` — public marketing landing page. Client-side redirects to `/app.html` if a JWT is
  already in `localStorage`.
- `public/app.html` (+ `public/app.js`) — the authenticated product-creation cabinet (upload photo/video,
  generate text, pick platforms, publish).
- `public/setup.html` — per-user platform connection/settings page (all OAuth/token flows and category pickers
  live here).
- `public/products.html` (+ `public/products.js`) — post history/list.
- `public/stats.html`, `public/login.html` — self-explanatory; inline `<script>` per page, no shared JS bundle.
- Auth-gated pages all follow the same pattern: check `localStorage.getItem('authToken')` client-side and
  redirect to `/login.html` if missing, then send it as `Authorization: Bearer <token>` on every API call.

### Multi-tenancy & auth (`src/auth.ts`, `src/user-tokens.ts`)
- JWT-based auth (`signToken`/`verifyToken`, 30-day expiry). `authMiddleware` + `requireExistingUser` are
  combined as `requireUser` in `server.ts` and spread (`...requireUser`) onto every per-user route.
  `currentUserId(req)` reads the numeric user id middleware attaches to `req`.
  `EVERY` per-user API route needs `...requireUser` — a route only reachable with a valid Postly session token.
- OAuth `state` params (Facebook/TikTok/OLX) are signed short-lived JWTs via `signOAuthState`/`verifyOAuthState`
  (15 min expiry) — never revert to unsigned base64 state; that lets an attacker bind their own social account
  to someone else's Postly user by crafting the authorize URL directly.
- Per-user social credentials live in `user_social_tokens` (one row per user+platform), encrypted at rest
  (`user-tokens.ts`: AES-256-GCM, key derived from `TOKEN_ENCRYPTION_KEY`/`JWT_SECRET`). Read via
  `getUserTokens(db, userId)` / `getUserSocialStatus(db, userId)`, write via `saveUserToken(db, userId, platform, data)`.
- **One external account → one Postly user** is enforced at the DB level via partial unique indexes in
  `sqlite.ts` (`ensureUniqueIndex`, tolerant of pre-existing duplicate rows so it never crashes startup).
  Platforms with a dedicated column (`page_id`, `instagram_user_id`, `open_id`, `user_settings.telegram_chat_id`)
  use that column directly; everything else (Prom, OLX, Rozetka, Kasta, Shafa) uses the generic
  `external_account_id` column — a hash of the token for platforms with static tokens (`hashForIdentity()`),
  or a real fetched account id for platforms whose tokens rotate (OLX), or a scraped username (Shafa, which has
  no real API). `saveUserToken` translates the resulting `UNIQUE constraint failed` into a friendly Ukrainian
  message via `DUPLICATE_ACCOUNT_MESSAGES`/`DUPLICATE_PLATFORM_MESSAGES`.

### Platform registry (`src/platforms/index.ts`, `src/platform-types.ts`)
Every publishing target implements `PublishingPlatform` (`generatePrompt(product)` + `publish(params)`).
`platforms: Record<PlatformId, PublishingPlatform>` is the single registry; `getPlatform(id)` /
`isPlatformId()` / `enabledPlatformIds` are the only things callers (server routes, scheduler) touch —
add a new platform by adding one entry here, not by scattering platform checks elsewhere.

**To add a new platform**, follow the pattern of the most recently added one (currently `kasta`, see
`src/kasta.ts` + its wiring in `platforms/index.ts`, `user-tokens.ts`, `server.ts`, `setup.html`, `app.html`):
1. `src/<platform>.ts` — `xTestConnection`, `publishXPost({product,text,photoPaths,imageUrls,extras,creds})`,
   and (if it has categories/attributes) a search + best-effort characteristic-matching helper, mirroring
   `rozetka.ts`'s `buildRozetkaParams` (only auto-fills what we already collect — color/size/material — and
   fails loudly with a clear message instead of guessing at fields we have no data for).
2. Add the id to `PlatformId` in `platform-types.ts`.
3. Add `<Platform>Creds` + a branch in `getUserTokens`/`getUserSocialStatus`/`DUPLICATE_*_MESSAGES` in
   `user-tokens.ts`.
4. Add the platform entry + `generatePrompt` (a JSON-output prompt if the platform needs structured fields
   like colors/sizes/brand) to `platforms/index.ts`, and to `enabledPlatformIds`.
5. Add `/api/<platform>/status|save|verify|categories|set-default-category` routes to `server.ts` (copy the
   Rozetka block — it's the fullest example) and add the platform key to the `platformKeys` array used for
   the stats "connected platforms" count.
6. Add a Setup tab (button + panel + JS) to `setup.html`, a checkbox to `app.html`, and an icon entry to
   `stats.html`'s `platformMeta` and `index.html`'s platform pills.
7. Generic `DELETE /api/user/social/:platform` and per-user token storage already work for any platform with
   no code changes needed there.

Platforms differ a lot in auth model — Facebook/TikTok/OLX use real OAuth (authorization code grant, one
shared dev app), Prom/Rozetka/Kasta use a personal token the seller pastes in themselves (no OAuth app at
all), Shafa has no real API and drives the actual site via a per-user Playwright session
(`src/shafa/`, `shafa.session.ts` persists the browser context so login doesn't repeat every publish).

### Unattended autoposting (`src/scheduler.ts`, `src/posting-plan.ts`, `src/notifications.ts`)
Everything below exists so a week of scheduled posts survives without anyone watching:

- **Stuck rows are recovered, not resurrected.** The container restarts on every deploy; a row claimed as
  `publishing` when that happens can never be claimed again. `recoverStuckPosts` marks anything publishing (or
  any studio product still `preparing`) for more than 20 minutes as failed with an explanation. It deliberately
  does **not** requeue: if the publish actually reached the platform before the process died, a retry would
  post twice, so a human decides.
- **A failed scheduled publish is retried** with a delay (`scheduleRetry`: 10 min, then 30, then final failure
  after 3 attempts) — a five-minute outage at Meta used to mean the post simply never went out. The due query
  honours `nextAttemptAt`, and any manual save or reschedule resets the counter.
- **Posts never go out in a burst.** At most one post per user×platform per tick, and never within 15 minutes
  of that account's previous publish; anything closer is pushed back. The weekly slot grid keeps real spacing
  (≥4h) at planning time — this is only the runtime backstop.
- **`POST /api/instagram/schedule-plan`** assigns times to draft studio posts from `posting-plan.ts`, the code
  version of `POSTING_SCHEDULE.md`. Slots are Kyiv wall-clock and converted per date via `Intl`, so the DST
  switch doesn't shift every post by an hour. Occupied slots are skipped; posts that don't fit stay drafts.
- **Instagram token expiry is tracked.** The Facebook token that publishes to Instagram lasts ~60 days and
  never refreshes itself; `getUserSocialStatus` now reports `instagram` as connected only while the token is
  alive, exposes the expiry, and a daily pass warns the owner (at most once every three days). Scheduling into
  a disconnected or expired account is rejected up front rather than failing overnight.
- **Derived media is cleaned up** after 30 days once a product has nothing left to publish — overlaid videos,
  slideshows, story frames and Instagram photo copies only. The seller's own uploads are never touched.
- **Notifications have no sender yet, on purpose.** There are several users and an event must reach the owner
  of that product, on a channel they chose and confirmed — so `notifications.ts` stores a per-user channel
  (`user_settings.notify_channel`/`notify_target`) and queues every event in the `notifications` table with
  `deliveredAt` NULL. `deliverNotification` is the single stub to replace; nothing is lost in the meantime.

### Publishing pipeline & scheduler (`src/scheduler.ts`)
- `platform_posts` rows move through `draft → scheduled → publishing → published/failed`.
- A background tick (`setInterval`, 45s) picks up due `scheduled` posts and publishes them; manual "publish
  now" goes through the same `publishPlatformPost()` function.
- Before doing any real publish work, `publishPlatformPost` atomically claims the row
  (`UPDATE ... SET status='publishing' WHERE id=? AND status NOT IN ('publishing','published')`, checking
  `result.changes`) — this is what prevents the same post being published twice if the scheduler tick and a
  manual click race, or a double-click happens. Don't remove this claim step when touching this file.
- `withRetry(fn, maxAttempts, baseDelayMs)` wraps flaky network calls with linear backoff.
- Token refresh (TikTok, OLX — both rotate access tokens) happens inline in the scheduler right before
  publish, persisted back via `saveUserToken`.

### Database (`src/db/sqlite.ts`)
- Single SQLite file. `DB_PATH` env var picks the path; on Railway it defaults to `/data/database.sqlite`
  when `/data` exists (the mounted persistent volume) so the DB survives redeploys — **the Railway volume's
  own Mount Path must be set to `/data` (the directory), not a nested file path**, or persistence silently
  breaks. Same reasoning applies to uploaded photos (`UPLOADS_DIR`, resolved in `server.ts`).
- Schema evolves via `ensureColumn(db, table, col, def)` (idempotent `ALTER TABLE ... ADD COLUMN`) and
  `ensureUniqueIndex(db, name, sql)` (idempotent `CREATE UNIQUE INDEX`, logs+continues instead of crashing
  startup if pre-existing data already violates it) — there are no numbered migration files, `initDb()` is
  the single source of truth and is safe to run against an existing populated DB every boot.
- Core tables: `users`, `user_social_tokens` (per-user platform credentials), `user_settings` (per-user
  Telegram chat id + shop branding), `products`, `product_images` (many-to-one), `platform_posts` (one row
  per product×platform).

### AI generation (`src/ai-generator.ts`)
Uses the OpenAI **Responses API** (`openai.responses.create()`, SDK v6+, `input_image`/`input_text` content
types — not the older Chat Completions shape). Model comes from `OPENAI_MODEL` env. Each platform's
`generatePrompt(product)` in `platforms/index.ts` supplies the platform-specific instructions; several
platforms (Shafa, Prom, OLX, Rozetka, Kasta) require the model to return structured JSON (parsed back out
of the generated text before publish) rather than plain post copy.

### Video overlay (`src/video-overlay.ts`)
ffmpeg/ffprobe-based media prep. Three builders: `createReelsStyleVideo` (text overlay on an uploaded video),
`createSlideshowReel` (product photos → a 1080×1920 Reel with a slow zoom and crossfades, so photo-only
products can reach Reels at all) and `createStoryFrame` (a 9:16 frame with the price burned in — stories carry
no caption, so anything the buyer must read has to be part of the image). Styles: `minimal`, `fashion`
(default), `premium`, `sale`. Requires `-pix_fmt yuv420p` (Instagram rejects video without it) and avoids emoji
in `drawtext` (ffmpeg can't render them without an emoji font) — uses `fonts/Arial-Bold.ttf` bundled in the
repo, with a `HAS_FONT` existence check and graceful fallback if it's ever missing.

### Instagram formats (`src/instagram.ts`)
One media set yields different posts, so the format is the seller's choice, stored per post in
`platform_posts.platformSettings` (`{format}`) and picked in the Instagram tab: `auto` (legacy behaviour —
format derived from the uploaded media), `reels`, `slideshow`, `carousel`, `story`. A carousel with a video
first slide never reaches the Reels feed, which is why `auto` is not a safe default for reach.
Derived media (`slideshow`/`story`) is built on demand via `POST /api/products/:id/instagram-media` and stored
on the product (`slideshowVideo*`, `storyImage*`) so a scheduled publish never waits on ffmpeg at slot time.
Publishing waits on the container's real `status_code` (`waitForContainerReady`) instead of fixed sleeps —
fixed pauses let longer videos publish before Meta finished processing them, which failed the post.

HEIC/HEIF (what an iPhone shoots by default) is decoded at **upload** time by `normalizeUploadedPhotos`
(server.ts) via `heif-convert` from `libheif-examples`, which the Dockerfile and nixpacks.toml install —
the ffmpeg in this image cannot demux a HEIF container at all ("moov atom not found"), so without that
package these photos work nowhere. Detection reads the file's own `ftyp` brand rather than the client's
mime type, since browsers routinely upload HEIC labelled `image/jpeg`; a photo that cannot be decoded is
rejected at upload with an explanation instead of failing at publish time, possibly overnight on a schedule.

Instagram accepts **JPEG only**, with an aspect ratio between 4:5 and 1.91:1 and at most 8 MB, so PNG/WEBP
uploads and ordinary 9:16 phone photos are rejected outright by the Graph API. `prepareInstagramImages`
(server.ts) therefore builds conforming copies in the background right after a product is created and stores
them in `product_images.igImage*`; the excess height is padded with a blurred background rather than cropped,
and an image that already conforms is recorded as-is instead of being duplicated on disk. An empty
`igImageUrl` means "not processed yet", and publishing falls back to the original.

A **bundle** (`POST /api/products/bundle`) — one Reel whose slideshow mixes photos from 2–6 products — is
stored as an ordinary product with `bundleOf` set, so it travels the same product → post → scheduler path with
no special case in publishing. Its `product_images` rows reference the source products' files rather than
copying them; the rendered reel is self-contained, so deleting a source product later doesn't break it.

### Instagram studio (`public/instagram.html`, `/api/instagram/studio`)
The Instagram-only workflow: one upload becomes every format at once. `prepareInstagramStudio` (server.ts)
runs in the background — ffmpeg and the AI together take a minute or two, which is far too long to hold a
request open — and the page polls `products.studioStatus` (`preparing` → `ready`/`failed`) until the cards
can be drawn. It builds the slideshow reel, the story frame, the overlaid video and the carousel photos
(captions burned into the first and last slide), then writes **one `platform_posts` row per format**,
distinguished by `formatKey`. That is what lifts the old "one row per product×platform" limit: a single
product now carries Reels, slideshow, carousel and story as separate posts, each with its own caption and
its own `scheduledAt`. Captions are written per format (`instagramFormatPrompt`), because a Reel is read
from its first line while a carousel is read by someone already interested; a story gets no caption at all.
Carousel slides are all conformed to the **same** aspect ratio (`targetRatio`), since Instagram crops every
slide to match the first one — mixed ratios silently cut the sides off the rest.

The weekly posting plan these formats serve lives in `POSTING_SCHEDULE.md`.

## Environment variables

(There is no `.env.example` in the repo — it was intentionally removed; this section is the
canonical list.) Baseline / mostly-legacy single-tenant fallbacks & shared-app config, now that
credentials are per-user: `OPENAI_API_KEY`, `OPENAI_MODEL`, `BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`ORDER_URL`, `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`, `SITE_URL`, `PORT`.

**Security-critical — must be set to real values in production:**
- `JWT_SECRET` — signs session tokens. If unset it falls back to a hardcoded dev string that is
  **public in this repo's source**, which would let anyone forge a valid login for any account.
- `TOKEN_ENCRYPTION_KEY` — encrypts per-user social tokens at rest (falls back to `JWT_SECRET` if
  unset; set both, ideally to different random values).
- `ADMIN_EMAIL` — the one account allowed to reach shared/global config routes (TikTok/OLX app
  credentials, site URL, the Facebook debug endpoint). `requireAdmin` **fails closed**: if
  `ADMIN_EMAIL` is unset, those routes are disabled for everyone rather than open to any logged-in
  user — so leaving it unset is safe, just means no one can use those admin-only routes.

Other: `DB_PATH`, `UPLOADS_DIR`, `FACEBOOK_APP_ID/APP_SECRET`, `TIKTOK_CLIENT_KEY/CLIENT_SECRET`,
`OLX_CLIENT_ID/CLIENT_SECRET` (shared OAuth app credentials — Prom/Rozetka/Kasta need no app-level
secret since sellers paste in their own personal tokens).
