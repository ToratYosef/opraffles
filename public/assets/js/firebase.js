/* global firebase */
(function initRafflePlatform() {
  const defaultConfig = {
    apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
    authDomain: "REPLACE_WITH_PROJECT.firebaseapp.com",
    projectId: "REPLACE_WITH_PROJECT_ID",
    storageBucket: "REPLACE_WITH_PROJECT.appspot.com",
    messagingSenderId: "REPLACE_WITH_SENDER_ID",
    appId: "REPLACE_WITH_APP_ID",
  };

  const runtimeConfig = window.__FIREBASE_CONFIG__ || defaultConfig;

  if (!firebase.apps.length) {
    firebase.initializeApp(runtimeConfig);
  }

  const db = firebase.firestore();
  const functions = firebase.app().functions("us-central1");

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
    formatCurrency,
    formatDate,
  };
})();
