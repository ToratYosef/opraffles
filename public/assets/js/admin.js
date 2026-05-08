/* global RafflePlatform */
(function spinControlRoom() {
  const functions = RafflePlatform.functions;
  const HARDCODED_ADMIN_CODE = "123";

  const loginSection = document.getElementById("loginSection");
  const dashboardSection = document.getElementById("dashboardSection");
  if (!loginSection || !dashboardSection) return;

  const loginForm = document.getElementById("loginForm");
  const adminCodeInput = document.getElementById("adminCode");
  const loginMessage = document.getElementById("loginMessage");
  const signOutBtn = document.getElementById("signOutBtn");
  const adminStatusChip = document.getElementById("adminStatusChip");
  const loggedInAs = document.getElementById("loggedInAs");

  const raffleSelector = document.getElementById("raffleSelector");
  const selectedType = document.getElementById("selectedType");
  const selectedStatus = document.getElementById("selectedStatus");
  const selectedRange = document.getElementById("selectedRange");
  const selectorHint = document.getElementById("selectorHint");
  const refreshSelectedBtn = document.getElementById("refreshSelectedBtn");

  const statSold = document.getElementById("statSold");
  const statRevenue = document.getElementById("statRevenue");
  const statReserved = document.getElementById("statReserved");
  const statLeft = document.getElementById("statLeft");

  const ticketTableBody = document.getElementById("ticketTableBody");
  const tableMeta = document.getElementById("tableMeta");

  const modalBackdrop = document.getElementById("modalBackdrop");
  const manualModal = document.getElementById("manualModal");
  const manualForm = document.getElementById("manualForm");
  const wheelModal = document.getElementById("wheelModal");
  const wheelList = document.getElementById("wheelList");
  const pickWinnerBtn = document.getElementById("pickWinnerBtn");
  const winnerModal = document.getElementById("winnerModal");
  const winnerName = document.getElementById("winnerName");
  const winnerTicket = document.getElementById("winnerTicket");
  const winnerPhone = document.getElementById("winnerPhone");
  const deleteModal = document.getElementById("deleteModal");
  const deleteTicketText = document.getElementById("deleteTicketText");
  const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
  const refundModal = document.getElementById("refundModal");
  const refundTicketText = document.getElementById("refundTicketText");
  const confirmRefundBtn = document.getElementById("confirmRefundBtn");

  const actionButtons = Array.from(document.querySelectorAll(".spin-action"));

  let adminCode = sessionStorage.getItem("opraffles_admin_code") || "";
  let raffles = [];
  let selectedRaffleId = "";
  let selectedSnapshot = null;
  let activeDeleteTicket = null;
  let activeRefundTicket = null;

  function formatCurrency(cents) {
    return RafflePlatform.formatCurrency(Number(cents || 0), "usd");
  }

  function setActionDisabled(disabled) {
    actionButtons.forEach((btn) => {
      btn.disabled = !!disabled;
    });
  }

  function clearStatsAndTable(message) {
    statSold.textContent = "0 / 0";
    statRevenue.textContent = "$0.00";
    statReserved.textContent = "0";
    statLeft.textContent = "0";
    ticketTableBody.innerHTML = '<tr><td colspan="8" class="px-3 py-4 text-sm text-slate-400">' + message + "</td></tr>";
    tableMeta.textContent = "No raffle selected";
  }

  function setSelectorHeader(raffle) {
    if (!raffle) {
      selectedType.textContent = "-";
      selectedStatus.textContent = "-";
      selectedRange.textContent = "-";
      return;
    }
    selectedType.textContent = raffle.type || "-";
    selectedStatus.textContent = raffle.active ? "Active" : "Inactive";
    const min = Number(raffle.minNumber || 1);
    const max = Number(raffle.maxNumber || raffle.totalSpots || 0);
    selectedRange.textContent = min && max ? (String(min) + "-" + String(max)) : "-";
  }

  function statusBadge(status) {
    const s = String(status || "").toLowerCase();
    if (s === "paid") return "bg-emerald-500/15 border-emerald-400/40 text-emerald-300";
    if (s === "reserved") return "bg-amber-500/15 border-amber-400/40 text-amber-300";
    if (s === "claimed") return "bg-sky-500/15 border-sky-400/40 text-sky-300";
    if (s === "refunded") return "bg-rose-500/15 border-rose-400/40 text-rose-300";
    return "bg-slate-500/15 border-slate-400/40 text-slate-300";
  }

  function openModal(id) {
    modalBackdrop.classList.remove("hidden");
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove("hidden");
      el.classList.add("flex");
    }
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add("hidden");
      el.classList.remove("flex");
    }
    const anyOpen = [manualModal, wheelModal, winnerModal, deleteModal, refundModal].some((m) => m && !m.classList.contains("hidden"));
    if (!anyOpen) modalBackdrop.classList.add("hidden");
  }

  function closeAllModals() {
    ["manualModal", "wheelModal", "winnerModal", "deleteModal", "refundModal"].forEach(closeModal);
    modalBackdrop.classList.add("hidden");
  }

  function callAdmin(name, payload) {
    const callable = functions.httpsCallable(name);
    return callable({ adminCode, ...payload }).then((r) => r.data || {});
  }

  async function loadRaffles() {
    const data = await callAdmin("adminGetDashboard", {});
    raffles = (data.raffles || []).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    raffleSelector.innerHTML = '<option value="">Select Spin Raffle...</option>' +
      raffles
        .filter((r) => r.type === "spin")
        .map((r) => '<option value="' + r.id + '">' + (r.name || r.id) + "</option>")
        .join("");

    if (selectedRaffleId && raffles.some((r) => r.id === selectedRaffleId && r.type === "spin")) {
      raffleSelector.value = selectedRaffleId;
    }
  }

  function renderTickets(tickets) {
    if (!Array.isArray(tickets) || !tickets.length) {
      ticketTableBody.innerHTML = '<tr><td colspan="8" class="px-3 py-4 text-sm text-slate-400">No tickets found for this raffle.</td></tr>';
      return;
    }

    ticketTableBody.innerHTML = tickets.map((t) => {
      const canDelete = !!t.id && t.source !== "reservation";
      const canRefund = !!t.id && (t.status === "paid" || t.status === "claimed");
      const canClaim = !!t.id && t.status === "paid";
      return '<tr class="border-t border-slate-800 hover:bg-slate-900/60">' +
        '<td class="px-3 py-3 font-bold text-amber-200">' + String(t.ticketNumber || "-") + "</td>" +
        '<td class="px-3 py-3"><span class="rounded-full border px-2 py-1 text-xs font-semibold uppercase ' + statusBadge(t.status) + '">' + String(t.status || "-") + "</span></td>" +
        '<td class="px-3 py-3">' + String(t.buyerName || "-") + "</td>" +
        '<td class="px-3 py-3">' + String(t.email || "-") + "</td>" +
        '<td class="px-3 py-3">' + String(t.phone || "-") + "</td>" +
        '<td class="px-3 py-3">' + formatCurrency(t.amount || 0) + "</td>" +
        '<td class="px-3 py-3">' + RafflePlatform.formatDate(t.timestamp) + "</td>" +
        '<td class="px-3 py-3"><div class="flex flex-wrap gap-1">' +
          '<button data-action="view" data-id="' + String(t.id || "") + '" class="rounded-lg border border-slate-700 px-2 py-1 text-xs">View</button>' +
          '<button data-action="delete" data-id="' + String(t.id || "") + '" class="rounded-lg border border-rose-300/40 px-2 py-1 text-xs text-rose-300 ' + (canDelete ? '' : 'opacity-40 cursor-not-allowed') + '">Delete</button>' +
          '<button data-action="refund" data-id="' + String(t.id || "") + '" class="rounded-lg border border-amber-300/40 px-2 py-1 text-xs text-amber-200 ' + (canRefund ? '' : 'opacity-40 cursor-not-allowed') + '">Refund</button>' +
          '<button data-action="claim" data-id="' + String(t.id || "") + '" class="rounded-lg border border-sky-300/40 px-2 py-1 text-xs text-sky-200 ' + (canClaim ? '' : 'opacity-40 cursor-not-allowed') + '">Mark Claimed</button>' +
        "</div></td>" +
      "</tr>";
    }).join("");
  }

  async function loadSelectedSnapshot() {
    selectedRaffleId = String(raffleSelector.value || "").trim();
    if (!selectedRaffleId) {
      selectedSnapshot = null;
      setSelectorHeader(null);
      selectorHint.textContent = "Select a raffle to manage tickets.";
      setActionDisabled(true);
      clearStatsAndTable("Select a raffle to manage tickets.");
      return;
    }

    const snapshot = await callAdmin("adminGetSpinRaffleSnapshot", { raffleId: selectedRaffleId });
    selectedSnapshot = snapshot;
    setSelectorHeader(snapshot.raffle || null);

    if (!snapshot.isSpin) {
      selectorHint.textContent = "This admin screen is only for spin raffles.";
      setActionDisabled(true);
      clearStatsAndTable("This admin screen is only for spin raffles.");
      return;
    }

    selectorHint.textContent = "Managing: " + String(snapshot.raffle.name || selectedRaffleId);
    setActionDisabled(false);
    const stats = snapshot.stats || {};
    statSold.textContent = String(stats.ticketsSold || 0) + " / " + String(stats.totalSpots || 0);
    statRevenue.textContent = formatCurrency(stats.revenueCents || 0);
    statReserved.textContent = String(stats.reservedCount || 0);
    statLeft.textContent = String(stats.ticketsLeft || 0);
    tableMeta.textContent = String((snapshot.tickets || []).length) + " rows";
    renderTickets(snapshot.tickets || []);
  }

  function findTicketByEntryId(entryId) {
    if (!selectedSnapshot || !Array.isArray(selectedSnapshot.tickets)) return null;
    return selectedSnapshot.tickets.find((t) => String(t.id || "") === String(entryId || "")) || null;
  }

  function exportPaidCsv() {
    if (!selectedSnapshot || !Array.isArray(selectedSnapshot.tickets)) return;
    const rows = ["ticketNumber,status,buyerName,email,phone,amount"];
    selectedSnapshot.tickets
      .filter((t) => t.status === "paid" || t.status === "claimed")
      .forEach((t) => {
        rows.push([
          t.ticketNumber || "",
          t.status || "",
          String(t.buyerName || "").replace(/,/g, " "),
          String(t.email || "").replace(/,/g, " "),
          String(t.phone || "").replace(/,/g, " "),
          Number(t.amount || 0),
        ].join(","));
      });

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "paid-tickets-" + selectedRaffleId + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function buildWheelList() {
    const paid = (selectedSnapshot && selectedSnapshot.paidTickets) || [];
    if (!paid.length) {
      wheelList.textContent = "No paid tickets available.";
      return;
    }
    wheelList.textContent = paid.map((t) => (t.buyerName || "Anonymous") + " | #" + String(t.ticketNumber || "-")).join("\n");
  }

  async function onActionClick(action) {
    if (!selectedRaffleId || !selectedSnapshot || !selectedSnapshot.isSpin) return;

    if (action === "cleanup") {
      const data = await callAdmin("adminCleanupSpinReservations", { raffleId: selectedRaffleId });
      selectorHint.textContent = "Expired reservations removed: " + String(data.released || 0);
      await loadSelectedSnapshot();
      return;
    }

    if (action === "export") {
      exportPaidCsv();
      return;
    }

    if (action === "manual") {
      openModal("manualModal");
      return;
    }

    if (action === "wheel") {
      buildWheelList();
      openModal("wheelModal");
      return;
    }

    if (action === "emailDrawing") {
      selectorHint.textContent = "Email campaign placeholder: Drawing Soon (selected raffle only).";
      return;
    }

    if (action === "emailRunningOut") {
      selectorHint.textContent = "Email campaign placeholder: Tickets Running Out (selected raffle only).";
    }
  }

  async function initSession() {
    if (!adminCode || adminCode !== HARDCODED_ADMIN_CODE) {
      loginSection.classList.remove("hidden");
      dashboardSection.classList.add("hidden");
      adminStatusChip.textContent = "Signed out";
      signOutBtn.classList.add("hidden");
      return;
    }

    loginSection.classList.add("hidden");
    dashboardSection.classList.remove("hidden");
    adminStatusChip.textContent = "Signed in";
    signOutBtn.classList.remove("hidden");
    loggedInAs.textContent = "Logged in admin: control-room";

    await loadRaffles();
    await loadSelectedSnapshot();
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = String(adminCodeInput.value || "").trim();
    if (code !== HARDCODED_ADMIN_CODE) {
      loginMessage.textContent = "Invalid admin code.";
      loginMessage.classList.remove("hidden");
      return;
    }
    loginMessage.classList.add("hidden");
    adminCode = code;
    sessionStorage.setItem("opraffles_admin_code", code);
    await initSession();
  });

  signOutBtn.addEventListener("click", () => {
    adminCode = "";
    selectedSnapshot = null;
    selectedRaffleId = "";
    sessionStorage.removeItem("opraffles_admin_code");
    closeAllModals();
    initSession();
  });

  raffleSelector.addEventListener("change", loadSelectedSnapshot);
  refreshSelectedBtn.addEventListener("click", loadSelectedSnapshot);

  actionButtons.forEach((btn) => {
    btn.addEventListener("click", () => onActionClick(btn.dataset.action));
  });

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.getAttribute("data-close-modal")));
  });

  modalBackdrop.addEventListener("click", closeAllModals);

  manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedRaffleId) return;
    const fd = new FormData(manualForm);
    await callAdmin("createManualEntry", {
      raffleId: selectedRaffleId,
      buyerName: String(fd.get("buyerName") || "").trim(),
      buyerEmail: String(fd.get("buyerEmail") || "").trim(),
      buyerPhone: String(fd.get("buyerPhone") || "").trim(),
      quantity: 1,
    });
    closeModal("manualModal");
    manualForm.reset();
    await loadSelectedSnapshot();
  });

  pickWinnerBtn.addEventListener("click", () => {
    const paid = (selectedSnapshot && selectedSnapshot.paidTickets) || [];
    if (!paid.length) {
      wheelList.textContent = "No paid tickets to pick from.";
      return;
    }
    const winner = paid[Math.floor(Math.random() * paid.length)];
    winnerName.textContent = winner.buyerName || "Anonymous";
    winnerTicket.textContent = "Ticket #: " + String(winner.ticketNumber || "-");
    winnerPhone.textContent = "Phone: " + String(winner.phone || "-");
    openModal("winnerModal");
  });

  ticketTableBody.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const entryId = btn.dataset.id;
    const ticket = findTicketByEntryId(entryId);

    if (action === "view") {
      if (!ticket) return;
      alert("Ticket #" + String(ticket.ticketNumber || "-") + "\nStatus: " + String(ticket.status || "-") + "\nBuyer: " + String(ticket.buyerName || "-"));
      return;
    }

    if (!ticket) return;

    if (action === "delete" && ticket.id && ticket.source !== "reservation") {
      activeDeleteTicket = ticket;
      deleteTicketText.textContent = "Delete ticket #" + String(ticket.ticketNumber || "-") + " for " + String(ticket.buyerName || "Unknown") + "?";
      openModal("deleteModal");
      return;
    }

    if (action === "refund" && ticket.id && (ticket.status === "paid" || ticket.status === "claimed")) {
      activeRefundTicket = ticket;
      refundTicketText.textContent = "Refund ticket #" + String(ticket.ticketNumber || "-") + " for " + String(ticket.buyerName || "Unknown") + "?";
      openModal("refundModal");
      return;
    }

    if (action === "claim" && ticket.id && ticket.status === "paid") {
      await callAdmin("adminMarkSpinTicketClaimed", { entryId: ticket.id });
      await loadSelectedSnapshot();
    }
  });

  confirmDeleteBtn.addEventListener("click", async () => {
    if (!activeDeleteTicket || !activeDeleteTicket.id) return;
    await callAdmin("adminDeleteSpinTicket", { entryId: activeDeleteTicket.id });
    activeDeleteTicket = null;
    closeModal("deleteModal");
    await loadSelectedSnapshot();
  });

  confirmRefundBtn.addEventListener("click", async () => {
    if (!activeRefundTicket || !activeRefundTicket.id) return;
    await callAdmin("adminRefundSpinTicket", { entryId: activeRefundTicket.id });
    activeRefundTicket = null;
    closeModal("refundModal");
    await loadSelectedSnapshot();
  });

  setActionDisabled(true);
  clearStatsAndTable("Select a raffle to manage tickets.");
  initSession().catch((error) => {
    console.error(error);
    selectorHint.textContent = "Failed to initialize admin control room.";
  });
})();
