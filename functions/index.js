const admin = require("firebase-admin");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({maxInstances: 10, region: "us-central1"});

const ADMIN_CODE = process.env.ADMIN_CODE || "123";
const DEFAULT_ALLOWED_ORIGINS = ["https://opraffles1.web.app"];
const SPIN_RESERVATION_MINUTES = Number(process.env.SPIN_RESERVATION_MINUTES || 15);
const CALLABLE_OPTS = {
	invoker: "public",
	cors: [
		"https://opraffles1.web.app",
		"https://opraffles1.firebaseapp.com",
		"http://localhost:5000",
		"http://localhost:5173",
	],
};

function getAllowedOrigins() {
	const fromEnv = String(process.env.ALLOWED_ORIGINS || "")
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
	return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...fromEnv]));
}

function applyCors(req, res) {
	const origin = String(req.headers.origin || "").trim();
	const allowedOrigins = getAllowedOrigins();
	if (origin && allowedOrigins.includes(origin)) {
		res.set("Access-Control-Allow-Origin", origin);
		res.set("Vary", "Origin");
	}
	res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
	res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

	if (req.method === "OPTIONS") {
		res.status(204).send("");
		return true;
	}
	return false;
}

function requireAdmin(code) {
	if (!code || code !== ADMIN_CODE) {
		throw new HttpsError("permission-denied", "Invalid admin code.");
	}
}

function getStripeClient() {
	const stripeSecret = process.env.STRIPE_SECRET_KEY;
	if (!stripeSecret) {
		throw new HttpsError("failed-precondition", "Missing STRIPE_SECRET_KEY environment variable.");
	}
	return new Stripe(stripeSecret, {apiVersion: "2024-06-20"});
}

function getStripePublishableKey() {
	const key = process.env.STRIPE_PUBLISHABLE_KEY;
	if (!key) {
		throw new HttpsError("failed-precondition", "Missing STRIPE_PUBLISHABLE_KEY environment variable.");
	}
	return key;
}

function normalizeSlug(value) {
	return String(value || "")
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
}

function parseFloatSafe(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function parseIntSafe(value) {
	const n = Number(value);
	return Number.isInteger(n) ? n : 0;
}

function buildPackageDeals(deals) {
	if (!Array.isArray(deals)) return [];
	return deals
			.map((tier) => ({
				qty: parseIntSafe(tier.qty),
				discountPercent: parseFloatSafe(tier.discountPercent),
			}))
			.filter((tier) => tier.qty >= 2 && tier.discountPercent > 0 && tier.discountPercent < 100)
			.sort((a, b) => a.qty - b.qty);
}

function sanitizeImageList(value) {
	if (!Array.isArray(value)) return [];
	return value
			.map((v) => String(v || "").trim())
			.filter(Boolean)
			.filter((v, i, arr) => arr.indexOf(v) === i);
}

function bestDealForQty(packageDeals, qty) {
	let best = {qty: 0, discountPercent: 0};
	packageDeals.forEach((tier) => {
		if (qty >= tier.qty && tier.discountPercent > best.discountPercent) {
			best = tier;
		}
	});
	return best;
}

async function countAssignedSpinSpots(raffleId) {
	const snap = await db.collection("entries")
			.where("raffleId", "==", raffleId)
			.where("assignedCardNumber", "!=", null)
			.select("assignedCardNumber")
			.get();
	return snap.docs.length;
}

async function getAssignedNumbersSet(raffleId) {
	const snap = await db.collection("entries")
			.where("raffleId", "==", raffleId)
			.where("assignedCardNumber", "!=", null)
			.select("assignedCardNumber")
			.get();
	const assigned = new Set();
	snap.docs.forEach((doc) => {
		const number = parseIntSafe(doc.data().assignedCardNumber);
		if (number > 0) assigned.add(number);
	});
	return assigned;
}

async function getReservedNumbersSet(raffleId) {
	const now = admin.firestore.Timestamp.now();
	const snap = await db.collection("spinReservations")
			.where("raffleId", "==", raffleId)
			.where("status", "==", "reserved")
			.where("expiresAt", ">", now)
			.select("number")
			.get();
	const reserved = new Set();
	snap.docs.forEach((doc) => {
		const number = parseIntSafe(doc.data().number);
		if (number > 0) reserved.add(number);
	});
	return reserved;
}

async function releaseExpiredReservations(raffleId) {
	const now = admin.firestore.Timestamp.now();
	let released = 0;

	for (;;) {
		let query = db.collection("spinReservations")
				.where("status", "==", "reserved")
				.where("expiresAt", "<=", now)
				.limit(200);
		if (raffleId) {
			query = query.where("raffleId", "==", raffleId);
		}

		const snap = await query.get();
		if (snap.empty) break;

		const batch = db.batch();
		snap.docs.forEach((doc) => {
			batch.update(doc.ref, {
				status: "released",
				releasedAt: admin.firestore.FieldValue.serverTimestamp(),
				releaseReason: "expired",
			});
		});
		await batch.commit();
		released += snap.size;
	}

	return released;
}

async function reserveRandomSpinNumber({raffleId, totalSpots, sessionToken, buyerName, buyerEmail, buyerPhone}) {
	await releaseExpiredReservations(raffleId);

	for (let attempt = 0; attempt < 8; attempt += 1) {
		const [assignedSet, reservedSet] = await Promise.all([
			getAssignedNumbersSet(raffleId),
			getReservedNumbersSet(raffleId),
		]);

		const available = [];
		for (let i = 1; i <= totalSpots; i += 1) {
			if (!assignedSet.has(i) && !reservedSet.has(i)) {
				available.push(i);
			}
		}

		if (!available.length) {
			throw new HttpsError("failed-precondition", "No spin spots are currently available.");
		}

		const picked = available[Math.floor(Math.random() * available.length)];
		const reservationRef = db.collection("spinReservations").doc(raffleId + "_" + String(picked));
		const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + SPIN_RESERVATION_MINUTES * 60 * 1000);

		try {
			await db.runTransaction(async (tx) => {
				const existing = await tx.get(reservationRef);
				if (existing.exists) {
					const data = existing.data();
					if (data.status === "paid") {
						throw new Error("RESERVE_CONFLICT");
					}
					if (data.status === "reserved" && data.expiresAt && data.expiresAt.toMillis() > Date.now()) {
						throw new Error("RESERVE_CONFLICT");
					}
				}

				tx.set(reservationRef, {
					raffleId,
					number: picked,
					status: "reserved",
					sessionToken,
					stripeSessionId: null,
					orderId: null,
					buyerName,
					buyerEmail,
					buyerPhone,
					expiresAt,
					createdAt: admin.firestore.FieldValue.serverTimestamp(),
					updatedAt: admin.firestore.FieldValue.serverTimestamp(),
				}, {merge: true});
			});

			return {
				reservationId: reservationRef.id,
				reservedNumber: picked,
				expiresAt,
			};
		} catch (error) {
			if (error && error.message === "RESERVE_CONFLICT") {
				continue;
			}
			throw error;
		}
	}

	throw new HttpsError("aborted", "Could not reserve a spot. Please try again.");
}

