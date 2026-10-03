import {
  doc, setDoc, updateDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const P3 = {
  N: null,
  initialized: false,
  restorePayload: null
};

function N() { return P3.N || window.NEXUS; }
function S() { return N().state; }
function DB() { return N().db; }
function esc(v) { return N().escapeHtml(v); }
function norm(v) { return N().normalize(v); }
function money(v) { return N().money(v); }
function dateText(v) { return N().dateText(v); }

function init() {
  if (P3.initialized || !window.NEXUS) return;
  P3.N = window.NEXUS;
  P3.initialized = true;

  installCommandButton();
  installNetworkStatus();
  document.addEventListener("nexus:render", function (event) {
    enhance(event.detail && event.detail.view || S().view);
  });
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("keydown", handleKeyboard);
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);

  if (S().user) enhance(S().view);
}

function installCommandButton() {
  if (document.getElementById("p3-command-launch")) return;
  const topbar = document.querySelector(".topbar");
  const quick = document.getElementById("quick-add");
  if (!topbar || !quick) return;
  quick.insertAdjacentHTML("beforebegin",
    "<button id='p3-command-launch' class='btn btn-secondary p3-command-launch' type='button' title='Command Palette (Ctrl/⌘ K)'>⌘</button>");
  document.getElementById("p3-command-launch").addEventListener("click", openCommandPalette);
}

function installNetworkStatus() {
  if (document.getElementById("p3-network")) return;
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const el = document.createElement("div");
  el.id = "p3-network";
  el.className = "p3-network";
  el.innerHTML = "<span class='p3-network-dot'></span><span class='p3-network-label'>Online</span>";
  const launch = document.getElementById("p3-command-launch");
  topbar.insertBefore(el, launch || null);
  updateNetworkStatus();
}

function updateNetworkStatus() {
  const el = document.getElementById("p3-network");
  if (!el) return;
  const online = navigator.onLine;
  el.classList.toggle("offline", !online);
  const label = el.querySelector(".p3-network-label");
  if (label) label.textContent = online ? "Online" : "Offline";
}

function enhance(view) {
  installCommandButton();
  installNetworkStatus();
  if (view === "settings") enhanceSettings();
  if (view === "receipts") enhanceReceipts();
  if (view === "qr") enhanceQr();
  if (view === "dashboard") enhanceDashboard();
}

