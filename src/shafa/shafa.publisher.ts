import { chromium, type BrowserContext, type Page } from "playwright";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import { ShafaProduct } from "./shafa.types";

// ─── Утиліти ──────────────────────────────────────────────────────────────

async function fileExists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

const debugDir = () => (fsSync.existsSync("/data") ? "/data" : ".");

// Debug screenshots are namespaced per user (debugPrefix = "shafa-<userId>-") so one
// user's Shafa automation run doesn't overwrite or leak into another's debug view.
function debugScreenshotPath(debugPrefix: string, name: string): string {
  return `${debugDir()}/${debugPrefix}${name}.png`;
}

// Each user gets their own Playwright storageState file and debug-screenshot prefix —
// previously the whole app shared a single /data/shafa-session.json, meaning every
// user's Shafa publish ran as whoever had logged in last.
const sessionsDir = () => {
  const dir = process.env.SHAFA_SESSION_DIR || (fsSync.existsSync("/data") ? "/data/shafa-sessions" : "./shafa-sessions");
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
  return dir;
};

export function shafaSessionPathForUser(userId: number): string {
  return `${sessionsDir()}/${userId}.json`;
}

export function shafaDebugPrefixForUser(userId: number): string {
  return `shafa-${userId}-`;
}

async function humanPause(baseMs: number) {
  const jitter = baseMs * 0.4 * (Math.random() - 0.5);
  await new Promise<void>(r => setTimeout(r, Math.round(baseMs + jitter)));
}

const p = () => humanPause(400);
const P = () => humanPause(1000);

// ─── Модальні вікна ───────────────────────────────────────────────────────

async function dismissModals(page: Page) {
  await humanPause(600);
  const children = await page.locator(".ReactModalPortal *").count();
  if (children === 0) return;

  await page.keyboard.press("Escape");
  await humanPause(700);
  if ((await page.locator(".ReactModalPortal *").count()) === 0) return;

  const closeBtn = page.locator(
    ".ReactModalPortal button[aria-label], .ReactModalPortal button:has-text('×'), .ReactModalPortal button:has-text('✕'), .ReactModalPortal button:has-text('Зрозуміло'), .ReactModalPortal button:has-text('Закрити')"
  ).first();
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click({ force: true });
    await humanPause(700);
    return;
  }

  await page.mouse.click(5, 5);
  await humanPause(700);
}

// ─── Клік по опції ────────────────────────────────────────────────────────

async function clickOption(page: Page, text: string): Promise<boolean> {
  const el = page.getByText(text, { exact: true }).first();
  if (!((await el.count()) > 0 && (await el.isVisible({ timeout: 2000 }).catch(() => false)))) {
    return false;
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(200);
  // Use mouse.click with coordinates — more reliable with React
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await el.click();
  }
  await humanPause(300);
  return true;
}

// ─── Кроки заповнення ─────────────────────────────────────────────────────

async function uploadImages(page: Page, imagePaths: string[]) {
  const resolved = imagePaths.map(i => path.resolve(i));
  for (const rp of resolved) {
    if (!(await fileExists(rp))) throw new Error(`Фото не знайдено: ${rp}`);
  }
  // Wait for file input — after fresh login the React app takes longer to mount
  await page.locator('input[type="file"]').first().waitFor({ state: "attached", timeout: 90000 });
  await page.locator('input[type="file"]').first().setInputFiles(resolved, { timeout: 90000 });
  await page.waitForTimeout(5000);
}

async function fillTitle(page: Page, title: string) {
  let input = page.locator('input[name="titleUk"]').first();
  if (!(await input.isVisible({ timeout: 2000 }).catch(() => false))) {
    input = page.locator('input[placeholder*="Куртка"]').first();
  }
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await humanPause(400);
  await input.fill(title);
  await p();
  await page.keyboard.press("Escape");
  await humanPause(400);
  await dismissModals(page);
}

async function fillCategory(page: Page, categoryPath: string[]) {
  await dismissModals(page);
  for (const cat of categoryPath) {
    // Exact text match is brittle — Shafa's category labels aren't verified live against our
    // preset list, and its markup sometimes substitutes Latin lookalikes for Cyrillic С/Х.
    // Match case/homoglyph-normalized, exact first then substring, same approach as sizes.
    await humanPause(300);
    const result = await page.evaluate(`(function() {
      var target = ${JSON.stringify(cat)};
      function norm(s) {
        return s.replace(/Х/g,"X").replace(/х/g,"x").replace(/С/g,"C").replace(/с/g,"c")
          .replace(/\\s+/g, " ").trim().toLowerCase();
      }
      var t = norm(target);
      var all = Array.from(document.querySelectorAll("button, [role='button'], a, li, [role='option'], span, div"));
      var visible = all.filter(function(el) { return el.offsetParent && (el.innerText||el.textContent||"").trim().length > 0 && (el.innerText||el.textContent||"").trim().length < 60; });
      var texts = visible.map(function(el) { return (el.innerText||el.textContent||"").trim(); });
      var candidates = visible.filter(function(el) { return norm((el.innerText||el.textContent||"").trim()) === t; });
      if (candidates.length === 0) {
        candidates = visible.filter(function(el) { return norm((el.innerText||el.textContent||"").trim()).indexOf(t) !== -1; });
      }
      if (candidates.length === 0) return { coords: null, seen: Array.from(new Set(texts)).slice(0, 80) };
      var el = candidates[candidates.length - 1];
      el.scrollIntoView({ block: "center", behavior: "instant" });
      var r = el.getBoundingClientRect();
      return { coords: { x: r.left + r.width/2, y: r.top + r.height/2 } };
    })()`) as { coords: { x: number; y: number } | null; seen?: string[] };

    if (!result.coords) {
      console.log(`[Shafa] Категорія "${cat}" не знайдена. Видимі елементи: ${JSON.stringify(result.seen)}`);
      throw new Error(`Категорія не знайдена: ${cat}`);
    }
    await humanPause(300);
    await page.mouse.click(result.coords.x, result.coords.y);
    await humanPause(1200);
  }
  await page.keyboard.press("Escape");
  await humanPause(800);
}

