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
  const spinModalStatus = document.getElementById("spinModalStatus");
  const spinRevealNumber = document.getElementById("spinRevealNumber");

  const params = new URLSearchParams(window.location.search);
  const slug = String(params.get("slug") || "").trim().toLowerCase();

  let raffle = null;
  let stripe = null;
  let cardElement = null;

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

  async function revealSpinAndRedirect(orderId, finalNumber) {
    spinModalStatus.textContent = "Payment successful";
    spinRevealModal.classList.remove("hidden");
    spinRevealModal.classList.add("flex");

    let ticks = 0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        spinRevealNumber.textContent = String(Math.floor(Math.random() * 99) + 1);
        ticks += 1;
        if (ticks > 20) {
          clearInterval(timer);
          resolve();
        }
      }, 95);
    });

    spinRevealNumber.textContent = String(finalNumber);
    await new Promise((resolve) => setTimeout(resolve, 3000));
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

    raffleBanner.src = raffle.bannerImage || "https://images.unsplash.com/photo-1519750157634-b6d493a0f77c?auto=format&fit=crop&w=1400&q=80";
    raffleTypeBadge.textContent = typeLabel(raffle.type);
    raffleName.textContent = raffle.name || "Raffle";
    raffleDescription.textContent = raffle.description || "";
    raffleEntryPrice.textContent = RafflePlatform.formatCurrency(Math.round(Number(raffle.entryPrice || 0) * 100), "usd");

    const paidEntriesSnap = await db.collection("entries")
      .where("raffleId", "==", raffle.id)
      .where("paymentStatus", "==", "paid")
      .get();
    const paidCount = paidEntriesSnap.size;

    let originalTotal = null;
    if (raffle.type === "spin") {
      originalTotal = Number(raffle.totalSpots || 0);
    } else if (!raffle.unlimitedEntries && Number(raffle.maxEntries || 0) > 0) {
      originalTotal = Number(raffle.maxEntries || 0);
    }

    if (originalTotal && originalTotal > 0) {
      const left = Math.max(originalTotal - paidCount, 0);
      ticketsLeftValue.textContent = String(left);
      ticketsLeftDetail.textContent = String(originalTotal) + " total - " + String(paidCount) + " paid";
    } else {
      ticketsLeftValue.textContent = "Unlimited";
      ticketsLeftDetail.textContent = String(paidCount) + " paid so far";
    }
    ticketsLeftCard.classList.remove("hidden");

    if (raffle.type === "spin") {
      spinInfo.classList.remove("hidden");
      spinSummary.textContent = "Numbers are assigned automatically after payment. Total spots: " + String(raffle.totalSpots || 0);
      priceCard.classList.add("hidden");
      estimateCard.classList.add("hidden");
      entryQtyWrap.classList.add("hidden");
      spinOneTicketNote.classList.remove("hidden");
      entryQtyInput.value = "1";
      entryQtyInput.disabled = true;
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

    checkoutBtn.disabled = true;
    checkoutBtn.textContent = "Processing...";

    try {
      if (raffle.type === "spin") {
        if (!stripe || !cardElement) {
          throw new Error("Card form is not ready. Please reload and try again.");
        }

        setMessage("Reserving your number...", "success");
        checkoutMessage.classList.remove("hidden");

        const startIntent = await functions.httpsCallable("createSpinPaymentIntent")({
          raffleId: raffle.id,
          buyerName,
          buyerEmail,
          buyerPhone,
        });

        const data = startIntent.data || {};
        if (!data.clientSecret || !data.orderId) {
          throw new Error("Unable to start payment.");
        }

        const confirmation = await stripe.confirmCardPayment(data.clientSecret, {
          payment_method: {
            card: cardElement,
            billing_details: {
              name: buyerName,
              email: buyerEmail,
              phone: buyerPhone,
            },
          },
        });

        if (confirmation.error) {
          await functions.httpsCallable("releaseSpinReservation")({
            orderId: data.orderId,
            reason: "payment_declined",
          });
          setMessage("Payment declined. Your payment did not go through. Please try again.", "error");
          checkoutMessage.classList.remove("hidden");
          checkoutBtn.disabled = false;
          checkoutBtn.textContent = "Pay Now";
          return;
        }

        setMessage("Payment successful. Revealing your number...", "success");
        checkoutMessage.classList.remove("hidden");

        const paidOrder = await waitForPaidOrder(data.orderId);
        const number = Array.isArray(paidOrder.assignedNumbers) ? paidOrder.assignedNumbers[0] : null;
        if (!number) {
          throw new Error("Payment completed, but number is not ready yet. Please refresh shortly.");
        }
        await revealSpinAndRedirect(data.orderId, number);
        return;
      }

      const callable = functions.httpsCallable("createCheckoutSession");
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
      checkoutBtn.textContent = "Pay Now";
    }
  });

  entryQtyInput.addEventListener("input", updateEstimate);

  loadRaffle().catch((error) => {
    console.error(error);
    raffleLoading.classList.add("hidden");
    raffleNotFound.classList.remove("hidden");
  });
})();
