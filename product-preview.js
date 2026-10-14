/* NEXUS Product Preview — optional, read-only barcode research.
   No barcode lookup is saved to Firestore unless the user explicitly opens
   the existing Asset or Book creation form and saves there. */
const PRODUCT_CATALOGS = [
  {name:"Open Food Facts",host:"world.openfoodfacts.org",kind:"Food"},
  {name:"Open Beauty Facts",host:"openbeautyfacts.org",kind:"Beauty"},
  {name:"Open Products Facts",host:"openproductsfacts.org",kind:"Products"},
  {name:"Open Pet Food Facts",host:"openpetfoodfacts.org",kind:"Pet Food"}
];
const productCache = new Map();
let preview = null;
let reader = null;
let requestController = null;
let requestId = 0;
let currentProduct = null;
let observing = null;
let initialized = false;

function nexus(){ return window.NEXUS; }
function esc(value){ return nexus().escapeHtml(String(value ?? "")); }
function barcodeValue(value){ return String(value || "").trim().replace(/[\s-]/g,"").toUpperCase(); }
function isBarcode(value){ return /^(?:\d{8}|\d{9}[\dX]|\d{12,14})$/.test(value); }
function isIsbn(value){ return /^(?:97[89]\d{10}|\d{9}[\dX])$/.test(value); }
function safeUrl(value){
  try { const url=new URL(String(value || "")); return url.protocol==="https:" ? url.href : ""; }
  catch(_){ return ""; }
}
function sourceLink(title,url){
  const safe=safeUrl(url);
  return safe?"<a class='btn btn-small btn-secondary' href='"+esc(safe)+"' target='_blank' rel='noopener noreferrer'>"+esc(title)+" ↗</a>":"";
}
function webSearch(barcode,shopping){
  return "https://www.google.com/search?"+(shopping?"tbm=shop&":"")+"q="+encodeURIComponent(barcode+" product");
}
function sourceLinks(barcode, product){
  return "<div class='np-sources'>"+
    (product && product.sourceUrl ? sourceLink("View "+product.source,product.sourceUrl) : "")+
    sourceLink("Search the web",webSearch(barcode,false))+
    sourceLink("Find shopping listings",webSearch(barcode,true))+
    "</div>";
}
function richText(value){ return esc(String(value || "").slice(0,650)); }
function stateNode(){
  return preview && preview.querySelector("#np-result");
}
function updateStatus(markup){
  const node=stateNode();
  if(node) node.innerHTML=markup;
}
function openPreview(initialBarcode){
  if(!nexus() || !nexus().state.user) return;
  cleanup();
  currentProduct=null;
  const body =
    "<div class='np-intro'><div class='eyebrow'>UNIVERSAL LOOKUP</div><p>Point your camera at a retail barcode or type its numbers. NEXUS shows a quick preview without adding anything to your records.</p></div>"+
    "<form id='np-lookup-form' class='np-lookup-form'><label class='np-code-label' for='np-code'>UPC · EAN · GTIN · ISBN</label>"+
      "<div class='np-lookup-row'><input id='np-code' name='barcode' type='text' inputmode='numeric' autocomplete='off' spellcheck='false' placeholder='Scan or enter a product barcode' value='"+esc(initialBarcode||"")+"' aria-label='Product barcode'>"+
      "<button class='btn btn-primary' type='submit'>Look up</button></div></form>"+
    "<div class='np-toolbar'><button type='button' class='btn btn-secondary' id='np-camera-toggle'>▦ Scan with camera</button><span class='microcopy'>Public catalogs · no automatic save</span></div>"+
    "<div id='np-camera-panel' class='np-camera-panel hidden'><div id='np-camera-reader' class='scan-reader'></div><button class='btn btn-small btn-secondary' id='np-stop-camera' type='button'>Stop camera</button></div>"+
    "<div id='np-result' class='np-result' aria-live='polite'><div class='np-placeholder'>Scan a barcode to see product details, images, and source links.</div></div>";
  preview=nexus().openModal("Product Preview",body,{wide:true,
    footer:"<span class='microcopy'>Details come from third-party databases and may be incomplete.</span><button class='btn btn-secondary' data-close-modal type='button'>Done</button>"});
  const owner=preview;
  owner.querySelector("#np-lookup-form").addEventListener("submit",function(event){
    event.preventDefault(); lookupCode(owner.querySelector("#np-code").value);
  });
  owner.querySelector("#np-camera-toggle").addEventListener("click",function(){toggleCamera();});
  owner.querySelector("#np-stop-camera").addEventListener("click",function(){stopCamera(true);});
  owner.querySelector("#np-result").addEventListener("click",function(event){
    const action=event.target.closest("[data-np-action]");
    if(!action || !currentProduct) return;
    if(action.dataset.npAction==="asset"){
      const product=currentProduct;
      cleanup();
      nexus().openAssetForm({
        name:product.title || "Scanned product",
        model:product.model || "",
        notes:"Barcode: "+product.barcode+"\nBrand: "+(product.brand||"Not listed")+
          "\nSize: "+(product.quantity||"Not listed")+
          "\nInformation source: "+product.source+
          (product.description?"\nDescription: "+product.description.slice(0,400):"")
      });
    }
    if(action.dataset.npAction==="book"){
      const code=currentProduct.barcode;
      cleanup();
      nexus().openBookForm(null,code);
    }
  });
  const backdrop=document.getElementById("modal-backdrop");
  observing=new MutationObserver(function(){
    if(preview && (backdrop.classList.contains("hidden") || !preview.querySelector("#np-lookup-form"))){
      cleanup();
    }
  });
  observing.observe(backdrop,{attributes:true,attributeFilter:["class"]});
  observing.observe(preview,{childList:true});
  if(initialBarcode) lookupCode(initialBarcode);
  else owner.querySelector("#np-code").focus();
}
function cleanup(){
  requestId++;
  if(requestController){ requestController.abort();requestController=null; }
  if(observing){observing.disconnect();observing=null;}
  stopCamera(false);
  preview=null;
  currentProduct=null;
}
async function stopCamera(hide){
  const old=reader;
  reader=null;
  if(old){try{await old.clear();}catch(_){/* Camera may already have stopped. */}}
  const panel=document.getElementById("np-camera-panel");
  if(panel && hide) panel.classList.add("hidden");
}
async function toggleCamera(){
  if(!preview)return;
  const panel=preview.querySelector("#np-camera-panel");
  if(reader){await stopCamera(true);return;}
  if(!window.Html5QrcodeScanner){
    nexus().toast("Camera unavailable","Enter the barcode manually instead.","error");return;
  }
  panel.classList.remove("hidden");
  const holder=preview.querySelector("#np-camera-reader");
  holder.innerHTML="";
  reader=new window.Html5QrcodeScanner("np-camera-reader",{
    fps:10,
    qrbox:function(w,h){return {width:Math.max(180,Math.min(320,Math.floor(w*.8))),height:Math.max(100,Math.min(160,Math.floor(h*.3))) };},
    rememberLastUsedCamera:true,
    showTorchButtonIfSupported:true,
    showZoomSliderIfSupported:true
  },false);
  const activeReader=reader;
  activeReader.render(async function(decoded){
    const value=barcodeValue(decoded);
    if(reader!==activeReader || !isBarcode(value))return;
    await stopCamera(true);
    if(!preview)return;
    preview.querySelector("#np-code").value=value;
    lookupCode(value);
  },function(){});
}
async function fetchJson(url,signal){
  const timeoutController=new AbortController();
  const timer=setTimeout(function(){timeoutController.abort();},5500);
  const abort=function(){timeoutController.abort();};
  if(signal)signal.addEventListener("abort",abort,{once:true});
  try{
    const response=await fetch(url,{mode:"cors",signal:timeoutController.signal,headers:{"Accept":"application/json"}});
    if(!response.ok)return null;
    return await response.json();
  }catch(_){return null;}
  finally{
    clearTimeout(timer);
    if(signal)signal.removeEventListener("abort",abort);
  }
}
function fromOpenFacts(catalog, data, barcode){
  if(!data || Number(data.status)!==1 || !data.product) return null;
  const p=data.product;
  const title=String(p.product_name_en || p.product_name || p.generic_name || "").trim();
  if(!title)return null;
  return {
    barcode:barcode,title:title,brand:p.brands||"",quantity:p.quantity||"",
    category:p.categories||catalog.kind,description:p.generic_name||"",
    image:safeUrl(p.image_front_url||p.image_url||""),
    ingredients:p.ingredients_text||"",allergens:p.allergens||"",
    score:p.nutriscore_grade && p.nutriscore_grade!=="unknown" ? String(p.nutriscore_grade).toUpperCase() : "",
    model:"",source:catalog.name,
    sourceUrl:"https://"+catalog.host+"/product/"+encodeURIComponent(barcode)
  };
}
async function lookUpCatalog(catalog,barcode,signal){
  const fields="code,product_name,product_name_en,generic_name,brands,quantity,categories,image_front_url,image_url,ingredients_text,allergens,nutriscore_grade";
  const api="https://"+catalog.host+"/api/v2/product/"+encodeURIComponent(barcode)+"?fields="+fields;
  return fromOpenFacts(catalog,await fetchJson(api,signal),barcode);
}
async function lookUpUpc(barcode,signal){
  const data=await fetchJson("https://api.upcitemdb.com/prod/trial/lookup?upc="+encodeURIComponent(barcode),signal);
  const p=data && Array.isArray(data.items) ? data.items[0] : null;
  if(!p || !p.title)return null;
  return {
    barcode:barcode,title:p.title,brand:p.brand||"",quantity:p.size||p.weight||p.dimension||"",
    category:p.category||"",description:p.description||"",image:safeUrl((p.images||[])[0]),
    ingredients:"",allergens:"",score:"",model:p.model||"",source:"UPCitemdb",
    sourceUrl:"https://www.upcitemdb.com/upc/"+encodeURIComponent(barcode)
  };
}
async function lookUpBook(barcode,signal){
  const p=await fetchJson("https://openlibrary.org/isbn/"+encodeURIComponent(barcode)+".json",signal);
  if(!p || !p.title)return null;
  return {
    barcode:barcode,title:p.title,brand:Array.isArray(p.publishers)?p.publishers.join(", "):"",
    quantity:p.number_of_pages ? p.number_of_pages+" pages" : "",
    category:"Book",description:typeof p.description==="string"?p.description:(p.description&&p.description.value)||"",
    image:p.covers&&p.covers[0]?"https://covers.openlibrary.org/b/id/"+encodeURIComponent(p.covers[0])+"-M.jpg":"",
    ingredients:"",allergens:"",score:"",model:"",source:"Open Library",
    sourceUrl:"https://openlibrary.org/isbn/"+encodeURIComponent(barcode)
  };
}
async function resolveProduct(barcode,signal){
  if(productCache.has(barcode))return productCache.get(barcode);
  let found=null;
  if(isIsbn(barcode))found=await lookUpBook(barcode,signal);
  if(!found){
    const results=await Promise.all(PRODUCT_CATALOGS.map(function(catalog){return lookUpCatalog(catalog,barcode,signal);}));
    found=results.filter(Boolean).sort(function(a,b){
      const score=function(p){return Number(!!p.image)+Number(!!p.brand)+Number(!!p.quantity)+Number(!!p.description);};
      return score(b)-score(a);
    })[0]||null;
  }
  if(!found && !signal.aborted)found=await lookUpUpc(barcode,signal);
  if(!signal.aborted && found)productCache.set(barcode,found);
  return found;
}
function displayProduct(product){
  currentProduct=product;
  const image=product.image?
    "<div class='np-product-image'><img src='"+esc(product.image)+"' alt='"+esc(product.title)+"' loading='lazy' referrerpolicy='no-referrer'></div>":
    "<div class='np-product-image np-image-empty'><span>▣</span><small>Image unavailable</small></div>";
  const rows=[
    ["Brand",product.brand],
    ["Size / format",product.quantity],
    ["Category",product.category],
    ["Model",product.model],
    ["Barcode",product.barcode],
    ["Source",product.source]
  ].filter(function(pair){return pair[1];});
  updateStatus("<div class='np-preview-card'>"+
    image+"<div class='np-info'><div class='eyebrow'>PRODUCT MATCH</div><h3>"+esc(product.title)+"</h3>"+
    "<div class='np-meta'>"+rows.map(function(pair){return "<div><span>"+esc(pair[0])+"</span><strong>"+richText(pair[1])+"</strong></div>";}).join("")+"</div></div></div>"+
    (product.description?"<div class='np-description'><strong>Description</strong><p>"+richText(product.description)+"</p></div>":"")+
    (product.ingredients?"<details class='np-more'><summary>Ingredients</summary><p>"+richText(product.ingredients)+"</p></details>":"")+
    (product.allergens?"<details class='np-more'><summary>Allergens</summary><p>"+richText(product.allergens)+"</p></details>":"")+
    "<div class='np-actions'><button type='button' class='btn btn-primary' data-np-action='asset'>Add to Assets</button>"+
    (isIsbn(product.barcode)?"<button type='button' class='btn btn-secondary' data-np-action='book'>Catalog Book</button>":"")+"</div>"+
    sourceLinks(product.barcode,product)+"<p class='microcopy np-disclaimer'>Product listings can be incomplete or outdated. No live shelf prices or in-store inventory are verified.</p>");
}
function noMatch(barcode){
  currentProduct=null;
  updateStatus("<div class='np-empty'><span class='np-empty-symbol'>⌕</span><h3>No confirmed catalog match</h3>"+
    "<p>We couldn't identify this barcode in the available databases. Some store-exclusive and new products are not indexed, and a catalog may occasionally be unavailable. You can search the wider web.</p>"+
    "<div class='np-code-readout'>"+esc(barcode)+"</div>"+sourceLinks(barcode,null)+"</div>");
}
async function lookupCode(raw){
  if(!preview)return;
  const code=barcodeValue(raw);
  if(!isBarcode(code)){
    currentProduct=null;
    updateStatus("<div class='np-empty'><h3>Check the barcode</h3><p>Enter an 8-, 12-, 13-, or 14-digit retail barcode, or a valid-length ISBN-10. Do not include a store SKU or a NEXUS QR URL.</p></div>");
    return;
  }
  preview.querySelector("#np-code").value=code;
  if(requestController)requestController.abort();
  const controller=new AbortController();
  requestController=controller;
  const id=++requestId;
  currentProduct=null;
  updateStatus("<div class='np-loading'><span class='np-loading-icon'>⌕</span><div><strong>Looking up "+esc(code)+"…</strong><p>Checking open product catalogs"+(isIsbn(code)?", book records":"")+" and the UPC directory when needed.</p></div></div>");
  const result=await resolveProduct(code,controller.signal);
  if(id!==requestId || controller.signal.aborted || !preview)return;
  if(result)displayProduct(result);
  else noMatch(code);
}
function init(){
  if(initialized || !window.NEXUS)return;
  initialized=true;
  document.addEventListener("nexus:product-preview",function(event){
    openPreview(event.detail && event.detail.barcode || "");
  });
  window.NEXUS.openProductPreview=openPreview;
}
document.addEventListener("nexus:ready",init);
if(window.NEXUS)init();