function allocateSpinNumbers({totalSpots, assignedNumbersSet, quantity, assignmentMode}) {
	const available = [];
	for (let i = 1; i <= totalSpots; i += 1) {
		if (!assignedNumbersSet.has(i)) available.push(i);
	}
	if (available.length < quantity) {
		throw new HttpsError("failed-precondition", "Not enough available spots for this spin raffle.");
	}

	if (assignmentMode === "random") {
		for (let i = available.length - 1; i > 0; i -= 1) {
			const j = Math.floor(Math.random() * (i + 1));
			[available[i], available[j]] = [available[j], available[i]];
		}
	}

	return available.slice(0, quantity);
}

exports.adminCreateRaffle = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const data = request.data || {};
	const name = String(data.name || "").trim();
	const slug = normalizeSlug(data.slug);
	const type = data.type === "spin" ? "spin" : "general";
	const entryPrice = parseFloatSafe(data.entryPrice);

	if (!name || !slug) {
		throw new HttpsError("invalid-argument", "Raffle name and slug are required.");
	}
	if (type !== "spin" && entryPrice <= 0) {
		throw new HttpsError("invalid-argument", "Entry price must be greater than zero.");
	}

	const existing = await db.collection("raffles").where("slug", "==", slug).limit(1).get();
	if (!existing.empty) {
		throw new HttpsError("already-exists", "A raffle with this slug already exists.");
	}

	const unlimitedEntries = data.unlimitedEntries !== false;
	let maxEntries = unlimitedEntries ? null : parseIntSafe(data.maxEntries);
	if (!unlimitedEntries && maxEntries < 1) {
		throw new HttpsError("invalid-argument", "Set a valid max entries value.");
	}

	let packageDeals = buildPackageDeals(data.packageDeals);

	const totalSpots = type === "spin" ? parseIntSafe(data.totalSpots) : null;
	const minNumber = type === "spin" ? parseIntSafe(data.minNumber || 1) : null;
	const maxNumber = type === "spin" ? parseIntSafe(data.maxNumber || totalSpots) : null;
	let assignmentMode = data.assignmentMode === "random" ? "random" : "next";
	if (type === "spin" && totalSpots < 1) {
		throw new HttpsError("invalid-argument", "Spin raffles require total spots.");
	}
	if (type === "spin") {
		// Spin raffles are constrained by spot count, not package deals or generic max-entry settings.
		packageDeals = [];
		maxEntries = null;
		assignmentMode = "random";
	}

	const now = admin.firestore.FieldValue.serverTimestamp();
	const bannerImages = sanitizeImageList(data.bannerImages);
	const primaryBanner = String(data.bannerImage || bannerImages[0] || "").trim();
	const raffleRef = db.collection("raffles").doc();
	await raffleRef.set({
		name,
		slug,
		description: String(data.description || "").trim(),
		shortDescription: String(data.shortDescription || "").trim(),
		bannerImage: primaryBanner,
		bannerImages,
		type,
		active: data.active !== false,
		featured: data.featured === true,
		entryPrice: type === "spin" ? 0 : entryPrice,
		packageDeals,
		unlimitedEntries,
		maxEntries,
		totalSpots,
		minNumber,
		maxNumber,
		assignmentMode,
		createdAt: now,
		updatedAt: now,
	});

	return {raffleId: raffleRef.id};
});

