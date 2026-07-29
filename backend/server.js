require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const axios     = require("axios");
const admin     = require("firebase-admin");
const rateLimit = require("express-rate-limit");
const crypto    = require("crypto");
const logger    = require("./logger");
const { extract, mergeExtracts, getSitemapUrls } = require("./extractor");

const VERSION         = process.env.npm_package_version || "1.0.0";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim().replace(/\/$/, "")).filter(Boolean);
const IS_DEV          = process.env.NODE_ENV !== "production";

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    // In dev: allow all origins (file://, Live Server, any localhost port)
    // In production: only listed origins
    if (IS_DEV || !origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("CORS: origin not allowed"));
  },
}));
app.use(express.json());

// ── Rate limiters ──────────────────────────────────────────────────────────
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many import requests. Please try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Firebase Admin ─────────────────────────────────────────────────────────
let db;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require("./serviceAccount.json");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  logger.info("Firebase Admin initialised");
} catch (e) {
  logger.error("Firebase Admin init failed", { message: e.message });
}

// ── Helpers ────────────────────────────────────────────────────────────────
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; PixoraBot/1.0; +https://pixora.in)",
  "Accept": "text/html,application/xhtml+xml",
};

function isPrivateUrl(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return (
      hostname === "localhost" ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      hostname === "0.0.0.0"
    );
  } catch { return true; }
}

async function fetchPage(url) {
  if (isPrivateUrl(url)) throw new Error("PRIVATE_URL");
  const res = await axios.get(url, {
    timeout: 8000,
    headers: HEADERS,
    maxRedirects: 5,
    maxContentLength: 5 * 1024 * 1024,
    responseType: "text",
    family: 4, // force IPv4 — avoids broken IPv6 on local machines
  });
  return res.data;
}

