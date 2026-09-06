// ── Auth helper ─────────────────────────────────────────
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  const target = String(args[0] || "");
  if (response.status === 401 && target.startsWith("/api/")) {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userEmail");
    window.location.replace("/login.html");
  }
  return response;
};

function authHeaders() {
  const token = localStorage.getItem('authToken');
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

// ── DOM refs ────────────────────────────────────────────
const form                = document.getElementById("productForm");
const photosInput         = document.getElementById("photos");
const videoInput          = document.getElementById("video");
const uploadBox           = document.getElementById("uploadBox");
const photoGallery        = document.getElementById("photoGallery");
const videoPreview        = document.getElementById("videoPreview");
const previewBtn          = document.getElementById("previewBtn");
const publishSelectedBtn  = document.getElementById("publishSelectedBtn");
const scheduleSelectedBtn = document.getElementById("scheduleSelectedBtn");
const newProductBtn       = document.getElementById("newProductBtn");
const previewPanel        = document.getElementById("previewPanel");
const tabs                = document.getElementById("tabs");
const platformEditor      = document.getElementById("platformEditor");
const statusMessage       = document.getElementById("statusMessage");
const productIdBadge      = document.getElementById("productIdBadge");

// ── 1. TOAST NOTIFICATIONS ───────────────────────────────
function showToast(message, type = "success", duration = 4500) {
  const container = document.getElementById("toastContainer");
  if (!container || !message) return;

  const icon = type === "success" ? "✓" : type === "error" ? "✕" : "⋯";
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Закрити">×</button>
  `;
  toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(toast));
  container.appendChild(toast);

  if (duration > 0) setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add("toast-out");
  setTimeout(() => toast.remove(), 260);
}

function showMessage(message, type = "success") {
  if (statusMessage) {
    statusMessage.textContent = message;
    statusMessage.className = `status ${type}`;
  }
  if (message) showToast(message, type);
}

// ── 2. PROGRESS BAR ──────────────────────────────────────
function setLoading(isLoading, text = "") {
  [previewBtn, publishSelectedBtn, scheduleSelectedBtn].forEach(b => {
    b.disabled = isLoading;
  });

  const bar = document.getElementById("progressBar");
  const msg = document.getElementById("progressMsg");

  if (isLoading) {
    bar?.classList.remove("hidden");
    if (msg) msg.textContent = text;
    if (statusMessage) {
      statusMessage.textContent = text;
      statusMessage.className = "status loading";
    }
  } else {
    bar?.classList.add("hidden");
    if (msg) msg.textContent = "";
  }
}

// ── 5. PRESETS (localStorage) ────────────────────────────
const PRESETS_KEY      = "ai-post-presets-v1";
const LAST_SETTINGS_KEY = "ai-post-last-settings-v1";

function getPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]"); } catch { return []; }
}

function savePresetData(name) {
  const presets = getPresets().filter(p => p.name !== name);
  presets.unshift({
    name,
    platforms: selectedPlatforms(),
    videoStyle: form.querySelector('input[name="videoStyle"]:checked')?.value || "fashion",
  });
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets.slice(0, 8)));
  refreshPresetSelect();
  showToast(`Шаблон «${name}» збережено`, "success", 3000);
}

function applyPreset(name) {
  const preset = getPresets().find(p => p.name === name);
  if (!preset) return;
  form.querySelectorAll('input[name="selectedPlatforms"]').forEach(cb => {
    cb.checked = preset.platforms.includes(cb.value);
  });
  if (preset.videoStyle) {
    const radio = form.querySelector(`input[name="videoStyle"][value="${preset.videoStyle}"]`);
    if (radio) {
      radio.checked = true;
      form.querySelectorAll(".video-style-card").forEach(c => c.classList.remove("active"));
      radio.closest(".video-style-card")?.classList.add("active");
    }
  }
  saveLastSettings();
}

function refreshPresetSelect() {
  const sel = document.getElementById("presetSelect");
  if (!sel) return;
  const presets = getPresets();
  sel.innerHTML = `<option value="">Шаблон налаштувань...</option>` +
    presets.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
}

function saveLastSettings() {
  try {
    localStorage.setItem(LAST_SETTINGS_KEY, JSON.stringify({
      platforms: selectedPlatforms(),
      videoStyle: form.querySelector('input[name="videoStyle"]:checked')?.value || "fashion",
    }));
  } catch {}
}

function loadLastSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LAST_SETTINGS_KEY) || "{}");
    if (s.platforms?.length) {
      form.querySelectorAll('input[name="selectedPlatforms"]').forEach(cb => {
        cb.checked = s.platforms.includes(cb.value);
      });
    }
    if (s.videoStyle) {
      const radio = form.querySelector(`input[name="videoStyle"][value="${s.videoStyle}"]`);
      if (radio) {
        radio.checked = true;
        form.querySelectorAll(".video-style-card").forEach(c => c.classList.remove("active"));
        radio.closest(".video-style-card")?.classList.add("active");
      }
    }
  } catch {}
}

function initPresets() {
  refreshPresetSelect();
  loadLastSettings();

  document.getElementById("presetSelect")?.addEventListener("change", e => {
    if (e.target.value) applyPreset(e.target.value);
    e.target.value = "";
  });

  document.getElementById("savePresetBtn")?.addEventListener("click", () => {
    const name = prompt("Назва шаблону (наприклад: TG + Instagram):");
    if (name?.trim()) savePresetData(name.trim());
  });

  // Auto-save last settings when platforms or video style change
  form.addEventListener("change", e => {
    if (
      e.target.name === "selectedPlatforms" ||
      e.target.name === "videoStyle"
    ) saveLastSettings();
  });
}

// ── Video style ──────────────────────────────────────────
function initVideoStyles() {
  document.querySelectorAll('input[name="videoStyle"]').forEach(radio => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".video-style-card").forEach(c => c.classList.remove("active"));
      radio.closest(".video-style-card")?.classList.add("active");
    });
  });

  form.querySelector('input[name="generateVideo"]')
    ?.addEventListener("change", syncVideoSettingsVisibility);

  syncVideoSettingsVisibility();
}

function syncVideoSettingsVisibility() {
  const videoSettings   = document.getElementById("videoSettings");
  const videoStyleSelect = document.getElementById("videoStyleSelect");
  const generateVideoInput = form.querySelector('input[name="generateVideo"]');
  const hasVideo = !!videoInput?.files?.length;

  if (!videoSettings) return;
  videoSettings.classList.toggle("hidden", !hasVideo);

  if (videoStyleSelect && generateVideoInput) {
    videoStyleSelect.classList.toggle("hidden", !generateVideoInput.checked);
  }
}

// ── Platform names / constants ───────────────────────────
const platformNames = {
  telegram:  "Telegram",
  instagram: "Instagram",
  facebook:  "Facebook",
  tiktok:    "TikTok",
  shafa:     "Shafa.ua",
  prom:      "Prom.ua",
  olx:       "OLX",
  rozetka:   "Rozetka",
  kasta:     "Kasta.ua",
};

// Побудовано на основі реальної структури каталогу Shafa (sitemap-catalogs-items.xml),
// а не вигадано вручну — тому набагато повніше за попередній список і включає розділ
// "Нижня білизна та купальники" (корсети, ліфчики, боді тощо), якого раніше не було.
// Точні назви кнопок на самій Shafa не перевірялись наживо (немає доступу для скрапінгу),
// тому fillCategory() в publisher'і тепер шукає категорію не строго точним співпадінням,
// а стійким до дрібних розбіжностей — якщо назва все ж не збіжиться, лог покаже реальні
// назви на сторінці в той момент.
const SHAFA_CATEGORY_PRESETS = [
  { group: "Плаття",                          label: "Максі-сукні",            path: ["Жіночий одяг", "Плаття", "Максі"] },
  { group: "Плаття",                          label: "Міді-сукні",             path: ["Жіночий одяг", "Плаття", "Міді"] },
  { group: "Плаття",                          label: "Міні-сукні",             path: ["Жіночий одяг", "Плаття", "Міні"] },
  { group: "Плаття",                          label: "Сарафани",               path: ["Жіночий одяг", "Плаття", "Сарафани"] },
  { group: "Плаття",                          label: "Весільні сукні",         path: ["Жіночий одяг", "Плаття", "Весільні"] },
  { group: "Плаття",                          label: "Туніки",                 path: ["Жіночий одяг", "Плаття", "Туніки"] },
  { group: "Плаття",                          label: "Вечірні сукні",          path: ["Жіночий одяг", "Плаття", "Вечірні"] },

  { group: "Кофти",                           label: "Болеро",                 path: ["Жіночий одяг", "Кофти", "Болеро"] },
  { group: "Кофти",                           label: "Джемпери",               path: ["Жіночий одяг", "Кофти", "Джемпери"] },
  { group: "Кофти",                           label: "Худі",                   path: ["Жіночий одяг", "Кофти", "Худі"] },
  { group: "Кофти",                           label: "Кардигани",              path: ["Жіночий одяг", "Кофти", "Кардигани"] },
  { group: "Кофти",                           label: "Лонгсліви",              path: ["Жіночий одяг", "Кофти", "Лонгсліви"] },
  { group: "Кофти",                           label: "Накидки",                path: ["Жіночий одяг", "Кофти", "Накидки"] },
  { group: "Кофти",                           label: "Пончо",                  path: ["Жіночий одяг", "Кофти", "Пончо"] },
  { group: "Кофти",                           label: "Пуловери",               path: ["Жіночий одяг", "Кофти", "Пуловери"] },
  { group: "Кофти",                           label: "Реглани",                path: ["Жіночий одяг", "Кофти", "Реглан"] },
  { group: "Кофти",                           label: "Светри",                 path: ["Жіночий одяг", "Кофти", "Светри"] },
  { group: "Кофти",                           label: "Світшоти",               path: ["Жіночий одяг", "Кофти", "Світшоти"] },
  { group: "Кофти",                           label: "Толстовки",              path: ["Жіночий одяг", "Кофти", "Толстовки"] },
  { group: "Кофти",                           label: "Водолазки",              path: ["Жіночий одяг", "Кофти", "Водолазки"] },
  { group: "Кофти",                           label: "Жилети",                 path: ["Жіночий одяг", "Кофти", "Жилети"] },

  { group: "Майки та футболки",               label: "Футболки",               path: ["Жіночий одяг", "Майки та футболки", "Футболки"] },
  { group: "Майки та футболки",               label: "Майки",                  path: ["Жіночий одяг", "Майки та футболки", "Майки"] },
  { group: "Майки та футболки",               label: "Поло",                   path: ["Жіночий одяг", "Майки та футболки", "Поло"] },
  { group: "Майки та футболки",               label: "Топи",                   path: ["Жіночий одяг", "Майки та футболки", "Топи"] },

  { group: "Нижня білизна та купальники",     label: "Корсети",                path: ["Жіночий одяг", "Нижня білизна та купальники", "Корсети"] },
  { group: "Нижня білизна та купальники",     label: "Ліфчики",                path: ["Жіночий одяг", "Нижня білизна та купальники", "Ліфчики"] },
  { group: "Нижня білизна та купальники",     label: "Боді",                   path: ["Жіночий одяг", "Нижня білизна та купальники", "Боді"] },
  { group: "Нижня білизна та купальники",     label: "Комплекти",              path: ["Жіночий одяг", "Нижня білизна та купальники", "Комплекти"] },
  { group: "Нижня білизна та купальники",     label: "Трусики",                path: ["Жіночий одяг", "Нижня білизна та купальники", "Трусики"] },
  { group: "Нижня білизна та купальники",     label: "Купальники",             path: ["Жіночий одяг", "Нижня білизна та купальники", "Купальники"] },
  { group: "Нижня білизна та купальники",     label: "Білизняні майки",        path: ["Жіночий одяг", "Нижня білизна та купальники", "Білизняні майки"] },
  { group: "Нижня білизна та купальники",     label: "Пеньюари",               path: ["Жіночий одяг", "Нижня білизна та купальники", "Пеньюари"] },
  { group: "Нижня білизна та купальники",     label: "Термобілизна",           path: ["Жіночий одяг", "Нижня білизна та купальники", "Термобілизна"] },
  { group: "Нижня білизна та купальники",     label: "Колготки",               path: ["Жіночий одяг", "Нижня білизна та купальники", "Колготки"] },
  { group: "Нижня білизна та купальники",     label: "Панчохи",                path: ["Жіночий одяг", "Нижня білизна та купальники", "Панчохи"] },
  { group: "Нижня білизна та купальники",     label: "Аксесуари (білизна)",    path: ["Жіночий одяг", "Нижня білизна та купальники", "Аксесуари"] },

  { group: "Одяг для дому та сну",            label: "Домашній одяг",          path: ["Жіночий одяг", "Одяг для дому та сну", "Домашній одяг"] },
  { group: "Одяг для дому та сну",            label: "Халати",                 path: ["Жіночий одяг", "Одяг для дому та сну", "Халати"] },
  { group: "Одяг для дому та сну",            label: "Кігурумі",               path: ["Жіночий одяг", "Одяг для дому та сну", "Кігурумі"] },
  { group: "Одяг для дому та сну",            label: "Нічні сорочки",          path: ["Жіночий одяг", "Одяг для дому та сну", "Нічні сорочки"] },
  { group: "Одяг для дому та сну",            label: "Піжами",                 path: ["Жіночий одяг", "Одяг для дому та сну", "Піжами"] },

  { group: "Сорочки та блузи",                label: "Блузи",                  path: ["Жіночий одяг", "Сорочки та блузи", "Блузи"] },
  { group: "Сорочки та блузи",                label: "Сорочки",                path: ["Жіночий одяг", "Сорочки та блузи", "Сорочки"] },
  { group: "Сорочки та блузи",                label: "Вишиванки",              path: ["Жіночий одяг", "Сорочки та блузи", "Вишиванки"] },

  { group: "Штани",                           label: "Джинси",                 path: ["Жіночий одяг", "Штани", "Джинси"] },
  { group: "Штани",                           label: "Брюки",                  path: ["Жіночий одяг", "Штани", "Брюки"] },
  { group: "Штани",                           label: "Бриджі",                 path: ["Жіночий одяг", "Штани", "Бриджі"] },
  { group: "Штани",                           label: "Легінси",                path: ["Жіночий одяг", "Штани", "Легінси"] },
  { group: "Штани",                           label: "Шорти",                  path: ["Жіночий одяг", "Штани", "Шорти"] },

  { group: "Верхній одяг",                    label: "Куртки",                 path: ["Жіночий одяг", "Верхній одяг", "Куртки"] },
  { group: "Верхній одяг",                    label: "Пальта",                 path: ["Жіночий одяг", "Верхній одяг", "Пальта"] },
  { group: "Верхній одяг",                    label: "Плащі",                  path: ["Жіночий одяг", "Верхній одяг", "Плащі"] },
  { group: "Верхній одяг",                    label: "Дублянки",               path: ["Жіночий одяг", "Верхній одяг", "Дублянки"] },
  { group: "Верхній одяг",                    label: "Шуби",                   path: ["Жіночий одяг", "Верхній одяг", "Шуби"] },
  { group: "Верхній одяг",                    label: "Пуховики",               path: ["Жіночий одяг", "Верхній одяг", "Пуховики"] },
  { group: "Верхній одяг",                    label: "Вітрівки",               path: ["Жіночий одяг", "Верхній одяг", "Вітрівки"] },
  { group: "Верхній одяг",                    label: "Парки",                  path: ["Жіночий одяг", "Верхній одяг", "Парки"] },
  { group: "Верхній одяг",                    label: "Дощовики",               path: ["Жіночий одяг", "Верхній одяг", "Дощовики"] },
  { group: "Верхній одяг",                    label: "Піджаки та жакети",      path: ["Жіночий одяг", "Верхній одяг", "Піджаки та жакети"] },
  { group: "Верхній одяг",                    label: "Жилетки",                path: ["Жіночий одяг", "Верхній одяг", "Жилетки"] },

  { group: "Спідниці",                        label: "Спідниці міні",          path: ["Жіночий одяг", "Спідниці", "Міні"] },
  { group: "Спідниці",                        label: "Спідниці міді",          path: ["Жіночий одяг", "Спідниці", "Міді"] },
  { group: "Спідниці",                        label: "Спідниці максі",         path: ["Жіночий одяг", "Спідниці", "Максі"] },

  { group: "Жіночі комбінезони",              label: "Брючні комбінезони",     path: ["Жіночий одяг", "Жіночі комбінезони", "Брючні комбінезони"] },
  { group: "Жіночі комбінезони",              label: "Джинсові комбінезони",   path: ["Жіночий одяг", "Жіночі комбінезони", "Джинсові комбінезони"] },
  { group: "Жіночі комбінезони",              label: "Комбінезони з шортами",  path: ["Жіночий одяг", "Жіночі комбінезони", "Комбінезони з шортами"] },

  { group: "Жіночі костюми",                  label: "Брючні костюми",         path: ["Жіночий одяг", "Жіночі костюми", "Брючні костюми"] },
  { group: "Жіночі костюми",                  label: "Костюми з платтям",      path: ["Жіночий одяг", "Жіночі костюми", "Костюми з платтям"] },
  { group: "Жіночі костюми",                  label: "Костюми з шортами",      path: ["Жіночий одяг", "Жіночі костюми", "Костюми з шортами"] },
  { group: "Жіночі костюми",                  label: "Костюми зі спідницею",   path: ["Жіночий одяг", "Жіночі костюми", "Костюми зі спідницею"] },

  { group: "Спорт та відпочинок",             label: "Спортивні костюми",      path: ["Жіночий одяг", "Спорт та відпочинок", "Спортивні костюми"] },
  { group: "Спорт та відпочинок",             label: "Спортивні штани",        path: ["Жіночий одяг", "Спорт та відпочинок", "Спортивні штани"] },
  { group: "Спорт та відпочинок",             label: "Топи спортивні",         path: ["Жіночий одяг", "Спорт та відпочинок", "Топи"] },
  { group: "Спорт та відпочинок",             label: "Майки спортивні",        path: ["Жіночий одяг", "Спорт та відпочинок", "Майки"] },
  { group: "Спорт та відпочинок",             label: "Лосини",                 path: ["Жіночий одяг", "Спорт та відпочинок", "Лосини"] },
  { group: "Спорт та відпочинок",             label: "Шорти спортивні",        path: ["Жіночий одяг", "Спорт та відпочинок", "Шорти"] },
  { group: "Спорт та відпочинок",             label: "Кофти спортивні",        path: ["Жіночий одяг", "Спорт та відпочинок", "Кофти"] },
  { group: "Спорт та відпочинок",             label: "Капрі",                  path: ["Жіночий одяг", "Спорт та відпочинок", "Капрі"] },

  { group: "Інше",                            label: "Пляжний одяг",           path: ["Жіночий одяг", "Пляжний одяг"] },
  { group: "Інше",                            label: "Для вагітних",           path: ["Жіночий одяг", "Для вагітних"] },
];

let shafaExtras = {
  brand: "",
  categoryPath: ["Жіночий одяг", "Плаття", "Міді"],
  condition: "Новий",
  season: "",
  sleeveLength: "",
  madeInUkraine: "",
};

function renderShafaExtras() {
  const catMatch = SHAFA_CATEGORY_PRESETS.findIndex(
    p => JSON.stringify(p.path) === JSON.stringify(shafaExtras.categoryPath)
  );
  return `
    <div class="shafa-extras">
      <h4 style="margin:16px 0 10px;font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;font-weight:600">
        Поля для Shafa.ua
      </h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <label style="grid-column:1/-1">
          Категорія
          <select id="shafaCategoryPreset">
            <option value="-1">— шаблон категорії —</option>
            ${(() => {
              const groups = [];
              SHAFA_CATEGORY_PRESETS.forEach((p, i) => {
                let g = groups.find(g => g.name === p.group);
                if (!g) { g = { name: p.group, items: [] }; groups.push(g); }
                g.items.push({ ...p, i });
              });
              return groups.map(g => `
                <optgroup label="${escapeHtml(g.name)}">
                  ${g.items.map(p =>
                    `<option value="${p.i}" ${catMatch === p.i ? "selected" : ""}>${p.label}</option>`
                  ).join("")}
                </optgroup>
              `).join("");
            })()}
          </select>
        </label>
        <label>
          Розділ 1
          <input type="text" id="shafaCat1" value="${escapeHtml(shafaExtras.categoryPath[0] || "")}" placeholder="Жіночий одяг">
        </label>
        <label>
          Розділ 2
          <input type="text" id="shafaCat2" value="${escapeHtml(shafaExtras.categoryPath[1] || "")}" placeholder="Плаття">
        </label>
        <label style="grid-column:1/-1">
          Підкатегорія
          <input type="text" id="shafaCat3" value="${escapeHtml(shafaExtras.categoryPath[2] || "")}" placeholder="Сукні міді">
        </label>
        <label>
          Бренд
          <input type="text" id="shafaBrand" value="${escapeHtml(shafaExtras.brand)}" placeholder="Zara, H&M, No name...">
        </label>
        <label>
          Стан
          <select id="shafaCondition">
            ${["Новий","Ідеальний","Дуже хороший","Хороший","Задовільний"].map(v =>
              `<option value="${v}" ${shafaExtras.condition === v ? "selected" : ""}>${v}</option>`
            ).join("")}
          </select>
        </label>
        <label>
          Сезон
          <select id="shafaSeason">
            <option value="">— не вказано</option>
            ${["Весна","Демісезон","Зима","Літо","Осінь"].map(v =>
              `<option value="${v}" ${shafaExtras.season === v ? "selected" : ""}>${v}</option>`
            ).join("")}
          </select>
        </label>
        <label>
          Рукав
          <select id="shafaSleeveLength">
            <option value="">— не вказано</option>
            ${["Без рукавів","Довгий","Короткий","Три чверті"].map(v =>
              `<option value="${v}" ${shafaExtras.sleeveLength === v ? "selected" : ""}>${v}</option>`
            ).join("")}
          </select>
        </label>
        <label>
          Зроблено в Україні
          <select id="shafaMadeInUkraine">
            <option value="">— ні</option>
            ${["Виробництво","Хендмейд"].map(v =>
              `<option value="${v}" ${shafaExtras.madeInUkraine === v ? "selected" : ""}>${v}</option>`
            ).join("")}
          </select>
        </label>
      </div>
    </div>
  `;
}

function syncShafaExtras() {
  const preset  = document.getElementById("shafaCategoryPreset");
  const cat1    = document.getElementById("shafaCat1");
  const cat2    = document.getElementById("shafaCat2");
  const cat3    = document.getElementById("shafaCat3");
  const brand   = document.getElementById("shafaBrand");
  const cond    = document.getElementById("shafaCondition");
  const season  = document.getElementById("shafaSeason");
  const sleeve  = document.getElementById("shafaSleeveLength");
  const ukraine = document.getElementById("shafaMadeInUkraine");

  preset?.addEventListener("change", () => {
    const idx = Number(preset.value);
    if (idx >= 0 && SHAFA_CATEGORY_PRESETS[idx]) {
      const path = SHAFA_CATEGORY_PRESETS[idx].path;
      if (cat1) cat1.value = path[0] || "";
      if (cat2) cat2.value = path[1] || "";
      if (cat3) cat3.value = path[2] || "";
      shafaExtras.categoryPath = [...path];
    }
  });

  [cat1, cat2, cat3].forEach((el, i) => {
    el?.addEventListener("input", () => { shafaExtras.categoryPath[i] = el.value; });
  });

  brand?.addEventListener("input",   () => { shafaExtras.brand         = brand.value; });
  cond?.addEventListener("change",   () => { shafaExtras.condition     = cond.value; });
  season?.addEventListener("change", () => { shafaExtras.season        = season.value; });
  sleeve?.addEventListener("change", () => { shafaExtras.sleeveLength  = sleeve.value; });
  ukraine?.addEventListener("change",() => { shafaExtras.madeInUkraine = ukraine.value; });
}

// ── State ────────────────────────────────────────────────
let currentProduct    = null;
let currentImages     = [];
let platformPosts     = [];
let activePlatform    = "telegram";
let selectedPhotoFiles = [];
let selectedVideoFile  = null;
let tiktokCreatorState = {
  postId: null,
  info: null,
  videoDurationSec: null,
  loading: false,
  error: "",
};
const tiktokStatusPollers = new Map();

function setInputFiles(input, files) {
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  input.files = dt.files;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedPlatforms() {
  return [...form.querySelectorAll('input[name="selectedPlatforms"]:checked')].map(i => i.value);
}

function getFormPayload() {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    title: data.title || "",
    model: data.model || "",
    price: data.price || "",
    dropPrice: data.dropPrice || "",
    priceMarkup: data.priceMarkup || "",
    sizes: data.sizes || "",
    sizeSystem: data.sizeSystem || "Міжнародний",
    colors: data.colors || "",
    fabric: data.fabric || "",
    description: data.description || "",
  };
}

function currentPost() {
  return platformPosts.find(p => p.platform === activePlatform);
}

function syncCurrentTextarea() {
  const textarea = platformEditor.querySelector(".post-textarea");
  const post = currentPost();
  if (textarea && post) post.text = textarea.value;
}

const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Усі",
  MUTUAL_FOLLOW_FRIENDS: "Друзі (взаємні підписки)",
  FOLLOWER_OF_CREATOR: "Підписники",
  SELF_ONLY: "Лише я",
};

function getTikTokSettings(post) {
  const raw = post?.platformSettings && typeof post.platformSettings === "object"
    ? post.platformSettings
    : {};
  const commercialContent = raw.commercialContent === true;
  const settings = {
    privacyLevel: String(raw.privacyLevel || ""),
    allowComment: raw.allowComment === true,
    allowDuet: raw.allowDuet === true,
    allowStitch: raw.allowStitch === true,
    commercialContent,
    yourBrand: commercialContent && raw.yourBrand === true,
    brandedContent: commercialContent && raw.brandedContent === true,
    musicUsageAccepted: raw.musicUsageAccepted === true,
  };
  if (post) post.platformSettings = settings;
  return settings;
}

// Формат публікації в Instagram. З одного набору медіа виходять різні пости,
// і вибір не косметичний: карусель із відео першим слайдом не потрапляє в стрічку
// Reels, тобто не дає охоплення поза підписниками.
const INSTAGRAM_FORMATS = [
  { value: "auto",      label: "Авто",              hint: "Формат за набором медіа: є відео — Reels, кілька фото — карусель." },
  { value: "reels",     label: "Reels (відео)",     hint: "Вертикальне відео товару. Головний формат для охоплення." },
  { value: "slideshow", label: "Слайдшоу з фото",   hint: "Reels, зібраний із фото товару — для позицій без відеозйомки." },
  { value: "carousel",  label: "Карусель",          hint: "Фото в стрічку. Оптимально 4–6, більше догортує менше людей." },
  { value: "story",     label: "Сторіз",            hint: "Кадр 9:16 із запеченою ціною. Живе 24 години, підпису немає." },
];

let instagramMediaState = { productId: null, format: "", busy: false, error: "" };

function getInstagramSettings(post) {
  const raw = post?.platformSettings && typeof post.platformSettings === "object"
    ? post.platformSettings
    : {};
  const known = INSTAGRAM_FORMATS.some(item => item.value === raw.format);
  const settings = { format: known ? raw.format : "auto" };
  if (post) post.platformSettings = settings;
  return settings;
}

function syncInstagramSettingsFromForm(post) {
  if (!post || post.platform !== "instagram") return getInstagramSettings(post);
  const format = platformEditor.querySelector("#instagramFormat")?.value || "auto";
  const settings = { format: INSTAGRAM_FORMATS.some(item => item.value === format) ? format : "auto" };
  post.platformSettings = settings;
  return settings;
}

function getInstagramPublishBlockReason(post) {
  if (!post || post.platform !== "instagram") return "";
  const { format } = getInstagramSettings(post);
  const hasVideo = !!(currentProduct?.videoUrl || currentProduct?.processedVideoUrl);
  const hasPhotos = (currentImages?.length || 0) > 0;

  if (format === "reels" && !hasVideo) return "Для Reels завантаж відео або обери «Слайдшоу з фото»";
  if (format === "slideshow" && !currentProduct?.slideshowVideoUrl) return "Спочатку збери слайдшоу з фото";
  if (format === "carousel" && !hasPhotos) return "Для каруселі завантаж фото товару";
  if (format === "story" && !currentProduct?.storyImageUrl && !hasPhotos && !hasVideo) {
    return "Для сторіз завантаж фото або відео товару";
  }
  if (format === "auto" && !hasPhotos && !hasVideo) return "Завантаж фото або відео товару";
  return "";
}

function renderInstagramExtras(post) {
  const { format } = getInstagramSettings(post);
  const hasVideo = !!(currentProduct?.videoUrl || currentProduct?.processedVideoUrl);
  const hasPhotos = (currentImages?.length || 0) > 0;
  const active = INSTAGRAM_FORMATS.find(item => item.value === format) || INSTAGRAM_FORMATS[0];
  const stateMatches = instagramMediaState.productId === currentProduct?.id;
  const busy = stateMatches && instagramMediaState.busy;
  const error = stateMatches ? instagramMediaState.error : "";

  const options = INSTAGRAM_FORMATS
    .map(item => `<option value="${item.value}" ${item.value === format ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");

  let mediaBlock = "";
  if (format === "slideshow") {
    const ready = !!currentProduct?.slideshowVideoUrl;
    mediaBlock = `
      <div class="instagram-media-row">
        <div>
          <strong>${ready ? "Слайдшоу готове" : "Слайдшоу ще не зібране"}</strong>
          <small>${hasPhotos
            ? `Збираємо вертикальний ролик 1080×1920 з фото товару (до 6 кадрів).`
            : `Спочатку завантаж фото товару.`}</small>
        </div>
        <button type="button" class="btn secondary prepare-instagram-media" data-format="slideshow" ${busy || !hasPhotos ? "disabled" : ""}>
          ${busy ? "Збираємо…" : ready ? "Перезібрати" : "Зібрати слайдшоу"}
        </button>
      </div>
      ${ready ? `<video class="instagram-media-preview" src="${escapeHtml(currentProduct.slideshowVideoUrl)}" controls playsinline></video>` : ""}
    `;
  } else if (format === "story") {
    const ready = !!currentProduct?.storyImageUrl;
    mediaBlock = `
      <div class="instagram-media-row">
        <div>
          <strong>${ready ? "Кадр для сторіз готовий" : "Кадр для сторіз не готовий"}</strong>
          <small>У сторіз немає підпису — назву й ціну запікаємо в саме зображення 9:16.</small>
        </div>
        <button type="button" class="btn secondary prepare-instagram-media" data-format="story" ${busy || !hasPhotos ? "disabled" : ""}>
          ${busy ? "Готуємо…" : ready ? "Оновити кадр" : "Підготувати кадр"}
        </button>
      </div>
      ${ready ? `<img class="instagram-media-preview" src="${escapeHtml(currentProduct.storyImageUrl)}" alt="Кадр для сторіз">` : ""}
      <small class="instagram-note">Опитування, посилання й інші наліпки через API недоступні — їх можна додати вручну вже до опублікованої сторіз.</small>
    `;
  } else if (format === "auto" && hasVideo && hasPhotos) {
    mediaBlock = `
      <small class="instagram-note warn">Є і відео, і фото: вийде карусель із відео першим слайдом. Вона не потрапляє в стрічку Reels — для охоплення обери «Reels (відео)».</small>
    `;
  }

  return `
    <section class="instagram-settings-card">
      <label>
        Формат публікації
        <select id="instagramFormat">${options}</select>
      </label>
      <small class="instagram-note">${escapeHtml(active.hint)}</small>
      ${mediaBlock}
      ${error ? `<small class="instagram-note error-text">${escapeHtml(error)}</small>` : ""}
    </section>
  `;
}

async function prepareInstagramMedia(format) {
  if (!currentProduct?.id) throw new Error("Спочатку згенеруй прев'ю товару");

  instagramMediaState = { productId: currentProduct.id, format, busy: true, error: "" };
  renderPlatformEditor();
  setLoading(true, format === "slideshow" ? "Збираємо слайдшоу з фото…" : "Готуємо кадр для сторіз…");

  try {
    const response = await fetch(`/api/products/${currentProduct.id}/instagram-media`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ format }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося підготувати медіа");

    if (data.product) currentProduct = data.product;
    instagramMediaState = { productId: currentProduct.id, format, busy: false, error: "" };
    showMessage(format === "slideshow" ? "Слайдшоу зібрано ✓" : "Кадр для сторіз готовий ✓");
  } catch (error) {
    instagramMediaState = { productId: currentProduct.id, format, busy: false, error: error.message };
    throw error;
  } finally {
    renderPlatformEditor();
  }
}

function syncTikTokSettingsFromForm(post) {
  if (!post || post.platform !== "tiktok") return getTikTokSettings(post);
  const privacyLevel = platformEditor.querySelector("#tiktokPrivacy")?.value || "";
  const commercialContent = !!platformEditor.querySelector("#tiktokCommercial")?.checked;
  const settings = {
    privacyLevel,
    allowComment: !!platformEditor.querySelector("#tiktokAllowComment")?.checked,
    allowDuet: !!platformEditor.querySelector("#tiktokAllowDuet")?.checked,
    allowStitch: !!platformEditor.querySelector("#tiktokAllowStitch")?.checked,
    commercialContent,
    yourBrand: commercialContent && !!platformEditor.querySelector("#tiktokYourBrand")?.checked,
    brandedContent: commercialContent && privacyLevel !== "SELF_ONLY" && !!platformEditor.querySelector("#tiktokBrandedContent")?.checked,
    musicUsageAccepted: !!platformEditor.querySelector("#tiktokMusicAccepted")?.checked,
  };
  post.platformSettings = settings;
  return settings;
}

function validateTikTokSettingsForPublish(post) {
  const settings = getTikTokSettings(post);
  const info = tiktokCreatorState.postId === post.id ? tiktokCreatorState.info : null;
  if (!currentProduct?.videoUrl && !currentProduct?.processedVideoUrl) {
    throw new Error("TikTok: для публікації додайте відео");
  }
  if (!info) throw new Error("TikTok: дочекайтеся завантаження даних підключеного акаунта");
  if (!settings.privacyLevel) throw new Error("TikTok: вручну виберіть видимість публікації");
  if (!info.privacyLevelOptions.includes(settings.privacyLevel)) {
    throw new Error("TikTok: ця видимість недоступна для підключеного акаунта");
  }
  if (settings.commercialContent && !settings.yourBrand && !settings.brandedContent) {
    throw new Error("TikTok: вкажіть, чи контент просуває ваш бренд, сторонній бренд або обидва");
  }
  if (settings.brandedContent && settings.privacyLevel === "SELF_ONLY") {
    throw new Error("TikTok: брендований контент не можна публікувати з видимістю «Лише я»");
  }
  if (!settings.musicUsageAccepted) {
    throw new Error("TikTok: підтвердьте Music Usage Confirmation");
  }
  const duration = Number(tiktokCreatorState.videoDurationSec || 0);
  const maxDuration = Number(info.maxVideoPostDurationSec || 0);
  if (duration && maxDuration && duration > maxDuration + 0.05) {
    throw new Error(`TikTok: відео триває ${Math.ceil(duration)} с, максимум для акаунта — ${maxDuration} с`);
  }
  return settings;
}

function getTikTokPublishBlockReason(post) {
  if (!post || post.platform !== "tiktok") return "";
  const settings = getTikTokSettings(post);
  const info = tiktokCreatorState.postId === post.id ? tiktokCreatorState.info : null;
  if (!currentProduct?.videoUrl && !currentProduct?.processedVideoUrl) return "Для публікації в TikTok додайте відео";
  if (!info) return "Дочекайтеся завантаження даних TikTok-акаунта";
  if (!settings.privacyLevel) return "Вручну виберіть видимість публікації";
  if (settings.commercialContent && !settings.yourBrand && !settings.brandedContent) {
    return "Вкажіть, чи контент просуває ваш бренд, сторонній бренд або обидва";
  }
  if (!settings.musicUsageAccepted) return "Підтвердьте Music Usage Confirmation";
  const duration = Number(tiktokCreatorState.videoDurationSec || 0);
  const maxDuration = Number(info.maxVideoPostDurationSec || 0);
  if (duration && maxDuration && duration > maxDuration + 0.05) return "Відео перевищує ліміт тривалості TikTok";
  return "";
}

// ── 1. DRAG-AND-DROP PHOTO REORDER ───────────────────────
let dragSrcIndex = null;

function renderLocalGallery() {
  photoGallery.innerHTML = selectedPhotoFiles.map((file, index) => {
    const url = URL.createObjectURL(file);
    return `
      <figure class="thumb" draggable="true" data-index="${index}" title="Перетягни для зміни порядку">
        <button type="button" class="remove-media remove-photo" data-index="${index}" title="Видалити">×</button>
        <img src="${url}" alt="Фото ${index + 1}">
        ${index === 0 ? "<figcaption>Головне</figcaption>" : ""}
      </figure>
    `;
  }).join("");

  if (selectedPhotoFiles.length || selectedVideoFile) {
    photoGallery.insertAdjacentHTML("beforeend",
      `<button type="button" class="clear-media-btn" id="clearAllMediaBtn">Очистити все</button>`
    );
  }

  // Attach drag events to each thumb
  photoGallery.querySelectorAll(".thumb[draggable]").forEach(thumb => {
    thumb.addEventListener("dragstart", onThumbDragStart);
    thumb.addEventListener("dragover",  onThumbDragOver);
    thumb.addEventListener("dragleave", onThumbDragLeave);
    thumb.addEventListener("drop",      onThumbDrop);
    thumb.addEventListener("dragend",   onThumbDragEnd);
  });
}

function onThumbDragStart(e) {
  dragSrcIndex = Number(this.dataset.index);
  this.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}

function onThumbDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  photoGallery.querySelectorAll(".thumb").forEach(t => t.classList.remove("drag-over"));
  this.classList.add("drag-over");
}

function onThumbDragLeave() {
  this.classList.remove("drag-over");
}

function onThumbDrop(e) {
  e.stopPropagation();
  const targetIndex = Number(this.dataset.index);
  if (dragSrcIndex !== null && dragSrcIndex !== targetIndex) {
    const [moved] = selectedPhotoFiles.splice(dragSrcIndex, 1);
    selectedPhotoFiles.splice(targetIndex, 0, moved);
    setInputFiles(photosInput, selectedPhotoFiles);
    renderLocalGallery();
    showToast("Порядок фото змінено", "success", 2000);
  }
}

function onThumbDragEnd() {
  photoGallery.querySelectorAll(".thumb").forEach(t => {
    t.classList.remove("dragging", "drag-over");
  });
  dragSrcIndex = null;
}

function renderLocalVideo() {
  if (!selectedVideoFile) { videoPreview.innerHTML = ""; return; }
  const url = URL.createObjectURL(selectedVideoFile);
  videoPreview.innerHTML = `
    <figure class="thumb video-thumb">
      <button type="button" class="remove-media remove-video">×</button>
      <video src="${url}" controls muted></video>
      <figcaption>Відео</figcaption>
    </figure>
  `;
}

function renderSavedGallery() {
  const videoUrl          = currentProduct?.videoUrl || "";
  const processedVideoUrl = currentProduct?.processedVideoUrl || "";
  const useProcessedVideo = currentProduct?.useProcessedVideo !== false;
  const hasAnyVideo       = videoUrl || processedVideoUrl;

  if (!currentImages.length && !hasAnyVideo) return "";

  return `
    <div class="preview-gallery">
      ${processedVideoUrl ? `
        <div class="reel-preview-wrap">
          <figure class="reel-preview">
            <video src="${processedVideoUrl}" controls muted playsinline></video>
            <figcaption>Reels</figcaption>
          </figure>
          <label class="check video-choice-check">
            <input type="checkbox" id="useProcessedVideo" ${useProcessedVideo ? "checked" : ""}>
            <span>Використовувати оформлене відео</span>
          </label>
        </div>
      ` : videoUrl ? `
        <figure class="thumb video-thumb">
          <video src="${videoUrl}" controls muted playsinline></video>
          <figcaption>Оригінал</figcaption>
        </figure>
      ` : ""}

      ${currentImages.map((image, index) => `
        <figure class="thumb">
          <img src="${image.imageUrl}" alt="Фото ${index + 1}">
          ${index === 0 ? "<figcaption>Головне</figcaption>" : ""}
        </figure>
      `).join("")}
    </div>
  `;
}

function renderTabs() {
  const statusLabels = {
    draft: "Чернетка",
    scheduled: "Заплановано",
    publishing: "Обробляється",
    published: "Опубліковано",
    failed: "Помилка",
  };
  tabs.innerHTML = platformPosts.map(post => `
    <button
      type="button"
      class="tab ${post.platform === activePlatform ? "active" : ""}"
      data-platform="${post.platform}"
    >
      ${platformNames[post.platform] || post.platform}
      <span>${statusLabels[post.status] || post.status}</span>
    </button>
  `).join("");
}

function renderTikTokProcessingState(post) {
  if (post.status !== "publishing") return "";
  const apiStatus = post.platformStatus?.status || "PROCESSING_DOWNLOAD";
  const labels = {
    PROCESSING_UPLOAD: "TikTok завантажує відео",
    PROCESSING_DOWNLOAD: "TikTok завантажує та обробляє відео",
    PUBLISH_COMPLETE: "TikTok завершив публікацію",
  };
  return `
    <div class="tiktok-processing" role="status">
      <span class="tiktok-spinner" aria-hidden="true"></span>
      <div>
        <strong>${labels[apiStatus] || "TikTok обробляє публікацію"}</strong>
        <small>Це може тривати кілька хвилин. Postly автоматично перевіряє статус.</small>
      </div>
    </div>
  `;
}

function renderTikTokExtras(post) {
  const settings = getTikTokSettings(post);
  const stateMatches = tiktokCreatorState.postId === post.id;
  const info = stateMatches ? tiktokCreatorState.info : null;
  const error = stateMatches ? tiktokCreatorState.error : "";

  if (error) {
    return `
      <section class="tiktok-settings-card">
        <div class="tiktok-alert error-text">${escapeHtml(error)}</div>
        <button type="button" class="btn secondary refresh-tiktok-info">Спробувати ще раз</button>
      </section>
    `;
  }
  if (!info) {
    return `
      <section class="tiktok-settings-card tiktok-loading-card" aria-busy="true">
        <span class="tiktok-spinner" aria-hidden="true"></span>
        <div><strong>Отримуємо актуальні налаштування TikTok…</strong><small>Перевіряємо акаунт, доступну видимість і дозволи.</small></div>
      </section>
    `;
  }

  const duration = Number(tiktokCreatorState.videoDurationSec || 0);
  const maxDuration = Number(info.maxVideoPostDurationSec || 0);
  const durationTooLong = duration && maxDuration && duration > maxDuration + 0.05;
  const brandedPrivate = settings.privacyLevel === "SELF_ONLY";
  const disclosureText = settings.brandedContent
    ? `Публікація матиме позначку «Paid partnership».`
    : settings.yourBrand
      ? `Публікація матиме позначку «Promotional content».`
      : "";
  const agreementLead = settings.brandedContent
    ? `Публікуючи, ви погоджуєтеся з `
    : `Публікуючи, ви погоджуєтеся з `;

  return `
    <section class="tiktok-settings-card">
      <div class="tiktok-account-row">
        ${info.creatorAvatarUrl ? `<img src="${escapeHtml(info.creatorAvatarUrl)}" alt="" class="tiktok-avatar">` : `<span class="tiktok-avatar tiktok-avatar-fallback">♪</span>`}
        <div>
          <small>Публікація в акаунт</small>
          <strong>${escapeHtml(info.creatorNickname || info.creatorUsername || "TikTok")}</strong>
          ${info.creatorUsername ? `<span>@${escapeHtml(info.creatorUsername)}</span>` : ""}
        </div>
        <button type="button" class="btn ghost refresh-tiktok-info" title="Оновити дані акаунта">Оновити</button>
      </div>

      ${duration ? `
        <div class="tiktok-duration ${durationTooLong ? "is-error" : ""}">
          Відео: ${Math.ceil(duration)} с · ліміт акаунта: ${maxDuration || "—"} с
          ${durationTooLong ? `<strong>Відео задовге для цього акаунта.</strong>` : ""}
        </div>
      ` : ""}

      <div class="tiktok-field">
        <label for="tiktokPrivacy">Хто може переглядати відео</label>
        <select id="tiktokPrivacy" class="tiktok-control">
          <option value="">— Виберіть вручну —</option>
          ${info.privacyLevelOptions.map(value => `
            <option value="${value}" ${settings.privacyLevel === value ? "selected" : ""} ${settings.brandedContent && value === "SELF_ONLY" ? "disabled" : ""}>
              ${TIKTOK_PRIVACY_LABELS[value] || value}
            </option>
          `).join("")}
        </select>
        <small>Postly не вибирає видимість замість вас.</small>
      </div>

      <fieldset class="tiktok-fieldset">
        <legend>Дозволити взаємодії</legend>
        <label class="tiktok-choice ${info.commentDisabled ? "is-disabled" : ""}">
          <input type="checkbox" id="tiktokAllowComment" ${settings.allowComment ? "checked" : ""} ${info.commentDisabled ? "disabled" : ""}>
          <span><strong>Коментарі</strong>${info.commentDisabled ? `<small>Вимкнено в налаштуваннях TikTok</small>` : ""}</span>
        </label>
        <label class="tiktok-choice ${info.duetDisabled ? "is-disabled" : ""}">
          <input type="checkbox" id="tiktokAllowDuet" ${settings.allowDuet ? "checked" : ""} ${info.duetDisabled ? "disabled" : ""}>
          <span><strong>Duet</strong>${info.duetDisabled ? `<small>Недоступно для цього акаунта</small>` : ""}</span>
        </label>
        <label class="tiktok-choice ${info.stitchDisabled ? "is-disabled" : ""}">
          <input type="checkbox" id="tiktokAllowStitch" ${settings.allowStitch ? "checked" : ""} ${info.stitchDisabled ? "disabled" : ""}>
          <span><strong>Stitch</strong>${info.stitchDisabled ? `<small>Недоступно для цього акаунта</small>` : ""}</span>
        </label>
        <small class="tiktok-help">Усі дозволи вимкнені за замовчуванням — увімкніть потрібні вручну.</small>
      </fieldset>

      <div class="tiktok-commercial">
        <label class="tiktok-choice tiktok-switch-row">
          <input type="checkbox" id="tiktokCommercial" ${settings.commercialContent ? "checked" : ""}>
          <span><strong>Комерційний контент</strong><small>Контент просуває вас, бренд, товар або послугу</small></span>
        </label>
        ${settings.commercialContent ? `
          <div class="tiktok-commercial-options">
            <label class="tiktok-choice">
              <input type="checkbox" id="tiktokYourBrand" ${settings.yourBrand ? "checked" : ""}>
              <span><strong>Ваш бренд</strong><small>Просування себе або власного бізнесу</small></span>
            </label>
            <label class="tiktok-choice ${brandedPrivate ? "is-disabled" : ""}">
              <input type="checkbox" id="tiktokBrandedContent" ${settings.brandedContent ? "checked" : ""} ${brandedPrivate ? "disabled" : ""}>
              <span><strong>Брендований контент</strong><small>${brandedPrivate ? "Недоступно з видимістю «Лише я»" : "Просування стороннього бренду або партнера"}</small></span>
            </label>
            ${settings.commercialContent && !settings.yourBrand && !settings.brandedContent ? `<div class="tiktok-alert">Виберіть хоча б один тип комерційного контенту.</div>` : ""}
            ${disclosureText ? `<div class="tiktok-disclosure">${disclosureText}</div>` : ""}
          </div>
        ` : ""}
      </div>

      <label class="tiktok-choice tiktok-consent">
        <input type="checkbox" id="tiktokMusicAccepted" ${settings.musicUsageAccepted ? "checked" : ""}>
        <span>
          <strong>Підтверджую передавання відео в TikTok</strong>
          <small>${agreementLead}${settings.brandedContent ? `<a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener">Branded Content Policy</a> та ` : ""}<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.</small>
        </span>
      </label>

      <p class="tiktok-processing-note">Після відправлення TikTok може обробляти відео кілька хвилин. Postly покаже «Опубліковано» лише після підтвердження TikTok.</p>
    </section>
  `;
}

async function loadTikTokCreatorInfo(post, force = false) {
  if (!post || post.platform !== "tiktok" || !currentProduct) return;
  if (!force && tiktokCreatorState.postId === post.id && (tiktokCreatorState.info || tiktokCreatorState.loading)) return;
  tiktokCreatorState = { postId: post.id, info: null, videoDurationSec: null, loading: true, error: "" };
  if (currentPost()?.id === post.id) renderPlatformEditor();
  try {
    const response = await fetch(`/api/tiktok/creator-info?productId=${encodeURIComponent(currentProduct.id)}`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося отримати дані TikTok");
    tiktokCreatorState = {
      postId: post.id,
      info: data.creatorInfo,
      videoDurationSec: data.videoDurationSec,
      loading: false,
      error: "",
    };
  } catch (error) {
    tiktokCreatorState = {
      postId: post.id,
      info: null,
      videoDurationSec: null,
      loading: false,
      error: error.message || "Не вдалося отримати дані TikTok",
    };
  }
  if (currentPost()?.id === post.id) renderPlatformEditor();
}

function renderPlatformEditor() {
  const post = currentPost();
  if (!post) { platformEditor.innerHTML = ""; return; }
  const tiktokBlockReason = getTikTokPublishBlockReason(post);
  const blockReason = tiktokBlockReason || getInstagramPublishBlockReason(post);
  const publishBlocked = post.status === "publishing" || !!blockReason;
  const statusLabels = { draft: "Чернетка", scheduled: "Заплановано", publishing: "Обробляється", published: "Опубліковано", failed: "Помилка" };

  productIdBadge.textContent = currentProduct ? `#${currentProduct.id}` : "";
  platformEditor.innerHTML = `
    ${renderSavedGallery()}
    <div class="platform-status">
      <span class="status-pill ${post.status}">${statusLabels[post.status] || post.status}</span>
      ${post.errorMessage ? `<strong style="color:var(--red);font-size:13px">${escapeHtml(post.errorMessage)}</strong>` : ""}
    </div>

    ${renderTikTokProcessingState(post)}

    <label>
      ${post.platform === "tiktok" ? "Опис і хештеги для TikTok" : `Текст для ${platformNames[post.platform] || post.platform}`}
      <textarea class="post-textarea" rows="14" ${post.platform === "tiktok" ? `maxlength="2200"` : ""}>${escapeHtml(post.text)}</textarea>
      ${post.platform === "tiktok" ? `<small class="tiktok-caption-count">${post.text.length} / 2200 символів · текст можна відредагувати</small>` : ""}
    </label>

    <div class="preview-text ${post.platform === "telegram" ? "telegram-preview" : ""}">
      ${post.platform === "telegram"
        ? post.text.replace(/\n/g, "<br>")
        : escapeHtml(post.text).replace(/\n/g, "<br>")}
    </div>

    ${post.platform === "shafa" ? renderShafaExtras() : ""}
    ${post.platform === "tiktok" ? renderTikTokExtras(post) : ""}
    ${post.platform === "instagram" ? renderInstagramExtras(post) : ""}

    <div class="schedule-row">
      <label>
        Дата і час
        <input type="datetime-local" class="schedule-at" value="${post.scheduledAt ? post.scheduledAt.slice(0, 16) : ""}">
      </label>
    </div>

    <div class="actions">
      <button type="button" class="btn secondary regenerate-platform">Перегенерувати</button>
      <button type="button" class="btn success publish-platform" ${publishBlocked ? "disabled" : ""} ${blockReason ? `title="${escapeHtml(blockReason)}"` : ""}>${post.status === "publishing" ? "Обробляється в TikTok…" : "Опублікувати зараз"}</button>
      <button type="button" class="btn primary schedule-platform" ${blockReason ? `disabled title="${escapeHtml(blockReason)}"` : ""}>Запланувати</button>
    </div>
  `;

  if (post.platform === "shafa") syncShafaExtras();
  if (post.platform === "tiktok") queueMicrotask(() => loadTikTokCreatorInfo(post));
}

function renderPreview() {
  previewPanel.classList.remove("hidden");
  renderTabs();
  renderPlatformEditor();
}

// ── API calls ────────────────────────────────────────────
async function savePost(post, status, scheduledAt = null) {
  const response = await fetch(`/api/platform-posts/${post.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      text: post.text,
      status,
      scheduledAt,
      ...(post.platform === "tiktok" ? { platformSettings: getTikTokSettings(post) } : {}),
      ...(post.platform === "instagram" ? { platformSettings: getInstagramSettings(post) } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося зберегти пост");
  Object.assign(post, data.platformPost);
}

async function createPreview() {
  const hasPhotos = photosInput.files?.length;
  const hasVideo  = videoInput?.files?.length;

  if (!hasPhotos && !hasVideo) throw new Error("Завантаж хоча б одне фото або відео товару");

  const platforms = selectedPlatforms();
  if (!platforms.length) throw new Error("Вибери хоча б одну платформу");

  const formData = new FormData(form);
  formData.delete("selectedPlatforms");
  formData.append("selectedPlatforms", JSON.stringify(platforms));

  setLoading(true, "Генеруємо прев'ю...");

  const response = await fetch("/api/posts/preview", { method: "POST", body: formData, headers: authHeaders() });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося згенерувати прев'ю");

  currentProduct = data.product;
  currentImages  = data.images || [];
  platformPosts  = data.platformPosts || [];
  tiktokCreatorState = { postId: null, info: null, videoDurationSec: null, loading: false, error: "" };
  instagramMediaState = { productId: null, format: "", busy: false, error: "" };
  activePlatform = platformPosts[0]?.platform || "telegram";
  renderPreview();

  if (data.videoProcessing) {
    showMessage("Прев'ю готове · ⏳ Відео обробляється у фоні...");
    pollVideoProcessing(data.productId);
  } else {
    showMessage("Прев'ю готове");
  }
}

function pollVideoProcessing(productId) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const r = await fetch(`/api/products/${productId}`, { headers: authHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      const product = d.product || d;
      if (product.processedVideoUrl) {
        clearInterval(interval);
        currentProduct = { ...currentProduct, ...product };
        renderPreview();
        showMessage("✅ Відео готове!");
      } else if (attempts >= 30) { // 5 min max
        clearInterval(interval);
      }
    } catch { clearInterval(interval); }
  }, 10_000); // poll every 10s
}

async function regeneratePlatform(platform = activePlatform) {
  syncCurrentTextarea();
  setLoading(true, "Перегенеровуємо текст...");

  const response = await fetch(`/api/posts/${currentProduct.id}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ...getFormPayload(), platform }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося перегенерувати текст");

  currentProduct = data.product;
  currentImages  = data.images || currentImages;
  platformPosts  = data.platformPosts || platformPosts;
  activePlatform = platform;
  renderPreview();
  showMessage("Текст оновлено");
}

async function publishPost(post) {
  syncCurrentTextarea();
  const isTikTok = post.platform === "tiktok";
  if (isTikTok) {
    if (post.status === "publishing") throw new Error("TikTok уже обробляє цю публікацію");
    if (activePlatform !== "tiktok") {
      activePlatform = "tiktok";
      renderPreview();
    } else {
      syncTikTokSettingsFromForm(post);
    }
    await loadTikTokCreatorInfo(post);
    validateTikTokSettingsForPublish(post);
  }
  await savePost(post, post.status === "scheduled" ? "draft" : post.status);

  const platformLabel = platformNames[post.platform] || post.platform;
  const isShafa = post.platform === "shafa";
  setLoading(true, isShafa
    ? `Shafa.ua — заповнює форму (~2 хв), не закривайте вкладку...`
    : isTikTok
      ? "Передаємо відео в TikTok…"
      : `Публікуємо ${platformLabel}...`
  );

  // Shafa takes up to 3 min — use AbortController with 4-minute timeout
  const controller = new AbortController();
  const timeoutId = isShafa ? setTimeout(() => controller.abort(), 4 * 60 * 1000) : null;

  let response;
  try {
    response = await fetch(`/api/platform-posts/${post.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        text: post.text,
        ...(isShafa ? { extras: shafaExtras } : {}),
        ...(isTikTok ? { platformSettings: getTikTokSettings(post) } : {}),
        ...(post.platform === "instagram" ? { platformSettings: getInstagramSettings(post) } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося опублікувати пост");

  Object.assign(post, data.platformPost);
  renderPreview();
  if (isTikTok && post.status === "publishing") {
    showMessage("TikTok прийняв відео й обробляє його. Статус оновиться автоматично.", "loading");
    pollTikTokPostStatus(post);
    return;
  }
  showMessage(`${platformLabel}: опубліковано ✓`);
}

async function pollTikTokPostStatus(post) {
  if (!post || post.platform !== "tiktok" || post.status !== "publishing") return;
  const pollToken = Symbol("tiktok-status");
  tiktokStatusPollers.set(post.id, pollToken);

  for (let attempt = 0; attempt < 72; attempt++) {
    if (tiktokStatusPollers.get(post.id) !== pollToken) return;
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const response = await fetch(`/api/platform-posts/${post.id}/status`, { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося перевірити статус TikTok");
      Object.assign(post, data.platformPost);
      if (currentPost()?.id === post.id) renderPreview();

      if (post.status === "published") {
        tiktokStatusPollers.delete(post.id);
        showMessage("TikTok: опубліковано ✓");
        return;
      }
      if (post.status === "failed") {
        tiktokStatusPollers.delete(post.id);
        showMessage(post.errorMessage || "TikTok: публікація не вдалася", "error");
        return;
      }
    } catch (error) {
      // A temporary status-check error must not trigger another publish request.
      // The server scheduler keeps checking the same publish_id in the background.
      if (attempt === 71) showMessage(error.message || "TikTok ще обробляє відео", "error");
    }
  }

  tiktokStatusPollers.delete(post.id);
  showMessage("TikTok усе ще обробляє відео. Можна закрити сторінку — Postly продовжить перевірку.", "loading");
}

async function schedulePost(post) {
  syncCurrentTextarea();
  if (post.platform === "tiktok") {
    if (activePlatform !== "tiktok") {
      activePlatform = "tiktok";
      renderPreview();
    } else {
      syncTikTokSettingsFromForm(post);
    }
    await loadTikTokCreatorInfo(post);
    validateTikTokSettingsForPublish(post);
  }
  const input = platformEditor.querySelector(".schedule-at");
  if (!input.value) throw new Error("Вкажи дату і час публікації");

  await savePost(post, "scheduled", new Date(input.value).toISOString());
  renderPreview();
  showMessage(`${platformNames[post.platform] || post.platform}: заплановано`);
}

// ── Event listeners ───────────────────────────────────────
photosInput.addEventListener("change", () => {
  selectedPhotoFiles = [...selectedPhotoFiles, ...(photosInput.files || [])].slice(0, 10);
  setInputFiles(photosInput, selectedPhotoFiles);
  renderLocalGallery();
});

videoInput?.addEventListener("change", () => {
  selectedVideoFile = videoInput.files?.[0] || null;
  if (selectedVideoFile) setInputFiles(videoInput, [selectedVideoFile]);
  renderLocalVideo();
  syncVideoSettingsVisibility();
});

photoGallery.addEventListener("click", e => {
  const removeBtn  = e.target.closest(".remove-photo");
  const clearAllBtn = e.target.closest("#clearAllMediaBtn");

  if (removeBtn) {
    selectedPhotoFiles.splice(Number(removeBtn.dataset.index), 1);
    setInputFiles(photosInput, selectedPhotoFiles);
    renderLocalGallery();
  }

  if (clearAllBtn) {
    selectedPhotoFiles = [];
    selectedVideoFile  = null;
    setInputFiles(photosInput, []);
    setInputFiles(videoInput, []);
    renderLocalGallery();
    renderLocalVideo();
    syncVideoSettingsVisibility();
  }
});

videoPreview.addEventListener("click", e => {
  if (!e.target.closest(".remove-video")) return;
  selectedVideoFile = null;
  setInputFiles(videoInput, []);
  renderLocalVideo();
  syncVideoSettingsVisibility();
});

// Drag-drop upload from desktop
uploadBox.addEventListener("dragover", e => { e.preventDefault(); uploadBox.classList.add("dragover"); });
uploadBox.addEventListener("dragleave", ()  => uploadBox.classList.remove("dragover"));
uploadBox.addEventListener("drop", e => {
  e.preventDefault();
  uploadBox.classList.remove("dragover");
  if (e.dataTransfer.files?.length) {
    photosInput.files = e.dataTransfer.files;
    renderLocalGallery();
  }
});

tabs.addEventListener("click", e => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  syncCurrentTextarea();
  activePlatform = btn.dataset.platform;
  renderPreview();
});

platformEditor.addEventListener("input", e => {
  if (!e.target.classList.contains("post-textarea")) return;
  syncCurrentTextarea();
  const previewText = platformEditor.querySelector(".preview-text");
  const post = currentPost();
  if (previewText && post) {
    previewText.innerHTML = post.platform === "telegram"
      ? post.text.replace(/\n/g, "<br>")
      : escapeHtml(post.text).replace(/\n/g, "<br>");
  }
  const count = platformEditor.querySelector(".tiktok-caption-count");
  if (count && post?.platform === "tiktok") {
    count.textContent = `${post.text.length} / 2200 символів · текст можна відредагувати`;
  }
});

platformEditor.addEventListener("click", async e => {
  const post = currentPost();
  if (!post) return;
  try {
    if (e.target.closest(".refresh-tiktok-info")) await loadTikTokCreatorInfo(post, true);
    const prepareButton = e.target.closest(".prepare-instagram-media");
    if (prepareButton) await prepareInstagramMedia(prepareButton.dataset.format);
    if (e.target.closest(".regenerate-platform"))  await regeneratePlatform(post.platform);
    if (e.target.closest(".publish-platform"))     await publishPost(post);
    if (e.target.closest(".schedule-platform"))    await schedulePost(post);
  } catch (err) {
    showMessage(err.message, "error");
  } finally {
    setLoading(false, statusMessage?.textContent || "");
  }
});

platformEditor.addEventListener("change", async e => {
  const checkbox = e.target.closest("#useProcessedVideo");
  if (checkbox && currentProduct) {
    currentProduct.useProcessedVideo = checkbox.checked;
    await fetch(`/api/products/${currentProduct.id}/video-choice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ useProcessedVideo: checkbox.checked }),
    });
    const post = currentPost();
    if (post?.platform === "tiktok") {
      tiktokCreatorState = { postId: null, info: null, videoDurationSec: null, loading: false, error: "" };
      await loadTikTokCreatorInfo(post, true);
    }
    return;
  }

  const post = currentPost();
  if (post?.platform === "tiktok" && e.target.closest(".tiktok-settings-card")) {
    syncTikTokSettingsFromForm(post);
    renderPlatformEditor();
  }

  if (post?.platform === "instagram" && e.target.closest("#instagramFormat")) {
    syncCurrentTextarea();
    syncInstagramSettingsFromForm(post);
    renderPlatformEditor();
  }
});