exports.adminUpdateRaffle = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const data = request.data || {};
	const raffleId = String(data.raffleId || "").trim();
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	const raffleRef = db.collection("raffles").doc(raffleId);
	const snap = await raffleRef.get();
	if (!snap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const current = snap.data();

	const type = data.type === "spin" ? "spin" : "general";
	const name = String(data.name || current.name || "").trim();
	const slug = normalizeSlug(data.slug || current.slug);
	const entryPrice = parseFloatSafe(data.entryPrice);
	if (!name || !slug) {
		throw new HttpsError("invalid-argument", "Raffle name and slug are required.");
	}
	if (type !== "spin" && entryPrice <= 0) {
		throw new HttpsError("invalid-argument", "Entry price must be greater than zero.");
	}

	if (slug !== current.slug) {
		const dupe = await db.collection("raffles").where("slug", "==", slug).limit(1).get();
		if (!dupe.empty) {
			throw new HttpsError("already-exists", "A raffle with this slug already exists.");
		}
	}

	const bannerImages = sanitizeImageList(data.bannerImages);
	const primaryBanner = String(data.bannerImage || bannerImages[0] || current.bannerImage || "").trim();
	const unlimitedEntries = type === "spin" ? true : data.unlimitedEntries !== false;
	const maxEntries = unlimitedEntries ? null : parseIntSafe(data.maxEntries);
	const packageDeals = type === "spin" ? [] : buildPackageDeals(data.packageDeals);
	const totalSpots = type === "spin" ? parseIntSafe(data.totalSpots) : null;
	const minNumber = type === "spin" ? parseIntSafe(data.minNumber || 1) : null;
	const maxNumber = type === "spin" ? parseIntSafe(data.maxNumber || totalSpots) : null;

	await raffleRef.update({
		name,
		slug,
		description: String(data.description || "").trim(),
		shortDescription: String(data.shortDescription || "").trim(),
		bannerImage: primaryBanner,
		bannerImages,
		type,
		active: data.active !== false,
		featured: data.featured === true,
		entryPrice: type === "spin" ? 0 : entryPrice,
		packageDeals,
		unlimitedEntries,
		maxEntries,
		totalSpots,
		minNumber,
		maxNumber,
		assignmentMode: type === "spin" ? "random" : (data.assignmentMode === "random" ? "random" : "next"),
		updatedAt: admin.firestore.FieldValue.serverTimestamp(),
	});

	return {success: true};
});

async function deleteByRaffleId(collectionName, raffleId) {
	for (;;) {
		const snap = await db.collection(collectionName)
				.where("raffleId", "==", raffleId)
				.limit(200)
				.get();
		if (snap.empty) return;
		const batch = db.batch();
		snap.docs.forEach((doc) => batch.delete(doc.ref));
		await batch.commit();
	}
}

exports.adminDeleteRaffle = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const raffleId = String(request.data && request.data.raffleId || "").trim();
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	const raffleRef = db.collection("raffles").doc(raffleId);
	const raffleSnap = await raffleRef.get();
	if (!raffleSnap.exists) {
		return {success: true, alreadyDeleted: true};
	}

	await Promise.all([
		deleteByRaffleId("entries", raffleId),
		deleteByRaffleId("orders", raffleId),
		deleteByRaffleId("spinReservations", raffleId),
	]);

	await raffleRef.delete();
	return {success: true};
});

exports.adminToggleRaffle = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const raffleId = String(request.data && request.data.raffleId || "").trim();
	const active = !!(request.data && request.data.active);
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	await db.collection("raffles").doc(raffleId).update({
		active,
		updatedAt: admin.firestore.FieldValue.serverTimestamp(),
	});

	return {success: true};
});

exports.adminGetDashboard = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const [rafflesSnap, ordersSnap, entriesSnap] = await Promise.all([
		db.collection("raffles").orderBy("createdAt", "desc").limit(200).get(),
		db.collection("orders").orderBy("createdAt", "desc").limit(200).get(),
		db.collection("entries").orderBy("createdAt", "desc").limit(400).get(),
	]);

	const raffles = rafflesSnap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
	const orders = ordersSnap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
	const entries = entriesSnap.docs.map((doc) => ({id: doc.id, ...doc.data()}));

	const revenueCents = orders
			.filter((order) => order.status === "paid")
			.reduce((sum, order) => sum + parseIntSafe(order.totalAmount), 0);

	return {
		raffles,
		orders,
		entries,
		stats: {
			revenueCents,
		},
	};
});

exports.adminGenerateWheelData = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const raffleId = String(request.data && request.data.raffleId || "").trim();
	const includeManual = !!(request.data && request.data.includeManual);
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	const raffleSnap = await db.collection("raffles").doc(raffleId).get();
	if (!raffleSnap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const raffle = raffleSnap.data();

	const entriesSnap = await db.collection("entries")
			.where("raffleId", "==", raffleId)
			.orderBy("createdAt", "desc")
			.limit(3000)
			.get();

	const filtered = entriesSnap.docs
			.map((doc) => ({id: doc.id, ...doc.data()}))
			.filter((entry) => {
				if (entry.paymentStatus === "paid") return true;
				if (includeManual && entry.source === "manual") return true;
				return false;
			});

	const names = filtered.map((entry) => entry.buyerName || "Anonymous");
	const assignedCount = filtered.filter((entry) => parseIntSafe(entry.assignedCardNumber) > 0).length;
	const totalSpots = parseIntSafe(raffle.totalSpots);
	const availableCount = totalSpots > 0 ? Math.max(totalSpots - assignedCount, 0) : 0;

	return {
		names,
		assignedCount,
		totalSpots,
		availableCount,
		entries: filtered,
	};
});

