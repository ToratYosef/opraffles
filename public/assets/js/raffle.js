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
  const ticketsLeftCard = document.getElementById("ticketsLeftCard");
  const ticketsLeftValue = document.getElementById("ticketsLeftValue");
  const ticketsLeftDetail = document.getElementById("ticketsLeftDetail");
  const spinScoreboard = document.getElementById("spinScoreboard");
  const scoreDigits = document.getElementById("scoreDigits");
  const scoreSubtext = document.getElementById("scoreSubtext");
  const priceCard = document.getElementById("priceCard");
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
  const cardElementWrap = document.getElementById("cardElementWrap");
  const estimateCard = document.getElementById("estimateCard");
  const spinRevealModal = document.getElementById("spinRevealModal");
  const spinModalTitle = document.getElementById("spinModalTitle");
  const spinModalSubtitle = document.getElementById("spinModalSubtitle");
  const spinRevealNumber = document.getElementById("spinRevealNumber");
  const spinPriceReveal = document.getElementById("spinPriceReveal");
  const spinFinalPrice = document.getElementById("spinFinalPrice");

  const params = new URLSearchParams(window.location.search);
  const slug = String(params.get("slug") || "").trim().toLowerCase();

  let raffle = null;
  let stripe = null;
  let cardElement = null;
  let flickerTimer = null;

  function typeLabel(type) {
    if (type === "spin") return "Spin The Wheel";
    return "General Entry";
  }

  function safeBannerUrl(value) {
    const raw = String(value || "").trim();
    if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) {
      return raw;
    }
    return "https://images.unsplash.com/photo-1519750157634-b6d493a0f77c?auto=format&fit=crop&w=1400&q=80";
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

  async function initializeCardElementForSpin() {
    if (!window.Stripe) {
      throw new Error("Stripe.js failed to load.");
    }

    const config = await functions.httpsCallable("getPublicConfig")({});
    const key = config.data && config.data.stripePublishableKey;
    if (!key) {
      throw new Error("Missing Stripe publishable key.");
    }

    stripe = window.Stripe(key);
    const elements = stripe.elements();
    cardElement = elements.create("card", {
      hidePostalCode: true,
      style: {
        base: {
          fontSize: "16px",
          color: "#0f172a",
          fontFamily: "Sora, system-ui, sans-serif",
          "::placeholder": { color: "#94a3b8" },
        },
      },
    });
    cardElement.mount("#cardElement");
    cardElementWrap.classList.remove("hidden");
  }

  function openSpinModal() {
    spinModalTitle.textContent = "Spinning...";
    spinModalSubtitle.textContent = "Your number is being selected";
    spinRevealNumber.textContent = "?";
    spinRevealNumber.classList.remove("animate-blink");
    spinPriceReveal.classList.add("hidden");
    spinRevealModal.classList.remove("hidden");
    spinRevealModal.classList.add("flex");
    const totalSpots = Number((raffle && raffle.totalSpots) || 500);
    flickerTimer = setInterval(() => {
      spinRevealNumber.textContent = String(Math.floor(Math.random() * totalSpots) + 1);
    }, 80);
  }

  function closeSpinModal() {
    if (flickerTimer) { clearInterval(flickerTimer); flickerTimer = null; }
    spinRevealModal.classList.add("hidden");
    spinRevealModal.classList.remove("flex");
  }

  async function revealSpinSuccess(orderId, finalNumber) {
    if (flickerTimer) { clearInterval(flickerTimer); flickerTimer = null; }
    spinModalTitle.textContent = "You got it!";
    spinModalSubtitle.textContent = "";
    spinRevealNumber.textContent = String(finalNumber);
    spinRevealNumber.classList.add("animate-blink");
    spinFinalPrice.textContent = "$" + String(finalNumber) + ".00";
    spinPriceReveal.classList.remove("hidden");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    window.location.href = "/success.html?order_id=" + encodeURIComponent(orderId);
  }

  async function waitForPaidOrder(orderId) {
    const callable = functions.httpsCallable("getOrderStatus");
    for (let i = 0; i < 20; i += 1) {
      const result = await callable({ orderId });
      const order = result.data && result.data.order;
      if (order && order.status === "paid") {
        return order;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error("Payment was captured but confirmation is still processing. Please refresh shortly.");
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

    raffleBanner.src = safeBannerUrl(raffle.bannerImage);
    raffleTypeBadge.textContent = typeLabel(raffle.type);
    raffleName.textContent = raffle.name || "Raffle";
    raffleDescription.textContent = raffle.description || "";
    raffleEntryPrice.textContent = RafflePlatform.formatCurrency(Math.round(Number(raffle.entryPrice || 0) * 100), "usd");

    const statsResult = await functions.httpsCallable("getRafflePublicStats")({ raffleId: raffle.id });
    const stats = statsResult.data || {};
    const paidCount = Number(stats.paidCount || 0);
    const originalTotal = stats.originalTotal == null ? null : Number(stats.originalTotal);

    if (originalTotal && originalTotal > 0) {
      const left = Number(stats.ticketsLeft == null ? 0 : stats.ticketsLeft);
      ticketsLeftValue.textContent = String(left);
      ticketsLeftDetail.textContent = String(originalTotal) + " total - " + String(paidCount) + " paid";
    } else {
      ticketsLeftValue.textContent = "Unlimited";
      ticketsLeftDetail.textContent = String(paidCount) + " paid so far";
    }
    ticketsLeftCard.classList.remove("hidden");

    if (raffle.type === "spin" && originalTotal && originalTotal > 0) {
      const left = Number(stats.ticketsLeft == null ? 0 : stats.ticketsLeft);
      const digits = String(Math.max(left, 0)).split("");
      scoreDigits.innerHTML = digits
        .map(
          (d) =>
            '<div class="flex h-16 w-12 items-center justify-center rounded-xl border-2 border-amber-300 bg-white shadow-sm">' +
            '<span class="text-3xl font-extrabold text-slate-900">' + d + "</span></div>"
        )
        .join("");
      scoreSubtext.textContent = "Out of " + String(originalTotal) + " total spots";
      spinScoreboard.classList.remove("hidden");
      ticketsLeftCard.classList.add("hidden");
    }

    if (raffle.type === "spin") {
      spinInfo.classList.add("hidden");
      priceCard.classList.add("hidden");
      estimateCard.classList.add("hidden");
      entryQtyWrap.classList.add("hidden");
      spinOneTicketNote.classList.remove("hidden");
      entryQtyInput.value = "1";
      entryQtyInput.disabled = true;
      checkoutBtn.textContent = "Pay Now";
      await initializeCardElementForSpin();
    } else {
      priceCard.classList.remove("hidden");
      estimateCard.classList.remove("hidden");
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
    const qty = raffle.type === "spin" ? 1 : Math.max(1, Number(entryQtyInput.value || 1));
    const buyerName = document.getElementById("buyerName").value.trim();
    const buyerEmail = document.getElementById("buyerEmail").value.trim();
    const buyerPhone = document.getElementById("buyerPhone").value.trim();

    try {
      if (raffle.type === "spin") {
        if (!stripe || !cardElement) {
          throw new Error("Payment form is not ready. Please reload and try again.");
        }

        const startIntent = await functions.httpsCallable("createSpinPaymentIntent")({
          raffleId: raffle.id,
          buyerName,
          buyerEmail,
          buyerPhone,
        });
        const spinReservationData = startIntent.data || {};
        if (!spinReservationData.clientSecret || !spinReservationData.orderId) {
          throw new Error("Unable to reserve a spot. Please try again.");
        }

        checkoutBtn.disabled = true;
        checkoutBtn.textContent = "Processing...";
        checkoutMessage.classList.add("hidden");

        openSpinModal();

        const confirmation = await stripe.confirmCardPayment(spinReservationData.clientSecret, {
          payment_method: {
            card: cardElement,
            billing_details: { name: buyerName, email: buyerEmail, phone: buyerPhone },
          },
        });

        if (confirmation.error) {
          closeSpinModal();
          await functions.httpsCallable("releaseSpinReservation")({
            orderId: spinReservationData.orderId,
            reason: "payment_declined",
          }).catch(() => {});
          setMessage("Payment failed: " + (confirmation.error.message || "Card declined.") + " Please try again.", "error");
          checkoutMessage.classList.remove("hidden");
          checkoutBtn.disabled = false;
          checkoutBtn.textContent = "Pay Now";
          return;
        }

        const paidOrder = await waitForPaidOrder(spinReservationData.orderId);
        const number = Array.isArray(paidOrder.assignedNumbers) ? paidOrder.assignedNumbers[0] : null;
        if (!number) {
          throw new Error("Payment completed, but number is not ready yet. Please refresh shortly.");
        }
        await revealSpinSuccess(spinReservationData.orderId, number);
        return;
      }

      const callable = functions.httpsCallable("createCheckoutSession");
      checkoutBtn.disabled = true;
      checkoutBtn.textContent = "Redirecting...";
      const result = await callable({
        raffleId: raffle.id,
        quantity: qty,
        buyerName,
        buyerEmail,
        buyerPhone,
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
      if (raffle && raffle.type === "spin") {
        checkoutBtn.textContent = "Pay Now";
      } else {
        checkoutBtn.textContent = "Continue to Checkout";
      }
    }
  });

  entryQtyInput.addEventListener("input", updateEstimate);

  loadRaffle().catch((error) => {
    console.error(error);
    raffleLoading.classList.add("hidden");
    raffleNotFound.classList.remove("hidden");
  });
})();
