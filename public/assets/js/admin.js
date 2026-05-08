/* global RafflePlatform */
(function adminController() {
  const db = RafflePlatform.db;
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

  const spinRaffleSelect = document.getElementById("spinRaffleSelect");
  const generateWheelListBtn = document.getElementById("generateWheelListBtn");
  const wheelNameList = document.getElementById("wheelNameList");
  const wheelOfNamesLink = document.getElementById("wheelOfNamesLink");
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

  async function loadDashboard() {
    const [rafflesSnap, ordersSnap, entriesSnap] = await Promise.all([
      db.collection("raffles").get(),
      db.collection("orders").orderBy("createdAt", "desc").limit(50).get(),
      db.collection("entries").orderBy("createdAt", "desc").limit(150).get(),
    ]);

    const raffles = rafflesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const orders = ordersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const entries = entriesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    cachedRaffles = raffles;
    cachedEntries = entries;

    const revenueCents = orders
      .filter((order) => order.status === "paid")
      .reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);

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
      tr.innerHTML =
        '<td class="px-3 py-2 font-medium">' + (raffle.name || "-") + "</td>" +
        '<td class="px-3 py-2">' + (raffle.type || "-") + "</td>" +
        '<td class="px-3 py-2">' + (raffle.active ? "Yes" : "No") + "</td>" +
        '<td class="px-3 py-2">' + (raffle.featured ? "Yes" : "No") + "</td>" +
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
        '<td class="px-3 py-2">' + (entry.packageName || "-") + "</td>" +
        '<td class="px-3 py-2">' + (entry.source || "payment") + "</td>";
      return tr;
    });
    renderRows(entriesTable, entryRows, "No entries found.");

    spinRaffleSelect.innerHTML = raffles
      .filter((r) => r.type === "spin" || r.type === "general" || r.type === "package")
      .map((r) => '<option value="' + r.id + '">' + r.name + "</option>")
      .join("");
  }

  createRaffleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    createRaffleMessage.classList.add("hidden");

    const formData = new FormData(createRaffleForm);
    const payload = {
      name: String(formData.get("name") || "").trim(),
      slug: String(formData.get("slug") || "").trim().toLowerCase(),
      type: String(formData.get("type") || "general"),
      description: String(formData.get("description") || "").trim(),
      shortDescription: String(formData.get("shortDescription") || "").trim(),
      bannerImage: String(formData.get("bannerImage") || "").trim(),
      entryPrice: Number(formData.get("entryPrice") || 0),
      active: !!formData.get("active"),
      featured: !!formData.get("featured"),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    try {
      if (!payload.name || !payload.slug) {
        throw new Error("Raffle name and slug are required.");
      }

      const existing = await db.collection("raffles").where("slug", "==", payload.slug).limit(1).get();
      if (!existing.empty) {
        throw new Error("Slug already exists.");
      }

      await db.collection("raffles").add(payload);
      createRaffleForm.reset();
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

    await db.collection("raffles").doc(raffleId).update({
      active: !raffle.active,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await loadDashboard();
  });

  generateWheelListBtn.addEventListener("click", () => {
    const raffleId = spinRaffleSelect.value;
    const filtered = cachedEntries.filter((entry) => entry.raffleId === raffleId && entry.paymentStatus === "paid");
    const names = filtered.map((entry) => entry.buyerName || "Anonymous");
    wheelNameList.value = names.join("\n");
    const encoded = encodeURIComponent(names.join("\n"));
    wheelOfNamesLink.href = "https://wheelofnames.com/?names=" + encoded;
  });

  exportCsvBtn.addEventListener("click", () => {
    const rows = ["entryNumber,buyerName,raffleName,packageName,source,paymentStatus"];
    cachedEntries.forEach((entry) => {
      rows.push([
        entry.entryNumber || entry.assignedCardNumber || "",
        (entry.buyerName || "").replaceAll(",", " "),
        (entry.raffleName || "").replaceAll(",", " "),
        (entry.packageName || "").replaceAll(",", " "),
        entry.source || "payment",
        entry.paymentStatus || "",
      ].join(","));
    });

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "entries-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  });

  sidebarNav.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-section]");
    if (!button) return;
    switchSection(button.dataset.section);
  });

  refreshBtn.addEventListener("click", loadDashboard);

  logoutBtn.addEventListener("click", () => {
    sessionStorage.removeItem("opraffles_admin_code");
    window.location.href = "/admin/index.html";
  });

  enforceAccess()
    .then(loadDashboard)
    .catch((error) => {
      console.error("Admin load failed", error);
      window.location.href = "/admin/index.html";
    });
})();