exports.adminGetSpinRaffleSnapshot = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const raffleId = String(request.data && request.data.raffleId || "").trim();
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	await releaseExpiredReservations(raffleId);

	const raffleSnap = await db.collection("raffles").doc(raffleId).get();
	if (!raffleSnap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const raffle = {id: raffleSnap.id, ...raffleSnap.data()};
	if (raffle.type !== "spin") {
		return {
			raffle,
			isSpin: false,
			stats: null,
			tickets: [],
		};
	}

	const [entriesSnap, ordersSnap, reservedSnap] = await Promise.all([
		db.collection("entries")
				.where("raffleId", "==", raffleId)
				.orderBy("createdAt", "desc")
				.limit(5000)
				.get(),
		db.collection("orders")
				.where("raffleId", "==", raffleId)
				.orderBy("createdAt", "desc")
				.limit(5000)
				.get(),
		db.collection("spinReservations")
				.where("raffleId", "==", raffleId)
				.where("status", "==", "reserved")
				.where("expiresAt", ">", admin.firestore.Timestamp.now())
				.limit(5000)
				.get(),
	]);

	const ordersById = new Map();
	ordersSnap.docs.forEach((doc) => ordersById.set(doc.id, doc.data()));

	const paidEntries = [];
	const tickets = [];
	entriesSnap.docs.forEach((doc) => {
		const e = doc.data();
		const number = parseIntSafe(e.assignedCardNumber);
		if (number < 1) return;
		const order = ordersById.get(e.orderId) || null;
		const amount = order ? parseIntSafe(order.totalAmount) : number * 100;
		if (e.paymentStatus === "paid") paidEntries.push(e);
		tickets.push({
			id: doc.id,
			ticketNumber: number,
			status: e.paymentStatus || "paid",
			buyerName: e.buyerName || "",
			email: e.buyerEmail || "",
			phone: e.buyerPhone || "",
			amount,
			timestamp: e.createdAt || null,
			source: e.source || "payment",
		});
	});

	reservedSnap.docs.forEach((doc) => {
		const r = doc.data();
		const number = parseIntSafe(r.number);
		if (number < 1) return;
		tickets.push({
			id: doc.id,
			reservationId: doc.id,
			ticketNumber: number,
			status: "reserved",
			buyerName: r.buyerName || "",
			email: r.buyerEmail || "",
			phone: r.buyerPhone || "",
			amount: number * 100,
			timestamp: r.createdAt || null,
			source: "reservation",
		});
	});

	const totalSpots = parseIntSafe(raffle.totalSpots);
	const paidCount = tickets.filter((t) => t.status === "paid").length;
	const reservedCount = tickets.filter((t) => t.status === "reserved").length;
	const claimedCount = tickets.filter((t) => t.status === "claimed").length;
	const refundedCount = tickets.filter((t) => t.status === "refunded").length;
	const soldLike = paidCount + claimedCount;
	const ticketsLeft = totalSpots > 0 ? Math.max(totalSpots - soldLike - reservedCount, 0) : 0;
	const revenueCents = tickets
			.filter((t) => t.status === "paid" || t.status === "claimed")
			.reduce((sum, t) => sum + parseIntSafe(t.amount), 0);

	tickets.sort((a, b) => Number(b.ticketNumber || 0) - Number(a.ticketNumber || 0));

	return {
		raffle,
		isSpin: true,
		stats: {
			totalSpots,
			ticketsSold: soldLike,
			revenueCents,
			reservedCount,
			ticketsLeft,
			paidCount,
			claimedCount,
			refundedCount,
		},
		tickets,
		paidTickets: tickets.filter((t) => t.status === "paid"),
	};
});

exports.adminCleanupSpinReservations = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);
	const raffleId = String(request.data && request.data.raffleId || "").trim();
	if (!raffleId) throw new HttpsError("invalid-argument", "Missing raffleId.");
	const released = await releaseExpiredReservations(raffleId);
	return {released};
});

exports.adminDeleteSpinTicket = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);
	const entryId = String(request.data && request.data.entryId || "").trim();
	if (!entryId) throw new HttpsError("invalid-argument", "Missing entryId.");

	const ref = db.collection("entries").doc(entryId);
	const snap = await ref.get();
	if (!snap.exists) return {success: true, alreadyDeleted: true};
	await ref.delete();
	return {success: true};
});

exports.adminMarkSpinTicketClaimed = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);
	const entryId = String(request.data && request.data.entryId || "").trim();
	if (!entryId) throw new HttpsError("invalid-argument", "Missing entryId.");

	await db.collection("entries").doc(entryId).set({
		paymentStatus: "claimed",
		claimedAt: admin.firestore.FieldValue.serverTimestamp(),
	}, {merge: true});
	return {success: true};
});

exports.adminRefundSpinTicket = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);
	const entryId = String(request.data && request.data.entryId || "").trim();
	if (!entryId) throw new HttpsError("invalid-argument", "Missing entryId.");

	const entryRef = db.collection("entries").doc(entryId);
	const entrySnap = await entryRef.get();
	if (!entrySnap.exists) throw new HttpsError("not-found", "Entry not found.");
	const entry = entrySnap.data();

	await entryRef.set({
		paymentStatus: "refunded",
		refundedAt: admin.firestore.FieldValue.serverTimestamp(),
	}, {merge: true});

	if (entry.orderId) {
		await db.collection("orders").doc(entry.orderId).set({
			status: "refunded",
			updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		}, {merge: true});
	}
	return {success: true};
});