function healthReport() {
  const issues = {
    duplicateIsbns: [],
    duplicateSerials: [],
    unlocatedAssets: [],
    unlocatedBooks: [],
    orphanTags: [],
    brokenReceiptLinks: [],
    overdueReturns: [],
    expiredWarranties: []
  };

  const isbnMap = {};
  S().data.books.forEach(function (b) {
    const key = norm(b.isbn || "");
    if (!key) return;
    if (!isbnMap[key]) isbnMap[key] = [];
    isbnMap[key].push(b);
  });
  issues.duplicateIsbns = Object.values(isbnMap).filter(function (g) { return g.length > 1; });

  const serialMap = {};
  S().data.assets.forEach(function (a) {
    const key = norm(a.serialNumber || "");
    if (!key) return;
    if (!serialMap[key]) serialMap[key] = [];
    serialMap[key].push(a);
  });
  issues.duplicateSerials = Object.values(serialMap).filter(function (g) { return g.length > 1; });

  issues.unlocatedAssets = S().data.assets.filter(function (a) { return !a.locationId; });
  issues.unlocatedBooks = S().data.books.filter(function (b) { return !b.locationId; });

  issues.orphanTags = S().data.qrTags.filter(function (t) {
    if (t.status !== "assigned") return false;
    if (t.targetType === "asset") return !S().data.assets.some(function (a) { return a.id === t.targetId; });
    if (t.targetType === "book") return !S().data.books.some(function (b) { return b.id === t.targetId; });
    if (t.targetType === "location") return !S().data.locations.some(function (l) { return l.id === t.targetId; });
    return false;
  });

  S().data.receipts.forEach(function (r) {
    (r.items || []).forEach(function (item, index) {
      if (item.linkedAssetId && !S().data.assets.some(function (a) { return a.id === item.linkedAssetId; })) {
        issues.brokenReceiptLinks.push({ receipt:r, index:index, kind:"asset", missingId:item.linkedAssetId, item:item });
      }
      if (item.linkedBookId && !S().data.books.some(function (b) { return b.id === item.linkedBookId; })) {
        issues.brokenReceiptLinks.push({ receipt:r, index:index, kind:"book", missingId:item.linkedBookId, item:item });
      }
    });
  });

  const today = new Date();
  function past(iso) { return iso && new Date(iso + "T23:59:59") < today; }
  issues.overdueReturns = [
    ...S().data.assets.filter(function (a) { return a.returnDeadline && a.returnStatus !== "closed" && past(a.returnDeadline); }).map(function (a) { return {type:"Asset",name:a.name,date:a.returnDeadline}; }),
    ...S().data.receipts.filter(function (r) { return r.returnDeadline && r.returnStatus !== "closed" && past(r.returnDeadline); }).map(function (r) { return {type:"Receipt",name:r.merchant || "Receipt",date:r.returnDeadline}; })
  ];
  issues.expiredWarranties = S().data.assets.filter(function (a) { return a.warrantyExpiration && past(a.warrantyExpiration); });

  const repairable = issues.orphanTags.length + issues.brokenReceiptLinks.length;
  const duplicateCount = issues.duplicateIsbns.length + issues.duplicateSerials.length;
  const organizationCount = issues.unlocatedAssets.length + issues.unlocatedBooks.length;
  const attentionCount = issues.overdueReturns.length + issues.expiredWarranties.length;

  return {
    issues: issues,
    repairable: repairable,
    duplicateCount: duplicateCount,
    organizationCount: organizationCount,
    attentionCount: attentionCount,
    total: repairable + duplicateCount + organizationCount + attentionCount
  };
}

function enhanceSettings() {
  if (document.getElementById("p3-settings")) return;
  const report = healthReport();
  const host = location.hostname.endsWith("github.io") ? "GitHub Pages" : location.hostname;
  const html =
    "<section id='p3-settings' class='card section-gap'><div class='card-title-row'><div><h2>System Health & Recovery</h2><div class='microcopy'>Phase 3 integrity, backups, and hosting diagnostics</div></div>" +
    (report.total ? "<span class='badge amber'>" + report.total + " attention</span>" : "<span class='badge green'>HEALTHY</span>") +
    "</div><div class='p3-health-summary'>" +
      healthChip("Repairable", report.repairable) +
      healthChip("Duplicates", report.duplicateCount) +
      healthChip("Unlocated", report.organizationCount) +
      healthChip("Historical", report.attentionCount) +
    "</div><div class='actions' style='justify-content:flex-start;margin-top:16px'>" +
      "<button class='btn btn-primary' data-p3-action='health-center'>Open Data Health</button>" +
      "<button class='btn btn-secondary' data-action='export-json'>Export Backup</button>" +
      "<button class='btn btn-secondary' data-p3-action='restore-backup'>Restore Backup</button>" +
    "</div></section>" +
    "<section class='card section-gap'><div class='card-title-row'><div><h2>Hosting</h2><div class='microcopy'>Static application delivery</div></div><span class='badge gold'>" + esc(host) + "</span></div>" +
      "<div class='panel-list'><div class='list-row'><div><div class='list-title'>Current site</div><div class='list-sub'>" + esc(N().appBaseUrl()) + "</div></div></div>" +
      "<div class='list-row'><div><div class='list-title'>Firebase role</div><div class='list-sub'>Authentication + Cloud Firestore only. Website files are served by GitHub Pages.</div></div></div></div>" +
      (location.hostname.endsWith("github.io") ? "<div class='inline-note' style='margin-top:12px'>Firebase Authentication must list <strong>" + esc(location.hostname) + "</strong> under Authentication → Settings → Authorized domains. This is a one-time Firebase provider setting, not NEXUS account creation.</div>" : "") +
    "</section>";
  document.getElementById("view").insertAdjacentHTML("beforeend", html);
}

