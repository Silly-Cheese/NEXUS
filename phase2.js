import {
  collection, addDoc, doc, getDoc, updateDoc, setDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const P2 = {
  N: null,
  initialized: false,
  currentInventory: null
};

function n() { return P2.N || window.NEXUS; }
function state() { return n().state; }
function db() { return n().db; }
function esc(v) { return n().escapeHtml(v); }
function money(v) { return n().money(v); }
function norm(v) { return n().normalize(v); }
function dateText(v) { return n().dateText(v); }
function todayISO() { return n().todayISO(); }
function monthKey(v) { return n().monthKey(v); }
function byId(list, id) { return (list || []).find(function (x) { return x.id === id; }); }
function addDays(iso, days) {
  const d = new Date((iso || todayISO()) + "T12:00:00");
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function daysUntil(iso) {
  if (!iso) return null;
  const a = new Date(todayISO() + "T12:00:00");
  const b = new Date(iso + "T12:00:00");
  return Math.ceil((b - a) / 86400000);
}
function statusBadge(label, type) {
  return "<span class='badge " + (type || "") + "'>" + esc(label) + "</span>";
}
function button(action, label, attrs, cls) {
  const data = Object.entries(attrs || {}).map(function (entry) {
    return " data-" + entry[0] + "='" + esc(entry[1]) + "'";
  }).join("");
  return "<button class='btn btn-small " + (cls || "btn-secondary") + "' data-p2-action='" + action + "'" + data + ">" + label + "</button>";
}
function receiptFor(id) { return byId(state().data.receipts, id); }
function assetFor(id) { return byId(state().data.assets, id); }
function bookFor(id) { return byId(state().data.books, id); }
function tagForEntity(type, id) {
  return state().data.qrTags.find(function (t) {
    return t.targetType === type && t.targetId === id && t.status !== "retired";
  });
}

function init() {
  if (P2.initialized || !window.NEXUS) return;
  P2.N = window.NEXUS;
  P2.initialized = true;
  document.addEventListener("nexus:render", onRender);
  document.addEventListener("click", onClick);
  if (P2.N.state.user) enhance(P2.N.state.view);
}

function onRender(event) {
  enhance(event.detail && event.detail.view || state().view);
}

function enhance(view) {
  if (!n() || !state().user) return;
  if (view === "dashboard") enhanceDashboard();
  if (view === "money") enhanceMoney();
  if (view === "receipts") enhanceReceipts();
  if (view === "assets") enhanceAssets();
  if (view === "qr") enhanceQr();
  if (view === "library") enhanceLibrary();
  if (view === "locations") enhanceLocations();
  if (view === "search") enhanceSearch();
  if (view === "settings") enhanceSettings();
}

function injectHeaderButton(html) {
  const actions = document.querySelector("#view .view-header .actions");
  if (actions) actions.insertAdjacentHTML("afterbegin", html);
}

function allReceiptItems() {
  const out = [];
  state().data.receipts.forEach(function (receipt) {
    (receipt.items || []).forEach(function (item, index) {
      out.push({
        receipt: receipt,
        item: item,
        index: index,
        merchant: receipt.merchant || "Unknown merchant",
        date: receipt.date,
        price: Number(item.price || 0),
        key: productKey(item.name)
      });
    });
  });
  return out;
}

function productKey(name) {
  return norm(name)
    .replace(/\b\d+(?:\.\d+)?\s*(oz|lb|lbs|ct|pk|pack|count|ml|l|gal|in|inch|ft)\b/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBookish(item) {
  const text = norm([item.name, item.category].join(" "));
  return item.category === "Books" || /book bible paperback hardcover commentary novel textbook journal devotional/.test(text);
}
function isDurable(item) {
  const text = norm([item.name, item.category].join(" "));
  return ["Electronics", "Household", "Education"].includes(item.category) ||
    /charger cable monitor keyboard mouse calculator headphone speaker laptop tablet phone lamp appliance tool backpack case printer camera/.test(text);
}
function unlinkedPurchaseItems() {
  return allReceiptItems().filter(function (x) {
    return !x.item.linkedAssetId && !x.item.linkedBookId && (isBookish(x.item) || isDurable(x.item));
  });
}

function currentMonthTransactions() {
  const key = monthKey(new Date());
  return state().data.transactions.filter(function (t) {
    return (t.type || "expense") === "expense" && monthKey(t.date) === key;
  });
}
function previousMonthsKeys(count) {
  const keys = [];
  const d = new Date();
  for (let i = 1; i <= count; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(monthKey(x));
  }
  return keys;
}
function categorySpendForMonth(key) {
  const totals = {};
  function add(category, amount) {
    const c = category || "Other";
    totals[c] = (totals[c] || 0) + Number(amount || 0);
  }
  state().data.transactions.filter(function (t) {
    return (t.type || "expense") === "expense" && monthKey(t.date) === key && !t.sourceReceiptId;
  }).forEach(function (t) { add(t.category, t.amount); });

  state().data.receipts.filter(function (r) { return monthKey(r.date) === key; }).forEach(function (r) {
    const items = r.items || [];
    if (!items.length) {
      const linked = state().data.transactions.find(function (t) { return t.sourceReceiptId === r.id; });
      add(linked && linked.category || "Other", r.total);
      return;
    }
    let sum = 0;
    items.forEach(function (i) {
      const amount = Number(i.price || 0);
      sum += amount;
      add(i.category || "Other", amount);
    });
    const remainder = Number(r.total || 0) - sum;
    if (remainder > .01) add("Other", remainder);
  });
  return totals;
}

function spendingOpportunities() {
  const currentKey = monthKey(new Date());
  const current = categorySpendForMonth(currentKey);
  const prevKeys = previousMonthsKeys(3);
  const ideas = [];
  Object.entries(current).forEach(function (entry) {
    const category = entry[0], amount = entry[1];
    const values = prevKeys.map(function (key) { return categorySpendForMonth(key)[category] || 0; });
    const avg = values.reduce(function (s, v) { return s + v; }, 0) / values.length;
    if (avg > 10 && amount > avg * 1.25 && amount - avg >= 15) {
      ideas.push({
        type: "Category shift",
        title: category + " is above your recent pace",
        text: "Current: " + money(amount) + " · 3-month average: " + money(avg) + " · difference: " + money(amount - avg)
      });
    }
  });

  const merchant = {};
  currentMonthTransactions().forEach(function (t) {
    const key = norm(t.merchant || "Unknown");
    if (!merchant[key]) merchant[key] = { name: t.merchant || "Unknown", count: 0, total: 0 };
    merchant[key].count++;
    merchant[key].total += Number(t.amount || 0);
  });
  Object.values(merchant).filter(function (m) { return m.count >= 4 && m.total >= 25; }).sort(function (a,b){return b.total-a.total;}).slice(0,2).forEach(function (m) {
    const avg = m.total / m.count;
    ideas.push({
      type: "Frequency",
      title: m.count + " purchases at " + m.name + " this month",
      text: "Total " + money(m.total) + " · average " + money(avg) + ". One fewer purchase at your current average would reduce spending by about " + money(avg) + "."
    });
  });

  const small = currentMonthTransactions().filter(function (t) { return Number(t.amount || 0) < 10; });
  const smallTotal = small.reduce(function (s,t){return s+Number(t.amount||0);},0);
  if (small.length >= 5) ideas.push({
    type: "Small purchases",
    title: small.length + " purchases under $10",
    text: "Together they total " + money(smallTotal) + " this month."
  });

  return ideas.slice(0, 5);
}

function recurringCandidates() {
  const map = {};
  state().data.transactions.filter(function (t) { return (t.type || "expense") === "expense"; }).forEach(function (t) {
    const key = norm(t.merchant || "");
    if (!key) return;
    if (!map[key]) map[key] = { merchant: t.merchant, entries: [] };
    map[key].entries.push({ date: t.date, amount: Number(t.amount || 0), month: monthKey(t.date) });
  });
  return Object.values(map).map(function (group) {
    const months = new Set(group.entries.map(function (e) { return e.month; }));
    const avg = group.entries.reduce(function(s,e){return s+e.amount;},0) / group.entries.length;
    const variance = group.entries.reduce(function(s,e){return s+Math.abs(e.amount-avg);},0) / group.entries.length;
    return {
      merchant: group.merchant,
      count: group.entries.length,
      months: months.size,
      average: avg,
      consistency: avg ? Math.max(0, 1 - variance / avg) : 0,
      latest: group.entries.sort(function(a,b){return String(b.date).localeCompare(String(a.date));})[0]
    };
  }).filter(function (x) {
    return x.months >= 2 && x.count >= 2;
  }).sort(function (a,b) {
    return (b.months * b.consistency) - (a.months * a.consistency);
  }).slice(0, 8);
}

function merchantStats() {
  const map = {};
  state().data.transactions.filter(function (t) { return (t.type || "expense") === "expense"; }).forEach(function (t) {
    const key = norm(t.merchant || "Unknown");
    if (!map[key]) map[key] = { key:key, name:t.merchant || "Unknown", count:0, total:0, categories:{}, dates:[] };
    const m = map[key];
    m.count++;
    m.total += Number(t.amount || 0);
    m.categories[t.category || "Other"] = (m.categories[t.category || "Other"] || 0) + Number(t.amount || 0);
    m.dates.push(t.date);
  });
  return Object.values(map).map(function (m) {
    m.average = m.count ? m.total / m.count : 0;
    m.topCategory = Object.entries(m.categories).sort(function(a,b){return b[1]-a[1];})[0];
    return m;
  }).sort(function(a,b){return b.total-a.total;});
}

function priceHistoryGroups() {
  const map = {};
  allReceiptItems().forEach(function (x) {
    if (!x.key || x.price <= 0) return;
    if (!map[x.key]) map[x.key] = { key:x.key, name:x.item.name, entries:[] };
    map[x.key].entries.push({ price:x.price, date:x.date, merchant:x.merchant, receiptId:x.receipt.id, name:x.item.name });
  });
  return Object.values(map).filter(function (g) { return g.entries.length >= 2; }).map(function (g) {
    g.entries.sort(function(a,b){return String(a.date).localeCompare(String(b.date));});
    g.latest = g.entries[g.entries.length-1];
    g.previous = g.entries[g.entries.length-2];
    g.delta = g.latest.price - g.previous.price;
    g.percent = g.previous.price ? g.delta / g.previous.price * 100 : 0;
    return g;
  }).sort(function(a,b){return Math.abs(b.percent)-Math.abs(a.percent);});
}

function returnAlerts() {
  const out = [];
  state().data.receipts.forEach(function (r) {
    if (!r.returnDeadline) return;
    const days = daysUntil(r.returnDeadline);
    if (days != null && days >= 0 && days <= 21 && r.returnStatus !== "closed") {
      out.push({ type:"receipt", id:r.id, title:r.merchant || "Receipt", date:r.returnDeadline, days:days, value:Number(r.total||0) });
    }
  });
  state().data.assets.forEach(function (a) {
    if (!a.returnDeadline) return;
    const days = daysUntil(a.returnDeadline);
    if (days != null && days >= 0 && days <= 21 && a.returnStatus !== "closed") {
      out.push({ type:"asset", id:a.id, title:a.name || "Asset", date:a.returnDeadline, days:days, value:Number(a.purchasePrice||0) });
    }
  });
  return out.sort(function(a,b){return a.days-b.days;});
}

function warrantyAlerts() {
  return state().data.assets.filter(function (a) {
    if (!a.warrantyExpiration) return false;
    const d = daysUntil(a.warrantyExpiration);
    return d != null && d >= 0 && d <= 90;
  }).map(function (a) {
    return { id:a.id, title:a.name, date:a.warrantyExpiration, days:daysUntil(a.warrantyExpiration) };
  }).sort(function(a,b){return a.days-b.days;});
}

function enhanceDashboard() {
  if (document.getElementById("p2-dashboard")) return;
  const opportunities = spendingOpportunities();
  const purchases = unlinkedPurchaseItems().slice(0,6);
  const returns = returnAlerts().slice(0,5);
  const warranties = warrantyAlerts().slice(0,5);

  const html = "<section id='p2-dashboard' class='section-gap'>" +
    "<div class='p2-section-title'><div><div class='eyebrow'>PHASE 2</div><h2>Attention Center</h2><p>NEXUS is connecting records and surfacing things that may need action.</p></div></div>" +
    "<div class='grid grid-2'>" +
      "<section class='card'><div class='card-title-row'><div><h2>Purchase Inbox</h2><div class='microcopy'>Receipt items that can become real records</div></div>" + statusBadge(String(purchases.length), purchases.length ? "amber" : "green") + "</div>" +
        (purchases.length ? "<div class='panel-list'>" + purchases.map(purchaseInboxRow).join("") + "</div>" : "<div class='empty-state'><strong>All caught up</strong><div>No unlinked durable purchases or books detected.</div></div>") +
      "</section>" +
      "<section class='card'><div class='card-title-row'><div><h2>Deadlines</h2><div class='microcopy'>Returns and warranties</div></div>" + statusBadge(String(returns.length + warranties.length), (returns.length+warranties.length) ? "amber" : "green") + "</div>" +
        deadlineRows(returns, warranties) +
      "</section>" +
    "</div>" +
    "<section class='card section-gap'><div class='card-title-row'><div><h2>Spending opportunities</h2><div class='microcopy'>Transparent observations—not automatic financial decisions</div></div></div>" +
      (opportunities.length ? "<div class='insight-grid'>" + opportunities.map(function (o) {
        return "<article class='insight'><div class='insight-label'>" + esc(o.type) + "</div><strong>" + esc(o.title) + "</strong><p>" + esc(o.text) + "</p></article>";
      }).join("") + "</div>" : "<div class='empty-state'><strong>No strong pattern yet</strong><div>NEXUS needs more spending history before it can make useful comparisons.</div></div>") +
    "</section></section>";
  document.getElementById("view").insertAdjacentHTML("beforeend", html);
}

function purchaseInboxRow(x) {
  return "<div class='list-row'><div class='list-main'><div class='list-title'>" + esc(x.item.name) + "</div><div class='list-sub'>" + esc(x.merchant) + " · " + dateText(x.date) + " · " + money(x.price) + "</div></div><div class='row-actions'>" +
    (isBookish(x.item) ? button("receipt-to-book","Add Book",{receipt:x.receipt.id,index:String(x.index)},"btn-secondary") : "") +
    (isDurable(x.item) ? button("receipt-to-asset","Create Asset",{receipt:x.receipt.id,index:String(x.index)},"btn-primary") : "") +
    "</div></div>";
}

function deadlineRows(returns, warranties) {
  const rows = [];
  returns.forEach(function (r) {
    rows.push("<div class='list-row'><div><div class='list-title'>" + esc(r.title) + "</div><div class='list-sub'>Return deadline · " + dateText(r.date) + "</div></div>" + statusBadge(r.days === 0 ? "Today" : r.days + "d", r.days <= 3 ? "red" : "amber") + "</div>");
  });
  warranties.forEach(function (w) {
    rows.push("<div class='list-row'><div><div class='list-title'>" + esc(w.title) + "</div><div class='list-sub'>Warranty expires · " + dateText(w.date) + "</div></div>" + statusBadge(w.days + "d", w.days <= 14 ? "red" : "amber") + "</div>");
  });
  return rows.length ? "<div class='panel-list'>" + rows.join("") + "</div>" : "<div class='empty-state'><strong>Nothing urgent</strong><div>No return or warranty deadlines are approaching.</div></div>";
}

function enhanceMoney() {
  if (document.getElementById("p2-money")) return;
  const merchants = merchantStats().slice(0,8);
  const recurring = recurringCandidates();
  const prices = priceHistoryGroups().slice(0,8);
  const opportunities = spendingOpportunities();

  const html = "<section id='p2-money' class='section-gap'>" +
    "<div class='p2-section-title'><div><div class='eyebrow'>INTELLIGENCE</div><h2>Deeper Spending Analysis</h2><p>Merchant behavior, repeated patterns, and your own item price history.</p></div></div>" +
    "<div class='grid grid-2'>" +
      "<section class='card'><div class='card-title-row'><div><h2>Merchant intelligence</h2><div class='microcopy'>Where your recorded spending goes</div></div></div>" +
        (merchants.length ? "<div class='panel-list'>" + merchants.map(function(m){
          return "<div class='list-row'><div><div class='list-title'>" + esc(m.name) + "</div><div class='list-sub'>" + m.count + " purchases · avg " + money(m.average) + "</div></div><div class='row-actions'><strong>" + money(m.total) + "</strong>" + button("merchant-profile","Profile",{merchant:m.key},"btn-ghost") + "</div></div>";
        }).join("") + "</div>" : "<div class='empty-state'><strong>No merchant history</strong><div>Transactions will build merchant profiles automatically.</div></div>") +
      "</section>" +
      "<section class='card'><div class='card-title-row'><div><h2>Repeated spending patterns</h2><div class='microcopy'>Candidates only—NEXUS does not assume they are subscriptions</div></div></div>" +
        (recurring.length ? "<div class='panel-list'>" + recurring.map(function(r){
          return "<div class='list-row'><div><div class='list-title'>" + esc(r.merchant) + "</div><div class='list-sub'>" + r.count + " purchases across " + r.months + " months</div></div><strong>" + money(r.average) + " avg</strong></div>";
        }).join("") + "</div>" : "<div class='empty-state'><strong>No repeated pattern yet</strong><div>More history is needed.</div></div>") +
      "</section>" +
    "</div>" +
    "<div class='grid grid-2 section-gap'>" +
      "<section class='card'><div class='card-title-row'><div><h2>Your price history</h2><div class='microcopy'>Built from repeated receipt items</div></div></div>" +
        (prices.length ? "<div class='panel-list'>" + prices.map(function(p){
          const cls = p.delta > .01 ? "red" : p.delta < -.01 ? "green" : "";
          const sign = p.delta > 0 ? "+" : "";
          return "<div class='list-row'><div><div class='list-title'>" + esc(p.latest.name) + "</div><div class='list-sub'>" + esc(p.latest.merchant) + " · " + dateText(p.latest.date) + "</div></div><div class='row-actions'>" + statusBadge(sign + p.percent.toFixed(1) + "%", cls) + button("price-history","History",{key:p.key},"btn-ghost") + "</div></div>";
        }).join("") + "</div>" : "<div class='empty-state'><strong>No repeat items yet</strong><div>Once the same product appears on multiple receipts, NEXUS will compare its price.</div></div>") +
      "</section>" +
      "<section class='card'><div class='card-title-row'><div><h2>Possible cutback areas</h2><div class='microcopy'>Based only on your recorded patterns</div></div></div>" +
        (opportunities.length ? "<div class='panel-list'>" + opportunities.map(function(o){
          return "<div class='list-row'><div><div class='list-title'>" + esc(o.title) + "</div><div class='list-sub'>" + esc(o.text) + "</div></div></div>";
        }).join("") + "</div>" : "<div class='empty-state'><strong>No unusual increase</strong><div>Your current month does not show a strong overspending pattern yet.</div></div>") +
      "</section>" +
    "</div></section>";
  document.getElementById("view").insertAdjacentHTML("beforeend", html);
}

function enhanceReceipts() {
  if (!document.getElementById("p2-receipt-summary")) {
    const pending = unlinkedPurchaseItems();
    const section = "<section id='p2-receipt-summary' class='card section-gap'><div class='card-title-row'><div><h2>Purchase Connections</h2><div class='microcopy'>Turn receipt line items into Assets or Library records without retyping the purchase</div></div>" +
      statusBadge(pending.length + " ready", pending.length ? "amber" : "green") + "</div>" +
      (pending.length ? "<div class='panel-list'>" + pending.slice(0,8).map(purchaseInboxRow).join("") + "</div>" : "<div class='inline-note'>All detected durable goods and books are already linked or there are none to process.</div>") +
      "</section>";
    const stats = document.querySelector("#view .grid.grid-3");
    if (stats) stats.insertAdjacentHTML("afterend", section);
  }

  document.querySelectorAll("#receipt-rows tr").forEach(function(row){
    const viewBtn = row.querySelector("[data-action='view-receipt']");
    if (!viewBtn || row.querySelector("[data-p2-action='receipt-tools']")) return;
    const actions = row.querySelector(".row-actions");
    if (actions) actions.insertAdjacentHTML("afterbegin", button("receipt-tools","Tools",{id:viewBtn.dataset.id},"btn-secondary"));
  });
}

function finderReportsOpen() {
  return state().data.finderReports.filter(function (r) { return r.status === "new" || r.status === "contacted"; });
}

function finderReportContext(report) {
  const tag = state().data.qrTags.find(function (t) {
    return t.publicSlug === report.publicSlug || t.labelCode === report.labelCode || t.id === report.labelCode;
  });
  let asset = null, book = null, location = null;
  if (tag && tag.targetType === "asset") asset = assetFor(tag.targetId);
  if (tag && tag.targetType === "book") book = bookFor(tag.targetId);
  if (tag && tag.targetType === "location") location = byId(state().data.locations, tag.targetId);
  const label = asset ? asset.name :
    book ? book.title :
    location ? (n().locationName(location.id) || location.name) :
    tag && tag.targetLabel ? tag.targetLabel :
    report.labelCode || "Tagged item";
  return {
    tag: tag,
    asset: asset,
    book: book,
    location: location,
    targetType: tag ? tag.targetType : report.targetType || "tag",
    targetId: tag ? tag.targetId : null,
    label: label
  };
}

function finderReportRow(report) {
  const ctx = finderReportContext(report);
  const status = report.status === "contacted" ? statusBadge("CONTACTED","gold") : statusBadge("NEW","red");
  return "<div class='list-row finder-report-row'><div class='list-main'><div class='list-title'>Finder report · " + esc(ctx.label) +
    "</div><div class='list-sub'>" + esc(report.reporterName || "Unknown finder") +
    (report.foundLocation ? " · " + esc(report.foundLocation) : "") + " · " + dateText(report.createdAt) +
    "</div></div><div class='row-actions'>" + status + button("finder-report","View",{id:report.id},"btn-primary") + "</div></div>";
}

function enhanceAssets() {
  const finderReports = finderReportsOpen();
  injectHeaderButton("<button class='btn btn-secondary' data-p2-action='asset-attention'>◷ Needs Attention" + (finderReports.length ? " · " + finderReports.length : "") + "</button>");
  if (!document.getElementById("p2-asset-attention")) {
    const returns = returnAlerts().filter(function(x){return x.type==="asset";});
    const warranty = warrantyAlerts();
    const lost = state().data.assets.filter(function(a){return a.lostMode;});
    const html = "<section id='p2-asset-attention' class='card section-gap'><div class='card-title-row'><div><h2>Needs Attention</h2><div class='microcopy'>Finder reports, returns, warranties, and lost-item status</div></div>" +
      (finderReports.length ? statusBadge(finderReports.length + " finder report" + (finderReports.length === 1 ? "" : "s"),"red") : statusBadge("CLEAR","green")) +
      "</div><div class='grid grid-4'>" +
      "<div class='insight'><div class='insight-label'>Finder Reports</div><strong>" + finderReports.length + " open</strong><p>Private reports submitted from public QR scans.</p></div>" +
      "<div class='insight'><div class='insight-label'>Returns</div><strong>" + returns.length + " approaching</strong><p>Within the next 21 days.</p></div>" +
      "<div class='insight'><div class='insight-label'>Warranties</div><strong>" + warranty.length + " approaching</strong><p>Within the next 90 days.</p></div>" +
      "<div class='insight'><div class='insight-label'>Lost Mode</div><strong>" + lost.length + " active</strong><p>Public QR behavior changes while Lost Mode is active.</p></div></div>" +
      (finderReports.length ? "<div class='divider'></div><div class='card-title-row'><div><h3>Finder reports</h3><div class='microcopy'>Newest open reports</div></div><button class='btn btn-small btn-secondary' data-p2-action='finder-reports'>View all</button></div><div class='panel-list'>" + finderReports.slice(0,5).map(finderReportRow).join("") + "</div>" : "") +
      "</section>";
    const stats = document.querySelector("#view .grid.grid-4") || document.querySelector("#view .grid.grid-3");
    if (stats) stats.insertAdjacentHTML("afterend", html);
  }

  document.querySelectorAll("#asset-grid .entity-card").forEach(function(card){
    const edit = card.querySelector("[data-action='edit-asset']");
    if (!edit || card.querySelector("[data-p2-asset-actions]")) return;
    const id = edit.dataset.id;
    const asset = assetFor(id);
    const actions = card.querySelector(".row-actions");
    if (!actions || !asset) return;
    actions.setAttribute("data-p2-asset-actions","");
    const lostLabel = asset.lostMode ? "Mark Found" : "Lost Mode";
    const lostClass = asset.lostMode ? "btn-primary" : "btn-ghost";
    actions.insertAdjacentHTML("beforeend",
      button("toggle-lost",lostLabel,{id:id},lostClass) +
      button("asset-return","Return",{id:id},"btn-ghost") +
      (asset.sourceReceiptId ? button("linked-receipt","Receipt",{id:asset.sourceReceiptId},"btn-ghost") : "") +
      button("asset-history","History",{id:id},"btn-ghost")
    );
    const details = [];
    if (asset.sourceReceiptId) details.push("Linked receipt");
    if (asset.returnDeadline) details.push("Return " + dateText(asset.returnDeadline));
    if (asset.warrantyExpiration) details.push("Warranty " + dateText(asset.warrantyExpiration));
    if (details.length) card.insertAdjacentHTML("beforeend","<div class='p2-connection-line'>↳ " + esc(details.join(" · ")) + "</div>");
  });
}

function enhanceQr() {
  injectHeaderButton("<button class='btn btn-secondary' data-p2-action='print-studio'>▤ Print Studio</button>");
  if (!document.getElementById("p2-qr-lifecycle")) {
    const retired = state().data.qrTags.filter(function(t){return t.status==="retired";}).length;
    const assigned = state().data.qrTags.filter(function(t){return t.status==="assigned";}).length;
    const html = "<section id='p2-qr-lifecycle' class='card section-gap'><div class='card-title-row'><div><h2>Tag Lifecycle</h2><div class='microcopy'>Tags can be reset and reused or permanently retired.</div></div></div><div class='grid grid-3'>" +
      "<div class='insight'><div class='insight-label'>Assigned</div><strong>" + assigned + "</strong><p>Currently attached to a record.</p></div>" +
      "<div class='insight'><div class='insight-label'>Unassigned</div><strong>" + state().data.qrTags.filter(function(t){return t.status==="unassigned";}).length + "</strong><p>Ready for your next item.</p></div>" +
      "<div class='insight'><div class='insight-label'>Retired</div><strong>" + retired + "</strong><p>Kept for history but no longer reusable.</p></div></div></section>";
    const stats = document.querySelector("#view .grid.grid-3");
    if (stats) stats.insertAdjacentHTML("afterend",html);
  }
  document.querySelectorAll("#qr-grid .entity-card").forEach(function(card){
    const print = card.querySelector("[data-action='print-one-tag']");
    if (!print || card.querySelector("[data-p2-qr-actions]")) return;
    const tag = byId(state().data.qrTags, print.dataset.code);
    const actions = card.querySelector(".row-actions");
    if (!tag || !actions) return;
    actions.setAttribute("data-p2-qr-actions","");
    if (tag.status === "assigned") {
      actions.insertAdjacentHTML("beforeend",button("reset-tag","Reset",{code:tag.id},"btn-ghost")+button("retire-tag","Retire",{code:tag.id},"btn-danger"));
    } else if (tag.status === "unassigned") {
      actions.insertAdjacentHTML("beforeend",button("retire-tag","Retire",{code:tag.id},"btn-danger"));
    }
  });
}

function enhanceLibrary() {
  injectHeaderButton("<button class='btn btn-secondary' data-p2-action='bibliography'>Bibliography</button><button class='btn btn-secondary' data-p2-action='shelf-report'>Shelf Report</button>");
  if (!document.getElementById("p2-library-intelligence")) {
    const books = state().data.books;
    const authors = new Set(books.map(function(b){return norm(b.author);}).filter(Boolean)).size;
    const publishers = new Set(books.map(function(b){return norm(b.publisher);}).filter(Boolean)).size;
    const notes = books.reduce(function(s,b){return s+(b.researchNotes||[]).length;},0);
    const finished = books.filter(function(b){return b.readingStatus==="Finished";}).length;
    const html = "<section id='p2-library-intelligence' class='card section-gap'><div class='card-title-row'><div><h2>Library Intelligence</h2><div class='microcopy'>Your collection as a research system</div></div></div><div class='grid grid-4'>" +
      "<div class='insight'><div class='insight-label'>Authors</div><strong>" + authors + "</strong><p>Unique normalized author names.</p></div>" +
      "<div class='insight'><div class='insight-label'>Publishers</div><strong>" + publishers + "</strong><p>Represented in your catalog.</p></div>" +
      "<div class='insight'><div class='insight-label'>Research Notes</div><strong>" + notes + "</strong><p>Searchable notes tied to your copies.</p></div>" +
      "<div class='insight'><div class='insight-label'>Finished</div><strong>" + finished + "</strong><p>" + (books.length ? Math.round(finished/books.length*100) : 0) + "% of catalog marked finished.</p></div></div></section>";
    const stats = document.querySelector("#view .grid.grid-4");
    if (stats) stats.insertAdjacentHTML("afterend",html);
  }
  document.querySelectorAll("#book-rows tr").forEach(function(row){
    const edit = row.querySelector("[data-action='edit-book']");
    if (!edit || row.querySelector("[data-p2-book-actions]")) return;
    const actions = row.querySelector(".row-actions");
    if (!actions) return;
    actions.setAttribute("data-p2-book-actions","");
    const book = bookFor(edit.dataset.id);
    actions.insertAdjacentHTML("beforeend",
      button("reading-log","Reading",{id:edit.dataset.id},"btn-ghost") +
      button("research-note","Note",{id:edit.dataset.id},"btn-ghost") +
      (book && book.sourceReceiptId ? button("linked-receipt","Receipt",{id:book.sourceReceiptId},"btn-ghost") : "")
    );
  });
}

function enhanceLocations() {
  injectHeaderButton("<button class='btn btn-secondary' data-p2-action='inventory-audit'>▦ Inventory Scan</button>");
  if (!document.getElementById("p2-location-help")) {
    const html = "<section id='p2-location-help' class='card section-gap'><div class='card-title-row'><div><h2>Inventory Mode</h2><div class='microcopy'>Use location QR codes and item tags together</div></div></div><div class='inline-note'>Choose a location, then scan items continuously. Audit mode compares what you scanned with what NEXUS expected there. Move mode can relocate every scanned Asset or Book into the selected location in one batch.</div></section>";
    const stats = document.querySelector("#view .grid.grid-3");
    if (stats) stats.insertAdjacentHTML("afterend",html);
  }
}

function enhanceSearch() {
  const term = state().searchTerm || "";
  if (!term || document.getElementById("p2-answer")) return;
  const answer = commandAnswer(term);
  const notes = searchResearchNotes(term);
  if (!answer && !notes.length) return;
  const target = document.querySelector("#view .search-results") || document.querySelector("#view .card");
  if (!target) return;
  let html = "";
  if (answer) {
    html += "<section id='p2-answer' class='card p2-answer'><div class='eyebrow'>NEXUS ANSWER</div><h2>" + esc(answer.title) + "</h2><p>" + esc(answer.text) + "</p>" + (answer.details || "") + "</section>";
  } else {
    html += "<div id='p2-answer'></div>";
  }
  if (notes.length) {
    html += "<section class='card'><div class='card-title-row'><div><h2>Research notes</h2><div class='microcopy'>Matches inside your own library notes</div></div>" + statusBadge(String(notes.length),"gold") + "</div><div class='panel-list'>" +
      notes.slice(0,10).map(function(x){return "<div class='list-row'><div><div class='list-title'>" + esc(x.book.title) + (x.note.page ? " · p. " + esc(x.note.page) : "") + "</div><div class='list-sub'>" + esc(x.note.text) + "</div></div></div>";}).join("") + "</div></section>";
  }
  target.insertAdjacentHTML("beforebegin",html);
}

function enhanceSettings() {
  if (document.getElementById("p2-settings")) return;
  const html = "<section id='p2-settings' class='card section-gap'><div class='card-title-row'><div><h2>Phase 2 Connections</h2><div class='microcopy'>Inter-module capabilities now active</div></div>" + statusBadge("ACTIVE","green") + "</div>" +
    "<div class='grid grid-3'><div class='insight'><div class='insight-label'>Receipt → Record</div><strong>Connected purchases</strong><p>Turn detected receipt items into Assets or Books while preserving the purchase link.</p></div>" +
    "<div class='insight'><div class='insight-label'>Physical World</div><strong>Inventory scanning</strong><p>Audit or relocate tagged items by scanning them into a NEXUS location.</p></div>" +
    "<div class='insight'><div class='insight-label'>Knowledge</div><strong>Research layer</strong><p>Reading history, research notes, bibliography export, and natural-language answers.</p></div></div></section>";
  document.getElementById("view").insertAdjacentHTML("beforeend",html);
}

function commandAnswer(term) {
  const q = norm(term);
  let m;
  if ((m = q.match(/where is (?:my )?(.+)/))) {
    const needle = m[1];
    const asset = state().data.assets.find(function(a){return norm(a.name).includes(needle);});
    const book = state().data.books.find(function(b){return norm(b.title).includes(needle);});
    const item = asset || book;
    if (item) {
      const loc = n().locationName(item.locationId);
      return { title:item.name || item.title, text:loc ? "NEXUS has it at " + loc + "." : "It is registered, but no location is assigned yet." };
    }
  }
  if ((m = q.match(/how much (?:did i |have i )?(?:spend|spent)(?: at| on)? (.+?)(?: this month| this year|$)/))) {
    let needle = m[1].trim();
    const thisYear = /this year/.test(q);
    const thisMonth = /this month/.test(q);
    const matches = state().data.transactions.filter(function(t){
      if ((t.type||"expense")!=="expense") return false;
      if (!norm([t.merchant,t.category,t.note].join(" ")).includes(needle)) return false;
      const d = new Date((t.date||todayISO())+"T12:00:00");
      if (thisYear && d.getFullYear() !== new Date().getFullYear()) return false;
      if (thisMonth && monthKey(t.date) !== monthKey(new Date())) return false;
      return true;
    });
    const total = matches.reduce(function(s,t){return s+Number(t.amount||0);},0);
    return { title:money(total), text:"Across " + matches.length + " matching recorded purchase" + (matches.length===1?"":"s") + "." };
  }
  if (/warrant/.test(q) && /expir|soon|attention/.test(q)) {
    const alerts = warrantyAlerts();
    return { title:alerts.length + " warranties approaching", text:alerts.length ? "These expire within the next 90 days." : "No registered asset warranty expires within the next 90 days.",
      details:alerts.length ? "<div class='panel-list' style='margin-top:12px'>" + alerts.map(function(x){return "<div class='list-row'><span>"+esc(x.title)+"</span>"+statusBadge(x.days+"d","amber")+"</div>";}).join("")+"</div>" : "" };
  }
  if (/what can i return|return deadline|returns/.test(q)) {
    const alerts=returnAlerts();
    return {title:alerts.length+" return windows approaching",text:alerts.length?"Within the next 21 days.":"Nothing with a recorded return deadline is approaching.",
      details:alerts.length ? "<div class='panel-list' style='margin-top:12px'>" + alerts.map(function(x){return "<div class='list-row'><span>"+esc(x.title)+"</span>"+statusBadge(x.days+"d","amber")+"</div>";}).join("")+"</div>" : ""};
  }
  if (/how many books|books do i own/.test(q)) {
    return { title:String(state().data.books.length) + " books", text:"Currently cataloged in your NEXUS library." };
  }
  if (/unassigned/.test(q) && /qr|tag/.test(q)) {
    const count=state().data.qrTags.filter(function(t){return t.status==="unassigned";}).length;
    return {title:count+" unassigned QR tags",text:"Ready to cut, tape, and assign."};
  }
  if ((m=q.match(/do i own (?:a |an |the )?(.+)/))) {
    const needle=m[1];
    const assets=state().data.assets.filter(function(a){return norm(a.name).includes(needle);});
    const books=state().data.books.filter(function(b){return norm([b.title,b.author].join(" ")).includes(needle);});
    const total=assets.length+books.length;
    return {title:total ? "Yes — " + total + " match" + (total===1?"":"es") : "No registered match",text:total ? "NEXUS found it in your Assets or Library." : "Nothing matching that description is currently registered."};
  }
  return null;
}

function searchResearchNotes(term) {
  const q=norm(term);
  if (!q) return [];
  const out=[];
  state().data.books.forEach(function(book){
    (book.researchNotes||[]).forEach(function(note){
      if (norm([note.text,note.tags,note.page,book.title,book.author].join(" ")).includes(q)) out.push({book:book,note:note});
    });
  });
  return out;
}

async function onClick(event) {
  const btn = event.target.closest("[data-p2-action]");
  if (!btn) return;
  event.preventDefault();
  const action=btn.dataset.p2Action;
  try {
    if (action==="receipt-to-asset") return openReceiptToAsset(btn.dataset.receipt,Number(btn.dataset.index));
    if (action==="receipt-to-book") return openReceiptToBook(btn.dataset.receipt,Number(btn.dataset.index));
    if (action==="receipt-tools") return openReceiptTools(btn.dataset.id);
    if (action==="merchant-profile") return openMerchantProfile(btn.dataset.merchant);
    if (action==="price-history") return openPriceHistory(btn.dataset.key);
    if (action==="toggle-lost") return toggleLost(btn.dataset.id);
    if (action==="asset-history") return openAssetHistory(btn.dataset.id);
    if (action==="asset-return") return openAssetReturn(btn.dataset.id);
    if (action==="linked-receipt") return n().openReceiptDetail(receiptFor(btn.dataset.id));
    if (action==="print-studio") return openPrintStudio();
    if (action==="reset-tag") return resetTag(btn.dataset.code);
    if (action==="retire-tag") return retireTag(btn.dataset.code);
    if (action==="bibliography") return openBibliography();
    if (action==="shelf-report") return openShelfReport();
    if (action==="reading-log") return openReadingLog(btn.dataset.id);
    if (action==="research-note") return openResearchNote(btn.dataset.id);
    if (action==="inventory-audit") return openInventoryAudit();
    if (action==="asset-attention") return openAssetAttention();
    if (action==="finder-reports") return openFinderReports();
    if (action==="finder-report") return openFinderReport(btn.dataset.id);
    if (action==="open-report-record") {
      const type=btn.dataset.type;
      const id=btn.dataset.id;
      n().closeModal();
      const view=type==="book" ? "library" : type==="location" ? "locations" : "assets";
      n().setActiveView(view);
      setTimeout(function(){
        let selector="";
        if(type==="asset") selector="[data-action='edit-asset'][data-id='"+CSS.escape(id)+"']";
        else if(type==="book") selector="[data-action='edit-book'][data-id='"+CSS.escape(id)+"']";
        else if(type==="location") selector="[data-action='edit-location'][data-id='"+CSS.escape(id)+"']";
        const target=selector ? document.querySelector(selector) : null;
        if(target) target.scrollIntoView({behavior:"smooth",block:"center"});
      },80);
      return;
    }
  } catch(error) {
    console.error(error);
    n().toast("Phase 2 error",error.message || "Something went wrong.","error");
  }
}

async function updateReceiptItem(receiptId,index,patch) {
  const receipt=receiptFor(receiptId);
  if (!receipt) throw new Error("Receipt not found.");
  const items=(receipt.items||[]).map(function(item,i){return i===index ? Object.assign({},item,patch) : item;});
  await updateDoc(doc(db(),"receipts",receiptId),{items:items,updatedAt:serverTimestamp()});
}

function openReceiptToAsset(receiptId,index) {
  const r=receiptFor(receiptId), item=r && (r.items||[])[index];
  if (!r || !item) return;
  const body="<form id='p2-create-asset' class='form-grid'>" +
    "<div class='field full'><label>Asset name</label><input name='name' required value='"+esc(item.name||"")+"'></div>" +
    "<div class='field'><label>Category</label><select name='category'>" + ["Electronics","Computer","School","Furniture","Tool","Container","Collectible","Appliance","Other"].map(function(c){return "<option "+(norm(item.category).includes(norm(c))?"selected":"")+">"+esc(c)+"</option>";}).join("") + "</select></div>" +
    "<div class='field'><label>Purchase price</label><input name='purchasePrice' type='number' step='0.01' min='0' value='"+esc(item.price||"")+"'></div>" +
    "<div class='field'><label>Model</label><input name='model'></div><div class='field'><label>Serial number</label><input name='serialNumber'></div>" +
    "<div class='field'><label>Location</label><select name='locationId'><option value=''>Not assigned</option>"+state().data.locations.map(function(l){return "<option value='"+esc(l.id)+"'>"+esc(n().locationName(l.id)||l.name)+"</option>";}).join("")+"</select></div>" +
    "<div class='field'><label>Warranty expiration</label><input name='warrantyExpiration' type='date'></div>" +
    "<div class='field'><label>Return deadline</label><input name='returnDeadline' type='date' value='"+esc(r.returnDeadline||"")+"'></div>" +
    "<label class='check-row full'><input type='checkbox' name='createQr' checked> Create a QR tag now</label></form>" +
    "<div class='inline-note' style='margin-top:12px'>Purchase link: "+esc(r.merchant||"Receipt")+" · "+dateText(r.date)+" · "+money(item.price)+"</div>";
  const modal=n().openModal("Create Asset from Receipt",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-save-asset'>Create Asset</button>"});
  modal.querySelector("#p2-save-asset").onclick=async function(){
    const form=modal.querySelector("#p2-create-asset");
    if(!form.reportValidity())return;
    const data={
      name:form.elements.name.value.trim(),category:form.elements.category.value,purchasePrice:Number(form.elements.purchasePrice.value||0),
      purchaseDate:r.date,sourceReceiptId:r.id,sourceReceiptItemIndex:index,sourceMerchant:r.merchant||"",
      model:form.elements.model.value.trim(),serialNumber:form.elements.serialNumber.value.trim(),locationId:form.elements.locationId.value||null,
      warrantyExpiration:form.elements.warrantyExpiration.value,returnDeadline:form.elements.returnDeadline.value,condition:"Good",
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    };
    const ref=await addDoc(collection(db(),"assets"),data);
    if(form.elements.createQr.checked) await n().createTagForEntity("asset",ref.id,data.name,"standard",false);
    await updateReceiptItem(r.id,index,{linkedAssetId:ref.id,linkedAt:new Date().toISOString()});
    await n().writeActivity("asset","Receipt item became an asset","asset",ref.id,data.name+" · "+money(data.purchasePrice));
    n().closeModal();
    await n().refresh(["assets","receipts","qrTags","activity"]);
    n().toast("Connected","The purchase is now an Asset and remains linked to its receipt.","success");
  };
}

function openReceiptToBook(receiptId,index) {
  const r=receiptFor(receiptId), item=r && (r.items||[])[index];
  if (!r || !item) return;
  const body="<form id='p2-create-book' class='form-grid'>" +
    "<div class='field full'><label>Title</label><input name='title' required value='"+esc(item.name||"")+"'></div>" +
    "<div class='field'><label>Author</label><input name='author'></div><div class='field'><label>ISBN</label><input name='isbn'></div>" +
    "<div class='field'><label>Publisher</label><input name='publisher'></div><div class='field'><label>Purchase price</label><input name='purchasePrice' type='number' step='0.01' min='0' value='"+esc(item.price||"")+"'></div>" +
    "<div class='field'><label>Shelf / location</label><select name='locationId'><option value=''>Not assigned</option>"+state().data.locations.map(function(l){return "<option value='"+esc(l.id)+"'>"+esc(n().locationName(l.id)||l.name)+"</option>";}).join("")+"</select></div>" +
    "<div class='field'><label>Reading status</label><select name='readingStatus'><option>Unread</option><option>Reading</option><option>Finished</option><option>Reference</option></select></div>" +
    "<label class='check-row full'><input type='checkbox' name='createQr' checked> Create a book QR label</label></form>" +
    "<div class='inline-note' style='margin-top:12px'>Purchase link: "+esc(r.merchant||"Receipt")+" · "+dateText(r.date)+" · "+money(item.price)+"</div>";
  const modal=n().openModal("Add Book from Receipt",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-save-book'>Add to Library</button>"});
  modal.querySelector("#p2-save-book").onclick=async function(){
    const form=modal.querySelector("#p2-create-book");
    if(!form.reportValidity())return;
    const data={title:form.elements.title.value.trim(),author:form.elements.author.value.trim(),isbn:form.elements.isbn.value.replace(/[^0-9Xx]/g,""),
      publisher:form.elements.publisher.value.trim(),purchasePrice:Number(form.elements.purchasePrice.value||0),purchaseDate:r.date,
      sourceReceiptId:r.id,sourceReceiptItemIndex:index,sourceMerchant:r.merchant||"",locationId:form.elements.locationId.value||null,
      readingStatus:form.elements.readingStatus.value,format:"Other",collections:[],researchNotes:[],readingHistory:[],
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()};
    if(data.isbn){
      try{
        const meta=await n().lookupIsbn(data.isbn);
        if(!data.author)data.author=meta.author||"";
        if(!data.publisher)data.publisher=meta.publisher||"";
        if(data.title===item.name && meta.title)data.title=meta.title;
        data.year=meta.year||"";
      }catch(_){}
    }
    const ref=await addDoc(collection(db(),"books"),data);
    if(form.elements.createQr.checked) await n().createTagForEntity("book",ref.id,data.title,"book",false);
    await updateReceiptItem(r.id,index,{linkedBookId:ref.id,linkedAt:new Date().toISOString()});
    await n().writeActivity("book","Receipt item added to library","book",ref.id,data.title);
    n().closeModal();
    await n().refresh(["books","receipts","qrTags","activity"]);
    n().toast("Connected","The purchase is now a Library record and remains linked to its receipt.","success");
  };
}

function openReceiptTools(id) {
  const r=receiptFor(id);
  if(!r)return;
  const linked=(r.items||[]).filter(function(i){return i.linkedAssetId||i.linkedBookId;}).length;
  const body="<div class='grid grid-3'><div class='insight'><div class='insight-label'>Items</div><strong>"+(r.items||[]).length+"</strong><p>Detected line items.</p></div>" +
    "<div class='insight'><div class='insight-label'>Connected</div><strong>"+linked+"</strong><p>Already linked to Assets or Books.</p></div>" +
    "<div class='insight'><div class='insight-label'>Return deadline</div><strong>"+esc(r.returnDeadline?dateText(r.returnDeadline):"Not set")+"</strong><p>Optional reminder window.</p></div></div>" +
    "<div class='divider'></div><form id='p2-receipt-tools' class='form-grid'><div class='field'><label>Return deadline</label><input name='returnDeadline' type='date' value='"+esc(r.returnDeadline||"")+"'></div>" +
    "<div class='field'><label>Return status</label><select name='returnStatus'><option value='open' "+(r.returnStatus!=="closed"?"selected":"")+">Open</option><option value='closed' "+(r.returnStatus==="closed"?"selected":"")+">Closed / no longer needed</option></select></div></form>" +
    "<div class='divider'></div><div class='panel-list'>"+(r.items||[]).map(function(item,index){
      let right="";
      if(item.linkedAssetId) right=statusBadge("Asset","green");
      else if(item.linkedBookId) right=statusBadge("Book","green");
      else right=(isBookish(item)?button("receipt-to-book","Add Book",{receipt:r.id,index:String(index)},"btn-ghost"):"")+(isDurable(item)?button("receipt-to-asset","Asset",{receipt:r.id,index:String(index)},"btn-ghost"):"");
      return "<div class='list-row'><div><div class='list-title'>"+esc(item.name)+"</div><div class='list-sub'>"+esc(item.category||"Other")+" · "+money(item.price)+"</div></div><div class='row-actions'>"+right+"</div></div>";
    }).join("")+"</div>";
  const modal=n().openModal("Receipt Tools",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-save-receipt-tools'>Save</button>"});
  modal.querySelector("#p2-save-receipt-tools").onclick=async function(){
    const form=modal.querySelector("#p2-receipt-tools");
    await updateDoc(doc(db(),"receipts",r.id),{returnDeadline:form.elements.returnDeadline.value,returnStatus:form.elements.returnStatus.value,updatedAt:serverTimestamp()});
    n().closeModal();
    await n().refresh(["receipts"]);
    n().toast("Receipt updated","Return tracking was saved.","success");
  };
}

function openMerchantProfile(key) {
  const m=merchantStats().find(function(x){return x.key===key;});
  if(!m)return;
  const tx=state().data.transactions.filter(function(t){return norm(t.merchant||"")===key;}).sort(function(a,b){return String(b.date).localeCompare(String(a.date));});
  const body="<div class='grid grid-3'><div class='insight'><div class='insight-label'>Total spent</div><strong>"+money(m.total)+"</strong><p>Across all recorded history.</p></div>" +
    "<div class='insight'><div class='insight-label'>Purchases</div><strong>"+m.count+"</strong><p>Average "+money(m.average)+".</p></div>" +
    "<div class='insight'><div class='insight-label'>Top category</div><strong>"+esc(m.topCategory?m.topCategory[0]:"—")+"</strong><p>"+(m.topCategory?money(m.topCategory[1]):"No category data")+"</p></div></div>" +
    "<div class='divider'></div><div class='panel-list'>"+tx.slice(0,30).map(function(t){return "<div class='list-row'><div><div class='list-title'>"+dateText(t.date)+"</div><div class='list-sub'>"+esc(t.category||"Other")+"</div></div><strong>"+money(t.amount)+"</strong></div>";}).join("")+"</div>";
  n().openModal(m.name,body,{wide:true});
}

function openPriceHistory(key) {
  const g=priceHistoryGroups().find(function(x){return x.key===key;});
  if(!g)return;
  const body="<div class='card-title-row'><div><h2>"+esc(g.latest.name)+"</h2><div class='microcopy'>Your own receipt history</div></div>"+statusBadge((g.percent>=0?"+":"")+g.percent.toFixed(1)+"%",g.percent>0?"red":g.percent<0?"green":"")+"</div>" +
    "<div class='panel-list'>"+g.entries.slice().reverse().map(function(e){return "<div class='list-row'><div><div class='list-title'>"+esc(e.merchant)+"</div><div class='list-sub'>"+dateText(e.date)+"</div></div><strong>"+money(e.price)+"</strong></div>";}).join("")+"</div>";
  n().openModal("Price History",body,{wide:false});
}

async function toggleLost(assetId) {
  const asset=assetFor(assetId);
  if(!asset)return;
  const next=!asset.lostMode;
  let message=asset.lostPublicMessage||"This item has been reported lost. If you know the owner, please help return it.";
  if(next){
    const entered=prompt("Optional public message shown when this QR is scanned:",message);
    if(entered===null)return;
    message=entered.trim()||message;
  }
  await updateDoc(doc(db(),"assets",asset.id),{lostMode:next,lostPublicMessage:message,lostReportedAt:next?new Date().toISOString():null,updatedAt:serverTimestamp()});
  const tag=tagForEntity("asset",asset.id);
  if(tag){
    await setDoc(doc(db(),"publicQr",tag.publicSlug),{
      status:next?"lost":"active",
      publicTitle:next?"Lost Registered Property":"Registered Personal Property",
      publicMessage:next?message:"This QR tag belongs to a private NEXUS installation.",
      updatedAt:serverTimestamp()
    },{merge:true});
  }
  await n().writeActivity("asset",next?"Lost Mode activated":"Asset marked found","asset",asset.id,asset.name);
  await n().refresh(["assets","activity","qrTags"]);
  n().toast(next?"Lost Mode active":"Asset recovered",next?"Public QR scans now show the lost-item message.":"The QR returned to normal public mode.","success");
}

function openAssetReturn(assetId) {
  const asset=assetFor(assetId);
  if(!asset)return;
  const body="<form id='p2-asset-return' class='form-grid'><div class='field'><label>Return deadline</label><input name='returnDeadline' type='date' value='"+esc(asset.returnDeadline||"")+"'></div>"+
    "<div class='field'><label>Status</label><select name='returnStatus'><option value='open' "+(asset.returnStatus!=="closed"?"selected":"")+">Open</option><option value='closed' "+(asset.returnStatus==="closed"?"selected":"")+">Closed / keep item</option></select></div>"+
    "<div class='field full'><label>Return note</label><textarea name='returnNote'>"+esc(asset.returnNote||"")+"</textarea></div></form>";
  const modal=n().openModal(asset.name+" · Return Tracking",body,{footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-save-asset-return'>Save</button>"});
  modal.querySelector("#p2-save-asset-return").onclick=async function(){
    const form=modal.querySelector("#p2-asset-return");
    await updateDoc(doc(db(),"assets",asset.id),{
      returnDeadline:form.elements.returnDeadline.value,
      returnStatus:form.elements.returnStatus.value,
      returnNote:form.elements.returnNote.value.trim(),
      updatedAt:serverTimestamp()
    });
    await n().writeActivity("asset","Return tracking updated","asset",asset.id,asset.name);
    n().closeModal();
    await n().refresh(["assets","activity"]);
    n().toast("Return tracking saved","NEXUS will surface the deadline when it approaches.","success");
  };
}

function openAssetHistory(assetId) {
  const asset=assetFor(assetId);
  if(!asset)return;
  const activity=state().data.activity.filter(function(a){return a.entityType==="asset" && a.entityId===assetId;});
  const r=asset.sourceReceiptId?receiptFor(asset.sourceReceiptId):null;
  const body=(r?"<div class='inline-note'>Purchased at "+esc(r.merchant||"Unknown")+" on "+dateText(r.date)+" · "+money(asset.purchasePrice)+"</div><div class='divider'></div>":"")+
    (activity.length?"<div class='panel-list'>"+activity.map(function(a){return "<div class='list-row'><div><div class='list-title'>"+esc(a.label)+"</div><div class='list-sub'>"+esc(a.detail||"")+"</div></div><span class='microcopy'>"+dateText(a.createdAt)+"</span></div>";}).join("")+"</div>":"<div class='empty-state'><strong>No history yet</strong><div>Future asset events will appear here.</div></div>");
  n().openModal(asset.name+" · History",body,{wide:true});
}

function openAssetAttention() {
  const reports=finderReportsOpen();
  const ret=returnAlerts().filter(function(x){return x.type==="asset";});
  const war=warrantyAlerts();
  const lost=state().data.assets.filter(function(a){return a.lostMode;});
  const rows=
    reports.map(finderReportRow).join("")+
    ret.map(function(x){return "<div class='list-row'><div><div class='list-title'>Return · "+esc(x.title)+"</div><div class='list-sub'>"+dateText(x.date)+"</div></div>"+statusBadge(x.days+"d","amber")+"</div>";}).join("")+
    war.map(function(x){return "<div class='list-row'><div><div class='list-title'>Warranty · "+esc(x.title)+"</div><div class='list-sub'>"+dateText(x.date)+"</div></div>"+statusBadge(x.days+"d","amber")+"</div>";}).join("")+
    lost.map(function(x){return "<div class='list-row'><div><div class='list-title'>Lost Mode · "+esc(x.name)+"</div><div class='list-sub'>Public QR is in lost-item mode.</div></div>"+statusBadge("LOST","red")+"</div>";}).join("");
  const body=rows ? "<div class='panel-list'>"+rows+"</div>" : "<div class='empty-state'><strong>Nothing needs attention</strong><div>No finder reports, approaching deadlines, or lost assets.</div></div>";
  n().openModal("Needs Attention",body,{wide:true});
}

function openFinderReports() {
  const reports = state().data.finderReports.slice().sort(function (a,b) {
    const av = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bv = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bv-av;
  });
  const open = reports.filter(function(r){return r.status==="new"||r.status==="contacted";});
  const closed = reports.filter(function(r){return r.status==="resolved"||r.status==="dismissed";});
  const body =
    "<div class='card-title-row'><div><h3>Open reports</h3><div class='microcopy'>Finder contact information is private to you.</div></div>"+statusBadge(String(open.length),open.length?"red":"green")+"</div>"+
    (open.length ? "<div class='panel-list'>"+open.map(finderReportRow).join("")+"</div>" : "<div class='empty-state'><strong>No open finder reports</strong><div>New public QR reports will appear here.</div></div>")+
    (closed.length ? "<div class='divider'></div><details class='p2-details'><summary><strong>Resolved / dismissed</strong><span>"+closed.length+"</span></summary><div class='panel-list'>"+closed.map(function(r){
      const ctx=finderReportContext(r);
      return "<div class='list-row'><div><div class='list-title'>"+esc(ctx.label)+"</div><div class='list-sub'>"+esc(r.reporterName||"Finder")+" · "+esc(r.status)+" · "+dateText(r.createdAt)+"</div></div>"+button("finder-report","View",{id:r.id},"btn-ghost")+"</div>";
    }).join("")+"</div></details>" : "");
  n().openModal("Finder Reports",body,{wide:true});
}

function finderContactLinks(report) {
  const links=[];
  if(report.contactEmail) links.push("<a class='btn btn-secondary btn-small' href='mailto:"+encodeURIComponent(report.contactEmail)+"'>Email Finder</a>");
  if(report.contactPhone) {
    const tel=String(report.contactPhone).replace(/[^0-9+]/g,"");
    links.push("<a class='btn btn-secondary btn-small' href='tel:"+esc(tel)+"'>Call / Text Finder</a>");
  }
  return links.join("");
}

function openFinderReport(reportId) {
  const report=byId(state().data.finderReports,reportId);
  if(!report)return;
  const ctx=finderReportContext(report);
  const body=
    "<div class='grid grid-3'>"+
      "<div class='insight'><div class='insight-label'>Item</div><strong>"+esc(ctx.label)+"</strong><p>"+esc(report.labelCode||"")+"</p></div>"+
      "<div class='insight'><div class='insight-label'>Finder</div><strong>"+esc(report.reporterName||"Unknown")+"</strong><p>"+esc(report.status||"new")+"</p></div>"+
      "<div class='insight'><div class='insight-label'>Reported</div><strong>"+dateText(report.createdAt)+"</strong><p>"+esc(report.foundLocation||"No location provided")+"</p></div>"+
    "</div><div class='divider'></div>"+
    "<div class='panel-list'>"+
      "<div class='list-row'><div><div class='list-title'>Email</div><div class='list-sub'>"+esc(report.contactEmail||"Not provided")+"</div></div></div>"+
      "<div class='list-row'><div><div class='list-title'>Phone</div><div class='list-sub'>"+esc(report.contactPhone||"Not provided")+"</div></div></div>"+
      "<div class='list-row'><div><div class='list-title'>Where found / seen</div><div class='list-sub'>"+esc(report.foundLocation||"Not provided")+"</div></div></div>"+
    "</div><div class='divider'></div><div class='field'><label>Finder message</label><div class='finder-message'>"+esc(report.message||"No message provided.")+"</div></div>"+
    "<div class='actions' style='justify-content:flex-start;margin-top:16px'>"+finderContactLinks(report)+
      (ctx.targetId ? "<button class='btn btn-secondary btn-small' data-p2-action='open-report-record' data-id='"+esc(ctx.targetId)+"' data-type='"+esc(ctx.targetType)+"'>Open "+esc(ctx.targetType === "book" ? "Book" : ctx.targetType === "location" ? "Location" : ctx.targetType === "asset" ? "Asset" : "Record")+"</button>" : "")+
    "</div>";
  const footer =
    "<button class='btn btn-secondary' data-close-modal>Close</button>"+
    (report.status!=="contacted"&&report.status!=="resolved"&&report.status!=="dismissed" ? "<button class='btn btn-secondary' id='finder-mark-contacted'>Mark Contacted</button>" : "")+
    (report.status!=="dismissed"&&report.status!=="resolved" ? "<button class='btn btn-danger' id='finder-dismiss'>Dismiss</button><button class='btn btn-primary' id='finder-resolve'>Resolve</button>" : "");
  const modal=n().openModal("Finder Report",body,{wide:true,footer:footer});
  const contacted=modal.querySelector("#finder-mark-contacted");
  if(contacted) contacted.onclick=function(){updateFinderReportStatus(report,"contacted");};
  const dismiss=modal.querySelector("#finder-dismiss");
  if(dismiss) dismiss.onclick=function(){updateFinderReportStatus(report,"dismissed");};
  const resolve=modal.querySelector("#finder-resolve");
  if(resolve) resolve.onclick=function(){updateFinderReportStatus(report,"resolved");};
}

async function updateFinderReportStatus(report,status) {
  const patch={status:status,updatedAt:serverTimestamp()};
  if(status==="contacted") patch.contactedAt=serverTimestamp();
  if(status==="resolved") patch.resolvedAt=serverTimestamp();
  if(status==="dismissed") patch.dismissedAt=serverTimestamp();
  await updateDoc(doc(db(),"finderReports",report.id),patch);
  await n().writeActivity("asset","Finder report "+status,"finderReport",report.id,report.labelCode+" · "+report.reporterName);
  n().closeModal();
  await n().refresh(["finderReports","activity"]);
  n().toast("Finder report updated","Report marked "+status+".","success");
  openFinderReports();
}

function openPrintStudio() {
  const tags=state().data.qrTags.filter(function(t){return t.status!=="retired";});
  const body="<form id='p2-print-studio'><div class='form-grid'><div class='field'><label>Filter</label><select id='p2-print-filter'><option value='all'>All active tags</option><option value='assigned'>Assigned</option><option value='unassigned'>Unassigned</option><option value='asset'>Assets</option><option value='book'>Books</option><option value='location'>Locations</option></select></div>" +
    "<div class='field'><label>Print size override</label><select id='p2-print-size'><option value='keep'>Keep each tag's size</option><option value='tiny'>Tiny</option><option value='standard'>Standard</option><option value='book'>Book</option><option value='container'>Container</option></select></div></div>" +
    "<div class='divider'></div><div class='p2-check-list' id='p2-print-tags'>"+tags.map(function(t){return "<label class='p2-check' data-kind='"+esc(t.targetType)+"' data-status='"+esc(t.status)+"'><input type='checkbox' value='"+esc(t.id)+"' checked><span><strong>"+esc(t.labelCode||t.id)+"</strong><small>"+esc(n().targetLabel(t))+"</small></span></label>";}).join("")+"</div></form>";
  const modal=n().openModal("NEXUS Print Studio",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-print-selected'>Print Selected</button>"});
  const filter=modal.querySelector("#p2-print-filter");
  filter.onchange=function(){
    modal.querySelectorAll("#p2-print-tags .p2-check").forEach(function(row){
      const v=filter.value;
      const show=v==="all"||row.dataset.status===v||row.dataset.kind===v;
      row.style.display=show?"":"none";
      if(!show)row.querySelector("input").checked=false;
    });
  };
  modal.querySelector("#p2-print-selected").onclick=function(){
    const ids=Array.from(modal.querySelectorAll("#p2-print-tags input:checked")).map(function(x){return x.value;});
    const override=modal.querySelector("#p2-print-size").value;
    const selected=tags.filter(function(t){return ids.includes(t.id);}).map(function(t){return override==="keep"?t:Object.assign({},t,{size:override});});
    if(!selected.length)return n().toast("Nothing selected","Choose at least one tag.","error");
    n().printTags(selected);
  };
}

async function resetTag(code) {
  const tag=byId(state().data.qrTags,code);
  if(!tag||!confirm("Reset "+code+" to an unassigned reusable tag?"))return;
  await updateDoc(doc(db(),"qrTags",code),{targetType:"unassigned",targetId:null,targetLabel:"UNASSIGNED",status:"unassigned",updatedAt:serverTimestamp()});
  await setDoc(doc(db(),"publicQr",tag.publicSlug),{status:"unassigned",targetType:"unassigned",publicTitle:"Unused NEXUS Tag",publicMessage:"This tag is ready to be assigned.",updatedAt:serverTimestamp()},{merge:true});
  await n().writeActivity("qr","QR tag reset","qrTag",code,"Ready for reassignment.");
  await n().refresh(["qrTags","activity"]);
}

async function retireTag(code) {
  const tag=byId(state().data.qrTags,code);
  if(!tag||!confirm("Retire "+code+"? This keeps its history but removes it from normal use."))return;
  await updateDoc(doc(db(),"qrTags",code),{status:"retired",retiredAt:new Date().toISOString(),updatedAt:serverTimestamp()});
  await setDoc(doc(db(),"publicQr",tag.publicSlug),{status:"retired",publicTitle:"Retired NEXUS Tag",publicMessage:"This tag is no longer active.",updatedAt:serverTimestamp()},{merge:true});
  await n().writeActivity("qr","QR tag retired","qrTag",code,"Tag removed from active use.");
  await n().refresh(["qrTags","activity"]);
}

function openBibliography() {
  const books=state().data.books;
  if(!books.length)return n().toast("No books","Catalog books before building a bibliography.","error");
  const body="<div class='form-grid'><div class='field'><label>Citation style</label><select id='p2-citation-style'><option>Chicago</option><option>Turabian</option><option>MLA</option><option>APA</option></select></div><div class='field'><label>Selection</label><div class='microcopy'>Choose the books to include.</div></div></div>" +
    "<div class='divider'></div><div class='p2-check-list'>"+books.map(function(b){return "<label class='p2-check'><input type='checkbox' value='"+esc(b.id)+"'><span><strong>"+esc(b.title)+"</strong><small>"+esc(b.author||"Unknown author")+"</small></span></label>";}).join("")+"</div>" +
    "<div class='divider'></div><div class='field'><label>Generated bibliography</label><textarea id='p2-bib-output' style='min-height:180px' readonly></textarea></div>";
  const modal=n().openModal("Bibliography Builder",body,{wide:true,footer:"<button class='btn btn-secondary' id='p2-copy-bib'>Copy</button><button class='btn btn-primary' id='p2-generate-bib'>Generate</button>"});
  function generate(){
    const ids=Array.from(modal.querySelectorAll(".p2-check input:checked")).map(function(x){return x.value;});
    const style=modal.querySelector("#p2-citation-style").value;
    const text=books.filter(function(b){return ids.includes(b.id);}).map(function(b){return citeBook(b,style);}).sort().join("\n\n");
    modal.querySelector("#p2-bib-output").value=text;
    return text;
  }
  modal.querySelector("#p2-generate-bib").onclick=generate;
  modal.querySelector("#p2-copy-bib").onclick=async function(){
    const text=modal.querySelector("#p2-bib-output").value||generate();
    if(!text)return;
    await navigator.clipboard.writeText(text);
    n().toast("Copied","Bibliography copied to clipboard.","success");
  };
}

function authorParts(author) {
  const a=String(author||"").trim();
  if(!a)return {normal:"Unknown Author",reverse:"Unknown Author"};
  const parts=a.split(/\s+/);
  if(parts.length<2)return {normal:a,reverse:a};
  return {normal:a,reverse:parts[parts.length-1]+", "+parts.slice(0,-1).join(" ")};
}
function citeBook(b,style) {
  const a=authorParts(b.author);
  const title=b.title||"Untitled";
  const publisher=b.publisher||"n.p.";
  const year=b.year||"n.d.";
  if(style==="MLA")return a.reverse+". "+title+". "+publisher+", "+year+".";
  if(style==="APA")return a.reverse+" ("+year+"). "+title+". "+publisher+".";
  if(style==="Turabian"||style==="Chicago")return a.reverse+". "+title+". "+publisher+", "+year+".";
  return a.reverse+". "+title+". "+publisher+", "+year+".";
}

function openShelfReport() {
  const map={};
  state().data.books.forEach(function(b){
    const loc=b.locationId?n().locationName(b.locationId):"Unlocated";
    if(!map[loc])map[loc]=[];
    map[loc].push(b);
  });
  const groups=Object.entries(map).sort(function(a,b){return b[1].length-a[1].length;});
  const body="<div class='panel-list'>"+groups.map(function(g){
    const books=g[1].slice().sort(function(a,b){return String(a.author||a.title).localeCompare(String(b.author||b.title));});
    return "<details class='p2-details'><summary><strong>"+esc(g[0])+"</strong><span>"+books.length+" books</span></summary><div>"+books.map(function(b,i){return "<div class='list-row'><span>"+(i+1)+". "+esc(b.author?b.author+" — "+b.title:b.title)+"</span></div>";}).join("")+"</div></details>";
  }).join("")+"</div>";
  n().openModal("Shelf Report",body,{wide:true});
}

function openReadingLog(bookId) {
  const b=bookFor(bookId);if(!b)return;
  const history=b.readingHistory||[];
  const body="<form id='p2-reading-form' class='form-grid'><div class='field'><label>Started</label><input name='startedAt' type='date'></div><div class='field'><label>Finished</label><input name='finishedAt' type='date'></div>" +
    "<div class='field'><label>Rating</label><select name='rating'><option value=''>No rating</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></div><div class='field full'><label>Reading note</label><textarea name='note'></textarea></div></form>" +
    (history.length?"<div class='divider'></div><div class='panel-list'>"+history.slice().reverse().map(function(h){return "<div class='list-row'><div><div class='list-title'>"+esc(h.finishedAt?dateText(h.finishedAt):"In progress")+"</div><div class='list-sub'>"+esc(h.note||"")+"</div></div>"+(h.rating?statusBadge(h.rating+"/5","gold"):"")+"</div>";}).join("")+"</div>":"");
  const modal=n().openModal(b.title+" · Reading",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-save-reading'>Save Reading</button>"});
  modal.querySelector("#p2-save-reading").onclick=async function(){
    const form=modal.querySelector("#p2-reading-form");
    const entry={startedAt:form.elements.startedAt.value||todayISO(),finishedAt:form.elements.finishedAt.value||"",rating:form.elements.rating.value?Number(form.elements.rating.value):null,note:form.elements.note.value.trim(),createdAt:new Date().toISOString()};
    const next=history.concat([entry]);
    await updateDoc(doc(db(),"books",b.id),{readingHistory:next,readingStatus:entry.finishedAt?"Finished":"Reading",updatedAt:serverTimestamp()});
    await n().writeActivity("book",entry.finishedAt?"Reading completed":"Reading logged","book",b.id,b.title);
    n().closeModal();await n().refresh(["books","activity"]);
  };
}

function openResearchNote(bookId) {
  const b=bookFor(bookId);if(!b)return;
  const notes=b.researchNotes||[];
  const body="<form id='p2-note-form' class='form-grid'><div class='field'><label>Page / location</label><input name='page' placeholder='84'></div><div class='field'><label>Tags</label><input name='tags' placeholder='natural law, apologetics'></div>" +
    "<div class='field full'><label>Your note</label><textarea name='text' required style='min-height:130px'></textarea></div></form>" +
    (notes.length?"<div class='divider'></div><div class='panel-list'>"+notes.slice().reverse().map(function(note){return "<div class='list-row'><div><div class='list-title'>"+(note.page?"p. "+esc(note.page):"Note")+"</div><div class='list-sub'>"+esc(note.text)+"</div></div></div>";}).join("")+"</div>":"");
  const modal=n().openModal(b.title+" · Research Notes",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-save-note'>Add Note</button>"});
  modal.querySelector("#p2-save-note").onclick=async function(){
    const form=modal.querySelector("#p2-note-form");if(!form.reportValidity())return;
    const note={page:form.elements.page.value.trim(),tags:form.elements.tags.value.trim(),text:form.elements.text.value.trim(),createdAt:new Date().toISOString()};
    await updateDoc(doc(db(),"books",b.id),{researchNotes:notes.concat([note]),updatedAt:serverTimestamp()});
    await n().writeActivity("book","Research note added","book",b.id,b.title+(note.page?" · p. "+note.page:""));
    n().closeModal();await n().refresh(["books","activity"]);
  };
}

function openInventoryAudit() {
  if(!state().data.locations.length)return n().toast("No locations","Create a location first.","error");
  const body="<div class='form-grid'><div class='field'><label>Location</label><select id='p2-inv-location'>"+state().data.locations.map(function(l){return "<option value='"+esc(l.id)+"'>"+esc(n().locationName(l.id)||l.name)+"</option>";}).join("")+"</select></div>" +
    "<div class='field'><label>Mode</label><select id='p2-inv-mode'><option value='audit'>Audit only</option><option value='move'>Move scanned items here</option></select></div></div>" +
    "<div class='divider'></div><div class='inline-note'>Start the camera, then scan NEXUS tags one after another. Duplicate scans are ignored.</div><div class='scan-reader' style='margin-top:12px'><div id='p2-inventory-reader'></div></div>" +
    "<div class='divider'></div><div id='p2-inventory-results'><div class='microcopy'>No items scanned yet.</div></div>";
  const modal=n().openModal("Inventory Scan",body,{wide:true,footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p2-finish-inventory'>Finish Session</button>"});
  const scanned=new Map();
  let scanner=null;
  setTimeout(function(){
    if(!window.Html5QrcodeScanner)return;
    scanner=new window.Html5QrcodeScanner("p2-inventory-reader",{fps:10,qrbox:{width:230,height:230},rememberLastUsedCamera:true,showTorchButtonIfSupported:true},false);
    scanner.render(function(text){
      const tag=resolveScannedTag(text);
      if(!tag||!["asset","book"].includes(tag.targetType))return;
      scanned.set(tag.id,tag);
      renderInventoryScans(modal,scanned);
    },function(){});
  },0);
  modal.querySelector("#p2-finish-inventory").onclick=async function(){
    if(scanner)try{await scanner.clear();}catch(_){}
    const locId=modal.querySelector("#p2-inv-location").value;
    const mode=modal.querySelector("#p2-inv-mode").value;
    const tags=Array.from(scanned.values());
    if(mode==="move"&&tags.length){
      const batch=writeBatch(db());
      tags.forEach(function(tag){
        if(tag.targetType==="asset")batch.update(doc(db(),"assets",tag.targetId),{locationId:locId,updatedAt:serverTimestamp()});
        if(tag.targetType==="book")batch.update(doc(db(),"books",tag.targetId),{locationId:locId,updatedAt:serverTimestamp()});
      });
      await batch.commit();
      await n().writeActivity("location","Inventory move completed","location",locId,tags.length+" items moved to "+n().locationName(locId));
      n().closeModal();await n().refresh(["assets","books","activity"]);
      n().toast("Inventory updated",tags.length+" items moved to "+n().locationName(locId)+".","success");
      return;
    }
    showAuditResult(modal,locId,tags);
  };
  modal.querySelectorAll("[data-close-modal]").forEach(function(btn){btn.addEventListener("click",async function(){if(scanner)try{await scanner.clear();}catch(_){}});});
}

function resolveScannedTag(text) {
  const raw=String(text||"");
  let slug=raw;
  try{const u=new URL(raw,location.origin);slug=u.searchParams.get("tag")||raw;}catch(_){}
  return state().data.qrTags.find(function(t){return t.id===slug||t.publicSlug===slug;});
}
function renderInventoryScans(modal,scanned) {
  const tags=Array.from(scanned.values());
  modal.querySelector("#p2-inventory-results").innerHTML="<div class='card-title-row'><strong>"+tags.length+" scanned</strong>"+statusBadge("LIVE","green")+"</div><div class='panel-list'>"+tags.slice().reverse().map(function(t){return "<div class='list-row'><span>"+esc(n().targetLabel(t))+"</span>"+statusBadge(t.targetType,"gold")+"</div>";}).join("")+"</div>";
}
function showAuditResult(modal,locId,tags) {
  const expected=[];
  state().data.assets.filter(function(a){return a.locationId===locId;}).forEach(function(a){expected.push({type:"asset",id:a.id,label:a.name});});
  state().data.books.filter(function(b){return b.locationId===locId;}).forEach(function(b){expected.push({type:"book",id:b.id,label:b.title});});
  const scannedKeys=new Set(tags.map(function(t){return t.targetType+"|"+t.targetId;}));
  const expectedKeys=new Set(expected.map(function(x){return x.type+"|"+x.id;}));
  const missing=expected.filter(function(x){return !scannedKeys.has(x.type+"|"+x.id);});
  const unexpected=tags.filter(function(t){return !expectedKeys.has(t.targetType+"|"+t.targetId);});
  modal.querySelector("#p2-inventory-results").innerHTML="<div class='grid grid-3'><div class='insight'><div class='insight-label'>Expected</div><strong>"+expected.length+"</strong><p>Registered at this location.</p></div><div class='insight'><div class='insight-label'>Missing scan</div><strong>"+missing.length+"</strong><p>Expected but not scanned.</p></div><div class='insight'><div class='insight-label'>Unexpected</div><strong>"+unexpected.length+"</strong><p>Scanned but registered elsewhere.</p></div></div>"+
    (missing.length?"<div class='divider'></div><h3>Expected but not scanned</h3><div class='panel-list'>"+missing.map(function(x){return "<div class='list-row'><span>"+esc(x.label)+"</span>"+statusBadge(x.type,"amber")+"</div>";}).join("")+"</div>":"")+
    (unexpected.length?"<div class='divider'></div><h3>Unexpected at this location</h3><div class='panel-list'>"+unexpected.map(function(t){return "<div class='list-row'><span>"+esc(n().targetLabel(t))+"</span>"+statusBadge(t.targetType,"red")+"</div>";}).join("")+"</div>":"");
}

document.addEventListener("nexus:ready",init);
if(window.NEXUS)init();