exports.createCheckoutSession = onCall(CALLABLE_OPTS, async (request) => {
	const data = request.data || {};
	const raffleId = String(data.raffleId || "").trim();
	const quantity = parseIntSafe(data.quantity);
	const buyerName = String(data.buyerName || "").trim();
	const buyerEmail = String(data.buyerEmail || "").trim();
	const buyerPhone = String(data.buyerPhone || "").trim();

	if (!raffleId || quantity < 1 || !buyerName || !buyerEmail) {
		throw new HttpsError("invalid-argument", "Missing checkout data.");
	}

	const raffleSnap = await db.collection("raffles").doc(raffleId).get();
	if (!raffleSnap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const raffle = raffleSnap.data();

	if (!raffle.active) {
		throw new HttpsError("failed-precondition", "Raffle is not active.");
	}

	if (raffle.type !== "spin" && !raffle.unlimitedEntries && parseIntSafe(raffle.maxEntries) > 0) {
		const usedSnap = await db.collection("entries")
				.where("raffleId", "==", raffleId)
				.limit(parseIntSafe(raffle.maxEntries) + 1)
				.get();
		const remaining = parseIntSafe(raffle.maxEntries) - usedSnap.size;
		if (remaining < quantity) {
			throw new HttpsError("failed-precondition", "Requested quantity exceeds remaining entries.");
		}
	}

	if (raffle.type === "spin") {
		throw new HttpsError("failed-precondition", "Spin raffles use on-page payment intent flow only.");
	}

	const unitPriceCents = Math.round(parseFloatSafe(raffle.entryPrice) * 100);
	const deal = raffle.type === "spin" ? {qty: 0, discountPercent: 0} : bestDealForQty(buildPackageDeals(raffle.packageDeals), quantity);
	const subtotal = unitPriceCents * quantity;
	const discountCents = Math.round(subtotal * (deal.discountPercent / 100));
	const totalCents = Math.max(subtotal - discountCents, 0);

	const stripe = getStripeClient();
	const siteUrl = process.env.SITE_URL || "http://localhost:5000";
	const orderRef = db.collection("orders").doc();

	let reservation = null;
	if (raffle.type === "spin") {
		reservation = await reserveRandomSpinNumber({
			raffleId,
			totalSpots: parseIntSafe(raffle.totalSpots),
			sessionToken: orderRef.id,
			buyerName,
			buyerEmail,
			buyerPhone,
		});
	}

	await orderRef.set({
		raffleId,
		raffleSlug: raffle.slug,
		raffleName: raffle.name,
		buyerName,
		buyerEmail,
		buyerPhone,
		stripeSessionId: null,
		stripePaymentIntentId: null,
		status: "pending",
		totalAmount: totalCents,
		currency: "usd",
		raffleType: raffle.type,
		selections: {
			quantity,
			discountPercent: deal.discountPercent || 0,
		},
		entryCount: quantity,
		reservationId: reservation ? reservation.reservationId : null,
		reservedNumber: reservation ? reservation.reservedNumber : null,
		reservationExpiresAt: reservation ? reservation.expiresAt : null,
		assignedNumbers: [],
		createdAt: admin.firestore.FieldValue.serverTimestamp(),
		paidAt: null,
		webhookProcessed: false,
	});

	let session;
	try {
		session = await stripe.checkout.sessions.create({
			mode: "payment",
			success_url: siteUrl + "/success.html?session_id={CHECKOUT_SESSION_ID}",
			cancel_url: siteUrl + "/cancel.html",
			customer_email: buyerEmail,
			metadata: {
				raffleId,
				raffleType: raffle.type,
				quantity: String(quantity),
				buyerName,
				buyerEmail,
				buyerPhone,
				discountPercent: String(deal.discountPercent || 0),
				orderId: orderRef.id,
				reservationId: reservation ? reservation.reservationId : "",
			},
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: "usd",
						unit_amount: totalCents,
						product_data: {
							name: raffle.name + " Entries",
							description: quantity + " entries" + (deal.discountPercent ? " with " + deal.discountPercent + "% package discount" : ""),
						},
					},
				},
			],
		});
	} catch (error) {
		if (reservation) {
			await db.collection("spinReservations").doc(reservation.reservationId).set({
				status: "released",
				releasedAt: admin.firestore.FieldValue.serverTimestamp(),
				releaseReason: "checkout_session_create_failed",
				updatedAt: admin.firestore.FieldValue.serverTimestamp(),
			}, {merge: true});
		}
		await orderRef.set({
			status: "failed",
			failureReason: "checkout_session_create_failed",
			updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		}, {merge: true});
		throw error;
	}

	await orderRef.set({
		stripeSessionId: session.id,
		updatedAt: admin.firestore.FieldValue.serverTimestamp(),
	}, {merge: true});

	if (reservation) {
		await db.collection("spinReservations").doc(reservation.reservationId).set({
			stripeSessionId: session.id,
			orderId: orderRef.id,
			updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		}, {merge: true});
	}

	return {
		checkoutUrl: session.url,
		sessionId: session.id,
		orderId: orderRef.id,
	};
});

exports.getPublicConfig = onCall(CALLABLE_OPTS, async () => {
	return {
		stripePublishableKey: getStripePublishableKey(),
	};
});

