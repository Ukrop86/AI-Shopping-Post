// Instagram-студія: один товар → чотири формати, кожен зі своїм текстом,
// готовим медіа і своїм часом публікації. Медіа готується на сервері у фоні,
// тож після створення товару сторінка опитує його стан, поки не буде готово.

const studioForm = document.getElementById("studioForm");
const studioPhotos = document.getElementById("studioPhotos");
const studioVideo = document.getElementById("studioVideo");
const studioGallery = document.getElementById("studioGallery");
const studioList = document.getElementById("studioList");
const studioStatus = document.getElementById("studioStatus");
const studioSubmit = document.getElementById("studioSubmit");
const toastContainer = document.getElementById("toastContainer");

const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  if (response.status === 401 && String(args[0] || "").startsWith("/api/")) {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userEmail");
    window.location.replace("/login.html");
  }
  return response;
};

function authHeaders() {
  const token = localStorage.getItem("authToken");
  return token ? { Authorization: "Bearer " + token } : {};
}

if (!localStorage.getItem("authToken")) window.location.replace("/login.html");

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(message, kind = "success") {
  if (!toastContainer) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span class="toast-msg"></span>`;
  el.querySelector(".toast-msg").textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ── Формати ──────────────────────────────────────────────────────────────────

const FORMATS = {
  reels: {
    label: "Reels",
    icon: "🎬",
    hint: "Вертикальне відео на моделі. Головний формат для охоплення.",
  },
  slideshow: {
    label: "Reels-слайдшоу",
    icon: "🖼",
    hint: "Reels, зібраний із фото товару — коли зйомки відео немає.",
  },
  carousel: {
    label: "Карусель",
    icon: "📚",
    hint: "Фото в стрічку. На першому кадрі — назва й ціна, на останньому — заклик.",
  },
  story: {
    label: "Сторіз",
    icon: "⚡",
    hint: "Живе 24 години. Підпису немає — назва й ціна запечені в кадр.",
  },
};

const STATUS_LABELS = {
  draft: "Чернетка",
  scheduled: "Заплановано",
  publishing: "Публікується",
  published: "Опубліковано",
  failed: "Помилка",
};

function postFormat(post) {
  if (post.formatKey) return post.formatKey;
  const settings = post.platformSettings && typeof post.platformSettings === "object" ? post.platformSettings : {};
  return settings.format || "auto";
}

function studioPosts(product) {
  return (product.platformPosts || [])
    .filter(post => post.platform === "instagram" && FORMATS[postFormat(post)])
    .sort((a, b) => Object.keys(FORMATS).indexOf(postFormat(a)) - Object.keys(FORMATS).indexOf(postFormat(b)));
}

// ── Прев'ю медіа для кожного формату ─────────────────────────────────────────

function mediaPreview(product, format) {
  if (format === "reels") {
    const url = product.processedVideoUrl || product.videoUrl;
    return url
      ? `<video class="studio-media" src="${escapeHtml(url)}" controls playsinline preload="metadata"></video>`
      : `<p class="studio-missing">Відео ще готується…</p>`;
  }

  if (format === "slideshow") {
    return product.slideshowVideoUrl
      ? `<video class="studio-media" src="${escapeHtml(product.slideshowVideoUrl)}" controls playsinline preload="metadata"></video>`
      : `<p class="studio-missing">Слайдшоу ще збирається…</p>`;
  }

  if (format === "story") {
    return product.storyImageUrl
      ? `<img class="studio-media" src="${escapeHtml(product.storyImageUrl)}" alt="Кадр для сторіз">`
      : `<p class="studio-missing">Кадр ще готується…</p>`;
  }

  const images = product.images || [];
  if (!images.length) return `<p class="studio-missing">Фото немає</p>`;
  return `
    <div class="studio-carousel">
      ${images
        .map((image, index) => `
          <figure>
            <img src="${escapeHtml(image.igImageUrl || image.imageUrl)}" alt="Слайд ${index + 1}">
            <figcaption>${index + 1}</figcaption>
          </figure>
        `)
        .join("")}
    </div>
  `;
}

function renderFormatCard(product, post) {
  const format = postFormat(post);
  const meta = FORMATS[format];
  const isStory = format === "story";

  return `
    <article class="studio-format" data-post-id="${post.id}" data-format="${format}">
      <header class="studio-format-head">
        <div>
          <strong>${meta.icon} ${escapeHtml(meta.label)}</strong>
          <small>${escapeHtml(meta.hint)}</small>
        </div>
        <span class="status-pill ${post.status}">${STATUS_LABELS[post.status] || post.status}</span>
      </header>

      ${post.errorMessage ? `<p class="error-text studio-error">${escapeHtml(post.errorMessage)}</p>` : ""}

      ${mediaPreview(product, format)}

      ${isStory
        ? `<p class="studio-note">У сторіз підпису немає. Опитування й наліпки Instagram через API не дозволяє — їх можна додати вручну вже після публікації.</p>`
        : `<label>
             Підпис
             <textarea class="studio-text" rows="7">${escapeHtml(post.text)}</textarea>
           </label>`}

      <div class="studio-format-actions">
        <label class="studio-when">
          Час публікації
          <input type="datetime-local" class="studio-at" value="${post.scheduledAt ? escapeHtml(post.scheduledAt.slice(0, 16)) : ""}">
        </label>
        <div class="studio-buttons">
          ${isStory ? "" : `<button type="button" class="btn secondary studio-save">Зберегти</button>`}
          <button type="button" class="btn primary studio-schedule">Запланувати</button>
          <button type="button" class="btn success studio-publish">Опублікувати зараз</button>
        </div>
      </div>
    </article>
  `;
}

function renderProduct(product) {
  const posts = studioPosts(product);
  const cover = product.images?.[0]?.imageUrl || product.imageUrl || "";
  const preparing = product.studioStatus === "preparing";
  const failed = product.studioStatus === "failed";

  const stateLine = preparing
    ? `<span class="studio-state preparing">Готуємо медіа й тексти…</span>`
    : failed
      ? `<span class="studio-state failed">Підготовка впала: ${escapeHtml(product.studioError || "невідома помилка")}</span>`
      : `<span class="studio-state ready">${posts.length} ${posts.length === 1 ? "формат" : posts.length < 5 ? "формати" : "форматів"}</span>`;

  return `
    <details class="card studio-product" data-id="${product.id}" ${preparing ? "open" : ""}>
      <summary>
        ${cover ? `<img class="studio-cover" src="${escapeHtml(cover)}" alt="">` : `<span class="studio-cover placeholder"></span>`}
        <span class="studio-summary-text">
          <strong>${escapeHtml(product.title || "Без назви")}</strong>
          <small>${escapeHtml(product.price || "ціна не вказана")} · #${product.id}</small>
        </span>
        ${stateLine}
      </summary>

      <div class="studio-product-body">
        ${failed || (!preparing && !posts.length)
          ? `<button type="button" class="btn secondary studio-rebuild">Спробувати ще раз</button>`
          : ""}
        ${preparing
          ? `<p class="studio-missing">Це займає до двох хвилин: збираємо слайдшоу, накладаємо плашки, пишемо тексти під кожен формат.</p>`
          : posts.map(post => renderFormatCard(product, post)).join("")}
        ${!preparing && posts.length ? `<button type="button" class="btn ghost studio-rebuild">Перегенерувати все</button>` : ""}
      </div>
    </details>
  `;
}

// ── Завантаження списку ──────────────────────────────────────────────────────

let products = [];

async function loadProducts() {
  const response = await fetch("/api/instagram/studio", { headers: authHeaders() });
  const data = await response.json();
  if (!data.success) {
    studioList.innerHTML = "<p>Не вдалося завантажити список</p>";
    return;
  }

  products = data.products || [];
  const openIds = new Set(
    [...studioList.querySelectorAll("details.studio-product[open]")].map(el => el.dataset.id)
  );

  studioList.innerHTML = products.length
    ? products.map(renderProduct).join("")
    : "<p>Ще нічого не підготовлено. Завантаж перший товар вище.</p>";

  for (const id of openIds) {
    const el = studioList.querySelector(`details.studio-product[data-id="${id}"]`);
    if (el) el.open = true;
  }

  if (products.some(product => product.studioStatus === "preparing")) schedulePoll();
}

let pollTimer = null;
function schedulePoll() {
  if (pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try {
      await loadProducts();
    } catch (error) {
      console.error("poll failed", error);
    }
  }, 5000);
}

// ── Створення товару ─────────────────────────────────────────────────────────

studioPhotos.addEventListener("change", () => {
  const files = [...(studioPhotos.files || [])].slice(0, 10);
  studioGallery.innerHTML = files
    .map(file => `<img src="${URL.createObjectURL(file)}" alt="">`)
    .join("");
});

studioForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!studioPhotos.files?.length && !studioVideo.files?.length) {
    toast("Завантаж хоча б одне фото або відео", "error");
    return;
  }

  studioSubmit.disabled = true;
  studioStatus.textContent = "Завантажуємо…";

  try {
    const formData = new FormData(studioForm);
    const response = await fetch("/api/instagram/studio", {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося створити товар");

    if (data.rejectedPhotos?.length) {
      toast(
        `Не вдалося прочитати ${data.rejectedPhotos.length} фото (${data.rejectedPhotos.join(", ")}) — решту завантажено.`,
        "error"
      );
    }

    studioForm.reset();
    studioGallery.innerHTML = "";
    studioStatus.textContent = "";
    toast("Товар створено. Готуємо формати — це до двох хвилин.");
    await loadProducts();
  } catch (error) {
    studioStatus.textContent = "";
    toast(error.message, "error");
  } finally {
    studioSubmit.disabled = false;
  }
});

document.getElementById("studioReset").addEventListener("click", () => {
  studioForm.reset();
  studioGallery.innerHTML = "";
  studioStatus.textContent = "";
});

document.getElementById("studioRefresh").addEventListener("click", () => loadProducts());

// ── Дії над постами ──────────────────────────────────────────────────────────

async function savePost(card, status) {
  const textarea = card.querySelector(".studio-text");
  const whenInput = card.querySelector(".studio-at");
  const scheduledAt = status === "scheduled" && whenInput?.value
    ? new Date(whenInput.value).toISOString()
    : null;

  if (status === "scheduled" && !scheduledAt) throw new Error("Вкажи дату й час публікації");

  const response = await fetch(`/api/platform-posts/${card.dataset.postId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text: textarea ? textarea.value : undefined, status, scheduledAt }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося зберегти");
}