function healthChip(label, value) {
  return "<div class='p3-health-chip'><span>" + esc(label) + "</span><strong>" + value + "</strong></div>";
}

function enhanceReceipts() {
  document.querySelectorAll("#receipt-rows tr").forEach(function (row) {
    if (row.querySelector("[data-p3-action='edit-receipt']")) return;
    const view = row.querySelector("[data-action='view-receipt']");
    const actions = row.querySelector(".row-actions");
    if (!view || !actions) return;
    actions.insertAdjacentHTML("afterbegin",
      "<button class='btn btn-small btn-ghost' data-p3-action='edit-receipt' data-id='" + esc(view.dataset.id) + "'>Edit</button>");
  });
}

function enhanceQr() {
  const actions = document.querySelector("#view .view-header .actions");
  if (actions && !actions.querySelector("[data-p3-action='print-calibration']")) {
    actions.insertAdjacentHTML("afterbegin",
      "<button class='btn btn-secondary' data-p3-action='print-calibration'>▤ Calibration</button>");
  }
}

function enhanceDashboard() {
  if (document.getElementById("p3-dashboard-health")) return;
  const report = healthReport();
  if (!report.total) return;
  const view = document.getElementById("view");
  if (!view) return;
  const html = "<section id='p3-dashboard-health' class='card section-gap'><div class='card-title-row'><div><h2>System health</h2><div class='microcopy'>NEXUS found records worth reviewing</div></div><span class='badge amber'>" + report.total + "</span></div>" +
    "<div class='actions' style='justify-content:flex-start'><button class='btn btn-small btn-secondary' data-p3-action='health-center'>Review Data Health</button></div></section>";
  view.insertAdjacentHTML("beforeend", html);
}

function handleKeyboard(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandPalette();
  }
}

function commandDefinitions() {
  return [
    {name:"Dashboard", hint:"Go to overview", run:function(){N().setActiveView("dashboard");}},
    {name:"Money", hint:"Open spending", run:function(){N().setActiveView("money");}},
    {name:"Receipts", hint:"Open receipt inbox", run:function(){N().setActiveView("receipts");}},
    {name:"Assets", hint:"Open physical registry", run:function(){N().setActiveView("assets");}},
    {name:"QR Registry", hint:"Open physical tags", run:function(){N().setActiveView("qr");}},
    {name:"Library", hint:"Open personal library", run:function(){N().setActiveView("library");}},
    {name:"Locations", hint:"Open physical map", run:function(){N().setActiveView("locations");}},
    {name:"Settings", hint:"Open settings", run:function(){N().setActiveView("settings");}},
    {name:"Scan", hint:"Open universal scanner", run:function(){N().openScanner();}},
    {name:"Data Health", hint:"Audit NEXUS integrity", run:openHealthCenter},
    {name:"Restore Backup", hint:"Merge a NEXUS JSON export", run:openRestoreBackup}
  ];
}

