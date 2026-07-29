(async function () {
  "use strict";

  // ── 1. Resolve widget ID and client ID ──────────────────────────────────────
  // Script tag uses ?id=pxt_xxxx (widgetId) or legacy ?client=xxx
  const scriptTag = document.currentScript || [...document.querySelectorAll("script")].find(s => s.src.includes("widget.js"));
  const srcUrl    = new URL(scriptTag?.src || "http://x?client=demo");
  const widgetId  = srcUrl.searchParams.get("id")   || "";
  const legacyId  = srcUrl.searchParams.get("client") || "demo";
  const baseUrl   = scriptTag?.src ? new URL(".", scriptTag.src).href : location.origin + "/";

  // ── 2. Inject CSS ────────────────────────────────────────────────────────────
  const cssLink = document.createElement("link");
  cssLink.rel   = "stylesheet";
  cssLink.href  = baseUrl + "widget.css";
  document.head.appendChild(cssLink);

  // ── 3. Firebase config ───────────────────────────────────────────────────────
  const FB_CONFIG = {
    apiKey:            "AIzaSyBmX-TR7eA_K_YzY34AwC4x5HmfwtqPN94",
    authDomain:        "chatbot-e3cec.firebaseapp.com",
    projectId:         "chatbot-e3cec",
    storageBucket:     "chatbot-e3cec.firebasestorage.app",
    messagingSenderId: "950464568801",
    appId:             "1:950464568801:web:9f7150964b7089048506a0",
    measurementId:     "G-SB58Q15YZ0",
  };

  // ── 4. Load Firebase (compat SDK — works as plain script, no bundler needed) ─
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics-compat.js");

  if (!firebase.apps.length) firebase.initializeApp(FB_CONFIG);
  const db        = firebase.firestore();
  const analytics = firebase.analytics();

  // ── 5. Fetch business config from Firestore ──────────────────────────────────
  // If widgetId provided, look up the client doc by widgetId field first
  let clientId = legacyId;
  let config;
  try {
    let snap;
    if (widgetId) {
      // Direct O(1) lookup via widgets/{widgetId} collection
      const widgetSnap = await db.collection("widgets").doc(widgetId).get();
      if (!widgetSnap.exists) throw new Error("Widget ID not found");
      clientId = widgetSnap.data().clientId;
      snap = await db.collection("clients").doc(clientId).get();
      if (!snap.exists) throw new Error("Client not found");
    } else {
      snap = await db.collection("clients").doc(clientId).get();
      if (!snap.exists) throw new Error("Client not found");
    }
    const d = snap.data();
    config = {
      businessName:   d.businessName    || "Pixora AI",
      tagline:        d.tagline         || "Your 24/7 Digital Sales Assistant",
      logo:           d.logo            || `https://api.dicebear.com/7.x/initials/svg?seed=${clientId}&backgroundColor=6366f1`,
      brandColor:     d.primaryColor    || "#6366F1",
      phone:          d.phone           || "",
      email:          d.email           || "",
      whatsapp:       d.whatsapp        || "",
      website:        d.website         || "",
      workingHours:   d.workingHours    || "",
      services:       d.services        || [],
      faq:            d.faq             || [],
      showBranding:   d.showBranding    !== false,
      aiInstructions: d.aiInstructions  || "",
    };
  } catch (err) {
    console.warn("[Pixora] Could not load config:", err.message);
    config = {
      businessName: "Pixora AI", tagline: "Your 24/7 Digital Sales Assistant",
      logo: "https://api.dicebear.com/7.x/initials/svg?seed=PX&backgroundColor=6366f1",
      brandColor: "#6366F1", phone:"", email:"", whatsapp:"", website:"",
      workingHours: "Always Online 🤖",
      services: ["Website Design","AI Chatbots","SEO","Branding"],
      faq: [
        { q:"What does Pixora do?", a:"We build websites, AI chatbots, and digital marketing solutions." },
        { q:"How much does a website cost?", a:"Websites start at ₹4,999. Chatbot plans start at ₹999/month." },
      ],
      showBranding: true,
    };
  }

  // ── 6. Build knowledge index from FAQs + services (built once, queried fast) ─
  // Each entry: { keywords: Set, answer, type }
  const knowledgeIndex = [];

  const STOP = new Set(["do","you","is","are","the","a","an","i","we","can","have","has","what","how","when","where","which","does","your","our","my"]);

  function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w));
  }

  // Index FAQs
  config.faq.forEach(f => {
    knowledgeIndex.push({ keywords: new Set(tokenize(f.q)), answer: f.a, type: "faq", original: f.q });
  });

  // Index services — each service becomes a searchable entry
  config.services.forEach(s => {
    knowledgeIndex.push({ keywords: new Set(tokenize(s)), answer: s, type: "service", original: s });
  });

  // Score a query against a knowledge entry (0–1)
  function scoreEntry(entry, queryTokens) {
    if (!entry.keywords.size) return 0;
    const matched = queryTokens.filter(t => entry.keywords.has(t)).length;
    return matched / entry.keywords.size;
  }

  // ── Analytics: write to Firestore subcollection (not just Firebase Analytics) ─
  function logEvent(event, extra = {}) {
    // Firebase Analytics
    try { analytics.logEvent(event, { client_id: clientId, ...extra }); } catch(e) {}
    // Firestore analytics subcollection
    try {
      db.collection("clients").doc(clientId).collection("analytics").add({
        event, page: location.href,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        ...extra,
      });
    } catch(e) {}
  }

  logEvent("widget_loaded");

  // ── 7. Apply brand colour ─────────────────────────────────────────────────────
  document.documentElement.style.setProperty("--px-color", config.brandColor);

  // ── 8. Build widget HTML ──────────────────────────────────────────────────────
  const widget = document.createElement("div");
  widget.id    = "pixora-widget";
  widget.innerHTML = `
    <div id="pixora-box" class="hidden">
      <div id="pixora-header" style="background:${config.brandColor}">
        <img src="${config.logo}" alt="logo" onerror="this.style.display='none'">
        <div id="pixora-header-info">
          <strong>${config.businessName}</strong>
          <span>🟢 Online – replies instantly</span>
        </div>
        <button id="pixora-close" title="Close">✕</button>
      </div>
      <div id="pixora-messages"></div>
      <div id="pixora-input-area">
        <input id="pixora-input" type="text" placeholder="Type a message…" autocomplete="off">
        <button id="pixora-send" style="background:${config.brandColor}" title="Send">
          <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
        </button>
      </div>
      ${config.showBranding ? `<div id="pixora-footer">Powered by <a href="https://pixora.in" target="_blank">Pixora AI</a></div>` : ""}
    </div>
    <button id="pixora-toggle" style="background:${config.brandColor}" title="Chat with us">
      <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>
    </button>`;
  document.body.appendChild(widget);

  // ── 9. Element refs ───────────────────────────────────────────────────────────
  const box      = document.getElementById("pixora-box");
  const messages = document.getElementById("pixora-messages");
  const input    = document.getElementById("pixora-input");
  const send     = document.getElementById("pixora-send");
  const toggle   = document.getElementById("pixora-toggle");
  const close    = document.getElementById("pixora-close");

  let awaitingLead = false;

  // ── 10. Open / close ──────────────────────────────────────────────────────────
  toggle.addEventListener("click", () => {
    const isHidden = box.classList.toggle("hidden");
    toggle.innerHTML = isHidden
      ? `<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>`
      : `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    if (!isHidden && messages.children.length === 0) {
      logEvent("chat_opened");
      greet();
    }
  });

  close.addEventListener("click", () => toggle.click());

  // ── 11. Send ──────────────────────────────────────────────────────────────────
  send.addEventListener("click", handleSend);
  input.addEventListener("keydown", e => { if (e.key === "Enter") handleSend(); });

  function handleSend() {
    const text = input.value.trim();
    if (!text || awaitingLead) return;
    input.value = "";
    addMsg(text, "user");
    setTimeout(() => respond(text), 600);
  }

  // ── 12. Greeting ──────────────────────────────────────────────────────────────
  function greet() {
    const h = new Date().getHours();
    const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    addMsg(`${g}! 👋 Welcome to <strong>${config.businessName}</strong>.<br>${config.tagline}`, "bot");
    setTimeout(() => addMsg("How can I help you today?", "bot",
      ["Our Services", "Working Hours", "Contact Us", "Leave a Message"]
    ), 700);
  }

  // ── 13. Response engine ───────────────────────────────────────────────────────

  let missCount = 0; // tracks consecutive unmatched messages

  // Synonym map — all variations collapse to one intent keyword
  const SYNONYMS = {
    // hours
    timing: "open", timings: "open", hours: "open", hour: "open",
    schedule: "open", "opening time": "open", "closing time": "open",
    "what time": "open", "when do": "open", "are you open": "open",
    // services
    offer: "service", offerings: "service", provide: "service",
    "what do you do": "service", "what do you sell": "service",
    menu: "service", products: "service",
    // contact
    number: "contact", call: "contact", reach: "contact",
    "get in touch": "contact", address: "contact", location: "contact",
    "where are you": "contact",
    // whatsapp
    wa: "whatsapp", "message you": "whatsapp", "chat on whatsapp": "whatsapp",
    // lead
    enquiry: "book", enquire: "book", callback: "book",
    interested: "book", appointment: "book", quote: "book",
    "get a quote": "book", "book a": "book", "i want to": "book",
    // delivery
    deliver: "delivery", "home delivery": "delivery",
    "do you deliver": "delivery", "delivery available": "delivery",
  };

  // Normalise text: lowercase, strip punctuation, expand synonyms
  function normalise(text) {
    let t = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    // Replace multi-word synonyms first (longest first to avoid partial replacement)
    Object.keys(SYNONYMS).sort((a, b) => b.length - a.length).forEach(phrase => {
      if (t.includes(phrase)) t = t.replace(phrase, SYNONYMS[phrase]);
    });
    return t;
  }

function respond(text) {
    const t = normalise(text);

    // ── Intent: services ──
    if (matches(t, ["service", "offer", "menu", "product", "provide"])) {
      missCount = 0;
      const list = config.services.length
        ? `We offer:<br>• ${config.services.join("<br>• ")}`
        : "Please contact us to learn about our services.";
      return addMsg(list, "bot", ["Working Hours", "Contact Us"]);
    }

    // ── Intent: hours ──
    if (matches(t, ["open", "timing", "hour", "schedule", "time"])) {
      missCount = 0;
      return addMsg(
        config.workingHours
          ? `⏰ We're open: <strong>${config.workingHours}</strong>`
          : "Please contact us for our working hours.",
        "bot", ["Contact Us", "Our Services"]
      );
    }

    // ── Intent: delivery (common enough to deserve its own check) ──
    if (matches(t, ["delivery", "deliver"])) {
      missCount = 0;
      // Look for a delivery-related FAQ first
      const deliveryFaq = config.faq.find(f =>
        normalise(f.q).includes("deliver")
      );
      if (deliveryFaq) return addMsg(deliveryFaq.a, "bot", ["Our Services", "Contact Us"]);
      return addMsg("Please contact us to find out about our delivery options.", "bot", ["Contact Us", "WhatsApp Us"]);
    }

    // ── Intent: contact / location ──
    if (matches(t, ["contact", "phone", "call", "email", "reach", "number", "address", "location", "where"])) {
      missCount = 0;
      return showContact();
    }

    // ── Intent: whatsapp ──
    if (matches(t, ["whatsapp", "wa", "message"])) {
      missCount = 0;
      return openWhatsApp();
    }

    // ── Intent: booking / enquiry ──
    if (matches(t, ["book", "enquiry", "enquire", "callback", "interested", "appointment", "quote", "leave"])) {
      missCount = 0;
      return showLeadForm();
    }

    // ── Intent: show FAQs list ──
    if (matches(t, ["faq", "question", "know more", "help", "more info"])) {
      missCount = 0;
      return showFAQs();
    }

    // ── Knowledge index search (FAQs + services) ──
    const queryTokens = t.split(" ").filter(w => w.length > 2);
    const scored = knowledgeIndex
      .map(entry => ({ entry, score: scoreEntry(entry, queryTokens) }))
      .filter(x => x.score >= 0.4)
      .sort((a, b) => b.score - a.score);

    if (scored.length) {
      missCount = 0;
      const top = scored[0].entry;
      if (top.type === "faq") {
        logEvent("faq_matched", { question: top.original });
        return addMsg(top.answer, "bot", ["More Questions", "Contact Us"]);
      }
      if (top.type === "service") {
        logEvent("service_matched", { service: top.original });
        return addMsg(`Yes, we offer <strong>${top.original}</strong>! Would you like to know more or place an enquiry?`, "bot",
          ["More Services", "Book / Enquire", "Contact Us"]);
      }
    }

    // ── Fallback ──
    missCount++;
    if (missCount >= 2) {
      // After 2 misses, proactively offer lead form
      missCount = 0;
      addMsg("I couldn't find an answer to that. Let me get someone from our team to help you directly! 👇", "bot");
      setTimeout(() => showLeadForm(), 800);
    } else {
      addMsg("I'm not sure about that. Try asking about our <strong>services</strong>, <strong>hours</strong>, or <strong>contact details</strong>.", "bot",
        ["Our Services", "Working Hours", "Contact Us"]
      );
    }
  }

  function matches(text, kws) { return kws.some(k => text.includes(k)); }

  // ── 14. Contact ───────────────────────────────────────────────────────────────
  function showContact() {
    const lines = [];
    if (config.phone)   lines.push(`📞 <strong>${config.phone}</strong>`);
    if (config.email)   lines.push(`📧 <a href="mailto:${config.email}" style="color:${config.brandColor}">${config.email}</a>`);
    if (config.website) lines.push(`🌐 <a href="${config.website}" target="_blank" style="color:${config.brandColor}">${config.website}</a>`);
    addMsg(lines.length ? lines.join("<br>") : "Please reach out via WhatsApp.", "bot",
      ["WhatsApp Us", "Leave a Message"]
    );
  }

  // ── 15. WhatsApp ──────────────────────────────────────────────────────────────
  function openWhatsApp() {
    if (!config.whatsapp) return addMsg("WhatsApp is not set up yet. Please call us!", "bot");
    const num = config.whatsapp.replace(/\D/g, "");
    const url = `https://wa.me/${num}?text=Hi%20${encodeURIComponent(config.businessName)}%2C%20I%20found%20you%20on%20your%20website!`;
    addMsg("Opening WhatsApp… 💬", "bot");
    logEvent("whatsapp_click");
    setTimeout(() => window.open(url, "_blank"), 800);
  }

  // ── 16. FAQs ──────────────────────────────────────────────────────────────────
  function showFAQs() {
    if (!config.faq.length) return addMsg("No FAQs set up yet. Please contact us directly!", "bot", ["Contact Us"]);
    addMsg("Here are some common questions:", "bot", config.faq.slice(0, 5).map(f => f.q));
  }

  // ── 17. Lead form → saves to Firestore ───────────────────────────────────────
  function showLeadForm() {
    awaitingLead = true;
    const msgEl = addMsg("Please fill in your details and we'll get back to you! 😊", "bot");

    const form = document.createElement("div");
    form.id    = "pixora-lead-form";
    form.innerHTML = `
      <input type="text"  id="px-name"    placeholder="Your Name *">
      <input type="tel"   id="px-phone"   placeholder="Phone Number *">
      <input type="email" id="px-email"   placeholder="Email (optional)">
      <input type="text"  id="px-message" placeholder="How can we help? (optional)">
      <button style="background:${config.brandColor}">Submit →</button>`;
    msgEl.appendChild(form);
    scrollBottom();

    form.querySelector("button").addEventListener("click", async () => {
      const name    = document.getElementById("px-name").value.trim();
      const phone   = document.getElementById("px-phone").value.trim();
      const email   = document.getElementById("px-email").value.trim();
      const message = document.getElementById("px-message").value.trim();

      document.getElementById("px-name").style.borderColor  = name  ? "" : "red";
      document.getElementById("px-phone").style.borderColor = phone ? "" : "red";
      if (!name || !phone) return;

      form.querySelector("button").textContent = "Saving…";
      form.querySelector("button").disabled    = true;

      try {
        await db.collection("clients").doc(clientId).collection("leads").add({
          name, phone, email, message,
          page:      location.href,
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
        logEvent("lead_captured");
      } catch (e) {
        console.warn("[Pixora] Lead save failed:", e.message);
      }

      form.remove();
      awaitingLead = false;
      addMsg(`Thanks <strong>${name}</strong>! 🎉 We'll reach out to you on <strong>${phone}</strong> shortly.`, "bot", ["WhatsApp Us"]);
    });
  }

  // ── 18. Quick replies ─────────────────────────────────────────────────────────
  function handleQuickReply(label) {
    addMsg(label, "user");
    setTimeout(() => {
      const map = {
        "Our Services":   () => respond("service"),
        "More Services":  () => respond("service"),
        "Working Hours":  () => respond("open"),
        "Contact Us":     () => respond("contact"),
        "Leave a Message":() => showLeadForm(),
        "Book / Enquire": () => showLeadForm(),
        "WhatsApp Us":    () => openWhatsApp(),
        "More Questions": () => showFAQs(),
      };
      (map[label] || (() => respond(label)))();
    }, 400);
  }

  // ── 19. DOM helpers ───────────────────────────────────────────────────────────
  function addMsg(html, type, quickReplies = []) {
    const el = document.createElement("div");
    el.className = `px-msg ${type}`;
    if (type === "user") el.style.background = config.brandColor;
    el.innerHTML = html;

    if (quickReplies.length) {
      const qr = document.createElement("div");
      qr.className = "px-quick-replies";
      quickReplies.forEach(label => {
        const btn = document.createElement("button");
        btn.className = "px-quick-btn";
        btn.textContent = label;
        btn.style.cssText = `border-color:${config.brandColor};color:${config.brandColor}`;
        btn.addEventListener("mouseover", () => { btn.style.background = config.brandColor; btn.style.color = "#fff"; });
        btn.addEventListener("mouseout",  () => { btn.style.background = "#fff"; btn.style.color = config.brandColor; });
        btn.addEventListener("click", () => { qr.remove(); handleQuickReply(label); });
        qr.appendChild(btn);
      });
      setTimeout(() => { messages.appendChild(qr); scrollBottom(); }, 50);
    }

    if (type === "bot") {
      const typing = addTyping();
      setTimeout(() => { typing.remove(); messages.appendChild(el); scrollBottom(); }, 500);
    } else {
      messages.appendChild(el);
      scrollBottom();
    }
    return el;
  }

  function addTyping() {
    const el = document.createElement("div");
    el.className = "px-msg bot px-typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    messages.appendChild(el);
    scrollBottom();
    return el;
  }

  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
})();