async function publishPost(card) {
  const textarea = card.querySelector(".studio-text");
  const response = await fetch(`/api/platform-posts/${card.dataset.postId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(textarea ? { text: textarea.value } : {}),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося опублікувати");
}

studioList.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;

  const card = event.target.closest(".studio-format");
  const productEl = event.target.closest(".studio-product");
  button.disabled = true;

  try {
    if (button.classList.contains("studio-rebuild")) {
      const response = await fetch(`/api/instagram/studio/${productEl.dataset.id}/rebuild`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося перезібрати");
      toast("Перезбираємо формати…");
      await loadProducts();
      return;
    }

    if (button.classList.contains("studio-save")) {
      await savePost(card, "draft");
      toast("Збережено");
    }

    if (button.classList.contains("studio-schedule")) {
      await savePost(card, "scheduled");
      toast("Заплановано");
    }

    if (button.classList.contains("studio-publish")) {
      const format = card.dataset.format;
      if (!confirm(`Опублікувати ${FORMATS[format].label} в Instagram просто зараз?`)) return;
      toast("Публікуємо… для відео це може зайняти хвилину.");
      await publishPost(card);
      toast("Опубліковано ✓");
    }

    await loadProducts();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

loadProducts();

// ── Автопостинг: розкидання по слотах ────────────────────────────────────────
// Сервер сам ставить час усім чернеткам за тижневим графіком: рілси у вечірні
// слоти, карусель в обідні, сторіз у свої вікна.

document.getElementById("studioPlan").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/api/instagram/schedule-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося розкидати по слотах");
    toast(data.message, data.skipped ? "loading" : "success");
    await loadProducts();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

// Планувати в акаунт, чий доступ помер, немає сенсу — попереджаємо вгорі
// сторінки, а не в момент нічного провалу.
async function loadSocialStatus() {
  try {
    const response = await fetch("/api/user/social-status", { headers: authHeaders() });
    const status = await response.json();
    const alert = document.getElementById("studioAlert");

    let message = "";
    if (!status?.instagram) {
      message = status?.instagramTokenExpired
        ? "Термін дії доступу до Instagram минув — заплановані пости не вийдуть. Перепідключи акаунт у Налаштуваннях."
        : "Instagram не підключено. Формати підготуються, але опублікувати їх не вийде — підключи акаунт у Налаштуваннях.";
    } else if (status?.instagramTokenExpiringSoon) {
      message = `Доступ до Instagram діє ще ${status.instagramTokenDaysLeft} дн. Перепідключи акаунт у Налаштуваннях, щоб автопостинг не зупинився.`;
    }

    alert.textContent = message;
    alert.classList.toggle("hidden", !message);
  } catch (error) {
    console.error("social status failed", error);
  }
}

// ── Сповіщення ───────────────────────────────────────────────────────────────

const notifyChannel = document.getElementById("notifyChannel");
const notifyTargetWrap = document.getElementById("notifyTargetWrap");
const notifyTarget = document.getElementById("notifyTarget");
const notifyState = document.getElementById("notifyState");

function syncNotifyForm() {
  const channel = notifyChannel.value;
  notifyTargetWrap.classList.toggle("hidden", channel === "none");
  document.getElementById("notifyTargetLabel").textContent =
    channel === "telegram" ? "Chat ID у Telegram" : "Email";
  notifyTarget.placeholder = channel === "telegram" ? "напр. 123456789" : "you@example.com";
}

notifyChannel.addEventListener("change", syncNotifyForm);

document.getElementById("notifySave").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/api/settings/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ channel: notifyChannel.value, target: notifyTarget.value.trim() }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося зберегти");
    toast(data.message);
    await loadNotifications();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

async function loadNotifications() {
  try {
    const response = await fetch("/api/notifications?limit=5", { headers: authHeaders() });
    const data = await response.json();
    if (!data.success) return;

    notifyChannel.value = data.channel?.channel || "none";
    notifyTarget.value = data.channel?.target || "";
    syncNotifyForm();

    const pending = (data.notifications || []).filter(item => !item.deliveredAt).length;
    const last = data.notifications?.[0];
    notifyState.textContent = last
      ? `Останнє: ${last.title} — ${new Date(last.createdAt).toLocaleString("uk-UA")}. ` +
        `Невручених подій: ${pending}. Відправка ще не увімкнена, події зберігаються в журналі.`
      : "Подій ще не було. Відправка ще не увімкнена — поки що збої записуються в журнал.";
  } catch (error) {
    console.error("notifications failed", error);
  }
}

loadSocialStatus();
loadNotifications();