function openCommandPalette() {
  const commands = commandDefinitions();
  const body = "<div class='field'><label>Command or search</label><input id='p3-command-input' autocomplete='off' placeholder='Type a command, or search NEXUS…'></div><div id='p3-command-list' class='p3-command-list'></div>";
  const modal = N().openModal("Command Palette", body, {footer:false});
  const input = modal.querySelector("#p3-command-input");
  const list = modal.querySelector("#p3-command-list");

  function draw() {
    const q = norm(input.value);
    const visible = commands.filter(function (c) { return !q || norm(c.name + " " + c.hint).includes(q); });
    list.innerHTML = visible.map(function (c, i) {
      return "<button class='p3-command " + (i === 0 ? "active" : "") + "' data-command-index='" + commands.indexOf(c) + "'><span>" + esc(c.name) + "</span><small>" + esc(c.hint) + "</small></button>";
    }).join("") + (q ? "<button class='p3-command' data-command-search='1'><span>Search NEXUS for “" + esc(input.value) + "”</span><small>Enter</small></button>" : "");
  }
  draw();
  input.focus();
  input.addEventListener("input", draw);
  list.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-command-index],[data-command-search]");
    if (!btn) return;
    if (btn.dataset.commandSearch) {
      S().searchTerm = input.value.trim();
      const global = document.getElementById("global-search");
      if (global) global.value = S().searchTerm;
      N().closeModal();
      N().setActiveView("search");
      return;
    }
    const cmd = commands[Number(btn.dataset.commandIndex)];
    if (!cmd) return;
    N().closeModal();
    cmd.run();
  });
  input.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    const first = list.querySelector("[data-command-index]");
    if (first && !input.value.trim()) {
      first.click();
      return;
    }
    const exact = commands.find(function (c) { return norm(c.name) === norm(input.value); });
    if (exact) {
      N().closeModal();
      exact.run();
      return;
    }
    S().searchTerm = input.value.trim();
    const global = document.getElementById("global-search");
    if (global) global.value = S().searchTerm;
    N().closeModal();
    N().setActiveView("search");
  });
}

function handleGlobalClick(event) {
  const el = event.target.closest("[data-p3-action]");
  if (!el) return;
  const action = el.dataset.p3Action;
  if (action === "health-center") openHealthCenter();
  if (action === "restore-backup") openRestoreBackup();
  if (action === "edit-receipt") openReceiptEditor(el.dataset.id);
  if (action === "print-calibration") openCalibration();
}

function openHealthCenter() {
  const report = healthReport();
  const i = report.issues;
  let sections = "";

  if (i.orphanTags.length) {
    sections += healthSection("Orphan QR tags", i.orphanTags.map(function (t) {
      return (t.labelCode || t.id) + " → missing " + (t.targetType || "target");
    }));
  }
  if (i.brokenReceiptLinks.length) {
    sections += healthSection("Broken receipt links", i.brokenReceiptLinks.map(function (x) {
      return (x.receipt.merchant || "Receipt") + " · " + (x.item.name || "Item") + " → missing " + x.kind;
    }));
  }
  if (i.duplicateIsbns.length) {
    sections += healthSection("Duplicate ISBNs", i.duplicateIsbns.map(function (g) {
      return (g[0].isbn || "ISBN") + " · " + g.map(function (b) { return b.title; }).join(" / ");
    }));
  }
  if (i.duplicateSerials.length) {
    sections += healthSection("Duplicate serial numbers", i.duplicateSerials.map(function (g) {
      return (g[0].serialNumber || "Serial") + " · " + g.map(function (a) { return a.name; }).join(" / ");
    }));
  }
  if (i.unlocatedAssets.length || i.unlocatedBooks.length) {
    sections += healthSection("No physical location", [
      ...i.unlocatedAssets.map(function (a) { return "Asset · " + a.name; }),
      ...i.unlocatedBooks.map(function (b) { return "Book · " + b.title; })
    ]);
  }
  if (i.overdueReturns.length) {
    sections += healthSection("Past return deadline", i.overdueReturns.map(function (x) {
      return x.type + " · " + x.name + " · " + dateText(x.date);
    }));
  }
  if (i.expiredWarranties.length) {
    sections += healthSection("Expired warranties", i.expiredWarranties.map(function (a) {
      return a.name + " · " + dateText(a.warrantyExpiration);
    }));
  }

  const body =
    "<div class='p3-health-summary'>" +
      healthChip("Repairable", report.repairable) +
      healthChip("Duplicates", report.duplicateCount) +
      healthChip("Unlocated", report.organizationCount) +
      healthChip("Historical", report.attentionCount) +
    "</div><div class='divider'></div>" +
    (sections || "<div class='empty-state'><strong>Everything looks healthy</strong><div>No broken links, duplicate identifiers, or organization issues detected.</div></div>");

  const footer = report.repairable ?
    "<button class='btn btn-secondary' data-close-modal>Close</button><button class='btn btn-primary' id='p3-safe-repair'>Repair Safe Issues</button>" :
    "<button class='btn btn-primary' data-close-modal>Done</button>";
  const modal = N().openModal("NEXUS Data Health", body, {wide:true, footer:footer});
  const repair = modal.querySelector("#p3-safe-repair");
  if (repair) repair.addEventListener("click", repairSafeIssues);
}