exports.createSpinPaymentIntent = onCall(CALLABLE_OPTS, async (request) => {
	const data = request.data || {};
	const raffleId = String(data.raffleId || "").trim();
	const buyerName = String(data.buyerName || "").trim();
	const buyerEmail = String(data.buyerEmail || "").trim();
	const buyerPhone = String(data.buyerPhone || "").trim();

	if (!raffleId || !buyerName || !buyerEmail) {
		throw new HttpsError("invalid-argument", "Missing spin payment data.");
	}

	const raffleSnap = await db.collection("raffles").doc(raffleId).get();
	if (!raffleSnap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const raffle = raffleSnap.data();
	if (raffle.type !== "spin") {
		throw new HttpsError("failed-precondition", "This function is for spin raffles only.");
	}
	if (!raffle.active) {
		throw new HttpsError("failed-precondition", "Raffle is not active.");
	}

	const stripe = getStripeClient();
	const orderRef = db.collection("orders").doc();
	const reservation = await reserveRandomSpinNumber({
		raffleId,
		totalSpots: parseIntSafe(raffle.totalSpots),
		sessionToken: orderRef.id,
		buyerName,
		buyerEmail,
		buyerPhone,
	});

	// For spin raffles the ticket number IS the dollar amount.
	// Ticket #159 -> $159.00 = 15900 cents. Never use entryPrice for spin.
	const amountCents = reservation.reservedNumber * 100;
	if (amountCents <= 0) {
		await db.collection("spinReservations").doc(reservation.reservationId).set({
			status: "released",
			releasedAt: admin.firestore.FieldValue.serverTimestamp(),
			releaseReason: "invalid_amount",
			updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		}, {merge: true});
		throw new HttpsError("failed-precondition", "Reserved number produced an invalid charge amount.");
	}

	let paymentIntent;
	try {
		paymentIntent = await stripe.paymentIntents.create({
			amount: amountCents,
			currency: "usd",
			automatic_payment_methods: {enabled: true},
			receipt_email: buyerEmail,
			metadata: {
				raffleId,
				raffleType: "spin",
				orderId: orderRef.id,
				reservationId: reservation.reservationId,
				reservedNumber: String(reservation.reservedNumber),
				amountExpected: String(amountCents),
				buyerName,
				buyerEmail,
				buyerPhone,
			},
		});
	} catch (error) {
		await db.collection("spinReservations").doc(reservation.reservationId).set({
			status: "released",
			releasedAt: admin.firestore.FieldValue.serverTimestamp(),
			releaseReason: "payment_intent_create_failed",
			updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		}, {merge: true});
		throw error;
	}

	await orderRef.set({
		raffleId,
		raffleSlug: raffle.slug,
		raffleName: raffle.name,
		buyerName,
		buyerEmail,
		buyerPhone,
		stripeSessionId: null,
		stripePaymentIntentId: paymentIntent.id,
		status: "pending",
		totalAmount: amountCents,
		currency: "usd",
		raffleType: "spin",
		selections: {
			quantity: 1,
			discountPercent: 0,
		},
		entryCount: 1,
		reservationId: reservation.reservationId,
		reservedNumber: reservation.reservedNumber,
		reservationExpiresAt: reservation.expiresAt,
		assignedNumbers: [],
		createdAt: admin.firestore.FieldValue.serverTimestamp(),
		updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		paidAt: null,
		webhookProcessed: false,
	});

	await db.collection("spinReservations").doc(reservation.reservationId).set({
		stripePaymentIntentId: paymentIntent.id,
		orderId: orderRef.id,
		updatedAt: admin.firestore.FieldValue.serverTimestamp(),
	}, {merge: true});

	return {
		clientSecret: paymentIntent.client_secret,
		orderId: orderRef.id,
		expiresAt: reservation.expiresAt,
	};
});

exports.releaseSpinReservation = onCall(CALLABLE_OPTS, async (request) => {
	const orderId = String(request.data && request.data.orderId || "").trim();
	const reason = String(request.data && request.data.reason || "client_release").trim();
	if (!orderId) {
		throw new HttpsError("invalid-argument", "Missing orderId.");
	}

	const orderRef = db.collection("orders").doc(orderId);
	const orderSnap = await orderRef.get();
	if (!orderSnap.exists) {
		return {released: false, reason: "order_not_found"};
	}
	const order = orderSnap.data();
	if (order.status !== "pending") {
		return {released: false, reason: "order_not_pending"};
	}

	if (order.reservationId) {
		await db.collection("spinReservations").doc(order.reservationId).set({
			status: "released",
			releasedAt: admin.firestore.FieldValue.serverTimestamp(),
			releaseReason: reason,
			updatedAt: admin.firestore.FieldValue.serverTimestamp(),
		}, {merge: true});
	}

	await orderRef.set({
		status: "cancelled",
		cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
		updatedAt: admin.firestore.FieldValue.serverTimestamp(),
	}, {merge: true});

	return {released: true};
});

exports.getOrderStatus = onCall(CALLABLE_OPTS, async (request) => {
	const orderId = String(request.data && request.data.orderId || "").trim();
	if (!orderId) {
		throw new HttpsError("invalid-argument", "Missing orderId.");
	}

	const orderSnap = await db.collection("orders").doc(orderId).get();
	if (!orderSnap.exists) {
		throw new HttpsError("not-found", "Order not found.");
	}
	const order = orderSnap.data();
	return {
		order: {
			id: orderId,
			status: order.status || "pending",
			raffleType: order.raffleType || "general",
			raffleName: order.raffleName || "",
			entryCount: order.entryCount || 0,
			totalAmount: order.totalAmount || 0,
			currency: order.currency || "usd",
			assignedNumbers: Array.isArray(order.assignedNumbers) ? order.assignedNumbers : [],
		},
	};
});

exports.stripeWebhook = onRequest({invoker: "public"}, async (req, res) => {
	if (applyCors(req, res)) {
		return;
	}

	if (req.method !== "POST") {
		res.status(405).send("Method Not Allowed");
		return;
	}

	try {
		const stripe = getStripeClient();
		const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
		if (!webhookSecret) {
			throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable.");
		}

		const signature = req.headers["stripe-signature"];
		const event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);

		if (event.type !== "checkout.session.completed" &&
			event.type !== "checkout.session.expired" &&
			event.type !== "checkout.session.async_payment_failed" &&
			event.type !== "payment_intent.succeeded" &&
			event.type !== "payment_intent.payment_failed" &&
			event.type !== "payment_intent.canceled") {
			res.status(200).json({received: true, ignored: true});
			return;
		}

		const payload = event.data.object;
		let orderSnap;
		if (event.type.startsWith("payment_intent.")) {
			orderSnap = await db.collection("orders")
					.where("stripePaymentIntentId", "==", payload.id)
					.limit(1)
					.get();
		} else {
			orderSnap = await db.collection("orders")
					.where("stripeSessionId", "==", payload.id)
					.limit(1)
					.get();
		}

		if (orderSnap.empty) {
			logger.error("Order not found for Stripe event", {eventType: event.type, objectId: payload.id});
			res.status(200).json({received: true, orderFound: false});
			return;
		}

		const orderDoc = orderSnap.docs[0];
		const orderRef = orderDoc.ref;
		const order = orderDoc.data();

		if (event.type === "payment_intent.succeeded" && order.raffleType === "spin") {
			const metadata = payload.metadata || {};
			const reservedNumber = parseIntSafe(order.reservedNumber || metadata.reservedNumber);
			const expectedFromNumber = reservedNumber * 100;
			const expectedFromMeta = parseIntSafe(metadata.amountExpected || expectedFromNumber);
			const expectedCents = expectedFromMeta || expectedFromNumber;
			const actualCents = parseIntSafe(payload.amount);

			if (reservedNumber < 1 || expectedCents < 100 || actualCents !== expectedCents) {
				logger.error("Spin raffle amount mismatch; rejecting payment fulfillment", {
					orderId: orderRef.id,
					reservationId: order.reservationId || metadata.reservationId || null,
					reservedNumber,
					expectedCents,
					actualCents,
					paymentIntentId: payload.id,
				});

				await orderRef.set({
					status: "failed",
					failureReason: "spin_amount_mismatch",
					updatedAt: admin.firestore.FieldValue.serverTimestamp(),
				}, {merge: true});

				if (order.reservationId) {
					await db.collection("spinReservations").doc(order.reservationId).set({
						status: "released",
						releasedAt: admin.firestore.FieldValue.serverTimestamp(),
						releaseReason: "spin_amount_mismatch",
						updatedAt: admin.firestore.FieldValue.serverTimestamp(),
					}, {merge: true});
				}

				res.status(200).json({received: true, error: "spin_amount_mismatch"});
				return;
			}
		}

		if (event.type === "checkout.session.expired" ||
			event.type === "checkout.session.async_payment_failed" ||
			event.type === "payment_intent.payment_failed" ||
			event.type === "payment_intent.canceled") {
			if (order.status === "pending") {
				await orderRef.set({
					status: "cancelled",
					cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
					webhookProcessed: true,
				}, {merge: true});
				if (order.reservationId) {
					await db.collection("spinReservations").doc(order.reservationId).set({
						status: "released",
						releasedAt: admin.firestore.FieldValue.serverTimestamp(),
						releaseReason: event.type,
						updatedAt: admin.firestore.FieldValue.serverTimestamp(),
					}, {merge: true});
				}
			}
			res.status(200).json({received: true, released: true});
			return;
		}

		const shouldProcess = await db.runTransaction(async (tx) => {
			const fresh = await tx.get(orderRef);
			if (!fresh.exists) return false;
			const current = fresh.data();
			if (current.webhookProcessed) return false;
			tx.update(orderRef, {
				status: "paid",
				stripePaymentIntentId: event.type === "payment_intent.succeeded" ? payload.id : (payload.payment_intent || null),
				paidAt: admin.firestore.FieldValue.serverTimestamp(),
				webhookProcessed: true,
			});
			return true;
		});

		if (!shouldProcess) {
			res.status(200).json({received: true, duplicate: true});
			return;
		}

		const raffleSnap = await db.collection("raffles").doc(order.raffleId).get();
		const raffle = raffleSnap.data() || {};
		const quantity = parseIntSafe(order.entryCount);
		const assignedNumbers = [];

		if (raffle.type === "spin") {
			if (order.reservationId) {
				const reservationRef = db.collection("spinReservations").doc(order.reservationId);
				const reservationSnap = await reservationRef.get();
				if (!reservationSnap.exists) {
					throw new Error("Spin reservation not found for order " + orderRef.id);
				}
				const reservation = reservationSnap.data();
				if (reservation.status === "paid") {
					assignedNumbers.push(parseIntSafe(reservation.number));
				} else {
					await reservationRef.set({
						status: "paid",
						paidAt: admin.firestore.FieldValue.serverTimestamp(),
						stripeSessionId: order.stripeSessionId || null,
						stripePaymentIntentId: order.stripePaymentIntentId || (event.type === "payment_intent.succeeded" ? payload.id : null),
						orderId: orderRef.id,
						updatedAt: admin.firestore.FieldValue.serverTimestamp(),
					}, {merge: true});
					assignedNumbers.push(parseIntSafe(reservation.number));
				}
			} else {
				const assignedSet = await getAssignedNumbersSet(order.raffleId);
				const selected = allocateSpinNumbers({
					totalSpots: parseIntSafe(raffle.totalSpots),
					assignedNumbersSet: assignedSet,
					quantity,
					assignmentMode: raffle.assignmentMode,
				});
				selected.forEach((n) => assignedNumbers.push(n));
			}
		}

		const createdAt = admin.firestore.FieldValue.serverTimestamp();
		const writes = [];
		for (let i = 0; i < quantity; i += 1) {
			const entryId = orderRef.id + "_" + String(i + 1);
			const entryNumber = orderRef.id.slice(-6).toUpperCase() + "-" + String(i + 1).padStart(4, "0");
			const assignedCardNumber = raffle.type === "spin" ? assignedNumbers[i] : null;
			writes.push(
					db.collection("entries").doc(entryId).set({
						raffleId: order.raffleId,
						raffleSlug: order.raffleSlug,
						raffleName: order.raffleName,
						orderId: orderRef.id,
						buyerName: order.buyerName,
						buyerEmail: order.buyerEmail,
						buyerPhone: order.buyerPhone,
						entryNumber,
						packageId: null,
						packageName: null,
						assignedCardNumber,
						source: "payment",
						paymentStatus: "paid",
						createdAt,
					}, {merge: true}),
			);
		}
		await Promise.all(writes);

		await orderRef.update({
			assignedNumbers,
		});

		res.status(200).json({received: true, createdEntries: quantity});
	} catch (error) {
		logger.error("Stripe webhook failure", error);
		res.status(400).send("Webhook Error: " + error.message);
	}
});

