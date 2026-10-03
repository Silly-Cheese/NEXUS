import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, setDoc, getDoc, getDocs, doc, updateDoc, deleteDoc,
  serverTimestamp, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDWUZlg-LgHPDekyTv4AqbsMVWIhTq8MB0",
  authDomain: "nexus-5fd52.firebaseapp.com",
  projectId: "nexus-5fd52",
  storageBucket: "nexus-5fd52.firebasestorage.app",
  messagingSenderId: "956997766197",
  appId: "1:956997766197:web:a1adc13a8b088ee5f8357c"
};

const OWNER_EMAIL = "christophershelley257@gmail.com";
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const COLLECTIONS = ["transactions", "receipts", "assets", "qrTags", "books", "locations", "activity", "loans"];
const CATEGORIES = [
  "Groceries", "Dining", "Transportation", "Books", "Electronics", "Household",
  "Personal Care", "Education", "Entertainment", "Subscriptions", "Medical", "Gifts", "Other"
];
const ASSET_CATEGORIES = ["Electronics", "Computer", "School", "Furniture", "Tool", "Container", "Collectible", "Appliance", "Other"];
const LOCATION_TYPES = ["Room", "Bookcase", "Shelf", "Drawer", "Cabinet", "Closet", "Box", "Bag", "Other"];

const state = {
  user: null,
  view: "dashboard",
  searchTerm: "",
  charts: [],
  pendingTag: new URLSearchParams(location.search).get("tag"),
  data: Object.fromEntries(COLLECTIONS.map(function (name) { return [name, []]; }))
};

const $ = function (selector, root) { return (root || document).querySelector(selector); };
const $$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function money(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(number);
}

function dateText(value) {
  if (!value) return "—";
  try {
    if (value.toDate) return value.toDate().toLocaleDateString();
    const d = new Date(String(value) + (String(value).length === 10 ? "T12:00:00" : ""));
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
  } catch (_) { return String(value); }
}