previewBtn.addEventListener("click", async () => {
  try { await createPreview(); }
  catch (err) { showMessage(err.message, "error"); }
  finally { setLoading(false); }
});

publishSelectedBtn.addEventListener("click", async () => {
  try {
    if (!currentProduct) await createPreview();
    for (const platform of selectedPlatforms()) {
      const post = platformPosts.find(p => p.platform === platform);
      if (post) await publishPost(post);
    }
  } catch (err) {
    showMessage(err.message, "error");
  } finally {
    setLoading(false);
  }
});

scheduleSelectedBtn.addEventListener("click", async () => {
  try {
    const post = currentPost();
    if (!post) throw new Error("Спочатку створи попередній перегляд");
    await schedulePost(post);
  } catch (err) {
    showMessage(err.message, "error");
  } finally {
    setLoading(false);
  }
});

newProductBtn.addEventListener("click", () => {
  form.reset();
  selectedPhotoFiles = [];
  selectedVideoFile  = null;
  photoGallery.innerHTML   = "";
  videoPreview.innerHTML   = "";
  syncVideoSettingsVisibility();
  currentProduct = null;
  currentImages  = [];
  platformPosts  = [];
  tiktokCreatorState = { postId: null, info: null, videoDurationSec: null, loading: false, error: "" };
  tiktokStatusPollers.clear();
  activePlatform = "telegram";
  tabs.innerHTML          = "";
  platformEditor.innerHTML = "";
  productIdBadge.textContent = "";
  previewPanel.classList.add("hidden");
  loadLastSettings();
  showToast("Форму очищено", "success", 2000);
});

// ── Init ─────────────────────────────────────────────────
initVideoStyles();
initPresets();
