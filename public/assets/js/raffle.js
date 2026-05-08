/* global RafflePlatform */
(function rafflePageController() {
  const db = RafflePlatform.db;
  const functions = RafflePlatform.functions;

  const raffleLoading = document.getElementById("raffleLoading");
  const raffleNotFound = document.getElementById("raffleNotFound");
  const raffleContent = document.getElementById("raffleContent");

  const raffleBanner = document.getElementById("raffleBanner");
  const raffleTypeBadge = document.getElementById("raffleTypeBadge");
  const raffleName = document.getElementById("raffleName");
  const raffleDescription = document.getElementById("raffleDescription");
  const raffleEntryPrice = document.getElementById("raffleEntryPrice");
  const raffleEntryLimit = document.getElementById("raffleEntryLimit");
  const spinInfo = document.getElementById("spinInfo");
  const spinSummary = document.getElementById("spinSummary");
  const dealInfo = document.getElementById("dealInfo");
  const dealSummary = document.getElementById("dealSummary");

  const checkoutForm = document.getElementById("checkoutForm");
  const entryQtyInput = document.getElementById("entryQty");
  const entryQtyWrap = document.getElementById("entryQtyWrap");
  const spinOneTicketNote = document.getElementById("spinOneTicketNote");
  const estimatedTotal = document.getElementById("estimatedTotal");
  const estimatedDiscount = document.getElementById("estimatedDiscount");
  const checkoutMessage = document.getElementById("checkoutMessage");
  const checkoutBtn = document.getElementById("checkoutBtn");

  const params = new URLSearchParams(window.location.search);
  const slug = String(params.get("slug") || "").trim().toLowerCase();

  let raffle = null;

  function typeLabel(type) {
    if (type === "spin") return "Spin The Wheel";
    return "General Entry";
  }

  function bestDealForQty(deals, qty) {
    let best = { qty: 0, discountPercent: 0 };
    (deals || []).forEach((tier) => {
      const tierQty = Number(tier.qty || 0);
      const tierDiscount = Number(tier.discountPercent || 0);
      if (qty >= tierQty && tierDiscount > best.discountPercent) {
        best = { qty: tierQty, discountPercent: tierDiscount };
      }
    });
    return best;
  }

  function updateEstimate() {
    if (!raffle) return;
    const qty = raffle.type === "spin" ? 1 : Math.max(1, Number(entryQtyInput.value || 1));
    entryQtyInput.value = String(qty);

    const unitCents = Math.round(Number(raffle.entryPrice || 0) * 100);
    const subtotal = unitCents * qty;
    const deal = bestDealForQty(raffle.packageDeals || [], qty);
    const discount = Math.round(subtotal * (Number(deal.discountPercent || 0) / 100));
    const total = Math.max(subtotal - discount, 0);

    estimatedTotal.textContent = RafflePlatform.formatCurrency(total, "usd");
    estimatedDiscount.textContent = raffle.type === "spin"
      ? "One spot per payment. Your number is assigned automatically after payment succeeds."
      : deal.discountPercent > 0
      ? "Package deal applied: " + deal.discountPercent + "% off"
      : "No discount tier applied";
  }

  function setMessage(text, kind) {
    checkoutMessage.textContent = text;
    checkoutMessage.className = kind === "error"
      ? "rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700"
      : "rounded-lg bg-emerald-100 px-3 py-2 text-sm text-emerald-800";
  }

  async function loadRaffle() {
    if (!slug) {
      raffleLoading.classList.add("hidden");
      raffleNotFound.classList.remove("hidden");
      return;
    }

    const snap = await db.collection("raffles")
      .where("slug", "==", slug)
      .where("active", "==", true)
      .limit(1)
      .get();

    raffleLoading.classList.add("hidden");
    if (snap.empty) {
      raffleNotFound.classList.remove("hidden");
      return;
    }

    raffle = { id: snap.docs[0].id, ...snap.docs[0].data() };
    raffleContent.classList.remove("hidden");

    raffleBanner.src = raffle.bannerImage || "https://images.unsplash.com/photo-1519750157634-b6d493a0f77c?auto=format&fit=crop&w=1400&q=80";
    raffleTypeBadge.textContent = typeLabel(raffle.type);
    raffleName.textContent = raffle.name || "Raffle";
    raffleDescription.textContent = raffle.description || "";
    raffleEntryPrice.textContent = RafflePlatform.formatCurrency(Math.round(Number(raffle.entryPrice || 0) * 100), "usd");
    raffleEntryLimit.textContent = raffle.unlimitedEntries ? "Unlimited" : "Max " + String(raffle.maxEntries || 0);

    if (raffle.type === "spin") {
      spinInfo.classList.remove("hidden");
      spinSummary.textContent = "Numbers are assigned automatically after payment. Total spots: " + String(raffle.totalSpots || 0);
      entryQtyWrap.classList.add("hidden");
      spinOneTicketNote.classList.remove("hidden");
      entryQtyInput.value = "1";
      entryQtyInput.disabled = true;
    }

    if ((raffle.packageDeals || []).length) {
      dealInfo.classList.remove("hidden");
      dealSummary.textContent = raffle.packageDeals
        .map((tier) => "Buy " + tier.qty + " = " + tier.discountPercent + "% off")
        .join(" | ");
    }

    updateEstimate();
  }

  checkoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    checkoutMessage.classList.add("hidden");

    if (!raffle) return;
    const qty = Math.max(1, Number(entryQtyInput.value || 1));

    checkoutBtn.disabled = true;
    checkoutBtn.textContent = "Preparing checkout...";

    try {
      const callable = functions.httpsCallable("createCheckoutSession");
      const result = await callable({
        raffleId: raffle.id,
        quantity: qty,
        buyerName: document.getElementById("buyerName").value.trim(),
        buyerEmail: document.getElementById("buyerEmail").value.trim(),
        buyerPhone: document.getElementById("buyerPhone").value.trim(),
      });

      const data = result.data || {};
      if (!data.checkoutUrl) {
        throw new Error("Checkout URL not returned.");
      }

      window.location.href = data.checkoutUrl;
    } catch (error) {
      setMessage(error.message || "Could not start checkout.", "error");
      checkoutMessage.classList.remove("hidden");
      checkoutBtn.disabled = false;
      checkoutBtn.textContent = "Continue to Secure Checkout";
    }
  });

  entryQtyInput.addEventListener("input", updateEstimate);

  loadRaffle().catch((error) => {
    console.error(error);
    raffleLoading.classList.add("hidden");
    raffleNotFound.classList.remove("hidden");
  });
})();
