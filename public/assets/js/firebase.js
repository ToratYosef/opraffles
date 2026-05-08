/* global firebase */
(function initRafflePlatform() {
  const runtimeConfig = window.__FIREBASE_CONFIG__ || null;

  if (!firebase.apps.length && runtimeConfig) {
    firebase.initializeApp(runtimeConfig);
  }

  if (!firebase.apps.length) {
    throw new Error("Firebase is not initialized. Add /__/firebase/init.js or provide window.__FIREBASE_CONFIG__.");
  }

  const db = typeof firebase.firestore === "function" ? firebase.firestore() : null;
  let functions = null;
  let storage = null;
  const app = firebase.app();
  if (typeof app.functions === "function") {
    functions = app.functions("us-central1");
  }
  if (typeof app.storage === "function") {
    storage = app.storage();
  }

  function formatCurrency(amountCents, currency) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format((amountCents || 0) / 100);
  }

  function formatDate(value) {
    if (!value) return "-";
    const raw = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    if (Number.isNaN(raw.getTime())) return "-";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(raw);
  }

  window.RafflePlatform = {
    db,
    functions,
    storage,
    formatCurrency,
    formatDate,
  };
})();
