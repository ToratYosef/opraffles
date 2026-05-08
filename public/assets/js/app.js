/* global RafflePlatform */
(function homepageController() {
  const db = RafflePlatform.db;

  const desktopRaffleNav = document.getElementById("desktopRaffleNav");
  const mobileRaffleNav = document.getElementById("mobileRaffleNav");
  const rafflesLoading = document.getElementById("rafflesLoading");
  const rafflesEmpty = document.getElementById("rafflesEmpty");
  const rafflesGrid = document.getElementById("rafflesGrid");
  const refreshBtn = document.getElementById("refreshRafflesBtn");
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");
  const mobileMenu = document.getElementById("mobileMenu");
  const heroTitle = document.getElementById("heroTitle");
  const heroSubtitle = document.getElementById("heroSubtitle");
  const statActiveRaffles = document.getElementById("statActiveRaffles");
  const statFeaturedRaffles = document.getElementById("statFeaturedRaffles");

  function raffleTypeLabel(type) {
    const labels = {
      general: "General Entry",
      spin: "Spin The Wheel",
      package: "Package / Chinese Auction",
    };
    return labels[type] || "Raffle";
  }

  function raffleHref(raffle) {
    return "/raffle.html?slug=" + encodeURIComponent(raffle.slug || "");
  }

  function renderNav(raffles) {
    desktopRaffleNav.innerHTML = "";
    mobileRaffleNav.innerHTML = "";

    raffles.forEach((raffle) => {
      const desktopLink = document.createElement("a");
      desktopLink.href = raffleHref(raffle);
      desktopLink.className = "rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-white";
      desktopLink.textContent = raffle.name;
      desktopRaffleNav.appendChild(desktopLink);

      const mobileLink = document.createElement("a");
      mobileLink.href = raffleHref(raffle);
      mobileLink.className = "block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700";
      mobileLink.textContent = raffle.name;
      mobileRaffleNav.appendChild(mobileLink);
    });
  }

  function renderCards(raffles) {
    if (!raffles.length) {
      rafflesLoading.classList.add("hidden");
      rafflesGrid.classList.add("hidden");
      rafflesEmpty.classList.remove("hidden");
      return;
    }

    rafflesLoading.classList.add("hidden");
    rafflesEmpty.classList.add("hidden");
    rafflesGrid.classList.remove("hidden");
    rafflesGrid.innerHTML = "";

    raffles.forEach((raffle) => {
      const card = document.createElement("article");
      card.className = "group overflow-hidden rounded-3xl border border-slate-200 bg-white transition hover:-translate-y-1 hover:shadow-soft";

      const banner = raffle.bannerImage || "https://images.unsplash.com/photo-1519750157634-b6d493a0f77c?auto=format&fit=crop&w=1200&q=80";
      const entryPrice = Number(raffle.entryPrice || 0);
      let priceLabel = "See details";
      if (raffle.type === "spin") {
        priceLabel = "Spin raffle";
      } else if (entryPrice > 0) {
        priceLabel = RafflePlatform.formatCurrency(entryPrice * 100, "USD") + " / entry";
      }

      card.innerHTML =
        '<div class="relative h-44 overflow-hidden">' +
        '<img class="h-full w-full object-cover transition duration-500 group-hover:scale-105" src="' + banner + '" alt="Raffle banner" />' +
        '<div class="absolute inset-0 bg-gradient-to-t from-slate-900/35 to-transparent"></div>' +
        '<span class="absolute bottom-3 left-3 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase text-amber-800">' + raffleTypeLabel(raffle.type) + "</span>" +
        "</div>" +
        '<div class="p-5">' +
        '<h3 class="text-lg font-bold text-slate-900">' + (raffle.name || "Untitled Raffle") + "</h3>" +
        '<p class="mt-2 line-clamp-3 text-sm text-slate-600">' + (raffle.shortDescription || raffle.description || "No description provided yet.") + "</p>" +
        '<div class="mt-5 flex items-center justify-between">' +
        '<p class="text-sm font-semibold text-amber-700">' + priceLabel + "</p>" +
        '<a class="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600" href="' + raffleHref(raffle) + '">Enter</a>' +
        "</div>" +
        "</div>";

      rafflesGrid.appendChild(card);
    });
  }

  async function loadRaffles() {
    rafflesLoading.classList.remove("hidden");
    rafflesEmpty.classList.add("hidden");
    rafflesGrid.classList.add("hidden");

    try {
      const snapshot = await db.collection("raffles").where("active", "==", true).get();
      const raffles = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => {
          const featuredA = a.featured ? 1 : 0;
          const featuredB = b.featured ? 1 : 0;
          if (featuredA !== featuredB) return featuredB - featuredA;
          return (a.name || "").localeCompare(b.name || "");
        });

      statActiveRaffles.textContent = String(raffles.length);
      statFeaturedRaffles.textContent = String(raffles.filter((r) => r.featured).length);
      renderNav(raffles.slice(0, 7));
      renderCards(raffles);
    } catch (error) {
      console.error("Failed to load raffles", error);
      rafflesLoading.textContent = "Unable to load raffles right now.";
      rafflesEmpty.classList.add("hidden");
      rafflesGrid.classList.add("hidden");
    }
  }

  mobileMenuBtn.addEventListener("click", () => {
    mobileMenu.classList.toggle("hidden");
  });

  refreshBtn.addEventListener("click", loadRaffles);

  loadRaffles();
})();