async function fillCondition(page: Page, condition: string) {
  if (!(await clickOption(page, condition))) {
    throw new Error(`Стан "${condition}" не знайдено`);
  }
  await p();
}

async function fillBrand(page: Page, brand?: string) {
  if (!brand) return;
  // Бренд — input без placeholder всередині секції Бренд
  const idx: number = await page.evaluate(
    `(function() {
      var all = Array.from(document.querySelectorAll('*'));
      var lbl = all.find(function(el) {
        var t = (el.innerText||el.textContent||'').trim();
        return t === 'Бренд';
      });
      if (!lbl) return -1;
      var c = lbl.parentElement; var d = 0;
      while (c && d < 8) {
        var inp = c.querySelector('input[type="text"]');
        if (inp && inp.offsetParent !== null) {
          return Array.from(document.querySelectorAll('input[type="text"]')).indexOf(inp);
        }
        c = c.parentElement; d++;
      }
      return -1;
    })()`
  ) as number;
  if (idx < 0) return;
  const input = page.locator('input[type="text"]').nth(idx);
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();
  await humanPause(400);
  await input.pressSequentially(brand, { delay: 60 });
  await humanPause(800);
  // Вибираємо першу підказку якщо є
  const listbox = page.locator('[role="listbox"], [role="option"]').first();
  if ((await listbox.count()) > 0 && (await listbox.isVisible({ timeout: 500 }).catch(() => false))) {
    await page.keyboard.press("ArrowDown");
    await humanPause(200);
    await page.keyboard.press("Enter");
  }
  await p();
}

async function fillQuantity(page: Page, quantity?: string) {
  if (!quantity) return;
  const idx: number = await page.evaluate(
    `(function() {
      var all = Array.from(document.querySelectorAll('*'));
      var sec = all.find(function(el) {
        var t = (el.innerText||el.textContent||'').trim();
        return t.indexOf('Наявність') !== -1 && t.length < 30;
      });
      if (!sec) return -1;
      var c = sec.parentElement; var d = 0;
      while (c && d < 8) {
        var i = c.querySelector('input[type="number"]');
        if (i && i.offsetParent !== null) {
          return Array.from(document.querySelectorAll('input[type="number"]')).indexOf(i);
        }
        c = c.parentElement; d++;
      }
      return -1;
    })()`
  ) as number;
  if (idx >= 0) {
    await page.locator('input[type="number"]').nth(idx).fill(quantity);
    await p();
  }
}

async function fillDescription(page: Page, description: string) {
  const ta = page.locator('textarea[placeholder*="параметри"]').first();
  await ta.scrollIntoViewIfNeeded();
  await ta.click();
  await humanPause(400);
  await ta.fill(description);
  await p();
  await page.keyboard.press("Escape");
  await humanPause(400);
  await dismissModals(page);
}

// ─── Ключові слова ────────────────────────────────────────────────────────