exports.createManualEntry = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const data = request.data || {};
	const raffleId = String(data.raffleId || "").trim();
	const buyerName = String(data.buyerName || "").trim();
	const buyerEmail = String(data.buyerEmail || "").trim();
	const buyerPhone = String(data.buyerPhone || "").trim();
	const quantity = parseIntSafe(data.quantity || 1);

	if (!raffleId || !buyerName || quantity < 1) {
		throw new HttpsError("invalid-argument", "Missing manual entry data.");
	}

	const raffleSnap = await db.collection("raffles").doc(raffleId).get();
	if (!raffleSnap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const raffle = raffleSnap.data();

	let assignedNumbers = [];
	if (raffle.type === "spin") {
		const assignedSet = await getAssignedNumbersSet(raffleId);
		assignedNumbers = allocateSpinNumbers({
			totalSpots: parseIntSafe(raffle.totalSpots),
			assignedNumbersSet: assignedSet,
			quantity,
			assignmentMode: raffle.assignmentMode,
		});
	}

	const now = admin.firestore.FieldValue.serverTimestamp();
	const orderRef = db.collection("orders").doc();
	await orderRef.set({
		raffleId,
		raffleSlug: raffle.slug,
		raffleName: raffle.name,
		buyerName,
		buyerEmail,
		buyerPhone,
		stripeSessionId: null,
		stripePaymentIntentId: null,
		status: "manual",
		totalAmount: 0,
		currency: "usd",
		raffleType: raffle.type,
		selections: {quantity},
		entryCount: quantity,
		assignedNumbers,
		createdAt: now,
		paidAt: now,
		webhookProcessed: true,
	});

	const writes = [];
	for (let i = 0; i < quantity; i += 1) {
		const entryId = orderRef.id + "_" + String(i + 1);
		const entryNumber = orderRef.id.slice(-6).toUpperCase() + "-M" + String(i + 1).padStart(3, "0");
		writes.push(
				db.collection("entries").doc(entryId).set({
					raffleId,
					raffleSlug: raffle.slug,
					raffleName: raffle.name,
					orderId: orderRef.id,
					buyerName,
					buyerEmail,
					buyerPhone,
					entryNumber,
					packageId: null,
					packageName: null,
					assignedCardNumber: raffle.type === "spin" ? assignedNumbers[i] : null,
					source: "manual",
					paymentStatus: "manual",
					createdAt: now,
				}),
		);
	}
	await Promise.all(writes);

	return {orderId: orderRef.id};
});

