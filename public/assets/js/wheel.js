(function wheelController() {
  const listEl = document.getElementById("nameList");
  const winnerNameEl = document.getElementById("winnerName");
  const remainingCountEl = document.getElementById("remainingCount");
  const winnerHistoryEl = document.getElementById("winnerHistory");
  const spinBtn = document.getElementById("spinBtn");
  const removeWinnerBtn = document.getElementById("removeWinnerBtn");
  const resetBtn = document.getElementById("resetBtn");

  const params = new URLSearchParams(window.location.search);
  const namesFromQuery = params.get("names");

  let currentPool = [];
  let lastWinner = null;
  const winnerHistory = [];

  if (namesFromQuery) {
    listEl.value = namesFromQuery;
  }

  function parseNames() {
    return listEl.value
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function syncPool() {
    currentPool = parseNames();
    remainingCountEl.textContent = "Remaining entries: " + String(currentPool.length);
  }

  function renderHistory() {
    winnerHistoryEl.innerHTML = "";
    if (!winnerHistory.length) {
      const li = document.createElement("li");
      li.className = "text-slate-500";
      li.textContent = "No winners yet.";
      winnerHistoryEl.appendChild(li);
      return;
    }

    winnerHistory.forEach((winner) => {
      const li = document.createElement("li");
      li.className = "rounded-lg bg-slate-100 px-3 py-2";
      li.textContent = winner;
      winnerHistoryEl.appendChild(li);
    });
  }

  function runSpin() {
    syncPool();
    if (!currentPool.length) {
      winnerNameEl.textContent = "No names available";
      return;
    }

    const index = Math.floor(Math.random() * currentPool.length);
    lastWinner = currentPool[index];
    winnerNameEl.textContent = lastWinner;
    winnerHistory.unshift(lastWinner);
    if (winnerHistory.length > 12) {
      winnerHistory.pop();
    }
    renderHistory();
  }

  function removeWinnerFromPool() {
    if (!lastWinner) return;
    const names = parseNames();
    const winnerIndex = names.indexOf(lastWinner);
    if (winnerIndex === -1) return;
    names.splice(winnerIndex, 1);
    listEl.value = names.join("\n");
    lastWinner = null;
    syncPool();
  }

  function resetAll() {
    winnerNameEl.textContent = "-";
    lastWinner = null;
    winnerHistory.length = 0;
    renderHistory();
    syncPool();
  }

  spinBtn.addEventListener("click", runSpin);
  removeWinnerBtn.addEventListener("click", removeWinnerFromPool);
  resetBtn.addEventListener("click", resetAll);
  listEl.addEventListener("input", syncPool);

  syncPool();
  renderHistory();
})();