async function fillKeywords(page: Page, keywords: string[]) {
  if (!keywords.length) return;

  // Скролимо вниз щоб форма повністю відрендерилась
  await page.evaluate("window.scrollBy(0, 600)");
  await humanPause(600);
  await dismissModals(page);

  const findKwIdx = () => page.evaluate(`(function() {
    var allControls = Array.from(document.querySelectorAll('[class*="-control"]'));
    for (var i = 0; i < allControls.length; i++) {
      var ctrl = allControls[i];
      var placeholder = ctrl.querySelector('[class*="-placeholder"]');
      if (placeholder) {
        var t = (placeholder.innerText || placeholder.textContent || '').toLowerCase();
        if (t.indexOf('ключові') !== -1) return i;
      }
      var ctrlText = (ctrl.innerText || ctrl.textContent || '').trim();
      if (ctrlText.toLowerCase().indexOf('ключові') !== -1) return i;
    }
    // Fallback: шукаємо input з id react-select і перевіряємо label поруч
    var inputs = Array.from(document.querySelectorAll('input[id*="react-select"]'));
    for (var j = 0; j < inputs.length; j++) {
      var inp = inputs[j];
      var container = inp.closest('[class*="-container"]');
      if (!container) continue;
      var nearby = container.previousElementSibling || container.parentElement;
      if (nearby) {
        var nt = (nearby.innerText || nearby.textContent || '').toLowerCase();
        if (nt.indexOf('ключові') !== -1) {
          var ctrl2 = container.querySelector('[class*="-control"]');
          if (ctrl2) {
            return Array.from(document.querySelectorAll('[class*="-control"]')).indexOf(ctrl2);
          }
        }
      }
    }
    return -1;
  })()`);

  let kwIdx: number = await findKwIdx() as number;

  // Retry: прокручуємо нижче і шукаємо ще раз
  if (kwIdx < 0) {
    await page.evaluate("window.scrollBy(0, 400)");
    await humanPause(800);
    kwIdx = await findKwIdx() as number;
  }

  if (kwIdx < 0) {
    console.log("[Shafa] Keywords field not found, skipping");
    return;
  }
  console.log(`[Shafa] Keywords control found at index ${kwIdx}, entering ${keywords.length} keywords`);

  const kwControl = page.locator('[class*="-control"]').nth(kwIdx);
  await kwControl.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await humanPause(600);
  await kwControl.click({ force: true });
  await humanPause(500);
  await dismissModals(page);

  // Цикл: для кожного keyword — клік, введення, чекаємо loading, Enter або клік на підказку
  for (const kw of keywords) {
    await kwControl.click({ force: true });
    await humanPause(200);
    await page.keyboard.type(kw, { delay: 60 });
    await humanPause(500);
    // Чекаємо поки зникне "Loading..."
    await page.waitForFunction(
      `!document.querySelector('[class*="-loading-message"]')`,
      { timeout: 2500 }
    ).catch(() => {});
    await humanPause(300);

    const firstOption = page.locator('[class*="-option"]').first();
    if (await firstOption.isVisible({ timeout: 600 }).catch(() => false)) {
      await firstOption.click({ force: true });
    } else {
      await page.keyboard.press("Enter");
    }
    await humanPause(400);
  }

  await page.keyboard.press("Escape");
  await humanPause(300);
  await page.evaluate("document.activeElement && document.activeElement.blur()");
  await P();
}

// ─── Розміри (кнопки) ─────────────────────────────────────────────────────

