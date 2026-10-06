import {
  doc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const BULK = {
  view: null,
  active: false,
  selected: new Set()
};

const SUPPORTED = {
  library: {
    collection: "books",
    label: "books",
    itemSelector: "#book-rows tr",
    idFrom: function (item) {
      const el = item.querySelector("[data-action='edit-book']");
      return el && el.dataset.id;
    }
  },
  assets: {
    collection: "assets",
    label: "assets",
    itemSelector: "#asset-grid .entity-card",
    idFrom: function (item) {
      const el = item.querySelector("[data-action='edit-asset']");
      return el && el.dataset.id;
    }
  },
  locations: {
    collection: "locations",
    label: "locations",
    itemSelector: "#location-grid .entity-card",
    idFrom: function (item) {
      const el = item.querySelector("[data-action='edit-location']");
      return el && el.dataset.id;
    }
  },
  money: {
    collection: "transactions",
    label: "transactions",
    itemSelector: "#transaction-rows tr",
    idFrom: function (item) {
      const el = item.querySelector("[data-action='edit-transaction']");
      return el && el.dataset.id;
    }
  },
  receipts: {
    collection: "receipts",
    label: "receipts",
    itemSelector: "#receipt-rows tr",
    idFrom: function (item) {
      const el = item.querySelector("[data-action='view-receipt']");
      return el && el.dataset.id;
    }
  },
  qr: {
    collection: "qrTags",
    label: "QR tags",
    itemSelector: "#qr-grid .qr-card",
    idFrom: function (item) {
      const el = item.querySelector("[data-action='print-one-tag'],[data-action='assign-tag']");
      return el && (el.dataset.code || el.dataset.id);
    }
  }
};

function N() { return window.NEXUS; }
function S() { return N().state; }
function esc(value) { return N().escapeHtml(value); }

function option(value, label, selected) {
  return "<option value='" + esc(value) + "' " + (String(value) === String(selected) ? "selected" : "") + ">" + esc(label == null ? value : label) + "</option>";
}

function locationOptions(selected, excludeIds) {
  const excluded = new Set(excludeIds || []);
  return option("", "Not assigned", selected) + S().data.locations
    .filter(function (loc) { return !excluded.has(loc.id); })
    .map(function (loc) {
      return option(loc.id, N().locationName(loc.id) || loc.name, selected);
    }).join("");
}

function enhance(view) {
  if (!SUPPORTED[view]) {
    if (BULK.active) exitBulkMode();
    return;
  }

  if (BULK.view !== view) {
    BULK.view = view;
    BULK.active = false;
    BULK.selected.clear();
  }

  const actions = document.querySelector(".view-header .actions");
  if (actions && !actions.querySelector("[data-bulk-toggle]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary";
    button.dataset.bulkToggle = "1";
    button.textContent = "☑ Bulk Edit";
    actions.insertBefore(button, actions.firstChild);
  }

  if (BULK.active) applySelectionUI();
}

function enterBulkMode() {
  const config = SUPPORTED[S().view];
  if (!config) return;
  BULK.view = S().view;
  BULK.active = true;
  BULK.selected.clear();
  applySelectionUI();
}

function exitBulkMode() {
  BULK.active = false;
  BULK.selected.clear();
  const view = document.getElementById("view");
  if (!view) return;
  view.classList.remove("bulk-selection-mode");
  view.querySelectorAll(".bulk-select-cell,.bulk-card-selector,.bulk-selection-bar").forEach(function (el) { el.remove(); });
  view.querySelectorAll(".bulk-selected").forEach(function (el) { el.classList.remove("bulk-selected"); });
}

function currentItems() {
  const config = SUPPORTED[BULK.view];
  if (!config) return [];
  return Array.from(document.querySelectorAll(config.itemSelector)).map(function (element) {
    return { element: element, id: config.idFrom(element) };
  }).filter(function (entry) { return !!entry.id; });
}

function isVisible(element) {
  if (!element) return false;
  if (element.hidden) return false;
  if (element.style && element.style.display === "none") return false;
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function applySelectionUI() {
  const config = SUPPORTED[BULK.view];
  const view = document.getElementById("view");
  if (!config || !view) return;
  view.classList.add("bulk-selection-mode");

  const table = view.querySelector(config.itemSelector) && view.querySelector(config.itemSelector).closest("table");
  if (table) {
    const headRow = table.querySelector("thead tr");
    if (headRow && !headRow.querySelector(".bulk-select-cell")) {
      const th = document.createElement("th");
      th.className = "bulk-select-cell";
      th.innerHTML = "<input class='bulk-master-checkbox' type='checkbox' aria-label='Select visible records'>";
      headRow.insertBefore(th, headRow.firstChild);
    }
  }

  currentItems().forEach(function (entry) {
    const item = entry.element;
    const id = entry.id;
    if (item.tagName === "TR") {
      if (!item.querySelector(".bulk-select-cell")) {
        const td = document.createElement("td");
        td.className = "bulk-select-cell";
        td.innerHTML = "<input class='bulk-record-checkbox' type='checkbox' data-bulk-id='" + esc(id) + "' aria-label='Select record'>";
        item.insertBefore(td, item.firstChild);
      }
    } else {
      if (!item.querySelector(".bulk-card-selector")) {
        const label = document.createElement("label");
        label.className = "bulk-card-selector";
        label.innerHTML = "<input class='bulk-record-checkbox' type='checkbox' data-bulk-id='" + esc(id) + "'><span></span>";
        item.insertBefore(label, item.firstChild);
      }
    }
    const checked = BULK.selected.has(id);
    const checkbox = item.querySelector(".bulk-record-checkbox");
    if (checkbox) checkbox.checked = checked;
    item.classList.toggle("bulk-selected", checked);
  });

  let bar = view.querySelector(".bulk-selection-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "bulk-selection-bar";
    const header = view.querySelector(".view-header");
    if (header) header.insertAdjacentElement("afterend", bar);
  }
  renderBulkBar();
}

function renderBulkBar() {
  const bar = document.querySelector(".bulk-selection-bar");
  const config = SUPPORTED[BULK.view];
  if (!bar || !config) return;
  const selected = BULK.selected.size;
  bar.innerHTML =
    "<div class='bulk-selection-summary'><strong>" + selected + " selected</strong><span>" + esc(config.label) + "</span></div>" +
    "<div class='bulk-selection-actions'>" +
      "<button class='btn btn-small btn-secondary' type='button' data-bulk-action='visible'>Select visible</button>" +
      "<button class='btn btn-small btn-secondary' type='button' data-bulk-action='all'>Select all</button>" +
      "<button class='btn btn-small btn-ghost' type='button' data-bulk-action='clear'>Clear</button>" +
      (BULK.view === "qr" && selected ? "<button class='btn btn-small btn-secondary' type='button' data-bulk-action='print'>Print selected</button>" : "") +
      "<button class='btn btn-small btn-primary' type='button' data-bulk-action='edit' " + (!selected ? "disabled" : "") + ">Edit selected</button>" +
      "<button class='btn btn-small btn-ghost' type='button' data-bulk-action='done'>Done</button>" +
    "</div>";
}

function selectVisible() {
  currentItems().forEach(function (entry) {
    if (isVisible(entry.element)) BULK.selected.add(entry.id);
  });
  applySelectionUI();
}

function selectAll() {
  currentItems().forEach(function (entry) { BULK.selected.add(entry.id); });
  applySelectionUI();
}

function setRecordSelected(id, checked, element) {
  if (checked) BULK.selected.add(id);
  else BULK.selected.delete(id);
  if (element) element.classList.toggle("bulk-selected", checked);
  renderBulkBar();
}

function fieldToggle(name, label, control, hint) {
  return "<div class='bulk-field'><label class='bulk-field-enable'><input type='checkbox' name='enable_" + esc(name) + "'> <strong>" + esc(label) + "</strong></label>" +
    "<div class='bulk-field-control' data-bulk-control='" + esc(name) + "'>" + control + (hint ? "<div class='field-hint'>" + esc(hint) + "</div>" : "") + "</div></div>";
}

function bookEditor(ids) {
  const body =
    "<div class='inline-note'>Only checked fields will be changed. Everything else stays exactly as it is.</div>" +
    "<form id='bulk-edit-form' class='bulk-edit-form'>" +
      fieldToggle("locationId","Location","<select name='locationId'>" + locationOptions("", []) + "</select>") +
      fieldToggle("readingStatus","Reading status","<select name='readingStatus'>" +
        ["Unread","Reading","Finished","Reference"].map(function (x) { return option(x,x); }).join("") + "</select>") +
      fieldToggle("format","Format","<select name='format'>" +
        ["Hardcover","Paperback","Leather / Imitation Leather","Spiral","Other"].map(function (x) { return option(x,x); }).join("") + "</select>") +
      fieldToggle("publisher","Publisher","<input name='publisher' maxlength='180' placeholder='Set the same publisher'>") +
      fieldToggle("year","Publication year","<input name='year' maxlength='40' placeholder='2026'>") +
      fieldToggle("purchasePrice","Purchase price","<input name='purchasePrice' type='number' min='0' step='0.01'>") +
      fieldToggle("collections","Collections","<div class='bulk-inline-grid'><select name='collectionsMode'><option value='add'>Add</option><option value='remove'>Remove</option><option value='replace'>Replace</option></select><input name='collections' placeholder='Theology, Favorites'></div>","Comma-separated") +
      fieldToggle("notes","Notes","<div class='bulk-inline-grid'><select name='notesMode'><option value='append'>Append</option><option value='replace'>Replace</option><option value='clear'>Clear</option></select><textarea name='notes' placeholder='Text to apply'></textarea></div>") +
    "</form>";
  return { title:"Bulk Edit Books", body:body };
}

function assetEditor() {
  const categories=["Electronics","Computer","School","Furniture","Tool","Container","Collectible","Appliance","Other"];
  const conditions=["New","Excellent","Good","Fair","Needs Repair"];
  const body =
    "<div class='inline-note'>Only checked fields will be changed. Everything else stays exactly as it is.</div>" +
    "<form id='bulk-edit-form' class='bulk-edit-form'>" +
      fieldToggle("locationId","Location","<select name='locationId'>" + locationOptions("", []) + "</select>") +
      fieldToggle("category","Category","<select name='category'>" + categories.map(function(x){return option(x,x);}).join("") + "</select>") +
      fieldToggle("condition","Condition","<select name='condition'>" + conditions.map(function(x){return option(x,x);}).join("") + "</select>") +
      fieldToggle("purchaseDate","Purchase date","<input name='purchaseDate' type='date'>") +
      fieldToggle("warrantyExpiration","Warranty expiration","<input name='warrantyExpiration' type='date'>") +
      fieldToggle("purchasePrice","Purchase price","<input name='purchasePrice' type='number' min='0' step='0.01'>") +
      fieldToggle("notes","Notes","<div class='bulk-inline-grid'><select name='notesMode'><option value='append'>Append</option><option value='replace'>Replace</option><option value='clear'>Clear</option></select><textarea name='notes' placeholder='Text to apply'></textarea></div>") +
    "</form>";
  return { title:"Bulk Edit Assets", body:body };
}

function locationEditor(ids) {
  const types=["Room","Bookcase","Shelf","Drawer","Cabinet","Closet","Box","Bag","Other"];
  const body =
    "<div class='inline-note'>Only checked fields will be changed. Selected locations are excluded from the parent-location list to prevent obvious self-parenting.</div>" +
    "<form id='bulk-edit-form' class='bulk-edit-form'>" +
      fieldToggle("parentId","Move inside","<select name='parentId'>" + locationOptions("", ids) + "</select>") +
      fieldToggle("type","Location type","<select name='type'>" + types.map(function(x){return option(x,x);}).join("") + "</select>") +
      fieldToggle("notes","Notes","<div class='bulk-inline-grid'><select name='notesMode'><option value='append'>Append</option><option value='replace'>Replace</option><option value='clear'>Clear</option></select><textarea name='notes'></textarea></div>") +
    "</form>";
  return { title:"Bulk Edit Locations", body:body };
}

function transactionEditor() {
  const categories=["Groceries","Dining","Transportation","Books","Electronics","Household","Personal Care","Education","Entertainment","Subscriptions","Medical","Gifts","Other"];
  const body =
    "<div class='inline-note'>Bulk transaction edits do not change the original receipt records linked to those transactions.</div>" +
    "<form id='bulk-edit-form' class='bulk-edit-form'>" +
      fieldToggle("category","Category","<select name='category'>" + categories.map(function(x){return option(x,x);}).join("") + "</select>") +
      fieldToggle("type","Type","<select name='type'><option value='expense'>Expense</option><option value='income'>Income</option></select>") +
      fieldToggle("date","Date","<input name='date' type='date'>") +
      fieldToggle("note","Note","<div class='bulk-inline-grid'><select name='noteMode'><option value='append'>Append</option><option value='replace'>Replace</option><option value='clear'>Clear</option></select><textarea name='note'></textarea></div>") +
    "</form>";
  return { title:"Bulk Edit Transactions", body:body };
}

function receiptEditor() {
  const categories=["Groceries","Dining","Transportation","Books","Electronics","Household","Personal Care","Education","Entertainment","Subscriptions","Medical","Gifts","Other"];
  const body =
    "<div class='inline-note'>You can update receipt-level fields or recategorize every line item in the selected receipts.</div>" +
    "<form id='bulk-edit-form' class='bulk-edit-form'>" +
      fieldToggle("date","Receipt date","<input name='date' type='date'>") +
      fieldToggle("paymentMethod","Payment method","<input name='paymentMethod' placeholder='Cash, Visa •••• 1234'>") +
      fieldToggle("status","Status","<select name='status'><option value='confirmed'>Confirmed</option><option value='needs-review'>Needs Review</option></select>") +
      fieldToggle("itemCategory","All line-item categories","<select name='itemCategory'>" + categories.map(function(x){return option(x,x);}).join("") + "</select>","Changes every extracted item on each selected receipt.") +
      fieldToggle("note","Note","<div class='bulk-inline-grid'><select name='noteMode'><option value='append'>Append</option><option value='replace'>Replace</option><option value='clear'>Clear</option></select><textarea name='note'></textarea></div>") +
    "</form>";
  return { title:"Bulk Edit Receipts", body:body };
}

function qrEditor() {
  const body =
    "<div class='inline-note'>Bulk QR editing intentionally avoids changing ownership/assignment. You can safely change print size here.</div>" +
    "<form id='bulk-edit-form' class='bulk-edit-form'>" +
      fieldToggle("size","Print size","<select name='size'><option value='tiny'>Tiny</option><option value='standard'>Standard</option><option value='book'>Book</option><option value='container'>Container</option></select>") +
    "</form>";
  return { title:"Bulk Edit QR Tags", body:body };
}

function editorForView(view, ids) {
  if (view === "library") return bookEditor(ids);
  if (view === "assets") return assetEditor(ids);
  if (view === "locations") return locationEditor(ids);
  if (view === "money") return transactionEditor(ids);
  if (view === "receipts") return receiptEditor(ids);
  if (view === "qr") return qrEditor(ids);
  return null;
}

function currentDataMap() {
  const config=SUPPORTED[BULK.view];
  const map=new Map();
  (S().data[config.collection] || []).forEach(function(record){ map.set(record.id,record); });
  return map;
}

function enabled(form,name) {
  const el=form.elements["enable_"+name];
  return !!(el && el.checked);
}

function applyTextMode(existing, value, mode) {
  if (mode === "clear") return "";
  if (mode === "replace") return value;
  if (!value) return existing || "";
  return existing ? String(existing).trimEnd() + "\n" + value : value;
}

function patchForRecord(view, record, form) {
  const patch={updatedAt:serverTimestamp()};

  if(view==="library"){
    if(enabled(form,"locationId")) patch.locationId=form.elements.locationId.value || null;
    if(enabled(form,"readingStatus")) patch.readingStatus=form.elements.readingStatus.value;
    if(enabled(form,"format")) patch.format=form.elements.format.value;
    if(enabled(form,"publisher")) patch.publisher=form.elements.publisher.value.trim();
    if(enabled(form,"year")) patch.year=form.elements.year.value.trim();
    if(enabled(form,"purchasePrice")) patch.purchasePrice=Number(form.elements.purchasePrice.value || 0);
    if(enabled(form,"collections")){
      const values=form.elements.collections.value.split(",").map(function(x){return x.trim();}).filter(Boolean);
      const mode=form.elements.collectionsMode.value;
      const current=Array.isArray(record.collections)?record.collections.slice():[];
      if(mode==="replace") patch.collections=Array.from(new Set(values));
      else if(mode==="add") patch.collections=Array.from(new Set(current.concat(values)));
      else {
        const remove=new Set(values.map(function(x){return x.toLowerCase();}));
        patch.collections=current.filter(function(x){return !remove.has(String(x).toLowerCase());});
      }
    }
    if(enabled(form,"notes")) patch.notes=applyTextMode(record.notes,form.elements.notes.value.trim(),form.elements.notesMode.value);
  }

  if(view==="assets"){
    if(enabled(form,"locationId")) patch.locationId=form.elements.locationId.value || null;
    if(enabled(form,"category")) patch.category=form.elements.category.value;
    if(enabled(form,"condition")) patch.condition=form.elements.condition.value;
    if(enabled(form,"purchaseDate")) patch.purchaseDate=form.elements.purchaseDate.value;
    if(enabled(form,"warrantyExpiration")) patch.warrantyExpiration=form.elements.warrantyExpiration.value;
    if(enabled(form,"purchasePrice")) patch.purchasePrice=Number(form.elements.purchasePrice.value || 0);
    if(enabled(form,"notes")) patch.notes=applyTextMode(record.notes,form.elements.notes.value.trim(),form.elements.notesMode.value);
  }

  if(view==="locations"){
    if(enabled(form,"parentId")) patch.parentId=form.elements.parentId.value || null;
    if(enabled(form,"type")) patch.type=form.elements.type.value;
    if(enabled(form,"notes")) patch.notes=applyTextMode(record.notes,form.elements.notes.value.trim(),form.elements.notesMode.value);
  }

  if(view==="money"){
    if(enabled(form,"category")) patch.category=form.elements.category.value;
    if(enabled(form,"type")) patch.type=form.elements.type.value;
    if(enabled(form,"date")) patch.date=form.elements.date.value;
    if(enabled(form,"note")) patch.note=applyTextMode(record.note,form.elements.note.value.trim(),form.elements.noteMode.value);
  }

  if(view==="receipts"){
    if(enabled(form,"date")) patch.date=form.elements.date.value;
    if(enabled(form,"paymentMethod")) patch.paymentMethod=form.elements.paymentMethod.value.trim();
    if(enabled(form,"status")) patch.status=form.elements.status.value;
    if(enabled(form,"itemCategory")){
      patch.items=(record.items || []).map(function(item){return Object.assign({},item,{category:form.elements.itemCategory.value});});
    }
    if(enabled(form,"note")) patch.note=applyTextMode(record.note,form.elements.note.value.trim(),form.elements.noteMode.value);
  }

  if(view==="qr"){
    if(enabled(form,"size")) patch.size=form.elements.size.value;
  }

  return patch;
}

function hasAnyEnabledField(form) {
  return Array.from(form.querySelectorAll("input[name^='enable_']")).some(function(input){return input.checked;});
}

async function commitBulkEdit() {
  const config=SUPPORTED[BULK.view];
  if(!config || !BULK.selected.size) return;
  const modal=document.getElementById("modal");
  const form=modal && modal.querySelector("#bulk-edit-form");
  if(!form || !hasAnyEnabledField(form)){
    N().toast("Nothing selected to change","Check at least one field in the bulk editor.","error");
    return;
  }

  const ids=Array.from(BULK.selected);
  const dataMap=currentDataMap();
  const save=modal.querySelector("#bulk-save");
  save.disabled=true;
  save.textContent="Updating…";

  try{
    for(let offset=0;offset<ids.length;offset+=400){
      const batch=writeBatch(N().db);
      ids.slice(offset,offset+400).forEach(function(id){
        const record=dataMap.get(id) || {id:id};
        batch.update(doc(N().db,config.collection,id),patchForRecord(BULK.view,record,form));
      });
      await batch.commit();
    }

    await N().writeActivity("system","Bulk edit applied",config.collection,"bulk-"+Date.now(),ids.length+" "+config.label+" updated");
    N().closeModal();
    BULK.selected.clear();
    BULK.active=false;
    await N().refresh([config.collection,"activity"]);
    N().toast("Bulk edit complete",ids.length+" "+config.label+" updated.","success");
  }catch(error){
    console.error(error);
    save.disabled=false;
    save.textContent="Apply Changes";
    N().toast("Bulk edit failed",error.message || "NEXUS could not update the selected records.","error");
  }
}

function openBulkEditor() {
  const ids=Array.from(BULK.selected);
  const editor=editorForView(BULK.view,ids);
  if(!editor || !ids.length) return;
  const modal=N().openModal(editor.title,editor.body,{
    wide:true,
    footer:"<button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='bulk-save'>Apply Changes to "+ids.length+"</button>"
  });
  modal.querySelectorAll(".bulk-field-enable input").forEach(function(toggle){
    const name=toggle.name.replace(/^enable_/,"");
    const control=modal.querySelector("[data-bulk-control='"+CSS.escape(name)+"']");
    function update(){
      if(control){
        control.classList.toggle("disabled",!toggle.checked);
        control.querySelectorAll("input,select,textarea").forEach(function(el){el.disabled=!toggle.checked;});
      }
    }
    toggle.addEventListener("change",update);
    update();
  });
  modal.querySelector("#bulk-save").addEventListener("click",commitBulkEdit);
}

function printSelectedQr() {
  if(BULK.view!=="qr" || !BULK.selected.size) return;
  const tags=S().data.qrTags.filter(function(tag){return BULK.selected.has(tag.id);});
  if(tags.length) N().printTags(tags);
}

function handleClick(event) {
  const toggle=event.target.closest("[data-bulk-toggle]");
  if(toggle){
    event.preventDefault();
    BULK.active ? exitBulkMode() : enterBulkMode();
    return;
  }

  const checkbox=event.target.closest(".bulk-record-checkbox");
  if(checkbox){
    const item=checkbox.closest("tr,.entity-card");
    setRecordSelected(checkbox.dataset.bulkId,checkbox.checked,item);
    return;
  }

  const master=event.target.closest(".bulk-master-checkbox");
  if(master){
    if(master.checked) selectVisible();
    else {
      currentItems().forEach(function(entry){
        if(isVisible(entry.element)) BULK.selected.delete(entry.id);
      });
      applySelectionUI();
    }
    return;
  }

  const action=event.target.closest("[data-bulk-action]");
  if(!action)return;
  event.preventDefault();
  const type=action.dataset.bulkAction;
  if(type==="visible") selectVisible();
  if(type==="all") selectAll();
  if(type==="clear"){BULK.selected.clear();applySelectionUI();}
  if(type==="edit") openBulkEditor();
  if(type==="print") printSelectedQr();
  if(type==="done") exitBulkMode();
}

document.addEventListener("nexus:render",function(event){
  enhance(event.detail && event.detail.view || S().view);
});
document.addEventListener("click",handleClick,true);

if(N().state && N().state.user) enhance(N().state.view);
