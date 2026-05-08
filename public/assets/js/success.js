/* global RafflePlatform */
(function successPageController() {
  const functions = RafflePlatform.functions;

  const spinModal = document.getElementById("spinModal");
  const spinNumberDisplay = document.getElementById("spinNumberDisplay");
  const spinResultText = document.getElementById("spinResultText");

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

  function showError(message) {
    successLoading.classList.add("hidden");
    successError.textContent = message;
    successError.classList.remove("hidden");
  }

  async function waitForPaidOrder() {
    const callable = functions.httpsCallable("getOrderBySession");

    for (let i = 0; i < 12; i += 1) {
      const result = await callable({ sessionId });
      const order = result.data && result.data.order;
      if (order && order.status === "paid") {
        return order;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error("Payment is still processing. Please refresh in a moment.");
  }

  async function runSpinAnimation(finalNumber) {
    spinModal.classList.remove("hidden");
    spinModal.classList.add("flex");
    spinResultText.textContent = "Spinning...";
    spinResultText.className = "mt-5 text-xl font-bold text-slate-600";

    let ticks = 0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const random = Math.floor(Math.random() * 99) + 1;
        spinNumberDisplay.textContent = String(random);
        ticks += 1;
        if (ticks > 18) {
          clearInterval(timer);
          resolve();
        }
      }, 110);
    });

    spinNumberDisplay.textContent = String(finalNumber);
    spinResultText.textContent = "You got " + finalNumber;
    spinResultText.className = "mt-5 text-2xl font-extrabold text-red-600 animate-pulseFast";

    await new Promise((resolve) => setTimeout(resolve, 1800));
    spinModal.classList.remove("flex");
    spinModal.classList.add("hidden");
  }

  async function init() {
    if (!sessionId) {
      showError("Missing session id in URL.");
      return;
    }

    try {
      const order = await waitForPaidOrder();

      if (order.raffleType === "spin" && Array.isArray(order.assignedNumbers) && order.assignedNumbers.length) {
        await runSpinAnimation(order.assignedNumbers[0]);
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