function healthSection(title, rows) {
  return "<details class='p2-details' open><summary><strong>" + esc(title) + "</strong><span>" + rows.length + "</span></summary><div>" +
    rows.slice(0,100).map(function (row) { return "<div class='list-row'><span>" + esc(row) + "</span></div>"; }).join("") +
    "</div></details>";
}

async function repairSafeIssues() {
  const report = healthReport();
  if (!report.repairable) return;
  if (!confirm("Reset orphan QR tags and clear receipt links whose target record no longer exists? No valid record will be deleted.")) return;

  for (const tag of report.issues.orphanTags) {
    await updateDoc(doc(DB(), "qrTags", tag.id), {
      targetType:"unassigned", targetId:null, targetLabel:"UNASSIGNED", status:"unassigned", updatedAt:serverTimestamp()
    });
    if (tag.publicSlug) {
      await setDoc(doc(DB(), "publicQr", tag.publicSlug), {
        labelCode:tag.labelCode || tag.id,
        targetType:"unassigned",
        status:"unassigned",
        publicTitle:"Unused NEXUS Tag",
        publicMessage:"This tag is ready to be assigned.",
        updatedAt:serverTimestamp()
      }, {merge:true});
    }
  }

  const receiptGroups = {};
  report.issues.brokenReceiptLinks.forEach(function (x) {
    if (!receiptGroups[x.receipt.id]) receiptGroups[x.receipt.id] = x.receipt;
  });
  for (const receipt of Object.values(receiptGroups)) {
    const items = (receipt.items || []).map(function (item) {
      const next = Object.assign({}, item);
      if (next.linkedAssetId && !S().data.assets.some(function (a) { return a.id === next.linkedAssetId; })) {
        delete next.linkedAssetId;
        delete next.linkedAt;
      }
      if (next.linkedBookId && !S().data.books.some(function (b) { return b.id === next.linkedBookId; })) {
        delete next.linkedBookId;
        delete next.linkedAt;
      }
      return next;
    });
    await updateDoc(doc(DB(), "receipts", receipt.id), {items:items, updatedAt:serverTimestamp()});
  }

  await N().writeActivity("system", "Data Health repair completed", "system", "phase3-health", report.repairable + " safe issue(s) repaired.");
  N().closeModal();
  await N().refresh(["qrTags","receipts","activity"]);
  N().toast("Repair complete", report.repairable + " safe issue(s) repaired.", "success");
  openHealthCenter();
}