async function selectSizes(page: Page, sizes: string[] | undefined, sizeSystem = "Міжнародний", debugPrefix = "shafa-") {
  if (!sizes || sizes.length === 0) return;

  // The "Розмір" section only renders after Shafa finishes processing the chosen
  // category (it fetches the category-specific size options), so poll for it instead
  // of assuming the fixed pauses already spent on category/condition/brand/etc were enough.
  const sizeSectionAppeared = await page
    .waitForFunction(
      `Array.from(document.querySelectorAll("*")).some(function(el) {
        var t = (el.innerText || el.textContent || "").trim();
        return t === "Розмір *" || t === "Розмір" || t.indexOf("Розмір") === 0;
      })`,
      undefined,
      { timeout: 8000 }
    )
    .then(() => true)
    .catch(() => false);
  console.log(`[Shafa] "Розмір" section present in DOM: ${sizeSectionAppeared}`);
  if (!sizeSectionAppeared) {
    await page.screenshot({ path: debugScreenshotPath(debugPrefix, "debug-no-size-section"), fullPage: true }).catch(() => {});
    console.log("[Shafa] Size section never appeared — saved debug-no-size-section screenshot. Category selection likely didn't fully register.");
  }

  // Scroll to size section
  const sizeHeader = page.getByText(/Розмір/i).first();
  if ((await sizeHeader.count()) > 0) {
    await sizeHeader.scrollIntoViewIfNeeded().catch(() => {});
    await humanPause(400);
  }

  // Shafa's actual tab label differs from our internal "Українські" (site shows the
  // singular adjective "Український", prefixed with a 🇺🇦 flag emoji) and its raw HTML
  // sometimes substitutes Latin lookalikes for Cyrillic С/Х — Playwright's accessible-name
  // regex compares raw characters and can silently match an unrelated element elsewhere on
  // the page, so find and click the tab the same homoglyph-normalizing way size buttons are
  // matched, scoped to buttons near the "Розмір" label (not a page-wide accessible-name search).
  const tabWord = sizeSystem === "Українські" ? "Український" : sizeSystem;
  const tabResult = await page.evaluate(`(function() {
    var word = ${JSON.stringify(tabWord)};
    function norm(s) {
      return s.replace(/Х/g,"X").replace(/х/g,"x").replace(/С/g,"C").replace(/с/g,"c")
        .replace(/\\s+/g, "").trim();
    }
    var target = norm(word);
    var all = Array.from(document.querySelectorAll("button, [role='button']"));
    var candidates = all.filter(function(b) { return b.offsetParent; });
    var match = candidates.find(function(b) {
      return norm((b.innerText||b.textContent||"").trim()).indexOf(target) !== -1;
    });
    if (!match) return { coords: null, text: null, count: candidates.length };
    match.scrollIntoView({ block: "center", behavior: "instant" });
    var r = match.getBoundingClientRect();
    return { coords: { x: r.left + r.width/2, y: r.top + r.height/2 }, text: (match.innerText||match.textContent||"").trim() };
  })()`) as { coords: { x: number; y: number } | null; text: string | null; count?: number };
  console.log(`[Shafa] Size system tab "${sizeSystem}" match: ${tabResult.coords ? `found ("${tabResult.text}") at (${Math.round(tabResult.coords.x)},${Math.round(tabResult.coords.y)})` : "not found"}`);
  if (tabResult.coords) {
    await humanPause(300);
    await page.mouse.click(tabResult.coords.x, tabResult.coords.y);
    await humanPause(800);
  }
  await page.screenshot({ path: debugScreenshotPath(debugPrefix, "debug-size-tab-selected"), fullPage: true }).catch(() => {});

  // Normalize Cyrillic lookalikes to Latin (Shafa HTML uses mixed encoding) and
  // collapse the various dash characters (hyphen, non-breaking hyphen, en/em dash)
  // that Shafa's typography may use in range labels like "40‑42" down to a plain "-".
  const normSize = (s: string) =>
    s
      .replace(/Х/g, "X").replace(/х/g, "x").replace(/С/g, "C").replace(/с/g, "c")
      .replace(/[‐-―−]/g, "-")
      .replace(/\s+/g, "")
      .trim();

  // Click each size button using mouse coordinates (bypasses React synthetic event issues)
  for (const size of sizes) {
    const normSz = normSize(size);
    // Pass as string to avoid TypeScript checking browser-context code
    const result = await page.evaluate(`(function() {
      var sz = ${JSON.stringify(normSz)};
      function norm(s) {
        return s.replace(/Х/g,"X").replace(/х/g,"x").replace(/С/g,"C").replace(/с/g,"c")
          .replace(/[\\u2010-\\u2015\\u2212]/g, "-").replace(/\\s+/g, "").trim();
      }
      var all = Array.from(document.querySelectorAll("*"));
      var sizeLabel = null; var minLen = Infinity;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el.offsetParent) continue;
        var t = (el.innerText || el.textContent || "").trim();
        if ((t === "Розмір *" || t === "Розмір" || t.indexOf("Розмір") === 0) && t.length < minLen) {
          minLen = t.length; sizeLabel = el;
        }
      }
      var container = sizeLabel ? sizeLabel.parentElement : null;
      var seenLabels = [];
      for (var d = 0; d < 10 && container; d++) {
        var btns = Array.from(container.querySelectorAll("button, [role='button']"));
        var visible = btns.filter(function(b) { return b.offsetParent; });
        seenLabels = visible.map(function(b) { return norm((b.innerText||b.textContent||"").trim()); });
        var btn = visible.find(function(b) { return norm((b.innerText||b.textContent||"").trim()) === sz; });
        if (!btn) {
          btn = visible.find(function(b) {
            var bt = norm((b.innerText||b.textContent||"").trim());
            return bt.length > 0 && (bt.indexOf(sz) !== -1 || sz.indexOf(bt) !== -1);
          });
        }
        if (btn) {
          btn.scrollIntoView({ block:"nearest", behavior:"instant" });
          var r = btn.getBoundingClientRect();
          return { coords: { x: r.left + r.width/2, y: r.top + r.height/2 }, seenLabels: seenLabels };
        }
        container = container.parentElement;
      }
      return { coords: null, seenLabels: seenLabels };
    })()`) as { coords: { x: number; y: number } | null; seenLabels: string[] };
    const coords = result.coords;

    if (coords) {
      await page.mouse.click(coords.x, coords.y);
      console.log(`[Shafa] Size "${size}" clicked`);
      await humanPause(400);
    } else {
      console.log(`[Shafa] Size "${size}" not found. Visible size buttons: ${JSON.stringify(result.seenLabels)}`);
    }
  }
  await p();
}

// ─── Кольори (кнопки) ─────────────────────────────────────────────────────

async function selectColors(page: Page, colors?: string[]) {
  if (!colors || colors.length === 0) return;
  const label = page.getByText(/відтінків/i).first();
  if ((await label.count()) > 0) {
    await label.scrollIntoViewIfNeeded().catch(() => {});
    await humanPause(400);
  }
  for (const color of colors.slice(0, 2)) {
    await clickOption(page, color);
    await p();
  }
}

// ─── Текстове поле з автодоповненням (як матеріал) ────────────────────────