async function isCrawlAllowed(baseUrl) {
  try {
    const robotsUrl = new URL(baseUrl).origin + "/robots.txt";
    const txt  = await fetchPage(robotsUrl);
    const lines = txt.split("\n");
    let applies = false;
    for (const raw of lines) {
      const line = raw.trim().toLowerCase();
      if (line.startsWith("user-agent:")) {
        const agent = line.replace("user-agent:", "").trim();
        applies = agent === "*" || agent.includes("pixorabot");
      }
      if (applies && line.startsWith("disallow:")) {
        const path = line.replace("disallow:", "").trim();
        if (path === "/") return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

function findSubpages(html, baseUrl) {
  const origin  = new URL(baseUrl).origin;
  const pattern = /about|services|contact|faq|menu|offerings|what-we-do/i;
  const found   = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let href = m[1];
    if (href.startsWith("/")) href = origin + href;
    if (href.startsWith(origin) && pattern.test(href) && href !== baseUrl) {
      found.add(href.split("?")[0].split("#")[0]);
    }
  }
  return [...found].slice(0, 4);
}

// ── Translate raw errors into user-friendly messages ──────────────────────
function friendlyImportError(err) {
  const code   = err.code || "";
  const status = err.response?.status;
  const msg    = err.message || "";

  if (msg === "PRIVATE_URL")                          return "That URL points to a private or internal address.";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND") return "Could not reach that website. Check the URL and try again.";
  if (code === "ETIMEDOUT" || msg.includes("timeout")) return "The website took too long to respond (timeout). Try again later.";
  if (status === 403 || status === 401)                return "That website blocked our request. Please fill in details manually.";
  if (status === 404)                                  return "Page not found on that website (404).";
  if (status >= 500)                                   return "That website returned a server error. Try again later.";
  if (msg.includes("maxContentLength"))                return "That website's page is too large to import (over 5 MB).";
  return "Import failed. Please fill in your details manually.";
}

// ── GET /health ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: VERSION });
});

// ── GET / ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Pixora backend running", version: VERSION }));

// ── POST /api/importWebsite ────────────────────────────────────────────────
app.post("/api/importWebsite", importLimiter, async (req, res) => {
  let { website, clientId } = req.body;
  if (!website || !clientId) return res.status(400).json({ error: "website and clientId are required" });
  if (!/^https?:\/\//i.test(website)) website = "https://" + website;
  if (isPrivateUrl(website)) return res.status(400).json({ error: "That URL is not allowed." });

  const startTime       = Date.now();
  const CRAWL_TIMEOUT_MS = 20000;

  logger.info("Import started", { clientId, website });

  const crawlAllowed = await isCrawlAllowed(website);
  if (!crawlAllowed) {
    logger.warn("Crawl blocked by robots.txt", { website });
    return res.status(422).json({ error: "This website's robots.txt disallows crawling. Please fill in details manually." });
  }

  try {
    const homeHtml = await fetchPage(website);
    const homeData = extract(homeHtml, website);

    let subUrls = await getSitemapUrls(website, fetchPage);
    if (!subUrls.length) subUrls = findSubpages(homeHtml, website);
    subUrls = subUrls.filter(u => u !== website && !isPrivateUrl(u)).slice(0, 9);

    const elapsed    = Date.now() - startTime;
    const remaining  = CRAWL_TIMEOUT_MS - elapsed;
    const subResults = remaining > 0
      ? await Promise.allSettled(subUrls.map(u => fetchPage(u)))
      : [];
    const successfulUrls = subUrls.filter((_, i) => subResults[i]?.status === "fulfilled");

    const allExtracts = [homeData];
    subResults.forEach((r, i) => {
      if (r.status === "fulfilled") allExtracts.push(extract(r.value, subUrls[i]));
    });
    const extracted = mergeExtracts(allExtracts);

    if (!Object.keys(extracted).length) {
      logger.warn("No data extracted", { website });
      return res.status(422).json({ error: "No contact details or services found on that website. Please fill in details manually." });
    }

    const websiteImport = {
      url:          website,
      status:       "success",
      pagesScanned: 1 + successfulUrls.length,
      urlsScanned:  [website, ...successfulUrls],
      usedSitemap:  (await getSitemapUrls(website, fetchPage)).length > 0,
      importedAt:   new Date().toISOString(),
      durationMs:   Date.now() - startTime,
    };

    logger.info("Import complete", { clientId, website, pages: websiteImport.pagesScanned, durationMs: websiteImport.durationMs });
    return res.json({ success: true, extracted, websiteImport });

  } catch (err) {
    const friendly = friendlyImportError(err);
    logger.error("Import error", { website, code: err.code, status: err.response?.status, message: err.message });
    return res.status(422).json({ error: friendly });
  }
});

// ── POST /api/saveImport ───────────────────────────────────────────────────
app.post("/api/saveImport", async (req, res) => {
  const { clientId, approved, websiteImport } = req.body;
  if (!clientId || !approved) return res.status(400).json({ error: "clientId and approved are required" });
  if (!db) return res.status(500).json({ error: "Database not available" });

  try {
    await db.collection("clients").doc(clientId).set({
      ...approved,
      websiteImport,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.info("Import saved", { clientId });
    return res.json({ success: true });
  } catch (e) {
    logger.error("saveImport failed", { clientId, message: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// ── POST /api/registerWidget ───────────────────────────────────────────────
app.post("/api/registerWidget", async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!db) return res.status(500).json({ error: "Database not available" });

  try {
    const clientSnap = await db.collection("clients").doc(clientId).get();
    if (clientSnap.exists && clientSnap.data().widgetId) {
      return res.json({ success: true, widgetId: clientSnap.data().widgetId });
    }

    const widgetId = "pxt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await db.collection("widgets").doc(widgetId).set({ clientId });
    await db.collection("clients").doc(clientId).set({ widgetId }, { merge: true });

    logger.info("Widget registered", { clientId, widgetId });
    return res.json({ success: true, widgetId });
  } catch (e) {
    logger.error("registerWidget failed", { clientId, message: e.message });
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => logger.info(`Pixora backend running on http://localhost:${PORT}`));