function openReceiptEditor(id) {
  const receipt = S().data.receipts.find(function (r) { return r.id === id; });
  if (!receipt) return;

  const body = "<form id='p3-receipt-edit' class='form-grid'>" +
    "<div class='field'><label>Date</label><input name='date' type='date' value='" + esc(receipt.date || "") + "' required></div>" +
    "<div class='field'><label>Merchant</label><input name='merchant' value='" + esc(receipt.merchant || "") + "' required></div>" +
    "<div class='field'><label>Subtotal</label><input name='subtotal' type='number' step='0.01' min='0' value='" + esc(receipt.subtotal || "") + "'></div>" +
    "<div class='field'><label>Tax</label><input name='tax' type='number' step='0.01' min='0' value='" + esc(receipt.tax || "") + "'></div>" +
    "<div class='field'><label>Total</label><input name='total' type='number' step='0.01' min='0' value='" + esc(receipt.total || "") + "' required></div>" +
    "<div class='field'><label>Payment note</label><input name='paymentMethod' value='" + esc(receipt.paymentMethod || "") + "'></div>" +
    "<div class='field full'><label>Items</label><div id='p3-edit-items' class='receipt-items'>" +
      (receipt.items || []).map(function (item, index) { return receiptItemEditor(item, index); }).join("") +
    "</div></div><div class='field full'><label>Note</label><textarea name='note'>" + esc(receipt.note || "") + "</textarea></div></form>";

  const modal = N().openModal("Edit Receipt", body, {
    wide:true,
    footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p3-save-receipt'>Save Changes</button>"
  });

  modal.querySelector("#p3-save-receipt").addEventListener("click", async function () {
    const form = modal.querySelector("#p3-receipt-edit");
    if (!form.reportValidity()) return;
    const items = Array.from(modal.querySelectorAll("[data-p3-item-index]")).map(function (row) {
      const index = Number(row.dataset.p3ItemIndex);
      const original = (receipt.items || [])[index] || {};
      return Object.assign({}, original, {
        name:row.querySelector(".p3-ri-name").value.trim(),
        category:row.querySelector(".p3-ri-category").value,
        price:Number(row.querySelector(".p3-ri-price").value || 0)
      });
    });
    const data = {
      date:form.elements.date.value,
      merchant:form.elements.merchant.value.trim(),
      subtotal:Number(form.elements.subtotal.value || 0),
      tax:Number(form.elements.tax.value || 0),
      total:Number(form.elements.total.value || 0),
      paymentMethod:form.elements.paymentMethod.value.trim(),
      note:form.elements.note.value.trim(),
      items:items,
      updatedAt:serverTimestamp()
    };
    await updateDoc(doc(DB(),"receipts",receipt.id),data);

    const linked = S().data.transactions.find(function (t) { return t.sourceReceiptId === receipt.id; });
    if (linked) {
      await updateDoc(doc(DB(),"transactions",linked.id), {
        date:data.date,
        merchant:data.merchant,
        amount:data.total,
        category:dominantCategory(items),
        note:data.note,
        updatedAt:serverTimestamp()
      });
    }
    await N().writeActivity("receipt","Receipt corrected","receipt",receipt.id,data.merchant + " · " + money(data.total));
    N().closeModal();
    await N().refresh(["receipts","transactions","activity"]);
    N().toast("Receipt updated","Linked spending was synchronized too.","success");
  });
}

function receiptItemEditor(item, index) {
  const categories = ["Groceries","Dining","Transportation","Books","Electronics","Household","Personal Care","Education","Entertainment","Subscriptions","Medical","Gifts","Other"];
  return "<div class='receipt-item' data-p3-item-index='" + index + "'><div class='field'><label>Item</label><input class='p3-ri-name' value='" + esc(item.name || "") + "'></div>" +
    "<div class='field'><label>Category</label><select class='p3-ri-category'>" + categories.map(function (c) { return "<option " + (c === (item.category || "Other") ? "selected" : "") + ">" + esc(c) + "</option>"; }).join("") + "</select></div>" +
    "<div class='field'><label>Price</label><input class='p3-ri-price' type='number' step='0.01' min='0' value='" + esc(item.price || "") + "'></div>" +
    "<div class='microcopy' style='align-self:end;padding-bottom:10px'>" + (item.linkedAssetId ? "Linked Asset" : item.linkedBookId ? "Linked Book" : "") + "</div></div>";
}

function dominantCategory(items) {
  if (!items.length) return "Other";
  const totals = {};
  items.forEach(function (item) {
    const c = item.category || "Other";
    totals[c] = (totals[c] || 0) + Number(item.price || 0);
  });
  return Object.entries(totals).sort(function (a,b) { return b[1] - a[1]; })[0][0];
}