async function fillLabeledTextField(page: Page, labelText: string, value: string) {
  // Знаходимо ctrl за допомогою evaluateHandle: знаходимо перший ctrl що СЛІДУЄ за label
  const ctrlHandle = await page.evaluateHandle((lbl: string) => {
    const all = Array.from(document.querySelectorAll("*"));
    const label = all.reduce((best: Element | null, el: Element) => {
      if ((el as HTMLElement).offsetParent === null) return best;
      const t = ((el as HTMLElement).innerText || el.textContent || "").trim().toLowerCase();
      const lblL = lbl.toLowerCase();
      if (!((t === lblL) || (t.indexOf(lblL) !== -1 && t.length < lbl.length + 8))) return best;
      if (!best) return el;
      return t.length < ((best as HTMLElement).innerText || best.textContent || "").trim().length ? el : best;
    }, null);
    if (!label) return null;
    // Знаходимо перший ctrl що СЛІДУЄ за label в DOM order і знаходиться поруч (спільний предок до 6 рівнів)
    const allCtrls = Array.from(document.querySelectorAll("[class*=\"-control\"]"));
    return allCtrls.find(c => {
      if (label.contains(c)) return false;
      if (!(label.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      let a = label.parentElement; let d = 0;
      while (a && d < 6) { if (a.contains(c)) return true; a = a.parentElement; d++; }
      return false;
    }) || null;
  }, labelText);

  const ctrlElement = ctrlHandle.asElement();
  if (!ctrlElement) {
    console.log(`[Shafa] Field "${labelText}" not found`);
    return;
  }

  const ctrl = ctrlElement;
  await ctrl.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await ctrl.click({ timeout: 5000 });
  } catch(e: any) {
    console.log(`[Shafa] "${labelText}" click error: ${(e as Error).message?.slice(0,80)}`);
    return;
  }
  await humanPause(500);

  const menu = page.locator('[class*="-menu"]').first();
  let menuVisible = await menu.isVisible({ timeout: 1000 }).catch(() => false);

  // Якщо меню не відкрилось (server-side autocomplete) — вводимо першу літеру
  let prefixTyped = '';
  if (!menuVisible) {
    prefixTyped = value.charAt(0).toLowerCase();
    await page.keyboard.type(prefixTyped, { delay: 60 });
    await humanPause(800);
    await page.waitForFunction(
      `!document.querySelector('[class*="-loading-message"]')`,
      { timeout: 3000 }
    ).catch(() => {});
    menuVisible = await menu.isVisible({ timeout: 1000 }).catch(() => false);
  }

  if (!menuVisible) {
    console.log(`[Shafa] "${labelText}" → no dropdown for: "${value}"`);
    await page.keyboard.press("Escape");
    return;
  }

  // Допоміжна функція: scroll option into view + click at coordinates
  const tryClickOption = async (val: string): Promise<boolean> => {
    const result2 = await page.evaluate((v: string) => {
      const opts = Array.from(document.querySelectorAll('[class*="-option"]'));
      const allTexts = opts.map(o => ((o as HTMLElement).innerText || o.textContent || '').trim()).slice(0, 20);
      const opt = opts.find(o => ((o as HTMLElement).innerText || o.textContent || '').trim() === v) as HTMLElement | undefined;
      if (!opt) return { found: false, allTexts };
      opt.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = opt.getBoundingClientRect();
      return { found: true, allTexts, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, val);
    if (!result2.found) return false;
    await humanPause(60);
    await page.mouse.click(result2.x!, result2.y!);
    return true;
  };

  if (await tryClickOption(value)) {
    console.log(`[Shafa] "${labelText}" → clicked: "${value}"`);
  } else {
    // Опція не знайдена — вводимо решту значення (після вже введеного префіксу)
    const remainingToType = prefixTyped && value.toLowerCase().startsWith(prefixTyped)
      ? value.slice(prefixTyped.length)
      : value;
    if (remainingToType !== value) {
      // Вже є перша літера — просто дописуємо решту
      await page.keyboard.type(remainingToType, { delay: 60 });
    } else {
      // Очищаємо та вводимо знову
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace");
      await humanPause(100);
      await page.keyboard.type(value, { delay: 60 });
    }
    await humanPause(700);
    await page.waitForFunction(
      `!document.querySelector('[class*="-loading-message"]')`,
      { timeout: 3000 }
    ).catch(() => {});
    await humanPause(300);
    if (await tryClickOption(value)) {
      console.log(`[Shafa] "${labelText}" → clicked via search: "${value}"`);
    } else {
      const firstOpt = menu.locator('[class*="-option"]').first();
      if (await firstOpt.isVisible({ timeout: 1000 }).catch(() => false)) {
        const optText = await firstOpt.innerText().catch(() => "?");
        await firstOpt.click({ force: true });
        console.log(`[Shafa] "${labelText}" → clicked first opt: "${optText.trim()}"`);
      } else {
        console.log(`[Shafa] "${labelText}" → no option for: "${value}"`);
        await page.keyboard.press("Escape");
      }
    }
  }
  await humanPause(400);
}

async function fillLabeledTextFields(page: Page, labelText: string, values?: string[]) {
  if (!values || values.length === 0) return;
  for (const v of values) {
    await fillLabeledTextField(page, labelText, v);
  }
}

// ─── Кнопки-опції (масив) ─────────────────────────────────────────────────

async function clickOptions(page: Page, values?: string[]) {
  if (!values || values.length === 0) return;
  for (const v of values) {
    await clickOption(page, v);
    await p();
  }
}

// ─── Ціна ─────────────────────────────────────────────────────────────────

async function fillPrice(page: Page, price: string) {
  let input = page.locator('input[name="price"]').first();
  if (!(await input.isVisible({ timeout: 1000 }).catch(() => false))) {
    input = page.locator('input[placeholder="150"]').last();
  }
  if (!(await input.isVisible({ timeout: 1000 }).catch(() => false))) return;
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await humanPause(300);
  await input.fill(price);
  await p();
}

// ─── Основний потік ───────────────────────────────────────────────────────

// ─── Виявлення полів категорії (для дебагу) ───────────────────────────────
//
// Різні категорії Shafa показують різні характеристики (напр. "Наповнення" для
// сумок/курток), і ми не можемо знати їх наперед. Тому першого разу для кожної
// категорії ми знімаємо повний зліпок полів форми і зберігаємо його у файл —
// щоб потім можна було подивитися, які саме поля є, і навчити AI їх заповнювати.

function categorySlug(categoryPath: string[]): string {
  const joined = (categoryPath || []).filter(Boolean).join("__");
  return (joined.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120)) || "unknown";
}

const schemaDir = () => `${debugDir()}/shafa-schema`;

type DiscoveredField = { label: string; kind: string; value?: string };

async function discoverCategorySchema(page: Page): Promise<{ fields: DiscoveredField[]; buttons: string[] }> {
  // NB: no named function consts inside evaluate() — tsx/esbuild would inject a
  // __name() helper that doesn't exist in the browser context and throws. Keep the
  // logic inline / anonymous, matching the other evaluate blocks in this file.
  const result = await page.evaluate(() => {
    const fields: { label: string; kind: string; value?: string }[] = [];

    // react-select style dropdown fields: a "-control" with the nearest label text before it
    const controls = Array.from(document.querySelectorAll('[class*="-control"]'))
      .filter((c) => (c as HTMLElement).offsetParent !== null);
    for (const c of controls) {
      let label = "";
      let a: Element | null = c.parentElement;
      let depth = 0;
      while (a && depth < 5 && !label) {
        for (const k of Array.from(a.children)) {
          if (k === c || k.contains(c)) break;
          const t = ((k as HTMLElement).innerText || k.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length > 1 && t.length < 40) label = t;
        }
        a = a.parentElement;
        depth++;
      }
      const value = ((c as HTMLElement).innerText || c.textContent || "").replace(/\s+/g, " ").trim();
      fields.push({ label, kind: "select", value });
    }

    // free-text inputs / textareas with a placeholder
    for (const el of Array.from(document.querySelectorAll("input[type=text], textarea"))) {
      if ((el as HTMLElement).offsetParent === null) continue;
      const ph = ((el as HTMLInputElement).placeholder || "").replace(/\s+/g, " ").trim();
      if (ph) fields.push({ label: ph, kind: el.tagName === "TEXTAREA" ? "textarea" : "text" });
    }

    // option chips / buttons (seasons, features, sleeve type, …) — raw list for reference
    const seen: Record<string, boolean> = {};
    const buttons: string[] = [];
    for (const b of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      if ((b as HTMLElement).offsetParent === null) continue;
      const t = ((b as HTMLElement).innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length > 0 && t.length < 40 && !seen[t]) { seen[t] = true; buttons.push(t); }
    }

    return { fields, buttons };
  });
  return result;
}

async function recordCategorySchema(page: Page, categoryPath: string[], debugPrefix: string) {
  try {
    const dir = schemaDir();
    await fs.mkdir(dir, { recursive: true });
    const file = `${dir}/${debugPrefix}${categorySlug(categoryPath)}.json`;
    if (await fileExists(file)) {
      console.log(`[Shafa] category schema already recorded → ${file}`);
      return;
    }
    const schema = await discoverCategorySchema(page);
    const payload = {
      categoryPath,
      url: page.url(),
      capturedAt: new Date().toISOString(),
      fields: schema.fields,
      buttons: schema.buttons,
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[Shafa] recorded category schema (${schema.fields.length} fields, ${schema.buttons.length} buttons) → ${file}`);
  } catch (e) {
    // Never let discovery break a real publish — it's a debugging aid only.
    console.log(`[Shafa] category schema discovery failed: ${(e as Error).message?.slice(0, 120)}`);
  }
}

// Returns all recorded category-field snapshots for a user (for the debug view).
export async function listCategorySchemas(userId: number): Promise<any[]> {
  try {
    const dir = schemaDir();
    if (!fsSync.existsSync(dir)) return [];
    const prefix = shafaDebugPrefixForUser(userId);
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
    const out: any[] = [];
    for (const f of files) {
      try { out.push(JSON.parse(await fs.readFile(`${dir}/${f}`, "utf8"))); } catch { /* skip bad file */ }
    }
    return out;
  } catch {
    return [];
  }
}

async function fillShafaForm(page: Page, product: ShafaProduct, debugPrefix: string) {
  await page.goto("https://shafa.ua/uk/new", { waitUntil: "domcontentloaded", timeout: 90000 });
  await humanPause(3000);
  console.log(`[Shafa] After goto /uk/new — url: ${page.url()}`);
  await page.screenshot({ path: debugScreenshotPath(debugPrefix, "debug-new-page"), fullPage: false }).catch(() => {});

  await dismissModals(page);
  await uploadImages(page, product.imagePaths);
  await P();
  await fillTitle(page, product.title);
  await P();
  await fillCategory(page, product.categoryPath);
  await P();
  // First time we see this category, snapshot all its fields to a debug file —
  // categories differ (e.g. "Наповнення"), so this lets us see and tune later.
  await recordCategorySchema(page, product.categoryPath, debugPrefix);
  await fillCondition(page, product.condition);
  await fillBrand(page, product.brand);
  await fillQuantity(page, product.quantity);
  await P();
  await fillDescription(page, product.description);
  await P();
  await fillKeywords(page, product.keywords);

  // ── Основні характеристики ──
  await selectSizes(page, product.sizes, product.sizeSystem, debugPrefix);
  await selectColors(page, product.colors);

  // ── Додаткові характеристики — текстові поля ──
  await fillLabeledTextFields(page, "Матеріал",            product.materials);
  await P();
  await fillLabeledTextFields(page, "Силует",              product.silhouette);
  await fillLabeledTextFields(page, "Фасон",               product.fashionCut);
  await fillLabeledTextFields(page, "Стиль",               product.style);
  if (product.decor) await fillLabeledTextField(page, "Декор", product.decor);
  await fillLabeledTextFields(page, "Особливості моделі",  product.modelFeatures);
  // Принт: якщо є — вводимо, якщо нема — "Без принту" (автодоповнення)
  const printValues = (product.print && product.print.length > 0)
    ? product.print
    : ["Без принту"];
  await fillLabeledTextFields(page, "Принт", printValues);

  // ── Додаткові характеристики — кнопки ──
  if (product.sleeveLength) { await clickOption(page, product.sleeveLength); await p(); }
  await clickOptions(page, product.sleeveStyle);
  await clickOptions(page, product.features);
  await clickOptions(page, product.seasons);
  if (product.madeInUkraine) { await clickOption(page, product.madeInUkraine); await p(); }

  await P();
  await fillPrice(page, product.price);
  await P();
}

// ─── Авторизація ──────────────────────────────────────────────────────────

async function isAuthorized(page: Page) {
  // Navigate to a protected page — unauthenticated sessions get redirected to /login
  await page.goto("https://shafa.ua/uk/cabinet", { waitUntil: "domcontentloaded", timeout: 60000 });
  return !page.url().includes("/login");
}

async function saveSession(context: BrowserContext, sessionPath: string) {
  const dir = path.dirname(path.resolve(sessionPath));
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
  await context.storageState({ path: sessionPath });
}

async function loginToShafa(
  page: Page, context: BrowserContext,
  sessionPath: string, login: string, password: string, debugPrefix: string
) {
  await page.goto("https://shafa.ua/uk/login", { waitUntil: "domcontentloaded" });
  await humanPause(2000);
  console.log(`[Shafa] Login page url: ${page.url()}`);
  await page.screenshot({ path: debugScreenshotPath(debugPrefix, "debug-login") }).catch(() => {});

  const loginInput = page.locator('input[placeholder*="логін"], input[placeholder*="логин"], input[name="login"], input[name="email"], input[type="email"]').first();
  await loginInput.waitFor({ timeout: 15000 });
  await loginInput.fill(login);
  await humanPause(500);

  const passwordInput = page.locator('input[placeholder*="пароль"], input[type="password"]').first();
  await passwordInput.fill(password);
  await humanPause(700);

  await page.getByRole("button", { name: /Увійти|Войти/i }).click();
  await page.waitForTimeout(6000);
  console.log(`[Shafa] After login url: ${page.url()}`);
  await page.screenshot({ path: debugScreenshotPath(debugPrefix, "debug-after-login") }).catch(() => {});
  await saveSession(context, sessionPath);
}

// ─── Логін (окрема публічна функція для UI) ───────────────────────────────
//
// sessionPath and debugPrefix are per-user — the caller (server.ts) derives both from
// the authenticated userId, so each user's Shafa login/session/debug screenshots are
// fully isolated from every other user's.
export async function loginShafaAndSaveSession(
  login: string, password: string, sessionPath: string, debugPrefix: string
): Promise<{ username?: string }> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--no-first-run", "--no-zygote", "--mute-audio",
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") route.abort();
    else route.continue();
  });
  try {
    await loginToShafa(page, context, sessionPath, login, password, debugPrefix);
    // Verify login succeeded
    const authorized = await isAuthorized(page);
    if (!authorized) throw new Error("Не вдалося увійти — перевір логін та пароль");
    // Try to get username
    let username: string | undefined;
    try {
      const urlAfter = page.url();
      const m = urlAfter.match(/\/([^/?#]+)$/);
      if (m) username = m[1];
      // Try reading profile link
      const profileLink = await page.locator('a[href*="/profile"], a[href*="/seller"]').first().getAttribute("href").catch(() => null);
      if (profileLink) {
        const pm = profileLink.match(/\/([^/?#]+)$/);
        if (pm) username = pm[1];
      }
    } catch { /* username is optional */ }
    return { username };
  } finally {
    await browser.close();
  }
}

// ─── Публічна функція ─────────────────────────────────────────────────────

export type ShafaPublishResult = {
  externalPostId?: string;
  raw?: unknown;
};

export class ShafaSessionExpiredError extends Error {
  constructor() { super("SHAFA_SESSION_EXPIRED"); this.name = "ShafaSessionExpiredError"; }
}

export async function publishToShafa(
  product: ShafaProduct, sessionPath: string, debugPrefix: string
): Promise<ShafaPublishResult> {
  if (!(await fileExists(sessionPath))) throw new ShafaSessionExpiredError();

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-plugins",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-background-networking",
      "--disable-default-apps",
      "--mute-audio",
    ],
  });

  const context = await browser.newContext({ storageState: sessionPath });

  const page = await context.newPage();

  // Block images, fonts, media — saves RAM and speeds up page loads
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "font" || type === "media") {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    if (!(await isAuthorized(page))) {
      throw new ShafaSessionExpiredError();
    }

    await fillShafaForm(page, product, debugPrefix);

    // Закриваємо будь-які відкриті dropdown перед сабмітом
    await page.keyboard.press("Escape");
    await humanPause(500);
    await page.evaluate("document.body.click()");
    await humanPause(800);
    await dismissModals(page);

    // Скріншот перед сабмітом
    await page.screenshot({ path: debugScreenshotPath(debugPrefix, "before-submit"), fullPage: true }).catch(() => {});

    // Натискаємо "Додати річ" через координати миші (React-сумісний спосіб)
    const submitCoords = await page.evaluate(`(function() {
      var btns = Array.from(document.querySelectorAll('button'));
      var b = btns.find(function(b) {
        return /Додати річ|Добавить вещь|Зберегти/i.test((b.innerText||b.textContent||'').trim()) && b.offsetParent;
      });
      if (!b) return null;
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
      var r = b.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, text: (b.innerText||b.textContent||'').trim() };
    })()`);

    if (!submitCoords) throw new Error("Кнопка 'Додати річ' не знайдена на сторінці");
    const sc = submitCoords as { x: number; y: number; text: string };
    console.log(`[Shafa] Submit btn found: "${sc.text}" at (${sc.x.toFixed(0)},${sc.y.toFixed(0)})`);

    await humanPause(500);
    await page.mouse.click(sc.x, sc.y);
    console.log("[Shafa] Submit btn clicked via mouse");

    // Читаємо помилки форми через 2с після кліку — до dismiss щоб не скидати стан
    await humanPause(2000);

    const getFormErrors = async () => {
      return page.evaluate(`(function() {
        var sels = ['[class*="error"]','[class*="Error"]','[class*="invalid"]','[class*="Invalid"]',
                    '[role="alert"]','.alert','[class*="message"]','[class*="Message"]',
                    '[class*="warning"]','[class*="Warning"]','[class*="hint"]','[class*="Hint"]'];
        var seen = {};
        var result = [];
        for (var i = 0; i < sels.length; i++) {
          document.querySelectorAll(sels[i]).forEach(function(el) {
            var t = (el.innerText || el.textContent || '').trim();
            if (t && t.length > 2 && t.length < 300 && !seen[t]) { seen[t]=1; result.push(t); }
          });
        }
        return result;
      })()`);
    };

    let formErrors = (await getFormErrors()) as string[];
    if (formErrors.length) console.log(`[Shafa] Form errors after click:`, formErrors);

    await page.screenshot({ path: debugScreenshotPath(debugPrefix, "after-click"), fullPage: true }).catch(() => {});

    // Чекаємо переходу — Shafa робить редирект після успішної публікації.
    // Успішне створення веде на /uk/new/<id>/promotion-packages (з ID товару),
    // тому перевіряти можна лише на "все ще на голій формі створення" (без ID),
    // а не на будь-яке входження "/new" — інакше сторінка з пропозицією
    // платного просування помилково сприймається як провал.
    const isCreateFormUrl = (u: string) => /\/new\/?(\?.*)?$/.test(u);
    let finalUrl = page.url();
    try {
      await page.waitForURL(
        url => !isCreateFormUrl(url.toString()),
        { timeout: 30000 }
      );
      finalUrl = page.url();
      console.log(`[Shafa] Success! Redirected to: ${finalUrl}`);
    } catch {
      finalUrl = page.url();
      // Перечитуємо помилки після повного очікування
      formErrors = (await getFormErrors()) as string[];
      if (formErrors.length) console.log(`[Shafa] Form errors after timeout:`, formErrors);
      console.log(`[Shafa] No redirect after 30s, current url: ${finalUrl}`);
      await page.screenshot({ path: debugScreenshotPath(debugPrefix, "submit-error"), fullPage: true }).catch(() => {});

      // Дамп всього видимого тексту сторінки для діагностики
      const pageText = await page.evaluate(`(function() {
        function vis(el) { return el.offsetParent !== null || el.tagName === 'BODY'; }
        var lines = [];
        document.querySelectorAll('p,span,div,label,h1,h2,h3,h4,li,button,[role="alert"],[class*="error"],[class*="Error"],[class*="message"],[class*="Message"],[class*="valid"]').forEach(function(el) {
          if (!vis(el)) return;
          var t = (el.innerText||el.textContent||'').trim();
          if (t && t.length > 1 && t.length < 200) lines.push(t);
        });
        var unique = lines.filter(function(v,i,a){ return a.indexOf(v)===i; });
        return unique.slice(0, 60).join(' | ');
      })()`).catch(() => "");
      console.log(`[Shafa] Page text dump:`, pageText);

      if (isCreateFormUrl(finalUrl)) {
        const errMsg = formErrors.length ? formErrors.join("; ") : "Форма не відправилась — URL не змінився після сабміту";
        throw new Error(errMsg);
      }
      console.log(`[Shafa] Accepted as success: ${finalUrl}`);
    }

    // Save updated session
    await saveSession(context, sessionPath).catch(() => {});

    await page.screenshot({ path: debugScreenshotPath(debugPrefix, "after-submit"), fullPage: true }).catch(() => {});
    return { externalPostId: finalUrl };
  } finally {
    await browser.close();
  }
}
