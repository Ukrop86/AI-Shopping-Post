const productsList = document.getElementById("productsList");
const bundleBar = document.getElementById("bundleBar");
const bundleCount = document.getElementById("bundleCount");
const bundleTitle = document.getElementById("bundleTitle");
const bundleMessage = document.getElementById("bundleMessage");
const bundleCreate = document.getElementById("bundleCreate");
const bundleClear = document.getElementById("bundleClear");

// Добірка = один Reels зі слайдшоу з фото кількох товарів. Вибір живе поза
// розміткою списку, щоб не злітати при перемальовуванні після фільтрів.
const bundleSelection = new Set();
const productsSearch = document.getElementById("productsSearch");
const platformFilter = document.getElementById("platformFilter");
const statusFilter = document.getElementById("statusFilter");

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
  const token = localStorage.getItem("authToken");
  return token ? { Authorization: "Bearer " + token } : {};
}

if (!localStorage.getItem("authToken")) {
  window.location.replace("/login.html");
}

const platformNames = {
  telegram: "Telegram",
  instagram: "Instagram",
  facebook: "Facebook",
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFilters() {
  const params = new URLSearchParams();

  if (productsSearch.value.trim()) {
    params.set("query", productsSearch.value.trim());
  }

  if (platformFilter.value) {
    params.set("platform", platformFilter.value);
  }

  if (statusFilter.value) {
    params.set("status", statusFilter.value);
  }

  return params;
}

async function loadProducts() {
  productsList.textContent = "Завантаження...";
  const response = await fetch(`/api/products?${getFilters().toString()}`, { headers: authHeaders() });
  const data = await response.json();

  if (!data.success) {
    productsList.innerHTML = "<p>Не вдалося завантажити товари</p>";
    return;
  }

  renderProducts(data.products);
}

function renderPlatformPosts(posts) {
  return posts
    .map(
      (post) => `
        <details class="platform-post" data-post-id="${post.id}" open>
          <summary>
            <span>${platformNames[post.platform] || post.platform}</span>
            <span class="status-pill ${post.status}">${post.status}</span>
          </summary>

          ${post.errorMessage ? `<p class="error-text">${escapeHtml(post.errorMessage)}</p>` : ""}

          <label>
            Текст
            <textarea class="edit-post-text" rows="8">${escapeHtml(post.text)}</textarea>
          </label>

          <label>
            Запланувати на
            <input class="edit-scheduled-at" type="datetime-local" value="${post.scheduledAt ? post.scheduledAt.slice(0, 16) : ""}">
          </label>

          <div class="actions">
            <button class="btn secondary save-post">Зберегти</button>
            <button class="btn success publish-post">Опублікувати</button>
            <button class="btn primary schedule-post">Запланувати</button>
          </div>
        </details>
      `
    )
    .join("");
}

function renderProducts(products) {
  if (!products.length) {
    productsList.innerHTML = "<p>Товарів не знайдено</p>";
    return;
  }

  productsList.innerHTML = products
    .map((product) => {
      const firstImage = product.images?.[0]?.imageUrl || product.imageUrl || "";
      const videoUrl = product.videoUrl || "";

      return `
        <article class="card product-card" data-id="${product.id}">
          <div>
            ${
              videoUrl
                ? `<video src="${videoUrl}" class="product-img" controls muted></video>`
                : firstImage
                  ? `<img src="${firstImage}" class="product-img" alt="${escapeHtml(product.title)}">`
                  : ""
            }

            <div class="image-strip">
              ${(product.images || [])
                .slice(videoUrl ? 0 : 1, 5)
                .map((image) => `<img src="${image.imageUrl}" alt="">`)
                .join("")}
            </div>
          </div>

          <div class="product-body">
            <div class="product-top">
              <div>
                <h2>${escapeHtml(product.title || "Без назви")}</h2>
                <p>${product.bundleOf ? "Добірка з кількох товарів" : `Артикул: ${escapeHtml(product.model || "не вказано")}`}</p>
              </div>
              <div class="product-top-right">
                <label class="bundle-pick">
                  <input type="checkbox" class="bundle-checkbox" value="${product.id}" ${bundleSelection.has(product.id) ? "checked" : ""}>
                  <span>У добірку</span>
                </label>
                <span class="small-badge">#${product.id}</span>
              </div>
            </div>

            <div class="grid">
              <label>
                Назва
                <input class="edit-title" value="${escapeHtml(product.title)}">
              </label>
              <label>
                Модель / артикул
                <input class="edit-model" value="${escapeHtml(product.model)}">
              </label>
              <label>
                Ціна
                <input class="edit-price" value="${escapeHtml(product.price)}">
              </label>
              <label>
                Дроп ціна
                <input class="edit-dropPrice" value="${escapeHtml(product.dropPrice)}">
              </label>
              <label>
                Розміри
                <input class="edit-sizes" value="${escapeHtml(product.sizes)}">
              </label>
              <label>
                Кольори
                <input class="edit-colors" value="${escapeHtml(product.colors)}">
              </label>
            </div>

            <label>
              Тканина / матеріал
              <input class="edit-fabric" value="${escapeHtml(product.fabric)}">
            </label>

            <label>
              Додатковий опис
              <textarea class="edit-description" rows="3">${escapeHtml(product.description)}</textarea>
            </label>

            <div class="actions">
              <button class="btn secondary save-product">Зберегти товар</button>
            </div>

            <div class="platform-stack">
              ${renderPlatformPosts(product.platformPosts || [])}
            </div>

            <p class="product-message"></p>
          </div>
        </article>
      `;
    })
    .join("");
}

function productPayload(card) {
  return {
    title: card.querySelector(".edit-title").value,
    model: card.querySelector(".edit-model").value,
    price: card.querySelector(".edit-price").value,
    dropPrice: card.querySelector(".edit-dropPrice").value,
    sizes: card.querySelector(".edit-sizes").value,
    colors: card.querySelector(".edit-colors").value,
    fabric: card.querySelector(".edit-fabric").value,
    description: card.querySelector(".edit-description").value,
  };
}

async function updatePlatformPost(details, status) {
  const text = details.querySelector(".edit-post-text").value;
  const scheduledInput = details.querySelector(".edit-scheduled-at");
  const scheduledAt = scheduledInput.value
    ? new Date(scheduledInput.value).toISOString()
    : null;
  const response = await fetch(`/api/platform-posts/${details.dataset.postId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ text, status, scheduledAt }),
  });
  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.message || "Не вдалося оновити пост");
  }
}

let searchTimer = null;

[platformFilter, statusFilter].forEach((control) =>
  control.addEventListener("change", loadProducts)
);

productsSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProducts, 250);
});

productsList.addEventListener("click", async (event) => {
  const card = event.target.closest(".product-card");

  if (!card) return;

  const message = card.querySelector(".product-message");
  const button = event.target.closest("button");

  if (!button) return;

  button.disabled = true;
  message.textContent = "Зберігаємо...";
  message.className = "product-message";

  try {
    if (button.classList.contains("save-product")) {
      const response = await fetch(`/api/products/${card.dataset.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(productPayload(card)),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Не вдалося зберегти товар");
      }

      message.textContent = "Товар збережено";
    }

    const details = event.target.closest(".platform-post");

    if (button.classList.contains("save-post")) {
      await updatePlatformPost(details, "draft");
      message.textContent = "Пост збережено";
    }

    if (button.classList.contains("schedule-post")) {
      await updatePlatformPost(details, "scheduled");
      message.textContent = "Пост заплановано";
    }

    if (button.classList.contains("publish-post")) {
      const text = details.querySelector(".edit-post-text").value;
      const response = await fetch(`/api/platform-posts/${details.dataset.postId}/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ text }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Не вдалося опублікувати пост");
      }

      message.textContent = "Пост опубліковано";
    }

    setTimeout(loadProducts, 700);
  } catch (error) {
    message.textContent = error.message;
    message.className = "product-message error-text";
  } finally {
    button.disabled = false;
  }
});

function renderBundleBar() {
  const count = bundleSelection.size;
  bundleBar.hidden = count === 0 && !bundleMessage.classList.contains("done");
  bundleCount.textContent = `Обрано ${count} ${count === 1 ? "товар" : count < 5 ? "товари" : "товарів"}`;
  bundleCreate.disabled = count < 2 || count > 6;
  if (count === 1) {
    bundleMessage.textContent = "Для добірки потрібно щонайменше 2 товари";
    bundleMessage.className = "bundle-message";
  } else if (count > 6) {
    bundleMessage.textContent = "Максимум 6 товарів на добірку";
    bundleMessage.className = "bundle-message error-text";
  } else if (!bundleMessage.classList.contains("done")) {
    bundleMessage.textContent = "";
  }
}

productsList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".bundle-checkbox");
  if (!checkbox) return;
  const productId = Number(checkbox.value);
  if (checkbox.checked) bundleSelection.add(productId);
  else bundleSelection.delete(productId);
  bundleMessage.className = "bundle-message";
  renderBundleBar();
});

bundleClear.addEventListener("click", () => {
  bundleSelection.clear();
  productsList.querySelectorAll(".bundle-checkbox").forEach((box) => { box.checked = false; });
  bundleMessage.textContent = "";
  bundleMessage.className = "bundle-message";
  renderBundleBar();
});

bundleCreate.addEventListener("click", async () => {
  bundleCreate.disabled = true;
  bundleMessage.className = "bundle-message";
  bundleMessage.textContent = "Збираємо слайдшоу — це займає до хвилини...";

  try {
    const response = await fetch("/api/products/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        productIds: [...bundleSelection],
        title: bundleTitle.value.trim() || undefined,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Не вдалося зібрати добірку");

    bundleSelection.clear();
    bundleTitle.value = "";
    bundleMessage.textContent = `Добірку створено (#${data.productId}, ${data.slideshow.photosUsed} кадрів, ${data.slideshow.durationSec} с). Текст і час — у картці добірки нижче.`;
    bundleMessage.className = "bundle-message done";
    await loadProducts();
  } catch (error) {
    bundleMessage.textContent = error.message;
    bundleMessage.className = "bundle-message error-text";
  } finally {
    renderBundleBar();
  }
});

loadProducts();