function openRestoreBackup() {
  const body = "<div class='inline-note'>Restore uses a NEXUS JSON export and <strong>merges</strong> records by their original IDs. It does not delete records that are already in your current database.</div>" +
    "<label class='ocr-drop' for='p3-backup-file' style='margin-top:14px'><div><div style='font-size:28px;margin-bottom:8px'>⇧</div><strong>Select NEXUS backup</strong><div class='microcopy' style='margin-top:5px'>JSON export from Settings</div></div></label>" +
    "<input id='p3-backup-file' type='file' accept='application/json,.json' hidden><div id='p3-restore-preview' style='margin-top:14px'></div>";
  const modal = N().openModal("Restore Backup", body, {
    wide:true,
    footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='p3-run-restore' disabled>Merge Restore</button>"
  });
  const fileInput = modal.querySelector("#p3-backup-file");
  const run = modal.querySelector("#p3-run-restore");
  fileInput.addEventListener("change", async function () {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      validateBackup(payload);
      P3.restorePayload = payload;
      const counts = Object.entries(payload.data || {}).map(function (entry) {
        return "<div class='list-row'><span>" + esc(entry[0]) + "</span><strong>" + (Array.isArray(entry[1]) ? entry[1].length : 0) + "</strong></div>";
      }).join("");
      modal.querySelector("#p3-restore-preview").innerHTML = "<div class='card'><div class='card-title-row'><strong>Backup accepted</strong><span class='badge green'>VALID</span></div><div class='microcopy'>Exported " + esc(payload.exportedAt || "unknown date") + "</div><div class='panel-list' style='margin-top:10px'>" + counts + "</div></div>";
      run.disabled = false;
    } catch (error) {
      P3.restorePayload = null;
      run.disabled = true;
      modal.querySelector("#p3-restore-preview").innerHTML = "<div class='inline-note' style='border-color:rgba(201,98,98,.35);color:#e4a2a2'>Invalid backup: " + esc(error.message) + "</div>";
    }
  });
  run.addEventListener("click", async function () {
    if (!P3.restorePayload) return;
    if (!confirm("Merge this backup into your current NEXUS data? Existing records with the same ID will be updated.")) return;
    run.disabled = true;
    run.textContent = "Restoring…";
    try {
      await restoreBackup(P3.restorePayload);
      P3.restorePayload = null;
      N().closeModal();
      await N().loadAll();
      N().toast("Restore complete","Backup records were merged successfully.","success");
    } catch (error) {
      console.error(error);
      run.disabled = false;
      run.textContent = "Merge Restore";
      N().toast("Restore failed",error.message || "The backup could not be restored.","error");
    }
  });
}

function validateBackup(payload) {
  if (!payload || typeof payload !== "object") throw new Error("The file is not a NEXUS backup.");
  if (!payload.data || typeof payload.data !== "object") throw new Error("Backup data section is missing.");
  const known = ["transactions","receipts","assets","qrTags","books","locations","activity","loans"];
  const present = known.filter(function (key) { return Array.isArray(payload.data[key]); });
  if (!present.length) throw new Error("No recognized NEXUS collections were found.");
}

function normalizeImportedValue(value) {
  if (Array.isArray(value)) return value.map(normalizeImportedValue);
  if (value && typeof value === "object") {
    if (typeof value.seconds === "number" && typeof value.nanoseconds === "number") {
      return new Date(value.seconds * 1000 + Math.floor(value.nanoseconds / 1000000)).toISOString();
    }
    const out = {};
    Object.entries(value).forEach(function (entry) { out[entry[0]] = normalizeImportedValue(entry[1]); });
    return out;
  }
  return value;
}