exports.getOrderBySession = onCall(CALLABLE_OPTS, async (request) => {
	const sessionId = String(request.data && request.data.sessionId || "").trim();
	if (!sessionId) {
		throw new HttpsError("invalid-argument", "Missing session id.");
	}

	const snap = await db.collection("orders")
			.where("stripeSessionId", "==", sessionId)
			.limit(1)
			.get();

	if (snap.empty) {
		throw new HttpsError("not-found", "Order not found.");
	}

	const order = snap.docs[0].data();
	return {
		order: {
			raffleName: order.raffleName || "",
			raffleType: order.raffleType || "general",
			status: order.status || "pending",
			entryCount: order.entryCount || 0,
			totalAmount: order.totalAmount || 0,
			currency: order.currency || "usd",
			assignedNumbers: Array.isArray(order.assignedNumbers) ? order.assignedNumbers : [],
		},
	};
});

exports.getRafflePublicStats = onCall(CALLABLE_OPTS, async (request) => {
	const raffleId = String(request.data && request.data.raffleId || "").trim();
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	const raffleSnap = await db.collection("raffles").doc(raffleId).get();
	if (!raffleSnap.exists) {
		throw new HttpsError("not-found", "Raffle not found.");
	}
	const raffle = raffleSnap.data();

	const paidEntriesSnap = await db.collection("entries")
			.where("raffleId", "==", raffleId)
			.where("paymentStatus", "==", "paid")
			.limit(10000)
			.get();
	const paidCount = paidEntriesSnap.size;

	let originalTotal = null;
	if (raffle.type === "spin") {
		originalTotal = parseIntSafe(raffle.totalSpots);
	} else if (!raffle.unlimitedEntries && parseIntSafe(raffle.maxEntries) > 0) {
		originalTotal = parseIntSafe(raffle.maxEntries);
	}

	let activeReservedCount = 0;
	if (raffle.type === "spin" && originalTotal && originalTotal > 0) {
		const now = admin.firestore.Timestamp.now();
		const reservedSnap = await db.collection("spinReservations")
				.where("raffleId", "==", raffleId)
				.where("status", "==", "reserved")
				.where("expiresAt", ">", now)
				.limit(10000)
				.get();
		activeReservedCount = reservedSnap.size;
	}

	const ticketsLeft = originalTotal && originalTotal > 0
		? Math.max(originalTotal - paidCount - activeReservedCount, 0)
		: null;

	return {
		paidCount,
		originalTotal,
		ticketsLeft,
	};
});

exports.exportRaffleCsv = onCall(CALLABLE_OPTS, async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const raffleId = String(request.data && request.data.raffleId || "").trim();
	if (!raffleId) {
		throw new HttpsError("invalid-argument", "Missing raffleId.");
	}

	const entriesSnap = await db.collection("entries")
			.where("raffleId", "==", raffleId)
			.orderBy("createdAt", "desc")
			.get();

	const rows = ["entryNumber,buyerName,buyerEmail,buyerPhone,assignedCardNumber,source,paymentStatus"]; 
	entriesSnap.docs.forEach((doc) => {
		const e = doc.data();
		rows.push([
			e.entryNumber || "",
			String(e.buyerName || "").replace(/,/g, " "),
			String(e.buyerEmail || "").replace(/,/g, " "),
			String(e.buyerPhone || "").replace(/,/g, " "),
			e.assignedCardNumber || "",
			e.source || "",
			e.paymentStatus || "",
		].join(","));
	});

	return {
		csv: rows.join("\n"),
		rowCount: entriesSnap.size,
	};
});
