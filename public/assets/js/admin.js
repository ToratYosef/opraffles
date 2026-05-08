/* global RafflePlatform */
(function adminController() {
  const storage = RafflePlatform.storage;
  const functions = RafflePlatform.functions;
  const HARDCODED_ADMIN_CODE = "123";

  const isAdminLanding = window.location.pathname.endsWith("/admin/") || window.location.pathname.endsWith("/admin/index.html");
  const isDashboard = window.location.pathname.endsWith("/admin/raffle.html");

  async function validateAdminCode(code) {
    return code === HARDCODED_ADMIN_CODE;
  }

  if (isAdminLanding) {
    const form = document.getElementById("adminCodeForm");
    const message = document.getElementById("adminCodeMessage");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      message.classList.add("hidden");
      const code = document.getElementById("adminCode").value.trim();

      try {
        const ok = await validateAdminCode(code);
        if (!ok) {
          message.textContent = "Invalid admin code.";
          message.className = "mt-2 rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700";
          return;
        }

        sessionStorage.setItem("opraffles_admin_code", code);
        window.location.href = "/admin/raffle.html";
      } catch (error) {
        console.error(error);
        message.textContent = "Could not verify code right now.";
        message.className = "mt-2 rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700";
      }
    });

    return;
  }

  if (!isDashboard) {
    return;
  }

  const savedCode = sessionStorage.getItem("opraffles_admin_code");
  if (!savedCode) {
    window.location.href = "/admin/index.html";
    return;
  }

  async function enforceAccess() {
    const ok = await validateAdminCode(savedCode);
    if (!ok) {
      sessionStorage.removeItem("opraffles_admin_code");
      window.location.href = "/admin/index.html";
    }
  }

  const sectionTitle = document.getElementById("sectionTitle");
  const sidebarNav = document.getElementById("sidebarNav");
  const refreshBtn = document.getElementById("refreshDashboardBtn");
  const logoutBtn = document.getElementById("adminLogoutBtn");

  const statTotalRaffles = document.getElementById("statTotalRaffles");
  const statActiveRafflesAdmin = document.getElementById("statActiveRafflesAdmin");
  const statRevenue = document.getElementById("statRevenue");
  const statEntries = document.getElementById("statEntries");

  const recentOrdersTable = document.getElementById("recentOrdersTable");
  const rafflesTable = document.getElementById("rafflesTable");
  const ordersTable = document.getElementById("ordersTable");
  const entriesTable = document.getElementById("entriesTable");

  const createRaffleForm = document.getElementById("createRaffleForm");
  const createRaffleMessage = document.getElementById("createRaffleMessage");
  const limitMode = document.getElementById("limitMode");
  const maxEntriesField = document.getElementById("maxEntries");
  const generalOptions = document.getElementById("generalOptions");
  const spinFields = document.getElementById("spinFields");
  const entryPriceLabel = document.getElementById("entryPriceLabel");
  const entryPriceInput = document.getElementById("entryPriceInput");
  const bannerFileInput = document.getElementById("bannerFile");
  const bannerImageInput = document.getElementById("bannerImage");

  const spinRaffleSelect = document.getElementById("spinRaffleSelect");
  const generateWheelListBtn = document.getElementById("generateWheelListBtn");
  const includeManualToggle = document.getElementById("includeManualToggle");
  const spinSpotStats = document.getElementById("spinSpotStats");
  const wheelNameList = document.getElementById("wheelNameList");
  const wheelOfNamesLink = document.getElementById("wheelOfNamesLink");
  const openInternalWheelBtn = document.getElementById("openInternalWheelBtn");
  const exportCsvBtn = document.getElementById("exportCsvBtn");

  let cachedRaffles = [];
  let cachedEntries = [];

  function switchSection(nextSection) {
    document.querySelectorAll(".dashboard-section").forEach((el) => el.classList.add("hidden"));
    const section = document.getElementById("section-" + nextSection);
    if (section) section.classList.remove("hidden");

    sidebarNav.querySelectorAll("button").forEach((button) => {
      if (button.dataset.section === nextSection) {
        button.className = "w-full rounded-xl bg-white/15 px-4 py-3 text-left text-sm font-semibold";
      } else {
        button.className = "w-full rounded-xl px-4 py-3 text-left text-sm hover:bg-white/10";
      }
    });

    sectionTitle.textContent = nextSection === "spin" ? "Spin Wheel" : nextSection.charAt(0).toUpperCase() + nextSection.slice(1);
  }

  function renderRows(target, rows, emptyText) {
    target.innerHTML = "";
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="6" class="px-3 py-3 text-sm text-slate-500">' + emptyText + "</td>";
      target.appendChild(tr);
      return;
    }
    rows.forEach((row) => target.appendChild(row));
  }

  function parseDealTiers(raw) {
    if (!raw.trim()) return [];
    const entries = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [qtyRaw, pctRaw] = part.split("=").map((v) => v.trim());
        return {
          qty: Number(qtyRaw),
          discountPercent: Number(pctRaw),
        };
      })
      .filter((tier) => Number.isInteger(tier.qty) && tier.qty >= 2 && tier.discountPercent > 0 && tier.discountPercent < 100)
      .sort((a, b) => a.qty - b.qty);

    return entries;
  }

  function getCallable(name) {
    if (!functions) {
      throw new Error("Firebase Functions SDK is unavailable on this page.");
    }
    return functions.httpsCallable(name);
  }

  async function callAdmin(name, payload) {
    const callable = getCallable(name);
    const response = await callable({
      adminCode: savedCode,
      ...payload,
    });
    return response.data;
  }

  async function uploadBannerIfNeeded(slug) {
    const file = bannerFileInput.files && bannerFileInput.files[0];
    if (!file) return String(bannerImageInput.value || "").trim();
    if (!storage) {
      throw new Error("Firebase Storage is not initialized.");
    }

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const safeSlug = slug.replace(/[^a-z0-9-]/g, "");
    const path = "raffle-banners/" + safeSlug + "-" + Date.now() + "." + ext;
    const uploadTask = storage.ref(path).put(file, { contentType: file.type || "image/jpeg" });
    await uploadTask;
    const url = await storage.ref(path).getDownloadURL();
    bannerImageInput.value = url;
    return url;
  }

  async function loadDashboard() {
    const data = await callAdmin("adminGetDashboard", {});
    const raffles = data.raffles || [];
    const orders = data.orders || [];
    const entries = data.entries || [];

    cachedRaffles = raffles;
    cachedEntries = entries;

    const revenueCents = Number(data.stats && data.stats.revenueCents ? data.stats.revenueCents : 0);

    statTotalRaffles.textContent = String(raffles.length);
    statActiveRafflesAdmin.textContent = String(raffles.filter((r) => r.active).length);
    statRevenue.textContent = RafflePlatform.formatCurrency(revenueCents, "USD");
    statEntries.textContent = String(entries.length);

    const recentRows = orders.slice(0, 7).map((order) => {
      const tr = document.createElement("tr");
      tr.className = "border-t border-slate-100";
      tr.innerHTML =
        '<td class="px-3 py-2">' + (order.buyerName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (order.raffleName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (order.status || "-") + "</td>" +
        '<td class="px-3 py-2">' + RafflePlatform.formatCurrency(order.totalAmount || 0, order.currency || "usd") + "</td>";
      return tr;
    });
    renderRows(recentOrdersTable, recentRows, "No orders yet.");

    const raffleRows = raffles.map((raffle) => {
      const tr = document.createElement("tr");
      tr.className = "border-t border-slate-100";
      const limitText = raffle.unlimitedEntries ? "Unlimited" : "Max " + String(raffle.maxEntries || 0);
      tr.innerHTML =
        '<td class="px-3 py-2 font-medium">' + (raffle.name || "-") + "</td>" +
        '<td class="px-3 py-2">' + (raffle.type || "-") + "</td>" +
        '<td class="px-3 py-2">' + RafflePlatform.formatCurrency(Math.round(Number(raffle.entryPrice || 0) * 100), "usd") + "</td>" +
        '<td class="px-3 py-2">' + (raffle.active ? "Yes" : "No") + "</td>" +
        '<td class="px-3 py-2">' + limitText + "</td>" +
        '<td class="px-3 py-2"><button data-id="' + raffle.id + '" class="toggle-active rounded-lg border border-slate-300 px-2 py-1 text-xs">Toggle Active</button></td>';
      return tr;
    });
    renderRows(rafflesTable, raffleRows, "No raffles found.");

    const orderRows = orders.map((order) => {
      const tr = document.createElement("tr");
      tr.className = "border-t border-slate-100";
      tr.innerHTML =
        '<td class="px-3 py-2">' + RafflePlatform.formatDate(order.createdAt) + "</td>" +
        '<td class="px-3 py-2">' + (order.buyerName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (order.raffleName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (order.status || "-") + "</td>" +
        '<td class="px-3 py-2">' + String(order.entryCount || 0) + "</td>" +
        '<td class="px-3 py-2">' + RafflePlatform.formatCurrency(order.totalAmount || 0, order.currency || "usd") + "</td>";
      return tr;
    });
    renderRows(ordersTable, orderRows, "No orders found.");

    const entryRows = entries.map((entry) => {
      const tr = document.createElement("tr");
      tr.className = "border-t border-slate-100";
      tr.innerHTML =
        '<td class="px-3 py-2">' + (entry.entryNumber || entry.assignedCardNumber || "-") + "</td>" +
        '<td class="px-3 py-2">' + (entry.buyerName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (entry.raffleName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (entry.assignedCardNumber || "-") + "</td>" +
        '<td class="px-3 py-2">' + (entry.source || "payment") + "</td>";
      return tr;
    });
    renderRows(entriesTable, entryRows, "No entries found.");

    spinRaffleSelect.innerHTML = raffles
      .filter((r) => r.type === "spin")
      .map((r) => '<option value="' + r.id + '">' + r.name + "</option>")
      .join("");

    if (!spinRaffleSelect.innerHTML) {
      spinRaffleSelect.innerHTML = '<option value="">No spin raffles</option>';
    }
  }

  createRaffleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    createRaffleMessage.classList.add("hidden");

    const formData = new FormData(createRaffleForm);
    try {
      const slug = String(formData.get("slug") || "").trim().toLowerCase();
      const type = String(formData.get("type") || "general");
      const limitModeValue = String(formData.get("limitMode") || "unlimited");
      const maxEntries = Number(formData.get("maxEntries") || 0);
      const dealTiers = parseDealTiers(String(formData.get("dealTiers") || ""));
      const bannerImageUrl = await uploadBannerIfNeeded(slug);

      const payload = {
        name: String(formData.get("name") || "").trim(),
        slug,
        type,
        description: String(formData.get("description") || "").trim(),
        shortDescription: String(formData.get("shortDescription") || "").trim(),
        bannerImage: bannerImageUrl,
        entryPrice: Number(formData.get("entryPrice") || 0),
        active: !!formData.get("active"),
        featured: !!formData.get("featured"),
        unlimitedEntries: limitModeValue === "unlimited",
        maxEntries: limitModeValue === "max" ? maxEntries : null,
        packageDeals: dealTiers,
        totalSpots: Number(formData.get("totalSpots") || 0),
        assignmentMode: String(formData.get("assignmentMode") || "next"),
      };

      if (type === "spin") {
        payload.unlimitedEntries = true;
        payload.maxEntries = null;
        payload.packageDeals = [];
      }

      if (!payload.name || !payload.slug) {
        throw new Error("Raffle name and slug are required.");
      }

      if (payload.entryPrice <= 0) {
        throw new Error("Entry price must be greater than 0.");
      }

      if (limitModeValue === "max" && maxEntries < 1) {
        throw new Error("Set a valid max entries value.");
      }

      if (type === "spin" && payload.totalSpots < 1) {
        throw new Error("Spin raffles must include total spots.");
      }

      await callAdmin("adminCreateRaffle", payload);
      createRaffleForm.reset();
      spinFields.classList.add("hidden");
      maxEntriesField.classList.add("hidden");
      createRaffleMessage.textContent = "Raffle created successfully.";
      createRaffleMessage.className = "mt-3 rounded-lg bg-emerald-100 px-3 py-2 text-sm text-emerald-800";
      await loadDashboard();
    } catch (error) {
      createRaffleMessage.textContent = error.message || "Could not create raffle.";
      createRaffleMessage.className = "mt-3 rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-800";
    }
  });

  rafflesTable.addEventListener("click", async (event) => {
    const button = event.target.closest(".toggle-active");
    if (!button) return;

    const raffleId = button.getAttribute("data-id");
    const raffle = cachedRaffles.find((item) => item.id === raffleId);
    if (!raffle) return;

    await callAdmin("adminToggleRaffle", {
      raffleId,
      active: !raffle.active,
    });

    await loadDashboard();
  });

  generateWheelListBtn.addEventListener("click", async () => {
    const raffleId = spinRaffleSelect.value;
    if (!raffleId) return;

    const data = await callAdmin("adminGenerateWheelData", {
      raffleId,
      includeManual: includeManualToggle.checked,
    });

    const names = data.names || [];
    wheelNameList.value = names.join("\n");
    const encoded = encodeURIComponent(names.join("\n"));
    wheelOfNamesLink.href = "https://wheelofnames.com/?names=" + encoded;
    spinSpotStats.textContent =
      "Assigned spots: " + String(data.assignedCount || 0) +
      " | Available spots: " + String(data.availableCount || 0) +
      " | Total spots: " + String(data.totalSpots || 0);
  });

  exportCsvBtn.addEventListener("click", () => {
    const raffleId = spinRaffleSelect.value;
    if (!raffleId) return;
    callAdmin("exportRaffleCsv", { raffleId }).then((data) => {
      const blob = new Blob([data.csv || ""], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "entries-" + raffleId + ".csv";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  openInternalWheelBtn.addEventListener("click", () => {
    const names = encodeURIComponent(wheelNameList.value || "");
    window.open("/admin/wheel.html?names=" + names, "_blank");
  });

  sidebarNav.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-section]");
    if (!button) return;
    switchSection(button.dataset.section);
  });

  refreshBtn.addEventListener("click", loadDashboard);

  function syncTypeFields(typeValue) {
    const isSpin = typeValue === "spin";
    spinFields.classList.toggle("hidden", !isSpin);
    generalOptions.classList.toggle("hidden", isSpin);
    limitMode.closest("label").classList.toggle("hidden", isSpin);
    if (isSpin) {
      limitMode.value = "unlimited";
      maxEntriesField.classList.add("hidden");
      maxEntriesField.value = "";
    }
    entryPriceLabel.textContent = isSpin ? "Price per spot/card" : "Entry price";
    entryPriceInput.placeholder = isSpin ? "Price per spot/card" : "Price per entry";
  }

  createRaffleForm.addEventListener("change", (event) => {
    if (event.target.name === "type") {
      syncTypeFields(event.target.value);
    }
    if (event.target.name === "limitMode") {
      maxEntriesField.classList.toggle("hidden", event.target.value !== "max");
    }
  });

  syncTypeFields(String(new FormData(createRaffleForm).get("type") || "general"));

  logoutBtn.addEventListener("click", () => {
    sessionStorage.removeItem("opraffles_admin_code");
    window.location.href = "/admin/index.html";
  });

  enforceAccess()
    .then(async () => {
      try {
        await loadDashboard();
      } catch (error) {
        console.error("Admin load failed", error);
        sectionTitle.textContent = "Dashboard Error";
        spinSpotStats.textContent = "Failed to load dashboard data. Deploy Functions and refresh.";
      }
    })
    .catch((error) => {
      console.error("Admin access check failed", error);
      window.location.href = "/admin/index.html";
    });
})();
