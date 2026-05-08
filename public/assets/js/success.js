/* global RafflePlatform */
(function successPageController() {
  const functions = RafflePlatform.functions;

  const successLoading = document.getElementById("successLoading");
  const successError = document.getElementById("successError");
  const successContent = document.getElementById("successContent");

  const summaryRaffle = document.getElementById("summaryRaffle");
  const summaryEntries = document.getElementById("summaryEntries");
  const summaryAmount = document.getElementById("summaryAmount");
  const assignedCardWrap = document.getElementById("assignedCardWrap");
  const summaryAssignedCard = document.getElementById("summaryAssignedCard");

  const params = new URLSearchParams(window.location.search);
  const sessionId = String(params.get("session_id") || "").trim();
  const orderId = String(params.get("order_id") || "").trim();

  function showError(message) {
    successLoading.classList.add("hidden");
    successError.textContent = message;
    successError.classList.remove("hidden");
  }

  async function waitForPaidOrder() {
    const bySession = functions.httpsCallable("getOrderBySession");
    const byOrder = functions.httpsCallable("getOrderStatus");

    for (let i = 0; i < 12; i += 1) {
      let result;
      if (orderId) {
        result = await byOrder({ orderId });
      } else {
        result = await bySession({ sessionId });
      }
      const order = result.data && result.data.order;
      if (order && order.status === "paid") {
        return order;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error("Payment is still processing. Please refresh in a moment.");
  }

  async function init() {
    if (!sessionId && !orderId) {
      showError("Missing payment reference in URL.");
      return;
    }

    try {
      const order = await waitForPaidOrder();

      if (order.raffleType === "spin" && Array.isArray(order.assignedNumbers) && order.assignedNumbers.length) {
        assignedCardWrap.classList.remove("hidden");
        summaryAssignedCard.textContent = order.assignedNumbers.join(", ");
      }

      summaryRaffle.textContent = order.raffleName || "-";
      summaryEntries.textContent = String(order.entryCount || 0);
      summaryAmount.textContent = RafflePlatform.formatCurrency(order.totalAmount || 0, order.currency || "usd");

      successLoading.classList.add("hidden");
      successContent.classList.remove("hidden");
    } catch (error) {
      showError(error.message || "Unable to load order confirmation.");
    }
  }

  init();
})();
