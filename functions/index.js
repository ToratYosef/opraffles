const admin = require("firebase-admin");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({maxInstances: 10, region: "us-central1"});

const ADMIN_CODE = process.env.ADMIN_CODE || "123";

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

exports.adminCreateRaffle = onCall(async (request) => {
	requireAdmin(request.data && request.data.adminCode);

	const data = request.data || {};
	const name = String(data.name || "").trim();
	const slug = normalizeSlug(data.slug);
	const type = data.type === "spin" ? "spin" : "general";
	const entryPrice = parseFloatSafe(data.entryPrice);

	if (!name || !slug) {
		throw new HttpsError("invalid-argument", "Raffle name and slug are required.");
	}
	if (entryPrice <= 0) {
		throw new HttpsError("invalid-argument", "Entry price must be greater than zero.");
	}

	const existing = await db.collection("raffles").where("slug", "==", slug).limit(1).get();
	if (!existing.empty) {
		throw new HttpsError("already-exists", "A raffle with this slug already exists.");
	}

	const unlimitedEntries = data.unlimitedEntries !== false;
	const maxEntries = unlimitedEntries ? null : parseIntSafe(data.maxEntries);
	if (!unlimitedEntries && maxEntries < 1) {
		throw new HttpsError("invalid-argument", "Set a valid max entries value.");
	}

	const packageDeals = buildPackageDeals(data.packageDeals);

	const totalSpots = type === "spin" ? parseIntSafe(data.totalSpots) : null;
	const assignmentMode = data.assignmentMode === "random" ? "random" : "next";
	if (type === "spin" && totalSpots < 1) {
		throw new HttpsError("invalid-argument", "Spin raffles require total spots.");
	}

	const now = admin.firestore.FieldValue.serverTimestamp();
	const raffleRef = db.collection("raffles").doc();
	await raffleRef.set({
		name,
		slug,
		description: String(data.description || "").trim(),
		shortDescription: String(data.shortDescription || "").trim(),
		bannerImage: String(data.bannerImage || "").trim(),
		type,
		active: data.active !== false,
		featured: data.featured === true,
		entryPrice,
		packageDeals,
		unlimitedEntries,
		maxEntries,
		totalSpots,
		assignmentMode,
		createdAt: now,
		updatedAt: now,
	});

	return {raffleId: raffleRef.id};
});

exports.adminToggleRaffle = onCall(async (request) => {
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

exports.adminGetDashboard = onCall(async (request) => {
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

exports.adminGenerateWheelData = onCall(async (request) => {
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
			.map((doc) => doc.data())
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
	};
});

exports.createCheckoutSession = onCall(async (request) => {
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

	if (!raffle.unlimitedEntries && parseIntSafe(raffle.maxEntries) > 0) {
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
		const totalSpots = parseIntSafe(raffle.totalSpots);
		const assigned = await countAssignedSpinSpots(raffleId);
		if (totalSpots - assigned < quantity) {
			throw new HttpsError("failed-precondition", "Not enough spin spots available.");
		}
	}

	const unitPriceCents = Math.round(parseFloatSafe(raffle.entryPrice) * 100);
	const deal = bestDealForQty(buildPackageDeals(raffle.packageDeals), quantity);
	const subtotal = unitPriceCents * quantity;
	const discountCents = Math.round(subtotal * (deal.discountPercent / 100));
	const totalCents = Math.max(subtotal - discountCents, 0);

	const stripe = getStripeClient();
	const siteUrl = process.env.SITE_URL || "http://localhost:5000";

	const session = await stripe.checkout.sessions.create({
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

	const orderRef = db.collection("orders").doc();
	await orderRef.set({
		raffleId,
		raffleSlug: raffle.slug,
		raffleName: raffle.name,
		buyerName,
		buyerEmail,
		buyerPhone,
		stripeSessionId: session.id,
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
		assignedNumbers: [],
		createdAt: admin.firestore.FieldValue.serverTimestamp(),
		paidAt: null,
		webhookProcessed: false,
	});

	return {
		checkoutUrl: session.url,
		sessionId: session.id,
		orderId: orderRef.id,
	};
});

exports.stripeWebhook = onRequest(async (req, res) => {
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

		if (event.type !== "checkout.session.completed") {
			res.status(200).json({received: true, ignored: true});
			return;
		}

		const session = event.data.object;
		const orderSnap = await db.collection("orders")
				.where("stripeSessionId", "==", session.id)
				.limit(1)
				.get();

		if (orderSnap.empty) {
			logger.error("Order not found for Stripe session", {sessionId: session.id});
			res.status(200).json({received: true, orderFound: false});
			return;
		}

		const orderDoc = orderSnap.docs[0];
		const orderRef = orderDoc.ref;
		const order = orderDoc.data();

		const shouldProcess = await db.runTransaction(async (tx) => {
			const fresh = await tx.get(orderRef);
			if (!fresh.exists) return false;
			const current = fresh.data();
			if (current.webhookProcessed) return false;
			tx.update(orderRef, {
				status: "paid",
				stripePaymentIntentId: session.payment_intent || null,
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
			const assignedSet = await getAssignedNumbersSet(order.raffleId);
			const selected = allocateSpinNumbers({
				totalSpots: parseIntSafe(raffle.totalSpots),
				assignedNumbersSet: assignedSet,
				quantity,
				assignmentMode: raffle.assignmentMode,
			});
			selected.forEach((n) => assignedNumbers.push(n));
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

exports.createManualEntry = onCall(async (request) => {
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

exports.getOrderBySession = onCall(async (request) => {
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

exports.exportRaffleCsv = onCall(async (request) => {
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
