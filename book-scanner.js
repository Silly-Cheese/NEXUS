import {
  collection, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const BOOK_SCAN = {
  scanner: null,
  queue: [],
  lastCode: "",
  lastCodeAt: 0,
  busy: false,
  searchResults: []
};

function N(){ return window.NEXUS; }
function S(){ return N().state; }
function esc(value){ return N().escapeHtml(value); }

function normalizeIsbn(value){
  return String(value || "").toUpperCase().replace(/[^0-9X]/g,"");
}

function validIsbn13(isbn){
  if(!/^\d{13}$/.test(isbn)) return false;
  let sum=0;
  for(let i=0;i<12;i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
  const check=(10 - (sum % 10)) % 10;
  return check === Number(isbn[12]);
}

function validIsbn10(isbn){
  if(!/^\d{9}[\dX]$/.test(isbn)) return false;
  let sum=0;
  for(let i=0;i<10;i++){
    const value=isbn[i] === "X" ? 10 : Number(isbn[i]);
    sum += value * (10-i);
  }
  return sum % 11 === 0;
}

function isbn10To13(isbn){
  isbn=normalizeIsbn(isbn);
  if(!validIsbn10(isbn)) return isbn;
  const base="978"+isbn.slice(0,9);
  let sum=0;
  for(let i=0;i<12;i++) sum += Number(base[i]) * (i % 2 ? 3 : 1);
  return base + String((10 - (sum % 10)) % 10);
}

function canonicalIsbn(value){
  const isbn=normalizeIsbn(value);
  if(validIsbn13(isbn)) return isbn;
  if(validIsbn10(isbn)) return isbn10To13(isbn);
  return "";
}

function extractIsbns(text){
  const raw=String(text || "");
  const candidates=[];
  const explicit=raw.match(/ISBN(?:-1[03])?\s*:?\s*([0-9Xx][0-9Xx\s-]{8,20})/gi) || [];
  explicit.forEach(function(chunk){
    const value=canonicalIsbn(chunk.replace(/^.*?:/,"").replace(/^ISBN(?:-1[03])?/i,""));
    if(value) candidates.push(value);
  });
  const loose=raw.match(/97[89][0-9\s-]{10,20}|[0-9][0-9\s-]{8,16}[0-9Xx]/g) || [];
  loose.forEach(function(chunk){
    const value=canonicalIsbn(chunk);
    if(value) candidates.push(value);
  });
  return Array.from(new Set(candidates));
}

function existingBookByIsbn(isbn){
  return S().data.books.find(function(book){
    return canonicalIsbn(book.isbn || "") === canonicalIsbn(isbn);
  }) || null;
}

function cleanAuthors(authors){
  if(!authors) return "";
  if(Array.isArray(authors)) return authors.filter(Boolean).join(", ");
  return String(authors || "");
}

async function openLibraryByIsbn(isbn){
  const response=await fetch("https://openlibrary.org/isbn/"+encodeURIComponent(isbn)+".json");
  if(!response.ok) throw new Error("Open Library not found");
  const book=await response.json();
  let authors=[];
  if(Array.isArray(book.authors)){
    const resolved=await Promise.all(book.authors.slice(0,5).map(async function(author){
      if(!author || !author.key) return "";
      try{
        const r=await fetch("https://openlibrary.org"+author.key+".json");
        if(!r.ok) return "";
        return (await r.json()).name || "";
      }catch(_){ return ""; }
    }));
    authors=resolved.filter(Boolean);
  }
  const date=String(book.publish_date || "");
  const yearMatch=date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return {
    isbn:isbn,
    title:book.title || "",
    subtitle:book.subtitle || "",
    author:authors.join(", "),
    publisher:Array.isArray(book.publishers) ? (book.publishers[0] || "") : "",
    year:yearMatch ? yearMatch[0] : date,
    pageCount:Number(book.number_of_pages || 0),
    language:Array.isArray(book.languages) && book.languages[0] && book.languages[0].key ? String(book.languages[0].key).split("/").pop() : "",
    subjects:Array.isArray(book.subjects) ? book.subjects.slice(0,20) : [],
    coverUrl:book.covers && book.covers[0] ? "https://covers.openlibrary.org/b/id/"+book.covers[0]+"-M.jpg" : "",
    metadataSources:["Open Library"]
  };
}

function googleVolumeToBook(item, fallbackIsbn){
  const info=item && item.volumeInfo || {};
  const identifiers=info.industryIdentifiers || [];
  let isbn13="";
  let isbn10="";
  identifiers.forEach(function(id){
    if(id.type==="ISBN_13") isbn13=normalizeIsbn(id.identifier);
    if(id.type==="ISBN_10") isbn10=normalizeIsbn(id.identifier);
  });
  const isbn=canonicalIsbn(isbn13 || isbn10 || fallbackIsbn);
  const yearMatch=String(info.publishedDate || "").match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return {
    isbn:isbn || canonicalIsbn(fallbackIsbn),
    title:info.title || "",
    subtitle:info.subtitle || "",
    author:cleanAuthors(info.authors),
    publisher:info.publisher || "",
    year:yearMatch ? yearMatch[0] : String(info.publishedDate || ""),
    pageCount:Number(info.pageCount || 0),
    language:info.language || "",
    subjects:Array.isArray(info.categories) ? info.categories.slice(0,20) : [],
    description:info.description || "",
    coverUrl:info.imageLinks && (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail) || "",
    metadataSources:["Google Books"]
  };
}

async function googleBooksByIsbn(isbn){
  const response=await fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:"+encodeURIComponent(isbn)+"&maxResults=5");
  if(!response.ok) throw new Error("Google Books lookup failed");
  const data=await response.json();
  if(!data.items || !data.items.length) throw new Error("Google Books not found");
  return googleVolumeToBook(data.items[0],isbn);
}

async function googleBooksSearch(query){
  const response=await fetch("https://www.googleapis.com/books/v1/volumes?q="+encodeURIComponent(query)+"&maxResults=8");
  if(!response.ok) throw new Error("Google Books search failed");
  const data=await response.json();
  return (data.items || []).map(function(item){return googleVolumeToBook(item,"");}).filter(function(book){return book.title;});
}

async function openLibrarySearch(query){
  try{
    const response=await fetch("https://openlibrary.org/search.json?q="+encodeURIComponent(query)+"&limit=8");
    if(!response.ok) return [];
    const data=await response.json();
    return (data.docs || []).slice(0,8).map(function(doc){
      const isbn=(doc.isbn || []).map(canonicalIsbn).find(Boolean) || "";
      return {
        isbn:isbn,
        title:doc.title || "",
        subtitle:doc.subtitle || "",
        author:Array.isArray(doc.author_name) ? doc.author_name.slice(0,5).join(", ") : "",
        publisher:Array.isArray(doc.publisher) ? (doc.publisher[0] || "") : "",
        year:doc.first_publish_year ? String(doc.first_publish_year) : "",
        subjects:Array.isArray(doc.subject) ? doc.subject.slice(0,20) : [],
        coverUrl:doc.cover_i ? "https://covers.openlibrary.org/b/id/"+doc.cover_i+"-M.jpg" : "",
        metadataSources:["Open Library Search"]
      };
    }).filter(function(book){return book.title;});
  }catch(_){ return []; }
}

function mergeBookData(primary, secondary){
  primary=primary || {};
  secondary=secondary || {};
  const merged={};
  ["isbn","title","subtitle","author","publisher","year","language","description","coverUrl"].forEach(function(key){
    merged[key]=primary[key] || secondary[key] || "";
  });
  merged.pageCount=Number(primary.pageCount || secondary.pageCount || 0);
  merged.subjects=Array.from(new Set([].concat(primary.subjects || [],secondary.subjects || []))).slice(0,30);
  merged.metadataSources=Array.from(new Set([].concat(primary.metadataSources || [],secondary.metadataSources || [])));
  return merged;
}

async function lookupIsbnBroad(isbn){
  isbn=canonicalIsbn(isbn);
  if(!isbn) throw new Error("That is not a valid ISBN-10 or ISBN-13.");
  const results=await Promise.allSettled([openLibraryByIsbn(isbn),googleBooksByIsbn(isbn)]);
  let merged={isbn:isbn,metadataSources:[]};
  results.forEach(function(result){
    if(result.status==="fulfilled") merged=mergeBookData(merged,result.value);
  });
  if(!merged.title) throw new Error("No metadata source found this ISBN.");
  return merged;
}

function scoreSearchResult(book,query){
  const q=String(query || "").toLowerCase();
  const title=String(book.title || "").toLowerCase();
  const author=String(book.author || "").toLowerCase();
  let score=0;
  q.split(/\s+/).filter(Boolean).forEach(function(token){
    if(title.includes(token)) score+=4;
    if(author.includes(token)) score+=2;
  });
  if(book.isbn) score+=1;
  return score;
}

async function searchBooks(query){
  query=String(query || "").trim();
  if(!query) return [];
  const results=await Promise.allSettled([googleBooksSearch(query),openLibrarySearch(query)]);
  let books=[];
  results.forEach(function(result){
    if(result.status==="fulfilled") books=books.concat(result.value);
  });

  const map=new Map();
  books.forEach(function(book){
    const key=book.isbn || (String(book.title).toLowerCase()+"|"+String(book.author).toLowerCase());
    if(!key) return;
    if(map.has(key)) map.set(key,mergeBookData(map.get(key),book));
    else map.set(key,book);
  });
  return Array.from(map.values()).sort(function(a,b){return scoreSearchResult(b,query)-scoreSearchResult(a,query);}).slice(0,10);
}

function queueKey(book){
  return book.isbn || (String(book.title || "").toLowerCase()+"|"+String(book.author || "").toLowerCase());
}

function addToQueue(book){
  const key=queueKey(book);
  if(!key) return false;
  if(BOOK_SCAN.queue.some(function(item){return queueKey(item)===key;})) return false;
  BOOK_SCAN.queue.push(book);
  renderQueue();
  return true;
}

function removeQueue(index){
  BOOK_SCAN.queue.splice(index,1);
  renderQueue();
}

function renderQueue(){
  const panel=document.getElementById("book-scan-queue");
  const count=document.getElementById("book-queue-count");
  const catalog=document.getElementById("book-catalog-queue");
  if(count) count.textContent=String(BOOK_SCAN.queue.length);
  if(catalog) catalog.disabled=!BOOK_SCAN.queue.length;
  if(!panel) return;
  if(!BOOK_SCAN.queue.length){
    panel.innerHTML="<div class='empty-state compact'><strong>No books queued</strong><div>Scan a barcode, photograph a cover/copyright page, or search by title.</div></div>";
    return;
  }
  panel.innerHTML=BOOK_SCAN.queue.map(function(book,index){
    const duplicate=book.isbn && existingBookByIsbn(book.isbn);
    return "<article class='book-scan-result "+(duplicate?"duplicate":"")+"'>" +
      (book.coverUrl ? "<img src='"+esc(book.coverUrl)+"' alt='' loading='lazy'>" : "<div class='book-scan-cover-placeholder'>▥</div>") +
      "<div class='book-scan-result-main'><strong>"+esc(book.title || "Untitled")+"</strong><span>"+esc(book.author || "Unknown author")+"</span><small>"+esc([book.publisher,book.year,book.isbn].filter(Boolean).join(" · "))+"</small>"+
      (duplicate ? "<span class='badge amber'>Already in library</span>" : "")+"</div>"+
      "<div class='book-scan-result-actions'><button class='btn btn-small btn-ghost' type='button' data-book-review='"+index+"'>Review</button><button class='icon-btn' type='button' data-book-remove='"+index+"' aria-label='Remove'>×</button></div>"+
    "</article>";
  }).join("");
}

function renderSearchResults(results){
  const panel=document.getElementById("book-search-results");
  BOOK_SCAN.searchResults=Array.isArray(results)?results.slice():[];
  if(!panel) return;
  if(!BOOK_SCAN.searchResults.length){
    panel.innerHTML="<div class='inline-note'>No matching books found. Try an ISBN, fewer title words, or add manually.</div>";
    return;
  }
  panel.innerHTML=BOOK_SCAN.searchResults.map(function(book,index){
    return "<button class='book-search-option' type='button' data-book-search-result='"+index+"'>" +
      (book.coverUrl ? "<img src='"+esc(book.coverUrl)+"' alt='' loading='lazy'>" : "<span class='book-search-cover'>▥</span>")+
      "<span><strong>"+esc(book.title)+"</strong><small>"+esc(book.author || "Unknown author")+"</small><small>"+esc([book.year,book.isbn].filter(Boolean).join(" · "))+"</small></span><span>＋</span></button>";
  }).join("");
}

function locationOptions(){
  return "<option value=''>Not assigned</option>"+S().data.locations.map(function(loc){
    return "<option value='"+esc(loc.id)+"'>"+esc(N().locationName(loc.id) || loc.name)+"</option>";
  }).join("");
}

async function lookupAndQueueIsbn(isbn){
  isbn=canonicalIsbn(isbn);
  if(!isbn){
    N().toast("Not an ISBN","NEXUS did not recognize a valid ISBN-10 or ISBN-13.","error");
    return;
  }
  if(existingBookByIsbn(isbn)){
    N().toast("Already cataloged","That ISBN is already in your NEXUS library.","error");
    return;
  }
  if(BOOK_SCAN.queue.some(function(book){return book.isbn===isbn;})){
    N().toast("Already queued","That book is already waiting in this scan session.","error");
    return;
  }
  setBookScanStatus("Looking up "+isbn+"…",true);
  try{
    const book=await lookupIsbnBroad(isbn);
    addToQueue(book);
    N().toast("Book found",book.title+" was added to the scan queue.","success");
  }catch(error){
    addToQueue({isbn:isbn,title:"",author:"",publisher:"",year:"",metadataSources:[]});
    N().toast("ISBN queued","Metadata was not found, but you can review and enter it manually.","error");
  }finally{
    setBookScanStatus("Ready for another book.",false);
  }
}

function setBookScanStatus(text,active){
  const el=document.getElementById("book-scan-status");
  if(!el)return;
  el.classList.toggle("active",!!active);
  el.innerHTML="<span class='smart-status-dot'></span><span>"+esc(text)+"</span>";
}

async function startBarcodeScanner(){
  const reader=document.getElementById("book-barcode-reader");
  if(!reader)return;
  if(!window.Html5QrcodeScanner){
    N().toast("Scanner unavailable","The barcode scanner library did not load.","error");
    return;
  }
  if(BOOK_SCAN.scanner){
    try{await BOOK_SCAN.scanner.clear();}catch(_){}
    BOOK_SCAN.scanner=null;
  }
  reader.innerHTML="";
  setBookScanStatus("Starting camera…",true);
  const qrbox=function(viewWidth,viewHeight){
    return {width:Math.min(340,Math.floor(viewWidth*.82)),height:Math.min(150,Math.floor(viewHeight*.35))};
  };
  const scanner=new window.Html5QrcodeScanner("book-barcode-reader",{
    fps:12,
    qrbox:qrbox,
    aspectRatio:1.777778,
    rememberLastUsedCamera:true,
    showTorchButtonIfSupported:true,
    showZoomSliderIfSupported:true
  },false);
  BOOK_SCAN.scanner=scanner;
  scanner.render(async function(decodedText){
    const now=Date.now();
    if(decodedText===BOOK_SCAN.lastCode && now-BOOK_SCAN.lastCodeAt<2500)return;
    BOOK_SCAN.lastCode=decodedText;
    BOOK_SCAN.lastCodeAt=now;
    const isbn=canonicalIsbn(decodedText);
    if(isbn) await lookupAndQueueIsbn(isbn);
    else setBookScanStatus("Barcode read, but it was not a valid ISBN. Try the ISBN barcode above the price barcode.",false);
  },function(){});
  setBookScanStatus("Point the camera at the ISBN barcode. Keep scanning to build a batch.",false);
}

async function stopBarcodeScanner(){
  if(BOOK_SCAN.scanner){
    try{await BOOK_SCAN.scanner.clear();}catch(_){}
    BOOK_SCAN.scanner=null;
  }
}

function imageToDataUrl(file){
  return new Promise(function(resolve,reject){
    const reader=new FileReader();
    reader.onload=function(){resolve(reader.result);};
    reader.onerror=function(){reject(new Error("Could not read image."));};
    reader.readAsDataURL(file);
  });
}

function usefulOcrQuery(text){
  const lines=String(text || "").split(/\r?\n/).map(function(line){return line.trim();}).filter(function(line){
    if(line.length<3 || line.length>90)return false;
    if(/isbn|copyright|published|all rights reserved|www\.|http|page \d/i.test(line))return false;
    return (line.match(/[A-Za-z]/g)||[]).length>=3;
  });
  return lines.slice(0,5).join(" ");
}

async function scanBookPhoto(file){
  if(!file)return;
  if(!window.Tesseract){
    N().toast("OCR unavailable","The text-recognition library did not load.","error");
    return;
  }
  setBookScanStatus("Reading book photo…",true);
  try{
    const dataUrl=await imageToDataUrl(file);
    const result=await window.Tesseract.recognize(dataUrl,"eng",{
      logger:function(message){
        if(message.status)setBookScanStatus("Photo OCR · "+String(message.status).replaceAll("_"," "),true);
      }
    });
    const text=result.data.text || "";
    const isbns=extractIsbns(text);
    if(isbns.length){
      for(const isbn of isbns.slice(0,3)) await lookupAndQueueIsbn(isbn);
      return;
    }
    const query=usefulOcrQuery(text);
    if(!query)throw new Error("No useful title or ISBN text was detected.");
    setBookScanStatus("No ISBN seen. Searching by cover text…",true);
    const results=await searchBooks(query);
    renderSearchResults(results);
    if(!results.length)throw new Error("NEXUS read text, but no matching book metadata was found.");
  }catch(error){
    N().toast("Could not identify book",error.message || "Try the barcode, copyright page, or manual search.","error");
  }finally{
    setBookScanStatus("Ready.",false);
  }
}

function bookRecordFromQueue(book,settings){
  return {
    isbn:canonicalIsbn(book.isbn || ""),
    title:book.title || "Untitled",
    subtitle:book.subtitle || "",
    author:book.author || "",
    publisher:book.publisher || "",
    year:book.year || "",
    edition:book.edition || "",
    pageCount:Number(book.pageCount || 0),
    language:book.language || "",
    subjects:Array.isArray(book.subjects)?book.subjects:[],
    description:book.description || "",
    coverUrl:book.coverUrl || "",
    metadataSources:Array.isArray(book.metadataSources)?book.metadataSources:[],
    format:settings.format,
    locationId:settings.locationId || null,
    readingStatus:settings.readingStatus,
    purchasePrice:0,
    collections:[],
    notes:"",
    createdAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };
}

async function catalogQueue(){
  if(BOOK_SCAN.busy || !BOOK_SCAN.queue.length)return;
  BOOK_SCAN.busy=true;
  const button=document.getElementById("book-catalog-queue");
  if(button){button.disabled=true;button.textContent="Cataloging…";}
  const settings={
    locationId:(document.getElementById("book-batch-location")||{}).value || "",
    readingStatus:(document.getElementById("book-batch-status")||{}).value || "Unread",
    format:(document.getElementById("book-batch-format")||{}).value || "Hardcover",
    createQr:!!(document.getElementById("book-batch-qr")||{}).checked
  };

  let added=0,skipped=0;
  try{
    for(const book of BOOK_SCAN.queue){
      if(book.isbn && existingBookByIsbn(book.isbn)){skipped++;continue;}
      if(!book.title){skipped++;continue;}
      const record=bookRecordFromQueue(book,settings);
      const ref=await addDoc(collection(N().db,"books"),record);
      if(settings.createQr)await N().createTagForEntity("book",ref.id,record.title,"book",false);
      await N().writeActivity("book","Book cataloged","book",ref.id,record.title+(record.author?" · "+record.author:""));
      added++;
    }
    BOOK_SCAN.queue=[];
    await N().refresh(["books","qrTags","activity"]);
    N().toast("Batch catalog complete",added+" books added"+(skipped?" · "+skipped+" skipped":"")+".","success");
    N().closeModal();
  }catch(error){
    console.error(error);
    N().toast("Batch catalog failed",error.message || "NEXUS could not catalog the queue.","error");
    if(button){button.disabled=false;button.textContent="Catalog Queue";}
  }finally{
    BOOK_SCAN.busy=false;
  }
}

function openBookScanner(){
  BOOK_SCAN.queue=[];
  BOOK_SCAN.lastCode="";
  BOOK_SCAN.lastCodeAt=0;
  BOOK_SCAN.searchResults=[];

  const body=
    "<div class='book-scan-hero'><div><div class='eyebrow'>LIBRARY CAPTURE</div><h3>Scan books almost any way</h3><p>Barcode, ISBN, cover/copyright photo, or title/author search. Keep scanning to build a batch.</p></div><span class='badge gold'><span id='book-queue-count'>0</span> queued</span></div>"+
    "<div class='book-scan-tabs'><button class='btn btn-small btn-primary' type='button' data-book-tab='barcode'>Barcode</button><button class='btn btn-small btn-secondary' type='button' data-book-tab='photo'>Photo / OCR</button><button class='btn btn-small btn-secondary' type='button' data-book-tab='search'>Search</button></div>"+
    "<section class='book-scan-pane' data-book-pane='barcode'><div class='inline-note'>Scan the EAN/ISBN barcode. The camera stays open so you can scan a whole stack of books.</div><div id='book-barcode-reader' class='scan-reader'></div><button class='btn btn-secondary' id='book-start-camera' type='button'>Start / Restart Camera</button></section>"+
    "<section class='book-scan-pane hidden' data-book-pane='photo'><div class='grid grid-2'><label class='ocr-drop book-photo-drop' for='book-photo-camera'><div><strong>Take Photo</strong><div class='microcopy'>Cover, copyright page, or ISBN page</div></div></label><label class='ocr-drop book-photo-drop' for='book-photo-file'><div><strong>Choose Image</strong><div class='microcopy'>NEXUS looks for ISBN first, then title text</div></div></label></div><input id='book-photo-camera' type='file' accept='image/*' capture='environment' hidden><input id='book-photo-file' type='file' accept='image/*' hidden></section>"+
    "<section class='book-scan-pane hidden' data-book-pane='search'><div class='book-search-bar'><input id='book-search-input' placeholder='ISBN, title, author, title + author…'><button class='btn btn-primary' id='book-search-button' type='button'>Search</button></div><div id='book-search-results' class='book-search-results'></div></section>"+
    "<div id='book-scan-status' class='smart-ocr-status'><span class='smart-status-dot'></span><span>Ready.</span></div>"+
    "<div class='divider'></div>"+
    "<div class='book-batch-settings'><div><div class='eyebrow'>BATCH DEFAULTS</div><strong>Apply to books cataloged from this queue</strong></div><div class='book-batch-grid'><label>Location<select id='book-batch-location'>"+locationOptions()+"</select></label><label>Status<select id='book-batch-status'><option>Unread</option><option>Reading</option><option>Finished</option><option>Reference</option></select></label><label>Format<select id='book-batch-format'><option>Hardcover</option><option>Paperback</option><option>Leather / Imitation Leather</option><option>Spiral</option><option>Other</option></select></label><label class='check-row'><input id='book-batch-qr' type='checkbox' checked> Create QR tags</label></div></div>"+
    "<div class='divider'></div><div class='card-title-row'><div><h3>Scan Queue</h3><div class='microcopy'>Review individual books or catalog the whole stack.</div></div></div><div id='book-scan-queue' class='book-scan-queue'></div>";

  const modal=N().openModal("Book Scanner",body,{
    wide:true,
    footer:"<button class='btn btn-secondary' data-close-modal>Close</button><button class='btn btn-primary' id='book-catalog-queue' disabled>Catalog Queue</button>"
  });

  renderQueue();

  modal.querySelectorAll("[data-book-tab]").forEach(function(button){
    button.addEventListener("click",async function(){
      const tab=button.dataset.bookTab;
      modal.querySelectorAll("[data-book-tab]").forEach(function(x){x.classList.toggle("btn-primary",x===button);x.classList.toggle("btn-secondary",x!==button);});
      modal.querySelectorAll("[data-book-pane]").forEach(function(pane){pane.classList.toggle("hidden",pane.dataset.bookPane!==tab);});
      if(tab!=="barcode")await stopBarcodeScanner();
    });
  });

  modal.querySelector("#book-start-camera").addEventListener("click",startBarcodeScanner);

  ["book-photo-camera","book-photo-file"].forEach(function(id){
    modal.querySelector("#"+id).addEventListener("change",function(event){
      scanBookPhoto(event.target.files && event.target.files[0]);
    });
  });

  async function doSearch(){
    const input=modal.querySelector("#book-search-input");
    const query=input.value.trim();
    if(!query)return;
    const isbn=canonicalIsbn(query);
    if(isbn){
      await lookupAndQueueIsbn(isbn);
      return;
    }
    setBookScanStatus("Searching book catalogs…",true);
    try{
      const results=await searchBooks(query);
      renderSearchResults(results);
      setBookScanStatus(results.length ? results.length+" results found." : "No results found.",false);
    }catch(error){
      setBookScanStatus("Search failed.",false);
      N().toast("Book search failed",error.message || "Try again.","error");
    }
  }

  modal.querySelector("#book-search-button").addEventListener("click",doSearch);
  modal.querySelector("#book-search-input").addEventListener("keydown",function(event){if(event.key==="Enter"){event.preventDefault();doSearch();}});

  modal.querySelector("#book-search-results").addEventListener("click",function(event){
    const result=event.target.closest("[data-book-search-result]");
    if(!result)return;
    const book=BOOK_SCAN.searchResults[Number(result.dataset.bookSearchResult)];
    if(book && addToQueue(book))N().toast("Added to queue",book.title,"success");
  });

  modal.querySelector("#book-scan-queue").addEventListener("click",async function(event){
    const remove=event.target.closest("[data-book-remove]");
    if(remove){removeQueue(Number(remove.dataset.bookRemove));return;}
    const review=event.target.closest("[data-book-review]");
    if(review){
      const book=BOOK_SCAN.queue[Number(review.dataset.bookReview)];
      if(!book)return;
      await stopBarcodeScanner();
      N().closeModal();
      N().openBookForm(book);
    }
  });

  modal.querySelector("#book-catalog-queue").addEventListener("click",catalogQueue);

  modal.querySelectorAll("[data-close-modal]").forEach(function(button){
    button.addEventListener("click",stopBarcodeScanner,{once:true});
  });
}

function intercept(event){
  const button=event.target.closest("[data-action='scan-book']");
  if(!button)return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openBookScanner();
}

document.addEventListener("click",intercept,true);