function dateTimeText(value) {
  if (!value) return "Just now";
  try {
    const d = value.toDate ? value.toDate() : new Date(value);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch (_) { return "Recently"; }
}

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function monthKey(date) {
  const d = date instanceof Date ? date : new Date(String(date || todayISO()) + "T12:00:00");
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function currentMonthKey() { return monthKey(new Date()); }

function previousMonthKey() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return monthKey(d);
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isOwner(user) {
  return !!user && String(user.email || "").toLowerCase() === OWNER_EMAIL;
}

function toast(title, message, type) {
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.innerHTML = "<strong>" + escapeHtml(title) + "</strong>" + escapeHtml(message || "");
  $("#toast-stack").appendChild(el);
  setTimeout(function () { el.remove(); }, 4200);
}

function humanIcon(type) {
  return ({ money: "◇", receipt: "▤", asset: "▣", qr: "⌁", book: "▥", location: "⌖", system: "◈", loan: "↗" })[type] || "◈";
}

async function writeActivity(type, label, entityType, entityId, detail) {
  try {
    await addDoc(collection(db, "activity"), {
      type: type || "system",
      label: label || "Activity",
      entityType: entityType || null,
      entityId: entityId || null,
      detail: detail || "",
      createdAt: serverTimestamp()
    });
  } catch (error) {
    console.warn("Activity write failed", error);
  }
}

async function loadCollection(name) {
  const snapshot = await getDocs(collection(db, name));
  const rows = snapshot.docs.map(function (snap) { return Object.assign({ id: snap.id }, snap.data()); });
  rows.sort(function (a, b) {
    const ad = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : Date.parse(a.date || a.purchaseDate || a.createdAt || 0) || 0;
    const bd = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : Date.parse(b.date || b.purchaseDate || b.createdAt || 0) || 0;
    return bd - ad;
  });
  state.data[name] = rows;
}

async function loadAll() {
  await Promise.all(COLLECTIONS.map(loadCollection));
  render();
}

async function refresh(names) {
  await Promise.all((names || COLLECTIONS).map(loadCollection));
  render();
}

function setMobileNavOpen(open) {
  const sidebar = $(".sidebar");
  const button = $("#mobile-menu");
  if (!sidebar || !button) return;
  sidebar.classList.toggle("open", !!open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
}

function setActiveView(name) {
  state.view = name;
  $$(".nav-item[data-view]").forEach(function (btn) { btn.classList.toggle("active", btn.dataset.view === name); });
  $$(".mobile-nav [data-view]").forEach(function (btn) { btn.classList.toggle("active", btn.dataset.view === name); });
  setMobileNavOpen(false);
  render();
}

function destroyCharts() {
  state.charts.forEach(function (chart) { try { chart.destroy(); } catch (_) {} });
  state.charts = [];
}

function render() {
  if (!state.user) return;
  destroyCharts();
  const renderers = {
    dashboard: renderDashboard,
    money: renderMoney,
    receipts: renderReceipts,
    assets: renderAssets,
    qr: renderQr,
    library: renderLibrary,
    locations: renderLocations,
    search: renderSearch,
    settings: renderSettings
  };
  const fn = renderers[state.view] || renderDashboard;
  $("#view").innerHTML = fn();
  bindViewActions();
  setTimeout(function () {
    afterRender();
    document.dispatchEvent(new CustomEvent("nexus:render", { detail: { view: state.view } }));
  }, 0);
}

function viewHeader(eyebrow, title, subtitle, actions) {
  return "<div class='view-header'><div><div class='eyebrow'>" + escapeHtml(eyebrow) + "</div><h1>" + escapeHtml(title) +
    "</h1><p>" + escapeHtml(subtitle || "") + "</p></div><div class='actions'>" + (actions || "") + "</div></div>";
}

function emptyState(title, copy, buttonHtml) {
  return "<div class='empty-state'><strong>" + escapeHtml(title) + "</strong><div>" + escapeHtml(copy) + "</div>" + (buttonHtml || "") + "</div>";
}

function expenseTransactions() {
  return state.data.transactions.filter(function (t) { return (t.type || "expense") === "expense"; });
}

function spendForMonth(key) {
  return expenseTransactions().filter(function (t) { return monthKey(t.date) === key; })
    .reduce(function (sum, t) { return sum + Number(t.amount || 0); }, 0);
}

function renderDashboard() {
  const nowKey = currentMonthKey();
  const spend = spendForMonth(nowKey);
  const prev = spendForMonth(previousMonthKey());
  const delta = prev ? ((spend - prev) / prev) * 100 : 0;
  const waitingReceipts = state.data.receipts.filter(function (r) { return r.status === "needs-review"; }).length;
  const activity = state.data.activity.slice(0, 8);

  return viewHeader("OVERVIEW", "Good " + greetingPart() + ".", "Everything you own, spend, scan, and catalog—connected.",
    "<button class='btn btn-secondary' data-action='scan'>▦ Scan</button><button class='btn btn-primary' data-action='quick-add'>＋ Quick Add</button>") +
    "<div class='grid grid-4'>" +
      statCard("◇", "Spent this month", money(spend), prev ? (delta >= 0 ? "↑ " : "↓ ") + Math.abs(delta).toFixed(1) + "% from last month" : "Start building your spending history") +
      statCard("▤", "Receipts", String(state.data.receipts.length), waitingReceipts ? waitingReceipts + " need review" : "All processed") +
      statCard("▣", "Registered assets", String(state.data.assets.length), countTagged("asset") + " have QR tags") +
      statCard("▥", "Library", String(state.data.books.length), state.data.books.filter(function (b) { return b.readingStatus === "Reading"; }).length + " currently reading") +
    "</div>" +
    "<div class='grid grid-2 section-gap'>" +
      "<section class='card'><div class='card-title-row'><div><h2>Spending trend</h2><div class='microcopy'>Last six months</div></div><span class='badge gold'>" + escapeHtml(nowKey) + "</span></div><div class='chart-wrap'><canvas id='dashboard-spend-chart'></canvas></div></section>" +
      "<section class='card'><div class='card-title-row'><div><h2>Recent activity</h2><div class='microcopy'>Your NEXUS timeline</div></div><button class='btn btn-small btn-ghost' data-view-jump='search'>Search</button></div>" +
        (activity.length ? "<div class='panel-list'>" + activity.map(activityRow).join("") + "</div>" : emptyState("Nothing here yet", "Your actions will build a searchable timeline.")) +
      "</section>" +
    "</div>" +
    "<section class='card section-gap'><div class='card-title-row'><div><h2>Spending intelligence</h2><div class='microcopy'>Calculated from your confirmed purchases</div></div><button class='btn btn-small btn-ghost' data-view-jump='money'>Open Money</button></div>" +
      "<div class='insight-grid'>" + spendingInsights().map(insightCard).join("") + "</div></section>";
}

function greetingPart() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function statCard(icon, label, value, foot) {
  return "<section class='card stat-card'><div class='card-title-row'><span class='stat-label'>" + escapeHtml(label) +
    "</span><span class='stat-icon'>" + icon + "</span></div><div><div class='stat-value'>" + escapeHtml(value) +
    "</div><div class='stat-foot'>" + escapeHtml(foot) + "</div></div></section>";
}

function activityRow(item) {
  return "<div class='list-row'><div style='display:flex;gap:10px;align-items:center;min-width:0'><span class='activity-icon'>" +
    humanIcon(item.type) + "</span><div class='list-main'><div class='list-title'>" + escapeHtml(item.label || "Activity") +
    "</div><div class='list-sub'>" + escapeHtml(item.detail || "") + "</div></div></div><span class='microcopy'>" + dateTimeText(item.createdAt) + "</span></div>";
}

function spendingInsights() {
  const tx = expenseTransactions();
  if (!tx.length) return [
    { label: "Ready", title: "Scan your first receipt", text: "NEXUS will begin calculating patterns as soon as spending data exists." },
    { label: "Privacy", title: "Receipt images stay local", text: "OCR happens on your device. NEXUS stores the extracted purchase data, not the image." },
    { label: "Connected", title: "Purchases can become assets", text: "Receipt items can later connect to your asset and library records." }
  ];
  const current = tx.filter(function (t) { return monthKey(t.date) === currentMonthKey(); });
  const total = current.reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
  const byCategory = groupSum(current, "category");
  const top = Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; })[0];
  const small = current.filter(function (t) { return Number(t.amount || 0) < 10; });
  const smallTotal = small.reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
  const d = new Date();
  const days = Math.max(1, d.getDate());
  const monthDays = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const projected = total / days * monthDays;
  return [
    {
      label: "Top category",
      title: top ? top[0] + " — " + money(top[1]) : "Not enough data",
      text: top && total ? ((top[1] / total) * 100).toFixed(0) + "% of this month's recorded spending." : "Keep adding purchases."
    },
    {
      label: "Small purchases",
      title: small.length + " purchases under $10",
      text: small.length ? "Together they total " + money(smallTotal) + " this month." : "No sub-$10 purchases recorded this month."
    },
    {
      label: "Projection",
      title: money(projected) + " projected",
      text: "If your current daily pace continues through the end of the month."
    }
  ];
}

function insightCard(item) {
  return "<article class='insight'><div class='insight-label'>" + escapeHtml(item.label) + "</div><strong>" +
    escapeHtml(item.title) + "</strong><p>" + escapeHtml(item.text) + "</p></article>";
}

function renderMoney() {
  const current = expenseTransactions().filter(function (t) { return monthKey(t.date) === currentMonthKey(); });
  const total = current.reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
  const byCategory = groupSum(current, "category");
  const topCategory = Object.entries(byCategory).sort(function (a, b) { return b[1] - a[1]; })[0];
  const byMerchant = groupSum(current, "merchant");
  const topMerchant = Object.entries(byMerchant).sort(function (a, b) { return b[1] - a[1]; })[0];
  const rows = state.data.transactions.slice(0, 100);

  return viewHeader("MONEY", "Spending", "Your purchase history and patterns—not a bank account.",
    "<button class='btn btn-primary' data-action='add-transaction'>＋ Transaction</button>") +
    "<div class='grid grid-3'>" +
      statCard("◇", "This month", money(total), current.length + " recorded transactions") +
      statCard("◫", "Top category", topCategory ? topCategory[0] : "—", topCategory ? money(topCategory[1]) : "No spending yet") +
      statCard("⌂", "Top merchant", topMerchant ? topMerchant[0] : "—", topMerchant ? money(topMerchant[1]) : "No spending yet") +
    "</div>" +
    "<div class='grid grid-2 section-gap'>" +
      "<section class='card'><div class='card-title-row'><div><h2>Monthly spending</h2><div class='microcopy'>Six-month trend</div></div></div><div class='chart-wrap'><canvas id='money-month-chart'></canvas></div></section>" +
      "<section class='card'><div class='card-title-row'><div><h2>By category</h2><div class='microcopy'>Current month</div></div></div>" +
        categoryBars(byCategory) + "</section>" +
    "</div>" +
    "<section class='card section-gap'><div class='card-title-row'><div><h2>Insights</h2><div class='microcopy'>Simple, transparent calculations</div></div></div><div class='insight-grid'>" +
      spendingInsights().map(insightCard).join("") + "</div></section>" +
    "<section class='card table-card section-gap'><div class='table-tools'><div><strong>Transactions</strong><div class='microcopy'>Newest first</div></div><input id='transaction-filter' class='toolbar-input' placeholder='Filter transactions…'></div>" +
      transactionTable(rows) + "</section>";
}

function groupSum(items, key) {
  return items.reduce(function (map, item) {
    const name = String(item[key] || "Other");
    map[name] = (map[name] || 0) + Number(item.amount || item.total || 0);
    return map;
  }, {});
}

function categorySpendingForMonth(key) {
  const totals = {};
  function add(category, amount) {
    const name = category || "Other";
    totals[name] = (totals[name] || 0) + Number(amount || 0);
  }

  state.data.transactions
    .filter(function (t) { return (t.type || "expense") === "expense" && monthKey(t.date) === key && !t.sourceReceiptId; })
    .forEach(function (t) { add(t.category, t.amount); });

  state.data.receipts
    .filter(function (r) { return monthKey(r.date) === key; })
    .forEach(function (r) {
      const items = r.items || [];
      if (items.length) {
        let itemTotal = 0;
        items.forEach(function (item) {
          const value = Number(item.price || 0);
          itemTotal += value;
          add(item.category, value);
        });
        const remainder = Number(r.total || 0) - itemTotal;
        if (remainder > 0.01) add("Other", remainder);
      } else {
        const linked = state.data.transactions.find(function (t) { return t.sourceReceiptId === r.id; });
        add(linked && linked.category || "Other", r.total);
      }
    });

  return totals;
}

function categoryBars(groups) {
  const entries = Object.entries(groups).sort(function (a, b) { return b[1] - a[1]; });
  if (!entries.length) return emptyState("No spending yet", "Add a transaction or scan a receipt to see category distribution.");
  const max = Math.max.apply(null, entries.map(function (e) { return e[1]; }));
  return entries.slice(0, 10).map(function (entry) {
    const pct = max ? entry[1] / max * 100 : 0;
    return "<div class='category-bar'><span class='category-name'>" + escapeHtml(entry[0]) + "</span><div class='category-track'><div class='category-fill' style='width:" +
      pct.toFixed(1) + "%'></div></div><span class='category-value'>" + money(entry[1]) + "</span></div>";
  }).join("");
}

function transactionTable(rows) {
  if (!rows.length) return emptyState("No transactions", "Add one manually or scan a receipt.");
  return "<div class='table-wrap'><table><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Source</th><th>Amount</th><th></th></tr></thead><tbody id='transaction-rows'>" +
    rows.map(function (t) {
      return "<tr data-search='" + escapeHtml(normalize([t.merchant, t.category, t.note].join(" "))) + "'><td>" + dateText(t.date) + "</td><td><strong>" +
        escapeHtml(t.merchant || "Purchase") + "</strong><div class='microcopy'>" + escapeHtml(t.note || "") + "</div></td><td><span class='badge'>" +
        escapeHtml(t.category || "Other") + "</span></td><td>" + (t.sourceReceiptId ? "<span class='badge gold'>Receipt</span>" : "<span class='badge'>Manual</span>") +
        "</td><td class='amount'>" + money(t.amount) + "</td><td><div class='row-actions'><button class='btn btn-small btn-ghost' data-action='edit-transaction' data-id='" +
        escapeHtml(t.id) + "'>Edit</button><button class='btn btn-small btn-danger' data-action='delete-record' data-collection='transactions' data-id='" +
        escapeHtml(t.id) + "'>Delete</button></div></td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderReceipts() {
  const rows = state.data.receipts;
  const total = rows.reduce(function (s, r) { return s + Number(r.total || 0); }, 0);
  const merchants = new Set(rows.map(function (r) { return r.merchant; }).filter(Boolean)).size;
  return viewHeader("RECEIPTS", "Receipt Inbox", "Scan a receipt, review the extraction, and turn it into structured spending data.",
    "<button class='btn btn-secondary' data-action='add-receipt-manual'>＋ Manual</button><button class='btn btn-primary' data-action='scan-receipt'>▦ Scan Receipt</button>") +
    "<div class='grid grid-3'>" +
      statCard("▤", "Receipts saved", String(rows.length), "Images are not stored") +
      statCard("◇", "Captured value", money(total), "Across all confirmed receipts") +
      statCard("⌂", "Merchants", String(merchants), "Unique stores in your receipt history") +
    "</div>" +
    "<section class='card table-card section-gap'><div class='table-tools'><div><strong>Receipt history</strong><div class='microcopy'>Structured data only</div></div><input id='receipt-filter' class='toolbar-input' placeholder='Filter receipts…'></div>" +
      receiptTable(rows) + "</section>";
}

function receiptTable(rows) {
  if (!rows.length) return emptyState("No receipts yet", "Scan your first paper receipt. OCR runs locally in this browser.");
  return "<div class='table-wrap'><table><thead><tr><th>Date</th><th>Merchant</th><th>Items</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody id='receipt-rows'>" +
    rows.map(function (r) {
      const search = normalize([r.merchant, (r.items || []).map(function (i) { return i.name; }).join(" ")].join(" "));
      return "<tr data-search='" + escapeHtml(search) + "'><td>" + dateText(r.date) + "</td><td><strong>" + escapeHtml(r.merchant || "Receipt") +
        "</strong><div class='microcopy'>" + escapeHtml(r.paymentMethod || "") + "</div></td><td>" + String((r.items || []).length) + "</td><td><span class='badge green'>" +
        escapeHtml(r.status || "confirmed") + "</span></td><td class='amount'>" + money(r.total) + "</td><td><div class='row-actions'><button class='btn btn-small btn-ghost' data-action='view-receipt' data-id='" +
        escapeHtml(r.id) + "'>View</button><button class='btn btn-small btn-danger' data-action='delete-receipt' data-id='" + escapeHtml(r.id) + "'>Delete</button></div></td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderAssets() {
  const assets = state.data.assets;
  const totalValue = assets.reduce(function (s, a) { return s + Number(a.purchasePrice || 0); }, 0);
  const expiring = assets.filter(function (a) {
    if (!a.warrantyExpiration) return false;
    const diff = new Date(a.warrantyExpiration + "T12:00:00") - new Date();
    return diff >= 0 && diff <= 1000 * 60 * 60 * 24 * 60;
  }).length;
  return viewHeader("ASSETS", "Physical Registry", "Keep the important things you own connected to receipts, locations, warranties, and QR tags.",
    "<button class='btn btn-primary' data-action='add-asset'>＋ Register Asset</button>") +
    "<div class='grid grid-3'>" +
      statCard("▣", "Assets", String(assets.length), countTagged("asset") + " tagged") +
      statCard("◇", "Recorded purchase value", money(totalValue), "Based on entered purchase prices") +
      statCard("◷", "Warranty attention", String(expiring), expiring ? "Expire within 60 days" : "Nothing expiring soon") +
    "</div>" +
    "<section class='section-gap'><div class='card-title-row'><div><h2>Registered items</h2><div class='microcopy'>Your physical inventory</div></div><input id='asset-filter' class='toolbar-input' placeholder='Filter assets…'></div>" +
      (assets.length ? "<div id='asset-grid' class='asset-grid'>" + assets.map(assetCard).join("") + "</div>" : "<div class='card'>" + emptyState("No assets registered", "Add something important enough to locate, document, or tag.") + "</div>") +
    "</section>";
}

function assetCard(a) {
  const loc = locationName(a.locationId);
  const tag = tagFor("asset", a.id);
  return "<article class='entity-card' data-search='" + escapeHtml(normalize([a.name, a.category, a.serialNumber, loc].join(" "))) + "'><div class='entity-top'><span class='entity-icon'>▣</span>" +
    (tag ? "<span class='badge gold'>" + escapeHtml(tag.labelCode || tag.id) + "</span>" : "<span class='badge'>Untagged</span>") + "</div><div class='entity-title'>" +
    escapeHtml(a.name || "Unnamed asset") + "</div><div class='entity-sub'>" + escapeHtml(a.category || "Other") + (a.serialNumber ? " · " + escapeHtml(a.serialNumber) : "") +
    "</div><div class='entity-meta'><span>Location<strong>" + escapeHtml(loc || "Not assigned") + "</strong></span><span>Purchase<strong>" +
    (a.purchasePrice ? money(a.purchasePrice) : "—") + "</strong></span></div><div class='row-actions' style='margin-top:12px;justify-content:flex-start'><button class='btn btn-small btn-ghost' data-action='edit-asset' data-id='" +
    escapeHtml(a.id) + "'>Edit</button>" + (!tag ? "<button class='btn btn-small btn-secondary' data-action='tag-entity' data-type='asset' data-id='" +
    escapeHtml(a.id) + "'>Create QR</button>" : "<button class='btn btn-small btn-secondary' data-action='print-one-tag' data-code='" + escapeHtml(tag.id) + "'>Print QR</button>") +
    "<button class='btn btn-small btn-danger' data-action='delete-record' data-collection='assets' data-id='" + escapeHtml(a.id) + "'>Delete</button></div></article>";
}

function renderQr() {
  const tags = state.data.qrTags;
  const unassigned = tags.filter(function (t) { return t.status === "unassigned" || t.targetType === "unassigned"; });
  const assigned = tags.filter(function (t) { return t.status === "assigned"; }).length;
  return viewHeader("QR REGISTRY", "Physical Tags", "Print on normal letter paper, cut on the guides, tape the tag on, and scan it later.",
    "<button class='btn btn-secondary' data-action='print-unassigned'>▤ Print Unassigned</button><button class='btn btn-primary' data-action='generate-tags'>＋ Generate Blank Tags</button>") +
    "<div class='grid grid-3'>" +
      statCard("⌁", "QR tags", String(tags.length), "All generated tags") +
      statCard("✓", "Assigned", String(assigned), "Connected to a NEXUS record") +
      statCard("○", "Ready to use", String(unassigned.length), "Pre-printed tags you can assign later") +
    "</div>" +
    "<section class='card section-gap'><div class='card-title-row'><div><h2>How paper tags work</h2><div class='microcopy'>No sticker printer required</div></div></div><div class='inline-note'>Generate a batch → print on ordinary 8.5×11 paper → cut along the dashed guides → tape labels onto items. Blank tags can be printed ahead of time and assigned only when you actually use one.</div></section>" +
    "<section class='section-gap'><div class='card-title-row'><div><h2>Registry</h2><div class='microcopy'>Newest tags first</div></div><input id='qr-filter' class='toolbar-input' placeholder='Filter tags…'></div>" +
      (tags.length ? "<div id='qr-grid' class='asset-grid'>" + tags.slice(0, 60).map(qrCard).join("") + "</div>" : "<div class='card'>" + emptyState("No QR tags yet", "Generate a sheet of blank labels to start.") + "</div>") +
    "</section>";
}

function qrCard(tag) {
  const target = targetLabel(tag);
  return "<article class='entity-card qr-card' data-search='" + escapeHtml(normalize([tag.labelCode, target, tag.targetType, tag.status].join(" "))) + "'><div class='entity-top'><span class='badge " +
    ((tag.status === "retired") ? "red" : (tag.status === "unassigned" || tag.targetType === "unassigned") ? "amber" : "green") + "'>" + escapeHtml((tag.status || "assigned").toUpperCase()) + "</span><span class='microcopy'>" +
    escapeHtml(tag.size || "standard") + "</span></div><div class='qr-box' id='qr-" + escapeHtml(tag.id.replace(/[^a-zA-Z0-9_-]/g, "")) + "'></div><div class='qr-label-code'>" +
    escapeHtml(tag.labelCode || tag.id) + "</div><div class='entity-sub' style='margin-top:5px'>" + escapeHtml(target) + "</div><div class='row-actions' style='justify-content:center;margin-top:12px'>" +
    ((tag.status === "unassigned" || tag.targetType === "unassigned") ? "<button class='btn btn-small btn-primary' data-action='assign-tag' data-code='" + escapeHtml(tag.id) + "'>Assign</button>" : "") +
    "<button class='btn btn-small btn-secondary' data-action='print-one-tag' data-code='" + escapeHtml(tag.id) + "'>Print</button></div></article>";
}

function renderLibrary() {
  const books = state.data.books;
  const reading = books.filter(function (b) { return b.readingStatus === "Reading"; }).length;
  const loaned = state.data.loans.filter(function (l) { return l.status === "active"; }).length;
  const value = books.reduce(function (s, b) { return s + Number(b.purchasePrice || 0); }, 0);
  return viewHeader("LIBRARY", "Personal Library", "Catalog, locate, read, and lend the books you actually own.",
    "<button class='btn btn-secondary' data-action='scan-book'>▦ Scan ISBN</button><button class='btn btn-primary' data-action='add-book'>＋ Add Book</button>") +
    "<div class='grid grid-4'>" +
      statCard("▥", "Books", String(books.length), "Cataloged volumes") +
      statCard("◉", "Currently reading", String(reading), "Active reading") +
      statCard("↗", "Loaned out", String(loaned), "Current loans") +
      statCard("◇", "Recorded purchase value", money(value), "Where price is known") +
    "</div>" +
    "<section class='card table-card section-gap'><div class='table-tools'><div><strong>Catalog</strong><div class='microcopy'>Search by title, author, ISBN, or shelf</div></div><input id='book-filter' class='toolbar-input' placeholder='Filter books…'></div>" +
      libraryTable(books) + "</section>";
}

function libraryTable(books) {
  if (!books.length) return emptyState("Your shelves are waiting", "Add a book manually or scan its ISBN.");
  return "<div class='table-wrap'><table><thead><tr><th>Book</th><th>ISBN</th><th>Location</th><th>Status</th><th>QR</th><th></th></tr></thead><tbody id='book-rows'>" +
    books.map(function (b) {
      const loc = locationName(b.locationId);
      const tag = tagFor("book", b.id);
      const activeLoan = state.data.loans.find(function (l) { return l.bookId === b.id && l.status === "active"; });
      const search = normalize([b.title, b.author, b.isbn, loc, b.publisher].join(" "));
      return "<tr data-search='" + escapeHtml(search) + "'><td><strong>" + escapeHtml(b.title || "Untitled") + "</strong><div class='microcopy'>" +
        escapeHtml(b.author || "Unknown author") + "</div></td><td>" + escapeHtml(b.isbn || "—") + "</td><td>" + escapeHtml(loc || "—") +
        "</td><td>" + (activeLoan ? "<span class='badge amber'>Loaned to " + escapeHtml(activeLoan.borrowerName || "Borrower") + "</span>" : "<span class='badge'>" +
        escapeHtml(b.readingStatus || "Unread") + "</span>") + "</td><td>" + (tag ? "<span class='badge gold'>" + escapeHtml(tag.labelCode || tag.id) + "</span>" : "—") +
        "</td><td><div class='row-actions'><button class='btn btn-small btn-ghost' data-action='edit-book' data-id='" + escapeHtml(b.id) + "'>Edit</button>" +
        (activeLoan ? "<button class='btn btn-small btn-secondary' data-action='return-book' data-loan='" + escapeHtml(activeLoan.id) + "' data-book='" + escapeHtml(b.id) + "'>Return</button>" :
        "<button class='btn btn-small btn-secondary' data-action='loan-book' data-id='" + escapeHtml(b.id) + "'>Loan</button>") +
        (!tag ? "<button class='btn btn-small btn-secondary' data-action='tag-entity' data-type='book' data-id='" + escapeHtml(b.id) + "'>QR</button>" : "") +
        "</div></td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderLocations() {
  const locations = state.data.locations;
  return viewHeader("LOCATIONS", "Physical Map", "Give shelves, drawers, rooms, boxes, and bags a place in NEXUS.",
    "<button class='btn btn-primary' data-action='add-location'>＋ Add Location</button>") +
    "<div class='grid grid-3'>" +
      statCard("⌖", "Locations", String(locations.length), "Defined places") +
      statCard("▣", "Placed assets", String(state.data.assets.filter(function (a) { return a.locationId; }).length), "Assets with a location") +
      statCard("▥", "Shelved books", String(state.data.books.filter(function (b) { return b.locationId; }).length), "Books with a location") +
    "</div>" +
    "<section class='section-gap'><div class='card-title-row'><div><h2>Your map</h2><div class='microcopy'>Locations can be nested inside other locations</div></div><input id='location-filter' class='toolbar-input' placeholder='Filter locations…'></div>" +
      (locations.length ? "<div id='location-grid' class='location-grid'>" + locations.map(locationCard).join("") + "</div>" : "<div class='card'>" +
      emptyState("No locations yet", "Start with a room, then add bookcases, shelves, drawers, or containers inside it.") + "</div>") + "</section>";
}

function locationCard(loc) {
  const tag = tagFor("location", loc.id);
  const countAssets = state.data.assets.filter(function (a) { return a.locationId === loc.id; }).length;
  const countBooks = state.data.books.filter(function (b) { return b.locationId === loc.id; }).length;
  return "<article class='entity-card' data-search='" + escapeHtml(normalize([loc.name, loc.type, locationName(loc.parentId)].join(" "))) + "'><div class='entity-top'><span class='entity-icon'>⌖</span><span class='badge'>" +
    escapeHtml(loc.type || "Location") + "</span></div><div class='entity-title'>" + escapeHtml(loc.name || "Location") + "</div><div class='entity-sub'>" +
    escapeHtml(loc.parentId ? "Inside " + locationName(loc.parentId) : "Top-level location") + "</div><div class='entity-meta'><span>Assets<strong>" + countAssets +
    "</strong></span><span>Books<strong>" + countBooks + "</strong></span></div><div class='row-actions' style='justify-content:flex-start;margin-top:12px'><button class='btn btn-small btn-ghost' data-action='edit-location' data-id='" +
    escapeHtml(loc.id) + "'>Edit</button>" + (!tag ? "<button class='btn btn-small btn-secondary' data-action='tag-entity' data-type='location' data-id='" + escapeHtml(loc.id) +
    "'>Create QR</button>" : "<button class='btn btn-small btn-secondary' data-action='print-one-tag' data-code='" + escapeHtml(tag.id) + "'>Print QR</button>") +
    "<button class='btn btn-small btn-danger' data-action='delete-record' data-collection='locations' data-id='" + escapeHtml(loc.id) + "'>Delete</button></div></article>";
}

function renderSearch() {
  const term = state.searchTerm || $("#global-search") && $("#global-search").value || "";
  const results = searchEverything(term);
  return viewHeader("SEARCH", term ? "Results for “" + term + "”" : "Search NEXUS", "One search across your spending, receipts, possessions, books, locations, and QR registry.", "") +
    (term ? renderSearchResults(results) : "<section class='card'>" + emptyState("Search anything", "Try a merchant, book title, ISBN, serial number, asset, shelf, category, or QR code.") + "</section>");
}

function searchEverything(term) {
  const needle = normalize(term);
  if (!needle) return {};
  const groups = {};
  function match(text) { return normalize(text).includes(needle); }
  groups.Transactions = state.data.transactions.filter(function (t) { return match([t.merchant, t.category, t.note, t.amount].join(" ")); }).slice(0, 20);
  groups.Receipts = state.data.receipts.filter(function (r) { return match([r.merchant, r.total, (r.items || []).map(function (i) { return i.name; }).join(" ")].join(" ")); }).slice(0, 20);
  groups.Assets = state.data.assets.filter(function (a) { return match([a.name, a.category, a.serialNumber, locationName(a.locationId)].join(" ")); }).slice(0, 20);
  groups.Books = state.data.books.filter(function (b) { return match([b.title, b.author, b.isbn, b.publisher, locationName(b.locationId)].join(" ")); }).slice(0, 20);
  groups.Locations = state.data.locations.filter(function (l) { return match([l.name, l.type, locationName(l.parentId)].join(" ")); }).slice(0, 20);
  groups["QR Tags"] = state.data.qrTags.filter(function (q) { return match([q.labelCode, q.targetType, targetLabel(q)].join(" ")); }).slice(0, 20);
  return groups;
}

function renderSearchResults(groups) {
  const nonEmpty = Object.entries(groups).filter(function (entry) { return entry[1].length; });
  if (!nonEmpty.length) return "<section class='card'>" + emptyState("No matches", "NEXUS could not find anything matching that search.") + "</section>";
  return "<div class='search-results'>" + nonEmpty.map(function (entry) {
    return "<section><div class='search-group-title'><span>" + escapeHtml(entry[0]) + "</span><span>" + entry[1].length + "</span></div>" +
      entry[1].map(function (item) { return searchResult(entry[0], item); }).join("") + "</section>";
  }).join("") + "</div>";
}

function searchResult(group, item) {
  let title = "", sub = "", view = "search";
  if (group === "Transactions") { title = (item.merchant || "Transaction") + " · " + money(item.amount); sub = (item.category || "Other") + " · " + dateText(item.date); view = "money"; }
  if (group === "Receipts") { title = (item.merchant || "Receipt") + " · " + money(item.total); sub = dateText(item.date) + " · " + (item.items || []).length + " items"; view = "receipts"; }
  if (group === "Assets") { title = item.name || "Asset"; sub = (item.category || "Other") + " · " + (locationName(item.locationId) || "No location"); view = "assets"; }
  if (group === "Books") { title = item.title || "Book"; sub = (item.author || "Unknown author") + (item.isbn ? " · " + item.isbn : ""); view = "library"; }
  if (group === "Locations") { title = item.name || "Location"; sub = item.type || "Location"; view = "locations"; }
  if (group === "QR Tags") { title = item.labelCode || item.id; sub = targetLabel(item); view = "qr"; }
  return "<div class='result' data-view-jump='" + view + "'><div class='result-title'>" + escapeHtml(title) + "</div><div class='result-sub'>" + escapeHtml(sub) + "</div></div>";
}

function renderSettings() {
  const counts = COLLECTIONS.reduce(function (obj, key) { obj[key] = state.data[key].length; return obj; }, {});
  return viewHeader("SETTINGS", "NEXUS Settings", "This installation is intentionally private and single-owner.", "") +
    "<div class='grid grid-2'><section class='card'><div class='card-title-row'><div><h2>Owner identity</h2><div class='microcopy'>Automatically verified by Firebase Authentication</div></div><span class='badge green'>VERIFIED</span></div>" +
      "<div class='list-row'><div><div class='list-title'>Authorized Google account</div><div class='list-sub'>" + escapeHtml(OWNER_EMAIL) + "</div></div></div>" +
      "<div class='list-row'><div><div class='list-title'>Signed in as</div><div class='list-sub'>" + escapeHtml(state.user.email || "") + "</div></div></div>" +
      "<div class='inline-note' style='margin-top:12px'>There is no NEXUS signup or owner setup screen. The authorized email is enforced by both the app and Firestore security rules.</div>" +
      "<div style='margin-top:14px'><button class='btn btn-danger' data-action='sign-out'>Sign out</button></div></section>" +
    "<section class='card'><div class='card-title-row'><div><h2>Data</h2><div class='microcopy'>Firebase project: nexus-5fd52</div></div></div>" +
      "<div class='panel-list'><div class='list-row'><span>Transactions</span><strong>" + counts.transactions + "</strong></div><div class='list-row'><span>Receipts</span><strong>" +
      counts.receipts + "</strong></div><div class='list-row'><span>Assets</span><strong>" + counts.assets + "</strong></div><div class='list-row'><span>Books</span><strong>" +
      counts.books + "</strong></div><div class='list-row'><span>QR tags</span><strong>" + counts.qrTags + "</strong></div></div><div style='margin-top:14px'><button class='btn btn-secondary' data-action='export-json'>Export NEXUS JSON</button></div></section></div>" +
    "<section class='card section-gap'><div class='card-title-row'><div><h2>Phase 1 architecture</h2><div class='microcopy'>Deliberately limited Firebase footprint</div></div></div>" +
      "<div class='grid grid-3'><div class='insight'><div class='insight-label'>Firebase Auth</div><strong>Google sign-in</strong><p>Authenticates your one authorized owner account.</p></div>" +
      "<div class='insight'><div class='insight-label'>Cloud Firestore</div><strong>Structured records</strong><p>Stores extracted receipt data, spending, assets, tags, books, locations, and history.</p></div>" +
      "<div class='insight'><div class='insight-label'>No Storage</div><strong>Local receipt OCR</strong><p>Receipt photos are processed locally and discarded after extraction.</p></div></div></section>";
}

function countTagged(type) {
  return state.data.qrTags.filter(function (t) { return t.targetType === type && t.status !== "unassigned"; }).length;
}

function locationName(id) {
  if (!id) return "";
  const loc = state.data.locations.find(function (x) { return x.id === id; });
  if (!loc) return "";
  if (loc.parentId && loc.parentId !== id) {
    const parent = state.data.locations.find(function (x) { return x.id === loc.parentId; });
    if (parent) return parent.name + " → " + loc.name;
  }
  return loc.name || "";
}

function tagFor(type, id) {
  return state.data.qrTags.find(function (t) { return t.targetType === type && t.targetId === id && t.status !== "retired"; });
}

function targetLabel(tag) {
  if (!tag) return "";
  if (tag.targetType === "unassigned" || !tag.targetId) return "Unassigned — ready to use";
  if (tag.targetLabel) return tag.targetLabel;
  if (tag.targetType === "asset") {
    const a = state.data.assets.find(function (x) { return x.id === tag.targetId; });
    return a ? a.name : "Asset";
  }
  if (tag.targetType === "book") {
    const b = state.data.books.find(function (x) { return x.id === tag.targetId; });
    return b ? b.title : "Book";
  }
  if (tag.targetType === "location") {
    const l = state.data.locations.find(function (x) { return x.id === tag.targetId; });
    return l ? l.name : "Location";
  }
  return "Registered item";
}

function afterRender() {
  if (state.view === "dashboard") drawMonthlyChart("dashboard-spend-chart");
  if (state.view === "money") drawMonthlyChart("money-month-chart");
  if (state.view === "qr") renderQrCards();
}

function drawMonthlyChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas || !window.Chart) return;
  const labels = [];
  const values = [];
  const d = new Date();
  for (let i = 5; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = monthKey(x);
    labels.push(x.toLocaleDateString([], { month: "short" }));
    values.push(spendForMonth(key));
  }
  const chart = new window.Chart(canvas, {
    type: "line",
    data: { labels: labels, datasets: [{ data: values, borderColor: "#c8a96b", backgroundColor: "rgba(200,169,107,.09)", fill: true, tension: .34, borderWidth: 2, pointRadius: 3, pointBackgroundColor: "#dec48e" }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (ctx) { return money(ctx.raw); } } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#7e8792" } },
        y: { beginAtZero: true, grid: { color: "rgba(255,255,255,.045)" }, ticks: { color: "#7e8792", callback: function (v) { return "$" + v; } } }
      }
    }
  });
  state.charts.push(chart);
}

function renderQrCards() {
  state.data.qrTags.slice(0, 60).forEach(function (tag) {
    const safeId = "qr-" + tag.id.replace(/[^a-zA-Z0-9_-]/g, "");
    const el = document.getElementById(safeId);
    if (!el || el.childNodes.length || !window.QRCode) return;
    new window.QRCode(el, { text: qrUrl(tag), width: 112, height: 112, colorDark: "#0a0a0a", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
  });
}

function appBaseUrl() {
  return new URL("./", window.location.href).href.split("#")[0].split("?")[0];
}

function qrUrl(tag) {
  return appBaseUrl() + "?tag=" + encodeURIComponent(tag.publicSlug || tag.id);
}

function bindViewActions() {
  $$("[data-view-jump]").forEach(function (el) { el.addEventListener("click", function () { setActiveView(el.dataset.viewJump); }); });
  $$("[data-action]").forEach(function (el) {
    el.addEventListener("click", function () { handleAction(el.dataset.action, el); });
  });
  bindFilter("#transaction-filter", "#transaction-rows tr");
  bindFilter("#receipt-filter", "#receipt-rows tr");
  bindFilter("#asset-filter", "#asset-grid > *");
  bindFilter("#book-filter", "#book-rows tr");
  bindFilter("#qr-filter", "#qr-grid > *");
  bindFilter("#location-filter", "#location-grid > *");
}

function bindFilter(inputSelector, itemSelector) {
  const input = $(inputSelector);
  if (!input) return;
  input.addEventListener("input", function () {
    const n = normalize(input.value);
    $$(itemSelector).forEach(function (row) { row.style.display = !n || String(row.dataset.search || "").includes(n) ? "" : "none"; });
  });
}

async function handleAction(action, el) {
  try {
    if (action === "quick-add") return openQuickAdd();
    if (action === "scan") return openScanner();
    if (action === "add-transaction") return openTransactionForm();
    if (action === "edit-transaction") return openTransactionForm(state.data.transactions.find(function (x) { return x.id === el.dataset.id; }));
    if (action === "scan-receipt") return openReceiptScanner();
    if (action === "add-receipt-manual") return openReceiptReview({ merchant: "", date: todayISO(), subtotal: 0, tax: 0, total: 0, items: [], rawText: "" });
    if (action === "view-receipt") return openReceiptDetail(state.data.receipts.find(function (x) { return x.id === el.dataset.id; }));
    if (action === "delete-receipt") return deleteReceipt(el.dataset.id);
    if (action === "add-asset") return openAssetForm();
    if (action === "edit-asset") return openAssetForm(state.data.assets.find(function (x) { return x.id === el.dataset.id; }));
    if (action === "generate-tags") return openGenerateTags();
    if (action === "print-unassigned") return printTags(state.data.qrTags.filter(function (x) { return x.status === "unassigned" || x.targetType === "unassigned"; }));
    if (action === "assign-tag") return openAssignTag(el.dataset.code);
    if (action === "print-one-tag") return printTags(state.data.qrTags.filter(function (x) { return x.id === el.dataset.code; }));
    if (action === "tag-entity") return createTagAndRefresh(el.dataset.type, el.dataset.id);
    if (action === "add-book") return openBookForm();
    if (action === "scan-book") return openScanner("book");
    if (action === "edit-book") return openBookForm(state.data.books.find(function (x) { return x.id === el.dataset.id; }));
    if (action === "loan-book") return openLoanBook(el.dataset.id);
    if (action === "return-book") return returnBook(el.dataset.loan, el.dataset.book);
    if (action === "add-location") return openLocationForm();
    if (action === "edit-location") return openLocationForm(state.data.locations.find(function (x) { return x.id === el.dataset.id; }));
    if (action === "delete-record") return deleteRecord(el.dataset.collection, el.dataset.id);
    if (action === "sign-out") return signOut(auth);
    if (action === "export-json") return exportJson();
  } catch (error) {
    console.error(error);
    toast("NEXUS error", friendlyError(error), "error");
  }
}

function openModal(title, body, options) {
  options = options || {};
  const modal = $("#modal");
  modal.className = "modal" + (options.wide ? " wide" : "");
  modal.innerHTML =
    "<header class='modal-header'><h2 id='modal-title'>" + escapeHtml(title) + "</h2><button class='close-btn' data-close-modal aria-label='Close'>×</button></header>" +
    "<div class='modal-body'>" + body + "</div>" +
    (options.footer === false ? "" : "<footer class='modal-footer'>" + (options.footer || "<button class='btn btn-secondary' data-close-modal>Cancel</button>") + "</footer>");
  $("#modal-backdrop").classList.remove("hidden");
  $$("[data-close-modal]", modal).forEach(function (btn) { btn.addEventListener("click", closeModal); });
  $("#modal-backdrop").onclick = function (e) { if (e.target === $("#modal-backdrop")) closeModal(); };
  return modal;
}

function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
  $("#modal").innerHTML = "";
}

function formValue(form, name) {
  const el = form.elements[name];
  return el ? el.value.trim() : "";
}

function categoryOptions(selected) {
  return CATEGORIES.map(function (c) { return "<option " + (c === selected ? "selected" : "") + ">" + escapeHtml(c) + "</option>"; }).join("");
}

function locationOptions(selected, excludeId) {
  return "<option value=''>Not assigned</option>" + state.data.locations.filter(function (l) { return l.id !== excludeId; }).map(function (l) {
    return "<option value='" + escapeHtml(l.id) + "' " + (l.id === selected ? "selected" : "") + ">" + escapeHtml(locationName(l.id) || l.name) + "</option>";
  }).join("");
}

function openQuickAdd() {
  const body = "<div class='grid grid-2'>" +
    quickTile("scan-receipt", "▤", "Scan receipt", "Extract a purchase from paper") +
    quickTile("add-transaction", "◇", "Transaction", "Record spending manually") +
    quickTile("add-asset", "▣", "Asset", "Register something you own") +
    quickTile("add-book", "▥", "Book", "Catalog a book") +
    quickTile("add-location", "⌖", "Location", "Add a shelf, drawer, room, or box") +
    quickTile("generate-tags", "⌁", "Blank QR tags", "Generate a printable batch") +
    "</div>";
  const modal = openModal("Quick Add", body, { footer: false });
  $$("[data-quick]", modal).forEach(function (btn) { btn.addEventListener("click", function () { closeModal(); handleAction(btn.dataset.quick, btn); }); });
}

function quickTile(action, icon, title, text) {
  return "<button class='entity-card' style='text-align:left;color:inherit' data-quick='" + action + "'><span class='entity-icon'>" + icon + "</span><div class='entity-title'>" +
    escapeHtml(title) + "</div><div class='entity-sub'>" + escapeHtml(text) + "</div></button>";
}

function openTransactionForm(existing) {
  existing = existing || {};
  const body = "<form id='transaction-form' class='form-grid'>" +
    "<div class='field'><label>Date</label><input name='date' type='date' required value='" + escapeHtml(existing.date || todayISO()) + "'></div>" +
    "<div class='field'><label>Type</label><select name='type'><option value='expense' " + ((existing.type || "expense") === "expense" ? "selected" : "") + ">Expense</option><option value='income' " + (existing.type === "income" ? "selected" : "") + ">Income</option></select></div>" +
    "<div class='field full'><label>Merchant / source</label><input name='merchant' required maxlength='120' value='" + escapeHtml(existing.merchant || "") + "' placeholder='Walmart'></div>" +
    "<div class='field'><label>Amount</label><input name='amount' type='number' min='0' step='0.01' required value='" + escapeHtml(existing.amount || "") + "' placeholder='0.00'></div>" +
    "<div class='field'><label>Category</label><select name='category'>" + categoryOptions(existing.category || "Other") + "</select></div>" +
    "<div class='field full'><label>Note</label><textarea name='note' maxlength='500' placeholder='Optional context'>" + escapeHtml(existing.note || "") + "</textarea></div></form>";
  const modal = openModal(existing.id ? "Edit Transaction" : "Add Transaction", body, {
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-transaction'>Save Transaction</button>"
  });
  $("#save-transaction", modal).addEventListener("click", async function () {
    const form = $("#transaction-form", modal);
    if (!form.reportValidity()) return;
    const data = {
      date: formValue(form, "date"),
      type: formValue(form, "type"),
      merchant: formValue(form, "merchant"),
      amount: Number(formValue(form, "amount")),
      category: formValue(form, "category"),
      note: formValue(form, "note"),
      updatedAt: serverTimestamp()
    };
    if (existing.id) await updateDoc(doc(db, "transactions", existing.id), data);
    else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "transactions"), data);
      await writeActivity("money", "Transaction added", "transaction", ref.id, data.merchant + " · " + money(data.amount));
    }
    closeModal();
    await refresh(["transactions", "activity"]);
    toast("Saved", "Transaction recorded.", "success");
  });
}

function openReceiptScanner() {
  const body = "<div class='inline-note'>Receipt OCR runs entirely in your browser. The image is used for extraction and is not uploaded to Firebase or saved by NEXUS.</div>" +
    "<label class='ocr-drop' for='receipt-file'><div><div style='font-size:28px;margin-bottom:8px'>▦</div><strong>Take a photo or choose a receipt image</strong><div class='microcopy' style='margin-top:5px'>JPG, PNG, or a camera capture</div></div></label>" +
    "<input id='receipt-file' type='file' accept='image/*' capture='environment' hidden>" +
    "<div id='ocr-status' class='microcopy' style='margin-top:14px'>Waiting for a receipt…</div><div class='ocr-progress'><span id='ocr-progress-bar'></span></div>";
  const modal = openModal("Scan Receipt", body, { footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button>" });
  $("#receipt-file", modal).addEventListener("change", async function (event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!window.Tesseract) {
      toast("OCR unavailable", "The OCR library did not load. Try manual receipt entry.", "error");
      return;
    }
    const status = $("#ocr-status", modal);
    const bar = $("#ocr-progress-bar", modal);
    status.textContent = "Reading receipt…";
    try {
      const result = await window.Tesseract.recognize(file, "eng", {
        logger: function (m) {
          if (typeof m.progress === "number") bar.style.width = Math.round(m.progress * 100) + "%";
          if (m.status) status.textContent = m.status.replaceAll("_", " ") + (typeof m.progress === "number" ? " · " + Math.round(m.progress * 100) + "%" : "");
        }
      });
      const parsed = parseReceiptText(result.data.text || "");
      closeModal();
      openReceiptReview(parsed);
    } catch (error) {
      console.error(error);
      status.textContent = "Could not read this image.";
      toast("Receipt scan failed", "Try a flatter, brighter photo or enter the receipt manually.", "error");
    }
  });
}

function parseReceiptText(rawText) {
  const lines = String(rawText || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
  const merchant = (lines.find(function (x) { return x.length > 2 && x.length < 60 && !/^\d/.test(x); }) || "").slice(0, 120);
  let date = todayISO();
  const dateLine = lines.join(" ").match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (dateLine) {
    let year = Number(dateLine[3]);
    if (year < 100) year += 2000;
    const candidate = new Date(year, Number(dateLine[1]) - 1, Number(dateLine[2]));
    if (!Number.isNaN(candidate.getTime())) {
      date = candidate.getFullYear() + "-" + String(candidate.getMonth() + 1).padStart(2, "0") + "-" + String(candidate.getDate()).padStart(2, "0");
    }
  }
  function amountFrom(keyword) {
    const line = lines.slice().reverse().find(function (x) { return new RegExp(keyword, "i").test(x) && /\d+[.,]\d{2}/.test(x); });
    if (!line) return 0;
    const nums = line.match(/\d+[.,]\d{2}/g);
    return nums && nums.length ? Number(nums[nums.length - 1].replace(",", ".")) : 0;
  }
  const subtotal = amountFrom("subtotal|sub total");
  const tax = amountFrom("\\btax\\b");
  let total = amountFrom("total|amount due|balance");
  const items = [];
  lines.forEach(function (line) {
    if (/subtotal|total|tax|change|cash|visa|mastercard|debit|credit|balance/i.test(line)) return;
    const match = line.match(/^(.{2,}?)\s+\$?(\d+[.,]\d{2})\s*$/);
    if (!match) return;
    const name = match[1].replace(/\s{2,}/g, " ").trim();
    if (!name || /^\d+$/.test(name)) return;
    items.push({ name: name.slice(0, 140), price: Number(match[2].replace(",", ".")), category: guessCategory(name) });
  });
  if (!total && items.length) total = items.reduce(function (s, i) { return s + i.price; }, 0) + tax;
  return { merchant: merchant, date: date, subtotal: subtotal, tax: tax, total: total, items: items.slice(0, 80), rawText: rawText };
}

function guessCategory(name) {
  const n = normalize(name);
  if (/book|bible|novel|paperback|hardcover/.test(n)) return "Books";
  if (/cable|charger|usb|headphone|mouse|keyboard|monitor|phone|electronic/.test(n)) return "Electronics";
  if (/shampoo|soap|tooth|deodorant|lotion|razor/.test(n)) return "Personal Care";
  if (/shirt|pants|sock|shoe|jacket|clothing/.test(n)) return "Other";
  if (/chicken|beef|milk|cheese|bread|pasta|rice|water|soda|juice|egg|food|snack/.test(n)) return "Groceries";
  return "Other";
}

function receiptItemRow(item, index) {
  return "<div class='receipt-item' data-item-index='" + index + "'><div class='field'><label>Item</label><input class='ri-name' value='" + escapeHtml(item.name || "") +
    "'></div><div class='field'><label>Category</label><select class='ri-category'>" + categoryOptions(item.category || "Other") + "</select></div><div class='field'><label>Price</label><input class='ri-price' type='number' step='0.01' min='0' value='" +
    escapeHtml(item.price || "") + "'></div><button class='icon-btn remove-item' type='button' title='Remove'>×</button></div>";
}

function openReceiptReview(parsed) {
  parsed = parsed || { items: [] };
  const body = "<form id='receipt-form' class='form-grid'>" +
    "<div class='field'><label>Date</label><input name='date' type='date' value='" + escapeHtml(parsed.date || todayISO()) + "' required></div>" +
    "<div class='field'><label>Merchant</label><input name='merchant' value='" + escapeHtml(parsed.merchant || "") + "' required></div>" +
    "<div class='field'><label>Subtotal</label><input name='subtotal' type='number' step='0.01' min='0' value='" + escapeHtml(parsed.subtotal || "") + "'></div>" +
    "<div class='field'><label>Tax</label><input name='tax' type='number' step='0.01' min='0' value='" + escapeHtml(parsed.tax || "") + "'></div>" +
    "<div class='field'><label>Total</label><input name='total' type='number' step='0.01' min='0' value='" + escapeHtml(parsed.total || "") + "' required></div>" +
    "<div class='field'><label>Payment note</label><input name='paymentMethod' placeholder='Visa •••• 1234'></div>" +
    "<div class='field full'><div style='display:flex;justify-content:space-between;align-items:center'><label>Line items</label><button class='btn btn-small btn-secondary' type='button' id='add-receipt-item'>＋ Item</button></div><div id='receipt-items' class='receipt-items'>" +
      (parsed.items || []).map(receiptItemRow).join("") + "</div></div>" +
    "<div class='field full'><label>Note</label><textarea name='note' placeholder='Optional'></textarea></div></form>" +
    "<div class='inline-note' style='margin-top:14px'>Review OCR carefully. NEXUS creates one spending transaction from the receipt total while keeping individual items available for item-level analysis.</div>";
  const modal = openModal("Review Receipt", body, {
    wide: true,
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-receipt'>Confirm Receipt</button>"
  });
  function bindRemovers() {
    $$(".remove-item", modal).forEach(function (btn) { btn.onclick = function () { btn.closest(".receipt-item").remove(); }; });
  }
  bindRemovers();
  $("#add-receipt-item", modal).addEventListener("click", function () {
    $("#receipt-items", modal).insertAdjacentHTML("beforeend", receiptItemRow({ name: "", price: "", category: "Other" }, Date.now()));
    bindRemovers();
  });
  $("#save-receipt", modal).addEventListener("click", async function () {
    const form = $("#receipt-form", modal);
    if (!form.reportValidity()) return;
    const items = $$(".receipt-item", modal).map(function (row) {
      return {
        name: $(".ri-name", row).value.trim(),
        category: $(".ri-category", row).value,
        price: Number($(".ri-price", row).value || 0)
      };
    }).filter(function (i) { return i.name; });
    const receipt = {
      merchant: formValue(form, "merchant"),
      date: formValue(form, "date"),
      subtotal: Number(formValue(form, "subtotal") || 0),
      tax: Number(formValue(form, "tax") || 0),
      total: Number(formValue(form, "total") || 0),
      paymentMethod: formValue(form, "paymentMethod"),
      note: formValue(form, "note"),
      items: items,
      rawText: String(parsed.rawText || "").slice(0, 30000),
      imageStored: false,
      status: "confirmed",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    const receiptRef = await addDoc(collection(db, "receipts"), receipt);
    if (receipt.total > 0) {
      await addDoc(collection(db, "transactions"), {
        merchant: receipt.merchant,
        date: receipt.date,
        amount: receipt.total,
        category: dominantReceiptCategory(items),
        type: "expense",
        note: receipt.note,
        sourceReceiptId: receiptRef.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    await writeActivity("receipt", "Receipt confirmed", "receipt", receiptRef.id, receipt.merchant + " · " + money(receipt.total));
    closeModal();
    await refresh(["receipts", "transactions", "activity"]);
    toast("Receipt saved", "Spending data was created automatically.", "success");
  });
}

function dominantReceiptCategory(items) {
  if (!items || !items.length) return "Other";
  const totals = {};
  items.forEach(function (i) { totals[i.category || "Other"] = (totals[i.category || "Other"] || 0) + Number(i.price || 0); });
  return Object.entries(totals).sort(function (a, b) { return b[1] - a[1]; })[0][0];
}

function openReceiptDetail(receipt) {
  if (!receipt) return;
  const items = receipt.items || [];
  const body = "<div class='grid grid-3'><div class='insight'><div class='insight-label'>Merchant</div><strong>" + escapeHtml(receipt.merchant || "—") +
    "</strong><p>" + dateText(receipt.date) + "</p></div><div class='insight'><div class='insight-label'>Total</div><strong>" + money(receipt.total) +
    "</strong><p>Tax " + money(receipt.tax) + "</p></div><div class='insight'><div class='insight-label'>Items</div><strong>" + items.length +
    "</strong><p>Structured line items</p></div></div><div class='divider'></div><div class='panel-list'>" + items.map(function (i) {
      return "<div class='list-row'><div><div class='list-title'>" + escapeHtml(i.name) + "</div><div class='list-sub'>" + escapeHtml(i.category || "Other") +
        "</div></div><strong>" + money(i.price) + "</strong></div>";
    }).join("") + "</div>" + (receipt.rawText ? "<div class='divider'></div><details><summary class='microcopy'>Show OCR text</summary><pre style='white-space:pre-wrap;color:var(--muted);font-size:11px'>" +
    escapeHtml(receipt.rawText) + "</pre></details>" : "");
  openModal("Receipt", body, { wide: true });
}

async function deleteReceipt(id) {
  if (!confirm("Delete this receipt and its linked transaction?")) return;
  const linked = state.data.transactions.filter(function (t) { return t.sourceReceiptId === id; });
  const batch = writeBatch(db);
  batch.delete(doc(db, "receipts", id));
  linked.forEach(function (t) { batch.delete(doc(db, "transactions", t.id)); });
  await batch.commit();
  await writeActivity("receipt", "Receipt deleted", "receipt", id, "Linked spending entry removed.");
  await refresh(["receipts", "transactions", "activity"]);
}

function openAssetForm(existing) {
  existing = existing || {};
  const body = "<form id='asset-form' class='form-grid'>" +
    "<div class='field full'><label>Name</label><input name='name' required maxlength='150' value='" + escapeHtml(existing.name || "") + "' placeholder='TI-84 Plus CE'></div>" +
    "<div class='field'><label>Category</label><select name='category'>" + ASSET_CATEGORIES.map(function (c) { return "<option " + (c === existing.category ? "selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div>" +
    "<div class='field'><label>Location</label><select name='locationId'>" + locationOptions(existing.locationId) + "</select></div>" +
    "<div class='field'><label>Serial number</label><input name='serialNumber' value='" + escapeHtml(existing.serialNumber || "") + "'></div>" +
    "<div class='field'><label>Model</label><input name='model' value='" + escapeHtml(existing.model || "") + "'></div>" +
    "<div class='field'><label>Purchase date</label><input name='purchaseDate' type='date' value='" + escapeHtml(existing.purchaseDate || "") + "'></div>" +
    "<div class='field'><label>Purchase price</label><input name='purchasePrice' type='number' step='0.01' min='0' value='" + escapeHtml(existing.purchasePrice || "") + "'></div>" +
    "<div class='field'><label>Warranty expiration</label><input name='warrantyExpiration' type='date' value='" + escapeHtml(existing.warrantyExpiration || "") + "'></div>" +
    "<div class='field'><label>Condition</label><select name='condition'>" + ["New", "Excellent", "Good", "Fair", "Needs Repair"].map(function (c) { return "<option " + (c === (existing.condition || "Good") ? "selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div>" +
    "<div class='field full'><label>Notes</label><textarea name='notes'>" + escapeHtml(existing.notes || "") + "</textarea></div>" +
    (!existing.id ? "<label class='check-row full'><input type='checkbox' name='createQr' checked> Create and assign a QR tag automatically</label>" : "") +
    "</form>";
  const modal = openModal(existing.id ? "Edit Asset" : "Register Asset", body, {
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-asset'>Save Asset</button>"
  });
  $("#save-asset", modal).addEventListener("click", async function () {
    const form = $("#asset-form", modal);
    if (!form.reportValidity()) return;
    const data = {
      name: formValue(form, "name"), category: formValue(form, "category"), locationId: formValue(form, "locationId") || null,
      serialNumber: formValue(form, "serialNumber"), model: formValue(form, "model"), purchaseDate: formValue(form, "purchaseDate"),
      purchasePrice: Number(formValue(form, "purchasePrice") || 0), warrantyExpiration: formValue(form, "warrantyExpiration"),
      condition: formValue(form, "condition"), notes: formValue(form, "notes"), updatedAt: serverTimestamp()
    };
    let id = existing.id;
    if (id) await updateDoc(doc(db, "assets", id), data);
    else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "assets"), data);
      id = ref.id;
      if (form.elements.createQr && form.elements.createQr.checked) await createTagForEntity("asset", id, data.name, "standard", false);
      await writeActivity("asset", "Asset registered", "asset", id, data.name);
    }
    closeModal();
    await refresh(["assets", "qrTags", "activity"]);
    toast("Asset saved", data.name + " is now in NEXUS.", "success");
  });
}

async function reserveCounter(field, count) {
  const counterRef = doc(db, "meta", "counters");
  return runTransaction(db, async function (transaction) {
    const snap = await transaction.get(counterRef);
    const current = snap.exists() && Number(snap.data()[field]) ? Number(snap.data()[field]) : (field === "qr" ? 500 : 0);
    const start = current + 1;
    const next = current + count;
    transaction.set(counterRef, { [field]: next, updatedAt: serverTimestamp() }, { merge: true });
    return { start: start, end: next };
  });
}

function randomSlug() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function createTagForEntity(type, id, label, size, reload) {
  const reserved = await reserveCounter("qr", 1);
  const code = "QR-" + String(reserved.start).padStart(5, "0");
  const slug = randomSlug();
  await setDoc(doc(db, "qrTags", code), {
    labelCode: code, publicSlug: slug, targetType: type, targetId: id, targetLabel: label || "Registered item",
    status: "assigned", size: size || "standard", createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  await setDoc(doc(db, "publicQr", slug), {
    labelCode: code, targetType: type, status: "active",
    publicTitle: type === "book" ? "Registered Book" : type === "location" ? "Registered Location" : "Registered Personal Property",
    publicMessage: "This QR tag belongs to a private NEXUS installation.",
    updatedAt: serverTimestamp()
  });
  await writeActivity("qr", "QR tag assigned", "qrTag", code, code + " → " + label);
  if (reload !== false) await refresh(["qrTags", "activity"]);
  return code;
}

async function createTagAndRefresh(type, id) {
  let label = "Registered item";
  if (type === "asset") { const x = state.data.assets.find(function (a) { return a.id === id; }); if (x) label = x.name; }
  if (type === "book") { const x = state.data.books.find(function (a) { return a.id === id; }); if (x) label = x.title; }
  if (type === "location") { const x = state.data.locations.find(function (a) { return a.id === id; }); if (x) label = x.name; }
  const code = await createTagForEntity(type, id, label, type === "book" ? "book" : "standard", true);
  toast("QR created", code + " is now assigned.", "success");
}

function openGenerateTags() {
  const body = "<form id='tag-batch-form' class='form-grid'><div class='field'><label>How many blank tags?</label><input name='count' type='number' min='1' max='40' value='20' required></div>" +
    "<div class='field'><label>Label size</label><select name='size'><option value='tiny'>Tiny — 5 across</option><option value='standard' selected>Standard — 4 across</option><option value='book'>Book — 4 across</option><option value='container'>Container — 2 across</option></select></div>" +
    "<div class='field full'><div class='inline-note'>NEXUS will reserve unique tags now. You can print them immediately or come back to QR Registry later.</div></div></form>";
  const modal = openModal("Generate Blank QR Tags", body, {
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='create-tag-batch'>Generate Tags</button>"
  });
  $("#create-tag-batch", modal).addEventListener("click", async function () {
    const form = $("#tag-batch-form", modal);
    if (!form.reportValidity()) return;
    const count = Math.min(40, Math.max(1, Number(formValue(form, "count"))));
    const size = formValue(form, "size");
    const range = await reserveCounter("qr", count);
    const batch = writeBatch(db);
    const created = [];
    for (let n = range.start; n <= range.end; n++) {
      const code = "QR-" + String(n).padStart(5, "0");
      const slug = randomSlug();
      const tag = { id: code, labelCode: code, publicSlug: slug, targetType: "unassigned", targetId: null, targetLabel: "UNASSIGNED", status: "unassigned", size: size };
      created.push(tag);
      batch.set(doc(db, "qrTags", code), Object.assign({}, tag, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
      batch.set(doc(db, "publicQr", slug), { labelCode: code, targetType: "unassigned", status: "unassigned", publicTitle: "Unused NEXUS Tag", publicMessage: "This tag has not been assigned yet.", updatedAt: serverTimestamp() });
    }
    await batch.commit();
    await writeActivity("qr", count + " blank QR tags generated", "qrTag", created[0].id, created[0].id + " through " + created[created.length - 1].id);
    closeModal();
    await refresh(["qrTags", "activity"]);
    toast("Tags ready", count + " blank tags were generated.", "success");
    if (confirm("Print this new batch now?")) await printTags(created);
  });
}

function openAssignTag(code) {
  const tag = state.data.qrTags.find(function (x) { return x.id === code; });
  if (!tag) return;
  const body = "<form id='assign-tag-form' class='form-grid'><div class='field full'><label>Assign " + escapeHtml(code) + " to</label><select name='target' required>" +
    "<option value=''>Choose a record…</option>" +
    "<optgroup label='Assets'>" + state.data.assets.map(function (a) { return "<option value='asset|" + escapeHtml(a.id) + "'>" + escapeHtml(a.name) + "</option>"; }).join("") + "</optgroup>" +
    "<optgroup label='Books'>" + state.data.books.map(function (b) { return "<option value='book|" + escapeHtml(b.id) + "'>" + escapeHtml(b.title) + "</option>"; }).join("") + "</optgroup>" +
    "<optgroup label='Locations'>" + state.data.locations.map(function (l) { return "<option value='location|" + escapeHtml(l.id) + "'>" + escapeHtml(l.name) + "</option>"; }).join("") + "</optgroup>" +
    "</select></div></form>";
  const modal = openModal("Assign QR Tag", body, {
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-tag-assignment'>Assign Tag</button>"
  });
  $("#save-tag-assignment", modal).addEventListener("click", async function () {
    const form = $("#assign-tag-form", modal);
    if (!form.reportValidity()) return;
    const parts = formValue(form, "target").split("|");
    const type = parts[0], id = parts[1];
    let label = "Registered item";
    if (type === "asset") label = (state.data.assets.find(function (x) { return x.id === id; }) || {}).name || label;
    if (type === "book") label = (state.data.books.find(function (x) { return x.id === id; }) || {}).title || label;
    if (type === "location") label = (state.data.locations.find(function (x) { return x.id === id; }) || {}).name || label;
    await updateDoc(doc(db, "qrTags", code), { targetType: type, targetId: id, targetLabel: label, status: "assigned", updatedAt: serverTimestamp() });
    await setDoc(doc(db, "publicQr", tag.publicSlug), {
      labelCode: code, targetType: type, status: "active",
      publicTitle: type === "book" ? "Registered Book" : type === "location" ? "Registered Location" : "Registered Personal Property",
      publicMessage: "This QR tag belongs to a private NEXUS installation.", updatedAt: serverTimestamp()
    }, { merge: true });
    await writeActivity("qr", "Blank tag assigned", "qrTag", code, code + " → " + label);
    closeModal();
    await refresh(["qrTags", "activity"]);
    toast("Tag assigned", code + " now points to " + label + ".", "success");
  });
}

function makeQrDataUrl(text, size) {
  return new Promise(function (resolve, reject) {
    try {
      if (!window.QRCode) return reject(new Error("QR library is unavailable."));
      const bin = $("#qr-render-bin");
      if (!bin) return reject(new Error("QR render surface is unavailable."));
      const holder = document.createElement("div");
      bin.innerHTML = "";
      bin.appendChild(holder);
      new window.QRCode(holder, {
        text: text,
        width: size,
        height: size,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.M
      });

      const started = Date.now();
      (function waitForQr() {
        const canvas = holder.querySelector("canvas");
        const img = holder.querySelector("img");
        if (canvas) {
          try { return resolve(canvas.toDataURL("image/png")); }
          catch (error) { return reject(error); }
        }
        if (img && img.src) {
          if (img.complete) return resolve(img.src);
          img.onload = function () { resolve(img.src); };
          img.onerror = function () { reject(new Error("QR image failed to load.")); };
          return;
        }
        if (Date.now() - started > 3500) return reject(new Error("QR rendering timed out."));
        requestAnimationFrame(waitForQr);
      })();
    } catch (error) {
      reject(error);
    }
  });
}

function printableTagMarkup(entry) {
  const t = entry.tag;
  const isContainer = t.size === "container";
  const cls = isContainer ? "nexus-paper-tag container" : "nexus-paper-tag " + escapeHtml(t.size || "standard");
  if (isContainer) {
    return "<div class='" + cls + "'><img src='" + entry.data + "' alt='QR code'><div class='nexus-paper-copy'><div class='nexus-paper-brand'>NEXUS</div><div class='nexus-paper-label'>" +
      escapeHtml(targetLabel(t)) + "</div><div class='nexus-paper-code'>" + escapeHtml(t.labelCode || t.id) + "</div><div class='nexus-paper-kind'>" +
      escapeHtml((t.targetType || "UNASSIGNED").toUpperCase()) + "</div></div></div>";
  }
  return "<div class='" + cls + "'><img src='" + entry.data + "' alt='QR code'><div class='nexus-paper-code'>" +
    escapeHtml(t.labelCode || t.id) + "</div><div class='nexus-paper-kind'>" +
    escapeHtml((t.status === "unassigned" ? "UNASSIGNED" : t.targetType || "NEXUS").toUpperCase()) + "</div></div>";
}

function printableSheetMarkup(ready) {
  return "<div class='nexus-print-document'><div class='nexus-paper-head'><div><div class='nexus-paper-title'>NEXUS</div><div class='nexus-paper-sub'>QR TAG SHEET</div></div><div class='nexus-paper-motto'>ORGANIZE · TRACK · FIND · KEEP</div></div><div class='nexus-paper-grid'>" +
    ready.map(printableTagMarkup).join("") + "</div></div>";
}

function qrPdfDimensions(size) {
  if (size === "tiny") return { colspan: 1, height: 1.18, qr: .68 };
  if (size === "book") return { colspan: 1, height: 1.52, qr: .82 };
  if (size === "container") return { colspan: 2, height: 1.82, qr: 1.00 };
  return { colspan: 1, height: 1.46, qr: .80 };
}

function buildQrPdf(ready) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("PDF library is unavailable.");
  const jsPDF = window.jspdf.jsPDF;
  const pdf = new jsPDF({ orientation: "portrait", unit: "in", format: "letter", compress: true });

  const pageW = 8.5;
  const pageH = 11;
  const margin = .35;
  const usableW = pageW - margin * 2;
  const gap = .08;
  const colW = (usableW - gap * 3) / 4;
  const bodyTop = 1.02;
  const bodyBottom = pageH - .35;
  let xCol = 0;
  let y = bodyTop;
  let rowH = 0;

  function header() {
    pdf.setTextColor(17,17,17);
    pdf.setFont("helvetica","bold");
    pdf.setFontSize(18);
    pdf.text("NEXUS", margin, .55);
    pdf.setFont("helvetica","normal");
    pdf.setFontSize(7);
    pdf.text("QR TAG SHEET", margin, .72);
    pdf.setDrawColor(200,169,107);
    pdf.setLineWidth(.015);
    pdf.line(margin, .82, pageW - margin, .82);
    pdf.setTextColor(70,70,70);
    pdf.setFontSize(6.5);
    pdf.text("ORGANIZE  ·  TRACK  ·  FIND  ·  KEEP", pageW - margin, .55, { align: "right" });
  }

  function newPage() {
    pdf.addPage("letter","portrait");
    header();
    xCol = 0;
    y = bodyTop;
    rowH = 0;
  }

  function nextRow() {
    y += rowH + gap;
    xCol = 0;
    rowH = 0;
  }

  function ensureRoom(height) {
    if (y + height <= bodyBottom) return;
    newPage();
  }

  function drawDashedRect(x, top, w, h) {
    pdf.setDrawColor(165,165,165);
    pdf.setLineWidth(.008);
    if (pdf.setLineDashPattern) pdf.setLineDashPattern([.05,.035], 0);
    pdf.rect(x, top, w, h);
    if (pdf.setLineDashPattern) pdf.setLineDashPattern([], 0);
  }

  function tagText(t) {
    const kind = (t.status === "unassigned" ? "UNASSIGNED" : t.targetType || "NEXUS").toUpperCase();
    return { code: t.labelCode || t.id, kind: kind, label: targetLabel(t) };
  }

  header();

  ready.forEach(function (entry) {
    const t = entry.tag;
    const dims = qrPdfDimensions(t.size || "standard");
    if (xCol + dims.colspan > 4) nextRow();
    ensureRoom(dims.height);

    const x = margin + xCol * (colW + gap);
    const w = dims.colspan === 2 ? colW * 2 + gap : colW;
    const top = y;
    drawDashedRect(x, top, w, dims.height);

    const txt = tagText(t);

    if (dims.colspan === 2) {
      const qrX = x + .12;
      const qrY = top + (dims.height - dims.qr) / 2;
      pdf.addImage(entry.data, "PNG", qrX, qrY, dims.qr, dims.qr, undefined, "FAST");

      const textX = qrX + dims.qr + .16;
      const textW = w - (textX - x) - .12;
      pdf.setTextColor(35,35,35);
      pdf.setFont("helvetica","bold");
      pdf.setFontSize(6);
      pdf.text("NEXUS", textX, top + .38);
      pdf.setFontSize(11);
      const labelLines = pdf.splitTextToSize(String(txt.label || "Registered item"), textW);
      pdf.text(labelLines.slice(0,2), textX, top + .63);
      const codeY = top + .63 + Math.min(labelLines.length,2) * .17 + .12;
      pdf.setFontSize(9);
      pdf.text(String(txt.code), textX, codeY);
      pdf.setFont("helvetica","normal");
      pdf.setFontSize(6);
      pdf.setTextColor(95,95,95);
      pdf.text(String(txt.kind), textX, codeY + .17);
    } else {
      const qrX = x + (w - dims.qr) / 2;
      const qrY = top + .13;
      pdf.addImage(entry.data, "PNG", qrX, qrY, dims.qr, dims.qr, undefined, "FAST");

      pdf.setTextColor(25,25,25);
      pdf.setFont("helvetica","bold");
      pdf.setFontSize(7.6);
      pdf.text(String(txt.code), x + w / 2, qrY + dims.qr + .16, { align: "center" });
      pdf.setFont("helvetica","normal");
      pdf.setFontSize(5.5);
      pdf.setTextColor(100,100,100);
      pdf.text(String(txt.kind), x + w / 2, qrY + dims.qr + .29, { align: "center" });
    }

    rowH = Math.max(rowH, dims.height);
    xCol += dims.colspan;
    if (xCol >= 4) nextRow();
  });

  pdf.setProperties({
    title: "NEXUS QR Tag Sheet",
    subject: "Printable NEXUS QR labels",
    creator: "NEXUS"
  });
  return pdf;
}

function openPdfBlob(blobUrl) {
  const opened = window.open(blobUrl, "_blank", "noopener");
  if (opened) return true;

  const link = document.createElement("a");
  link.href = blobUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

async function printTags(tags) {
  if (!tags || !tags.length) {
    toast("Nothing to print", "Generate or select a QR tag first.", "error");
    return;
  }

  toast("Preparing labels", "Rendering the printable PDF…");
  const ready = [];
  try {
    for (const tag of tags) {
      ready.push({ tag: tag, data: await makeQrDataUrl(qrUrl(tag), 420) });
    }
  } catch (error) {
    console.error(error);
    toast("Could not prepare labels", error.message || "QR rendering failed.", "error");
    return;
  }

  let pdf;
  try {
    pdf = buildQrPdf(ready);
  } catch (error) {
    console.error(error);
    toast("PDF generation failed", error.message || "Could not create the printable sheet.", "error");
    return;
  }

  const blob = pdf.output("blob");
  const blobUrl = URL.createObjectURL(blob);
  const sheet = printableSheetMarkup(ready);
  const body =
    "<div class='inline-note'><strong>Mobile-safe printing:</strong> NEXUS has already built the finished US-Letter PDF. Tap <strong>Print / Open PDF</strong> to open it in your phone's PDF viewer, where you can print or save it. The old browser-page printing method is no longer used.</div>" +
    "<div class='nexus-print-preview'>" + sheet + "</div>";
  const modal = openModal("QR Print Preview", body, {
    wide: true,
    footer:
      "<button class='btn btn-secondary' data-close-modal>Close</button>" +
      "<button class='btn btn-secondary' id='nexus-download-pdf'>Download PDF</button>" +
      "<button class='btn btn-primary' id='nexus-print-now'>Print / Open PDF</button>"
  });

  let revoked = false;
  function revokeLater() {
    if (revoked) return;
    revoked = true;
    setTimeout(function () { try { URL.revokeObjectURL(blobUrl); } catch (_) {} }, 120000);
  }

  $("#nexus-print-now", modal).addEventListener("click", function () {
    try {
      openPdfBlob(blobUrl);
      toast("Printable PDF opened", "Use the PDF viewer's Print option if it does not open the print service automatically.", "success");
    } catch (error) {
      console.error(error);
      toast("Could not open PDF", "Use Download PDF instead.", "error");
    }
  });

  $("#nexus-download-pdf", modal).addEventListener("click", function () {
    try {
      pdf.save("NEXUS-QR-Tags.pdf");
      toast("PDF ready", "The QR sheet was saved as a PDF.", "success");
    } catch (error) {
      console.error(error);
      toast("Download failed", error.message || "Could not save the PDF.", "error");
    }
  });

  $$("[data-close-modal]", modal).forEach(function (btn) {
    btn.addEventListener("click", revokeLater, { once: true });
  });
}

function openBookForm(existing, prefillIsbn) {
  existing = existing || {};
  if (prefillIsbn && !existing.isbn) existing.isbn = prefillIsbn;
  const body = "<form id='book-form' class='form-grid'>" +
    "<div class='field full'><label>ISBN</label><div style='display:flex;gap:8px'><input name='isbn' value='" + escapeHtml(existing.isbn || "") + "' placeholder='978…'><button class='btn btn-secondary' type='button' id='lookup-isbn'>Lookup</button></div><div class='field-hint'>Metadata lookup uses Open Library when available.</div></div>" +
    "<div class='field full'><label>Title</label><input name='title' required value='" + escapeHtml(existing.title || "") + "'></div>" +
    "<div class='field'><label>Author</label><input name='author' value='" + escapeHtml(existing.author || "") + "'></div>" +
    "<div class='field'><label>Publisher</label><input name='publisher' value='" + escapeHtml(existing.publisher || "") + "'></div>" +
    "<div class='field'><label>Publication year</label><input name='year' value='" + escapeHtml(existing.year || "") + "'></div>" +
    "<div class='field'><label>Format</label><select name='format'>" + ["Hardcover", "Paperback", "Leather / Imitation Leather", "Spiral", "Other"].map(function (c) { return "<option " + (c === (existing.format || "Hardcover") ? "selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div>" +
    "<div class='field'><label>Shelf / location</label><select name='locationId'>" + locationOptions(existing.locationId) + "</select></div>" +
    "<div class='field'><label>Reading status</label><select name='readingStatus'>" + ["Unread", "Reading", "Finished", "Reference"].map(function (c) { return "<option " + (c === (existing.readingStatus || "Unread") ? "selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div>" +
    "<div class='field'><label>Purchase price</label><input name='purchasePrice' type='number' min='0' step='0.01' value='" + escapeHtml(existing.purchasePrice || "") + "'></div>" +
    "<div class='field full'><label>Collections</label><input name='collections' value='" + escapeHtml((existing.collections || []).join(", ")) + "' placeholder='Theology, Apologetics, Favorites'></div>" +
    "<div class='field full'><label>Notes</label><textarea name='notes'>" + escapeHtml(existing.notes || "") + "</textarea></div>" +
    (!existing.id ? "<label class='check-row full'><input type='checkbox' name='createQr' checked> Create a book QR label automatically</label>" : "") +
    "</form>";
  const modal = openModal(existing.id ? "Edit Book" : "Catalog Book", body, {
    wide: true,
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-book'>Save Book</button>"
  });
  $("#lookup-isbn", modal).addEventListener("click", async function () {
    const form = $("#book-form", modal);
    const isbn = formValue(form, "isbn").replace(/[^0-9Xx]/g, "");
    if (!isbn) return toast("ISBN needed", "Enter or scan an ISBN first.", "error");
    const button = $("#lookup-isbn", modal);
    button.disabled = true; button.textContent = "Looking up…";
    try {
      const data = await lookupIsbn(isbn);
      if (data.title) form.elements.title.value = data.title;
      if (data.author) form.elements.author.value = data.author;
      if (data.publisher) form.elements.publisher.value = data.publisher;
      if (data.year) form.elements.year.value = data.year;
      toast("Metadata found", "Review the fields before saving.", "success");
    } catch (error) {
      toast("No metadata found", "You can still enter the book manually.", "error");
    } finally {
      button.disabled = false; button.textContent = "Lookup";
    }
  });
  $("#save-book", modal).addEventListener("click", async function () {
    const form = $("#book-form", modal);
    if (!form.reportValidity()) return;
    const data = {
      isbn: formValue(form, "isbn").replace(/[^0-9Xx]/g, ""), title: formValue(form, "title"), author: formValue(form, "author"),
      publisher: formValue(form, "publisher"), year: formValue(form, "year"), format: formValue(form, "format"),
      locationId: formValue(form, "locationId") || null, readingStatus: formValue(form, "readingStatus"),
      purchasePrice: Number(formValue(form, "purchasePrice") || 0),
      collections: formValue(form, "collections").split(",").map(function (x) { return x.trim(); }).filter(Boolean),
      notes: formValue(form, "notes"), updatedAt: serverTimestamp()
    };
    let id = existing.id;
    if (id) await updateDoc(doc(db, "books", id), data);
    else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "books"), data);
      id = ref.id;
      if (form.elements.createQr && form.elements.createQr.checked) await createTagForEntity("book", id, data.title, "book", false);
      await writeActivity("book", "Book cataloged", "book", id, data.title + (data.author ? " · " + data.author : ""));
    }
    closeModal();
    await refresh(["books", "qrTags", "activity"]);
    toast("Book saved", data.title + " is in your library.", "success");
  });
}

async function lookupIsbn(isbn) {
  const response = await fetch("https://openlibrary.org/isbn/" + encodeURIComponent(isbn) + ".json");
  if (!response.ok) throw new Error("Not found");
  const book = await response.json();
  let author = "";
  if (book.authors && book.authors[0] && book.authors[0].key) {
    try {
      const a = await fetch("https://openlibrary.org" + book.authors[0].key + ".json");
      if (a.ok) author = (await a.json()).name || "";
    } catch (_) {}
  }
  const publishDate = String(book.publish_date || "");
  const yearMatch = publishDate.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return {
    title: book.title || "",
    author: author,
    publisher: book.publishers && book.publishers[0] || "",
    year: yearMatch ? yearMatch[0] : publishDate
  };
}

function openLoanBook(bookId) {
  const book = state.data.books.find(function (b) { return b.id === bookId; });
  if (!book) return;
  const body = "<form id='loan-form' class='form-grid'><div class='field full'><label>Book</label><input value='" + escapeHtml(book.title) + "' disabled></div>" +
    "<div class='field'><label>Borrower</label><input name='borrowerName' required placeholder='Name'></div><div class='field'><label>Due date</label><input name='dueDate' type='date'></div>" +
    "<div class='field full'><label>Note</label><textarea name='note'></textarea></div></form>";
  const modal = openModal("Loan Book", body, {
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-loan'>Check Out</button>"
  });
  $("#save-loan", modal).addEventListener("click", async function () {
    const form = $("#loan-form", modal);
    if (!form.reportValidity()) return;
    const loan = {
      bookId: book.id, bookTitle: book.title, borrowerName: formValue(form, "borrowerName"),
      dueDate: formValue(form, "dueDate"), note: formValue(form, "note"), status: "active",
      checkedOutAt: serverTimestamp(), createdAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, "loans"), loan);
    await writeActivity("loan", "Book loaned", "loan", ref.id, book.title + " → " + loan.borrowerName);
    closeModal();
    await refresh(["loans", "activity"]);
    toast("Book checked out", book.title + " is marked as loaned.", "success");
  });
}

async function returnBook(loanId, bookId) {
  const loan = state.data.loans.find(function (l) { return l.id === loanId; });
  const book = state.data.books.find(function (b) { return b.id === bookId; });
  if (!loan || !confirm("Mark this book as returned?")) return;
  await updateDoc(doc(db, "loans", loanId), { status: "returned", returnedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await writeActivity("loan", "Book returned", "loan", loanId, (book ? book.title : loan.bookTitle) + " returned by " + loan.borrowerName);
  await refresh(["loans", "activity"]);
}

function openLocationForm(existing) {
  existing = existing || {};
  const body = "<form id='location-form' class='form-grid'><div class='field full'><label>Name</label><input name='name' required value='" + escapeHtml(existing.name || "") + "' placeholder='Bookcase A — Shelf 2'></div>" +
    "<div class='field'><label>Type</label><select name='type'>" + LOCATION_TYPES.map(function (x) { return "<option " + (x === (existing.type || "Shelf") ? "selected" : "") + ">" + x + "</option>"; }).join("") +
    "</select></div><div class='field'><label>Inside</label><select name='parentId'>" + locationOptions(existing.parentId, existing.id) + "</select></div>" +
    "<div class='field full'><label>Notes</label><textarea name='notes'>" + escapeHtml(existing.notes || "") + "</textarea></div>" +
    (!existing.id ? "<label class='check-row full'><input type='checkbox' name='createQr'> Create a location QR tag</label>" : "") + "</form>";
  const modal = openModal(existing.id ? "Edit Location" : "Add Location", body, {
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='save-location'>Save Location</button>"
  });
  $("#save-location", modal).addEventListener("click", async function () {
    const form = $("#location-form", modal);
    if (!form.reportValidity()) return;
    const data = { name: formValue(form, "name"), type: formValue(form, "type"), parentId: formValue(form, "parentId") || null, notes: formValue(form, "notes"), updatedAt: serverTimestamp() };
    let id = existing.id;
    if (id) await updateDoc(doc(db, "locations", id), data);
    else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "locations"), data);
      id = ref.id;
      if (form.elements.createQr && form.elements.createQr.checked) await createTagForEntity("location", id, data.name, "standard", false);
      await writeActivity("location", "Location created", "location", id, data.name);
    }
    closeModal();
    await refresh(["locations", "qrTags", "activity"]);
    toast("Location saved", data.name + " is now part of your physical map.", "success");
  });
}

async function deleteRecord(collectionName, id) {
  if (!confirm("Delete this record from NEXUS?")) return;
  await deleteDoc(doc(db, collectionName, id));
  const tags = state.data.qrTags.filter(function (t) {
    const type = collectionName === "assets" ? "asset" : collectionName === "books" ? "book" : collectionName === "locations" ? "location" : "";
    return type && t.targetType === type && t.targetId === id;
  });
  for (const tag of tags) {
    await updateDoc(doc(db, "qrTags", tag.id), { targetType: "unassigned", targetId: null, targetLabel: "UNASSIGNED", status: "unassigned", updatedAt: serverTimestamp() });
    await setDoc(doc(db, "publicQr", tag.publicSlug), { targetType: "unassigned", status: "unassigned", publicTitle: "Unused NEXUS Tag", publicMessage: "This tag is ready to be reassigned.", updatedAt: serverTimestamp() }, { merge: true });
  }
  await writeActivity("system", "Record deleted", collectionName, id, collectionName);
  await refresh([collectionName, "qrTags", "activity"]);
  toast("Deleted", "The record was removed.", "success");
}

function openScanner(mode) {
  if (!window.Html5QrcodeScanner) {
    toast("Scanner unavailable", "The scanner library did not load.", "error");
    return;
  }
  const body = "<div class='inline-note'>" + (mode === "book" ? "Scan the ISBN barcode on the back of a book." : "Scan a NEXUS QR tag, ISBN, UPC, or other barcode.") +
    "</div><div class='scan-reader'><div id='reader'></div></div>";
  const modal = openModal(mode === "book" ? "Scan Book ISBN" : "NEXUS Scanner", body, { wide: true, footer: "<button class='btn btn-secondary' data-close-modal>Close</button>" });
  let scanner;
  setTimeout(function () {
    scanner = new window.Html5QrcodeScanner("reader", { fps: 10, qrbox: { width: 250, height: 250 }, rememberLastUsedCamera: true, showTorchButtonIfSupported: true }, false);
    scanner.render(async function (decodedText) {
      try { await scanner.clear(); } catch (_) {}
      closeModal();
      handleScan(decodedText, mode);
    }, function () {});
  }, 0);
  $$("[data-close-modal]", modal).forEach(function (btn) {
    btn.addEventListener("click", async function () { if (scanner) try { await scanner.clear(); } catch (_) {} });
  });
}

function handleScan(decoded, mode) {
  const text = String(decoded || "").trim();
  try {
    const u = new URL(text, location.origin);
    const tag = u.searchParams.get("tag");
    if (tag) return openOwnerTag(tag);
  } catch (_) {}
  const digits = text.replace(/[^0-9Xx]/g, "");
  if ((digits.length === 10 || digits.length === 13) && (mode === "book" || /^97[89]/.test(digits) || digits.length === 10)) {
    return openBookForm(null, digits);
  }
  state.searchTerm = text;
  $("#global-search").value = text;
  setActiveView("search");
}

async function openOwnerTag(slug) {
  let tag = state.data.qrTags.find(function (t) { return t.publicSlug === slug || t.id === slug; });
  if (!tag) {
    await loadCollection("qrTags");
    tag = state.data.qrTags.find(function (t) { return t.publicSlug === slug || t.id === slug; });
  }
  if (!tag) return toast("Unknown QR", "This tag is not in your NEXUS registry.", "error");
  if (tag.status === "unassigned" || tag.targetType === "unassigned") return openAssignTag(tag.id);
  const body = "<div style='text-align:center'><div id='owner-tag-qr' class='qr-box'></div><div class='eyebrow'>" + escapeHtml(tag.labelCode || tag.id) +
    "</div><h2 style='margin:5px 0'>" + escapeHtml(targetLabel(tag)) + "</h2><p class='muted'>" + escapeHtml(tag.targetType || "item") + "</p></div>" +
    "<div class='divider'></div><div class='actions' style='justify-content:center'><button class='btn btn-secondary' id='owner-tag-open'>Open in " +
    escapeHtml(tag.targetType) + "s</button><button class='btn btn-primary' id='owner-tag-print'>Print tag</button></div>";
  const modal = openModal("Scanned Tag", body, { footer: false });
  setTimeout(function () {
    new window.QRCode($("#owner-tag-qr", modal), { text: qrUrl(tag), width: 112, height: 112, colorDark: "#000", colorLight: "#fff" });
  }, 0);
  $("#owner-tag-open", modal).addEventListener("click", function () {
    closeModal();
    setActiveView(tag.targetType === "book" ? "library" : tag.targetType === "location" ? "locations" : "assets");
  });
  $("#owner-tag-print", modal).addEventListener("click", function () { printTags([tag]); });
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    nexusVersion: "phase-1",
    owner: OWNER_EMAIL,
    data: state.data
  };
  const blob = new Blob([JSON.stringify(payload, function (key, value) {
    if (value && value.seconds && value.nanoseconds !== undefined) return { seconds: value.seconds, nanoseconds: value.nanoseconds };
    return value;
  }, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "nexus-export-" + todayISO() + ".json";
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

function friendlyError(error) {
  const code = String(error && error.code || "");
  if (code.includes("permission-denied")) return "Firestore denied this action. Deploy the included security rules and confirm you are signed into the authorized Google account.";
  if (code.includes("popup-closed")) return "Google sign-in was closed.";
  return error && error.message ? error.message : "Something went wrong.";
}

async function showPublicTag(slug) {
  $("#auth-gate").classList.add("hidden");
  $("#app-shell").classList.add("hidden");
  const panel = $("#public-scan");
  panel.classList.remove("hidden");
  try {
    const snap = await getDoc(doc(db, "publicQr", slug));
    if (!snap.exists()) {
      panel.innerHTML = "<div class='public-card'><div class='public-brand'>NEXUS</div><h1>Unknown Tag</h1><p>This QR code is not registered in this NEXUS installation.</p></div>";
      return;
    }
    const data = snap.data();
    panel.innerHTML = "<div class='public-card'><div class='public-brand'>NEXUS</div><span class='badge " + (data.status === "lost" ? "red" : data.status === "unassigned" || data.status === "retired" ? "amber" : "green") + "'>" +
      escapeHtml(String(data.status || "registered").toUpperCase()) + "</span><h1 style='margin-top:14px'>" + escapeHtml(data.publicTitle || "Registered Property") +
      "</h1><p>" + escapeHtml(data.publicMessage || "This item is registered to a private owner.") + "</p><div class='divider'></div><div class='microcopy'>Tag " +
      escapeHtml(data.labelCode || "") + "</div><button id='public-owner-signin' class='btn btn-secondary' style='margin-top:16px'>Owner sign in</button></div>";
    $("#public-owner-signin").addEventListener("click", doGoogleSignIn);
  } catch (error) {
    panel.innerHTML = "<div class='public-card'><div class='public-brand'>NEXUS</div><h1>Unable to read tag</h1><p>" + escapeHtml(friendlyError(error)) + "</p></div>";
  }
}

async function doGoogleSignIn() {
  $("#auth-status").textContent = "Opening Google sign-in…";
  try {
    await setPersistence(auth, browserLocalPersistence);
    const result = await signInWithPopup(auth, provider);
    if (!isOwner(result.user)) {
      await signOut(auth);
      $("#auth-status").textContent = "This NEXUS installation is private.";
      toast("Access denied", "That Google account is not the NEXUS owner.", "error");
    }
  } catch (error) {
    if (String(error.code || "").includes("popup-blocked")) {
      await signInWithRedirect(auth, provider);
      return;
    }
    $("#auth-status").textContent = friendlyError(error);
  }
}

function ownerLoadingMarkup(message) {
  return "<section class='card nexus-boot-card'><div class='nexus-loader' aria-hidden='true'></div><div><div class='eyebrow'>NEXUS</div><h2>" +
    escapeHtml(message || "Loading your system…") + "</h2><p class='muted'>Connecting securely to Cloud Firestore.</p></div></section>";
}

function timeoutPromise(ms, label) {
  return new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error(label || "Request timed out.")); }, ms);
  });
}

async function loadOwnerDataWithRecovery() {
  $("#view").innerHTML = ownerLoadingMarkup("Loading your data…");
  try {
    await Promise.race([loadAll(), timeoutPromise(18000, "Firestore took too long to respond.")]);
    return true;
  } catch (error) {
    console.error("NEXUS startup load failed", error);
    $("#view").innerHTML =
      "<section class='card nexus-recovery'><div class='eyebrow'>CONNECTION ISSUE</div><h2>NEXUS could not finish loading.</h2><p>" +
      escapeHtml(friendlyError(error)) + "</p><div class='actions' style='justify-content:flex-start;margin-top:16px'><button id='retry-owner-load' class='btn btn-primary'>Retry</button><button id='recovery-signout' class='btn btn-secondary'>Sign out</button></div><div class='inline-note' style='margin-top:16px'>If this is the first GitHub Pages deployment, make sure <strong>silly-cheese.github.io</strong> is listed in Firebase Authentication → Authorized domains and that the included Firestore rules have been deployed.</div></section>";
    $("#retry-owner-load").addEventListener("click", loadOwnerDataWithRecovery);
    $("#recovery-signout").addEventListener("click", function () { signOut(auth); });
    return false;
  }
}

async function startOwnerSession(user) {
  state.user = user;
  $("#auth-gate").classList.add("hidden");
  $("#public-scan").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#owner-chip").innerHTML = "<strong style='color:var(--text)'>Owner</strong><br>" + escapeHtml(user.email || "");

  try {
    await Promise.race([
      setDoc(doc(db, "users", user.uid), {
        email: user.email,
        displayName: user.displayName || "NEXUS Owner",
        role: "owner",
        lastLoginAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true }),
      timeoutPromise(12000, "Owner profile connection timed out.")
    ]);
  } catch (error) {
    console.warn("Owner profile sync deferred", error);
  }

  const loaded = await loadOwnerDataWithRecovery();
  if (!loaded) return;

  if (state.pendingTag) {
    const slug = state.pendingTag;
    history.replaceState({}, "", appBaseUrl());
    state.pendingTag = null;
    await openOwnerTag(slug);
  }
}

window.NEXUS = {
  state: state,
  db: db,
  auth: auth,
  OWNER_EMAIL: OWNER_EMAIL,
  refresh: refresh,
  render: render,
  setActiveView: setActiveView,
  setMobileNavOpen: setMobileNavOpen,
  openModal: openModal,
  closeModal: closeModal,
  toast: toast,
  writeActivity: writeActivity,
  openReceiptDetail: openReceiptDetail,
  openAssetForm: openAssetForm,
  openBookForm: openBookForm,
  openLocationForm: openLocationForm,
  openScanner: openScanner,
  printTags: printTags,
  buildQrPdf: buildQrPdf,
  qrUrl: qrUrl,
  targetLabel: targetLabel,
  locationName: locationName,
  tagFor: tagFor,
  createTagForEntity: createTagForEntity,
  randomSlug: randomSlug,
  reserveCounter: reserveCounter,
  loadAll: loadAll,
  loadOwnerDataWithRecovery: loadOwnerDataWithRecovery,
  appBaseUrl: appBaseUrl,
  money: money,
  dateText: dateText,
  normalize: normalize,
  escapeHtml: escapeHtml,
  todayISO: todayISO,
  monthKey: monthKey,
  lookupIsbn: lookupIsbn
};
document.dispatchEvent(new CustomEvent("nexus:ready"));

$("#google-signin").addEventListener("click", doGoogleSignIn);
$("#global-scan").addEventListener("click", function () { openScanner(); });
$("#mobile-scan").addEventListener("click", function () { openScanner(); });
$("#quick-add").addEventListener("click", openQuickAdd);
$("#mobile-menu").addEventListener("click", function () {
  setMobileNavOpen(!$(".sidebar").classList.contains("open"));
});
$("#sidebar-backdrop").addEventListener("click", function () { setMobileNavOpen(false); });

$$("[data-view]").forEach(function (btn) {
  btn.addEventListener("click", function () { setActiveView(btn.dataset.view); });
});

$("#global-search").addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    state.searchTerm = event.target.value.trim();
    setActiveView("search");
  }
});
$("#global-search").addEventListener("input", function (event) {
  if (state.view === "search") {
    state.searchTerm = event.target.value.trim();
    render();
  }
});
document.addEventListener("keydown", function (event) {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#global-search").focus();
  }
  if (event.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) closeModal();
  else if (event.key === "Escape" && $(".sidebar").classList.contains("open")) setMobileNavOpen(false);
});

setPersistence(auth, browserLocalPersistence).catch(function () {});
onAuthStateChanged(auth, async function (user) {
  try {
    if (user && isOwner(user)) {
      await startOwnerSession(user);
      return;
    }
    if (user && !isOwner(user)) await signOut(auth);
    state.user = null;
    $("#app-shell").classList.add("hidden");
    if (state.pendingTag) {
      await showPublicTag(state.pendingTag);
    } else {
      $("#public-scan").classList.add("hidden");
      $("#auth-gate").classList.remove("hidden");
      $("#auth-status").textContent = "Owner access only.";
    }
  } catch (error) {
    console.error(error);
    $("#auth-status").textContent = friendlyError(error);
    toast("Startup error", friendlyError(error), "error");
  }
});