async function restoreBackup(payload) {
  const known = ["transactions","receipts","assets","qrTags","books","locations","activity","loans"];
  const writes = [];
  known.forEach(function (collectionName) {
    const rows = Array.isArray(payload.data[collectionName]) ? payload.data[collectionName] : [];
    rows.forEach(function (row) {
      if (!row || !row.id) return;
      const clean = normalizeImportedValue(Object.assign({}, row));
      delete clean.id;
      clean.restoredAt = new Date().toISOString();
      writes.push({collectionName:collectionName,id:row.id,data:clean});
    });
  });

  for (let offset = 0; offset < writes.length; offset += 350) {
    const batch = writeBatch(DB());
    writes.slice(offset, offset + 350).forEach(function (w) {
      batch.set(doc(DB(), w.collectionName, w.id), w.data, {merge:true});
    });
    await batch.commit();
  }

  const tags = Array.isArray(payload.data.qrTags) ? payload.data.qrTags : [];
  for (let offset = 0; offset < tags.length; offset += 350) {
    const batch = writeBatch(DB());
    tags.slice(offset, offset + 350).forEach(function (tag) {
      if (!tag.publicSlug) return;
      const status = tag.status || (tag.targetType === "unassigned" ? "unassigned" : "active");
      const title = status === "retired" ? "Retired NEXUS Tag" :
        status === "lost" ? "Lost Registered Property" :
        status === "unassigned" ? "Unused NEXUS Tag" :
        tag.targetType === "book" ? "Registered Book" :
        tag.targetType === "location" ? "Registered Location" : "Registered Personal Property";
      batch.set(doc(DB(),"publicQr",tag.publicSlug), {
        labelCode:tag.labelCode || tag.id,
        targetType:tag.targetType || "unassigned",
        status:status === "assigned" ? "active" : status,
        publicTitle:title,
        publicMessage:status === "unassigned" ? "This tag is ready to be assigned." : "This QR tag belongs to a private NEXUS installation.",
        updatedAt:serverTimestamp()
      }, {merge:true});
    });
    await batch.commit();
  }

  const maxQr = tags.reduce(function (max, tag) {
    const match = String(tag.labelCode || tag.id || "").match(/QR-(\d+)/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 500);
  await setDoc(doc(DB(),"meta","counters"), {qr:maxQr, updatedAt:serverTimestamp()}, {merge:true});
  await N().writeActivity("system","Backup restored","system","phase3-restore",writes.length + " record(s) merged.");
}

function openCalibration() {
  const markup =
    "<div class='nexus-print-document'><div class='nexus-paper-head'><div><div class='nexus-paper-title'>NEXUS</div><div class='nexus-paper-sub'>PRINT CALIBRATION</div></div><div class='nexus-paper-motto'>US LETTER · 100% SCALE</div></div>" +
    "<div style='display:grid;gap:18px;color:#111'><div style='border:1px solid #111;width:1in;height:1in;display:grid;place-items:center;font:12px Arial'>1 INCH</div>" +
    "<div style='border-top:1px solid #111;width:4in;padding-top:6px;font:11px Arial'>This line should measure exactly 4 inches.</div>" +
    "<div style='border:1px dashed #888;width:1.75in;height:1.1in;display:grid;place-items:center;font:11px Arial;text-align:center'>STANDARD TAG<br>CUT GUIDE</div>" +
    "<p style='font:11px/1.5 Arial;max-width:6in'>Print with paper size <strong>Letter</strong> and scale <strong>100%</strong> or <strong>Actual size</strong>. Disable “Fit to page” if it changes these measurements.</p></div></div>";
  const body = "<div class='inline-note'>Use this once to confirm your phone/printer is not shrinking NEXUS labels.</div><div class='nexus-print-preview'>" + markup + "</div>";
  const modal = N().openModal("Print Calibration", body, {
    wide:true,
    footer:"<button class='btn btn-secondary' data-close-modal>Close</button><button class='btn btn-primary' id='p3-print-calibration-now'>Print Calibration</button>"
  });
  modal.querySelector("#p3-print-calibration-now").addEventListener("click", function () { printMarkup(markup); });
}

function printMarkup(markup) {
  const old = document.getElementById("nexus-print-root");
  if (old) old.remove();
  const root = document.createElement("div");
  root.id = "nexus-print-root";
  root.className = "nexus-print-root";
  root.innerHTML = markup;
  document.body.appendChild(root);
  document.body.classList.add("nexus-printing");

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    document.body.classList.remove("nexus-printing");
    const current = document.getElementById("nexus-print-root");
    if (current) current.remove();
    window.removeEventListener("afterprint", cleanup);
  }
  window.addEventListener("afterprint", cleanup, {once:true});
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      try { window.print(); }
      catch (error) { cleanup(); N().toast("Printing failed",error.message || "Could not open print dialog.","error"); }
    });
  });
  setTimeout(cleanup,90000);
}

document.addEventListener("nexus:ready", init);
if (window.NEXUS) init();
