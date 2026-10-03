import {
  collection, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const CATEGORIES = [
  "Groceries", "Dining", "Transportation", "Books", "Electronics", "Household",
  "Personal Care", "Education", "Entertainment", "Subscriptions", "Medical", "Gifts", "Other"
];

function N() { return window.NEXUS; }
function state() { return N().state; }
function esc(value) { return N().escapeHtml(value); }
function norm(value) { return N().normalize(value); }
function money(value) { return N().money(value); }
function todayISO() { return N().todayISO(); }

function categoryOptions(selected) {
  return CATEGORIES.map(function (category) {
    return "<option value='" + esc(category) + "' " + (category === selected ? "selected" : "") + ">" + esc(category) + "</option>";
  }).join("");
}

function localISODate(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function loadLocalImage(file) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = function () {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode this image."));
    };
    image.src = url;
  });
}

function drawRotatedImage(image, rotation, maxDimension) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const swap = rotation % 180 !== 0;
  const rotatedWidth = swap ? sourceHeight : sourceWidth;
  const rotatedHeight = swap ? sourceWidth : sourceHeight;
  const scale = Math.min(1, maxDimension / Math.max(rotatedWidth, rotatedHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rotatedWidth * scale));
  canvas.height = Math.max(1, Math.round(rotatedHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(
    image,
    -(sourceWidth * scale) / 2,
    -(sourceHeight * scale) / 2,
    sourceWidth * scale,
    sourceHeight * scale
  );
  ctx.restore();
  return canvas;
}

function receiptImageStats(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const stride = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 70000)));
  let count = 0, sum = 0, sumSq = 0;
  for (let y = 0; y < canvas.height; y += stride) {
    for (let x = 0; x < canvas.width; x += stride) {
      const i = (y * canvas.width + x) * 4;
      const gray = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
      sum += gray;
      sumSq += gray * gray;
      count++;
    }
  }
  const brightness = count ? sum / count : 0;
  const variance = count ? Math.max(0, sumSq / count - brightness * brightness) : 0;
  return {
    width: canvas.width,
    height: canvas.height,
    brightness: brightness,
    contrast: Math.sqrt(variance)
  };
}

function histogram(imageData) {
  const h = new Uint32Array(256);
  for (let i = 0; i < imageData.data.length; i += 4) {
    const g = Math.max(0, Math.min(255, Math.round(
      imageData.data[i] * .299 + imageData.data[i + 1] * .587 + imageData.data[i + 2] * .114
    )));
    h[g]++;
  }
  return h;
}

function percentile(h, pct) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h[i];
  const target = total * pct;
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += h[i];
    if (running >= target) return i;
  }
  return 255;
}

function otsu(h) {
  let total = 0, weighted = 0;
  for (let i = 0; i < 256; i++) {
    total += h[i];
    weighted += i * h[i];
  }
  let backgroundWeight = 0, backgroundSum = 0, best = 150, bestVariance = -1;
  for (let i = 0; i < 256; i++) {
    backgroundWeight += h[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += i * h[i];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weighted - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * Math.pow(backgroundMean - foregroundMean, 2);
    if (variance > bestVariance) {
      bestVariance = variance;
      best = i;
    }
  }
  return best;
}

function preprocess(source, thresholdOnly) {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  const input = ctx.getImageData(0, 0, source.width, source.height);
  const h = histogram(input);
  const low = percentile(h, .035);
  const high = Math.max(low + 24, percentile(h, .965));
  const rawThreshold = otsu(h);
  const range = Math.max(1, high - low);
  const mappedThreshold = Math.max(75, Math.min(215, (rawThreshold - low) * 255 / range));
  const output = new ImageData(source.width, source.height);

  for (let i = 0; i < input.data.length; i += 4) {
    let gray = input.data[i] * .299 + input.data[i + 1] * .587 + input.data[i + 2] * .114;
    gray = Math.max(0, Math.min(255, (gray - low) * 255 / range));
    if (thresholdOnly) gray = gray >= mappedThreshold ? 255 : 0;
    else gray = Math.pow(gray / 255, .86) * 255;
    const value = Math.round(gray);
    output.data[i] = value;
    output.data[i + 1] = value;
    output.data[i + 2] = value;
    output.data[i + 3] = 255;
  }

  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d").putImageData(output, 0, 0);
  return canvas;
}

async function prepareImage(file, rotation) {
  const image = await loadLocalImage(file);
  const source = drawRotatedImage(image, rotation || 0, 2400);
  const previewScale = Math.min(1, 860 / Math.max(source.width, source.height));
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(source.width * previewScale));
  preview.height = Math.max(1, Math.round(source.height * previewScale));
  preview.getContext("2d").drawImage(source, 0, 0, preview.width, preview.height);
  return {
    preview: preview,
    enhanced: preprocess(source, false),
    threshold: preprocess(source, true),
    stats: receiptImageStats(source)
  };
}

function cleanLine(line) {
  return String(line || "")
    .replace(/[|¦]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoneyToken(token) {
  if (!token) return null;
  let value = String(token).trim()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/([Oo])/g, function (match, letter, offset, text) {
      const before = offset > 0 ? text[offset - 1] : "";
      const after = offset + 1 < text.length ? text[offset + 1] : "";
      return /\d/.test(before) || /\d/.test(after) ? "0" : letter;
    })
    .replace(/([Il])/g, function (match, letter, offset, text) {
      const before = offset > 0 ? text[offset - 1] : "";
      const after = offset + 1 < text.length ? text[offset + 1] : "";
      return /\d/.test(before) || /\d/.test(after) ? "1" : letter;
    });
  const negative = /^\s*[-(]/.test(value) || /\)\s*$/.test(value);
  value = value.replace(/[()]/g, "");
  const match = value.match(/-?\d{1,7}(?:\.\d{2})/);
  if (!match) return null;
  const amount = Number(match[0]);
  if (!Number.isFinite(amount)) return null;
  return negative ? -Math.abs(amount) : amount;
}

function moneyTokens(line) {
  const matches = String(line || "").match(/[-(]?\s*\$?\s*[\dOoIl]{1,7}(?:,\d{3})*(?:\.\d{2})\)?/g) || [];
  return matches.map(parseMoneyToken).filter(function (x) { return x !== null; });
}

function productKey(name) {
  return norm(name)
    .replace(/\b\d{5,14}\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:oz|lb|lbs|ct|pk|pack|ml|gal|inch|in|ft)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function learnedCategory(name) {
  const key = productKey(name);
  if (!key) return null;
  const map = {};
  state().data.receipts.forEach(function (receipt) {
    (receipt.items || []).forEach(function (item) {
      if (!item.category || item.category === "Other") return;
      const itemKey = productKey(item.name);
      if (!itemKey) return;
      if (!map[itemKey]) map[itemKey] = {};
      map[itemKey][item.category] = (map[itemKey][item.category] || 0) + 1;
    });
  });
  if (map[key]) {
    return Object.entries(map[key]).sort(function (a, b) { return b[1] - a[1]; })[0][0];
  }
  return null;
}

function guessCategory(name) {
  const learned = learnedCategory(name);
  if (learned) return learned;
  const n = norm(name);
  if (/book|bible|novel|paperback|hardcover|commentary|journal|devotional|textbook/.test(n)) return "Books";
  if (/cable|charger|usb|headphone|earbud|mouse|keyboard|monitor|phone|electronic|battery|adapter|speaker|tablet|computer/.test(n)) return "Electronics";
  if (/shampoo|conditioner|soap|tooth|deodorant|lotion|razor|body wash|skincare|makeup|tissue|toilet paper/.test(n)) return "Personal Care";
  if (/notebook|binder|pencil|pen\b|marker|folder|school|calculator|paper\b|staple/.test(n)) return "Education";
  if (/movie|game\b|toy\b|stream|music|dvd|blu ray/.test(n)) return "Entertainment";
  if (/medicine|pharmacy|vitamin|bandage|ibuprofen|acetaminophen/.test(n)) return "Medical";
  if (/detergent|cleaner|bleach|trash bag|foil|storage bag|dish soap|paper towel/.test(n)) return "Household";
  if (/chicken|beef|pork|turkey|milk|cheese|bread|pasta|rice|water|soda|juice|egg|snack|fruit|apple|banana|orange|vegetable|lettuce|potato|yogurt|cereal|coffee|tea\b|sauce|frozen|pizza|cookie|chips|cracker/.test(n)) return "Groceries";
  if (/restaurant|burger|fries|sandwich|latte|mocha|cafe/.test(n)) return "Dining";
  if (/gasoline|fuel|unleaded|diesel|parking|toll/.test(n)) return "Transportation";
  if (/gift|present/.test(n)) return "Gifts";
  return "Other";
}

function historicalMerchant(candidate) {
  const key = norm(candidate);
  if (!key) return candidate;
  const exact = state().data.receipts.find(function (receipt) {
    return norm(receipt.merchant || "") === key;
  });
  return exact ? exact.merchant : candidate;
}

function merchantFromLines(lines) {
  const candidates = lines.slice(0, 10).map(function (line, index) {
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    let score = letters * 1.4 - digits * .7 - index * .65;
    if (/thank|welcome|receipt|store\s*#|cashier|register|phone|tel|www\.|http|address|street|st\b|ave|road|rd\b|date|time|transaction|order|customer/i.test(line)) score -= 18;
    if (/^[A-Z0-9 &'’.-]{3,45}$/.test(line) && letters >= 3) score += 8;
    if (line.length > 60 || line.length < 2) score -= 15;
    if (moneyTokens(line).length) score -= 10;
    return { line: line, score: score };
  }).sort(function (a, b) { return b.score - a.score; });
  const merchant = candidates.length && candidates[0].score > 0 ? candidates[0].line : "";
  return historicalMerchant(merchant.slice(0, 120));
}

function parseDate(lines) {
  const text = lines.slice(0, 35).join(" ");
  let match = text.match(/\b(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
  if (match) {
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isNaN(d.getTime())) return localISODate(d);
  }
  match = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    const d = new Date(year, Number(match[1]) - 1, Number(match[2]));
    if (!Number.isNaN(d.getTime()) && d.getMonth() === Number(match[1]) - 1) return localISODate(d);
  }
  match = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2}|\d{2})\b/i);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const d = new Date(match[1] + " " + match[2] + ", " + year);
    if (!Number.isNaN(d.getTime())) return localISODate(d);
  }
  return todayISO();
}

function amountFromLines(lines, pattern, exclude) {
  const candidates = [];
  lines.forEach(function (line) {
    if (!pattern.test(line)) return;
    if (exclude && exclude.test(line)) return;
    const values = moneyTokens(line);
    if (values.length) candidates.push(values[values.length - 1]);
  });
  return candidates.length ? candidates[candidates.length - 1] : 0;
}

function isMetadataLine(line) {
  return /(?:^|\b)(subtotal|sub total|total|grand total|amount due|balance due|tax|sales tax|change|cash|visa|mastercard|amex|discover|debit|credit|tender|payment|approval|auth|transaction|receipt|invoice|order|register|cashier|associate|server|customer|points|rewards|member|loyalty|phone|tel|www\.|http|thank you|items sold|item count)(?:\b|$)/i.test(line);
}

function extractItems(lines) {
  const items = [];
  const seen = new Set();
  lines.forEach(function (line, index) {
    if (isMetadataLine(line)) return;
    const values = moneyTokens(line);
    if (!values.length) return;
    const price = values[values.length - 1];
    let name = line.replace(/[-(]?\s*\$?\s*[\dOoIl]{1,7}(?:,\d{3})*(?:\.\d{2})\)?(?:\s*[A-Z]{1,2})?\s*$/i, "").trim();
    if ((!name || name.length < 2) && index > 0 && !moneyTokens(lines[index - 1]).length && !isMetadataLine(lines[index - 1])) {
      name = lines[index - 1];
    }
    name = cleanLine(name).replace(/^[*#~]+\s*/, "").replace(/\s+[A-Z]\s*$/i, "").trim();
    if (!name || name.length < 2 || /^\d+$/.test(name) || isMetadataLine(name)) return;
    if (!Number.isFinite(price) || Math.abs(price) > 100000) return;
    const key = norm(name) + "|" + Number(price).toFixed(2);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      name: name.slice(0, 140),
      price: Number(price.toFixed(2)),
      category: guessCategory(name)
    });
  });
  return items.slice(0, 120);
}

function paymentMethod(lines) {
  const text = lines.join(" ");
  const match = text.match(/\b(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS|DISCOVER|DEBIT|CREDIT)\b[^0-9]{0,20}[*xX#• -]*(\d{4})\b/i);
  if (match) return match[1].replace(/master card/i, "Mastercard") + " •••• " + match[2];
  if (/\bcash\b/i.test(text)) return "Cash";
  if (/\bapple pay\b/i.test(text)) return "Apple Pay";
  if (/\bgoogle pay\b/i.test(text)) return "Google Pay";
  return "";
}

function balanceInfo(parsed) {
  const itemSum = (parsed.items || []).reduce(function (sum, item) { return sum + Number(item.price || 0); }, 0);
  const base = Number(parsed.subtotal || 0) || itemSum;
  const expected = base + Number(parsed.tax || 0);
  const difference = Number(parsed.total || 0) - expected;
  return {
    itemSum: itemSum,
    expected: expected,
    difference: difference,
    balanced: !parsed.total || Math.abs(difference) <= .08
  };
}

function parseReceiptText(rawText) {
  const lines = String(rawText || "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  const subtotal = amountFromLines(lines, /\bsub\s*total\b|\bsubtotal\b/i);
  const tax = amountFromLines(lines, /\b(?:sales\s*)?tax\b/i, /\btax id\b/i);
  let total = amountFromLines(lines, /\b(?:grand\s+total|amount\s+due|balance\s+due|total\s+due|total)\b/i, /\b(?:subtotal|sub\s*total|total\s+savings|total\s+discount|total\s+items?)\b/i);
  const items = extractItems(lines);
  if (!total) total = subtotal ? subtotal + tax : items.reduce(function (sum, item) { return sum + Number(item.price || 0); }, 0) + tax;
  const parsed = {
    merchant: merchantFromLines(lines),
    date: parseDate(lines),
    subtotal: Number((subtotal || 0).toFixed(2)),
    tax: Number((tax || 0).toFixed(2)),
    total: Number((total || 0).toFixed(2)),
    paymentMethod: paymentMethod(lines),
    items: items,
    rawText: rawText
  };
  const balance = balanceInfo(parsed);
  parsed.scanMeta = {
    lineCount: lines.length,
    itemSum: Number(balance.itemSum.toFixed(2)),
    balanceDifference: Number(balance.difference.toFixed(2)),
    balanced: balance.balanced
  };
  return parsed;
}

function scoreCandidate(parsed) {
  let score = 0;
  if (parsed.merchant) score += 15;
  if (parsed.date && parsed.date !== todayISO()) score += 7;
  if (parsed.total > 0) score += 24;
  if (parsed.subtotal > 0) score += 8;
  score += Math.min(30, (parsed.items || []).length * 3);
  if (parsed.paymentMethod) score += 4;
  const balance = balanceInfo(parsed);
  if (balance.balanced && parsed.total > 0) score += 12;
  else if (Math.abs(balance.difference) <= 1) score += 5;
  return Math.max(0, Math.min(100, score));
}

function bestCandidate(candidates) {
  candidates.forEach(function (candidate) {
    const ocr = Number(candidate.scanMeta.ocrConfidence || 0);
    const parse = scoreCandidate(candidate);
    candidate.scanMeta.parseScore = parse;
    candidate.scanMeta.combinedScore = parse * .72 + ocr * .28;
  });
  return candidates.slice().sort(function (a, b) {
    return b.scanMeta.combinedScore - a.scanMeta.combinedScore;
  })[0];
}

function duplicateReceipt(parsed) {
  return state().data.receipts.find(function (receipt) {
    return String(receipt.date || "") === String(parsed.date || "") &&
      Math.abs(Number(receipt.total || 0) - Number(parsed.total || 0)) <= .01 &&
      norm(receipt.merchant || "") === norm(parsed.merchant || "");
  }) || null;
}

function receiptItemRow(item, index) {
  return "<div class='receipt-item smart-receipt-item' data-item-index='" + index + "'>" +
    "<div class='field'><label>Item</label><input class='sri-name' value='" + esc(item.name || "") + "'></div>" +
    "<div class='field'><label>Category</label><select class='sri-category'>" + categoryOptions(item.category || "Other") + "</select></div>" +
    "<div class='field'><label>Price</label><input class='sri-price' type='number' step='0.01' value='" + esc(item.price == null ? "" : item.price) + "'></div>" +
    "<button class='icon-btn smart-remove-item' type='button' title='Remove'>×</button></div>";
}

function dominantCategory(items) {
  if (!items.length) return "Other";
  const totals = {};
  items.forEach(function (item) {
    totals[item.category || "Other"] = (totals[item.category || "Other"] || 0) + Number(item.price || 0);
  });
  return Object.entries(totals).sort(function (a, b) { return b[1] - a[1]; })[0][0];
}

function openReview(parsed) {
  const duplicate = duplicateReceipt(parsed);
  const meta = parsed.scanMeta || {};
  const parseScore = Math.round(Number(meta.parseScore || scoreCandidate(parsed)));
  const ocr = Math.round(Number(meta.ocrConfidence || 0));
  const summaryClass = parseScore >= 80 ? "green" : parseScore >= 55 ? "amber" : "red";

  const body =
    "<div class='smart-review-summary'><div><div class='eyebrow'>SCAN QUALITY</div><strong>" +
    (parseScore >= 80 ? "Strong extraction" : parseScore >= 55 ? "Review recommended" : "Careful review needed") +
    "</strong></div><div class='smart-review-badges'>" +
      (ocr ? "<span class='badge " + (ocr >= 75 ? "green" : ocr >= 50 ? "amber" : "red") + "'>OCR " + ocr + "%</span>" : "") +
      "<span class='badge " + summaryClass + "'>Parse " + parseScore + "%</span>" +
      (duplicate ? "<span class='badge red'>Possible duplicate</span>" : "") +
    "</div></div>" +
    (duplicate ? "<div class='receipt-duplicate-warning'>NEXUS already has a receipt with this merchant, date, and total.</div>" : "") +
    "<form id='smart-receipt-form' class='form-grid'>" +
      "<div class='field'><label>Date</label><input name='date' type='date' required value='" + esc(parsed.date || todayISO()) + "'></div>" +
      "<div class='field'><label>Merchant</label><input name='merchant' required value='" + esc(parsed.merchant || "") + "'></div>" +
      "<div class='field'><label>Subtotal</label><input name='subtotal' type='number' step='0.01' value='" + esc(parsed.subtotal || "") + "'></div>" +
      "<div class='field'><label>Tax</label><input name='tax' type='number' step='0.01' value='" + esc(parsed.tax || "") + "'></div>" +
      "<div class='field'><label>Total</label><input name='total' type='number' step='0.01' min='0' required value='" + esc(parsed.total || "") + "'></div>" +
      "<div class='field'><label>Payment</label><input name='paymentMethod' value='" + esc(parsed.paymentMethod || "") + "' placeholder='Visa •••• 1234'></div>" +
      "<div class='field full' id='smart-reconcile'></div>" +
      "<div class='field full'><div class='smart-items-heading'><div><label>Line items</label><div class='microcopy'>NEXUS learns categories from previously confirmed receipts.</div></div><div class='row-actions'><button class='btn btn-small btn-secondary' id='smart-recategorize' type='button'>Auto-categorize</button><button class='btn btn-small btn-secondary' id='smart-add-item' type='button'>＋ Item</button></div></div><div id='smart-receipt-items' class='receipt-items'>" +
        (parsed.items || []).map(receiptItemRow).join("") +
      "</div></div>" +
      "<div class='field full'><label>Note</label><textarea name='note' placeholder='Optional'></textarea></div>" +
    "</form>" +
    "<details class='smart-ocr-details'><summary>OCR details & raw text</summary><div class='smart-ocr-meta'>" +
      "<span>Pass: " + esc(meta.pass || "OCR") + "</span>" +
      (meta.imageWidth ? "<span>Image: " + meta.imageWidth + "×" + meta.imageHeight + "</span>" : "") +
      "<span>Lines: " + esc(meta.lineCount || 0) + "</span></div><pre>" + esc(parsed.rawText || "") + "</pre></details>";

  const modal = N().openModal("Review Receipt", body, {
    wide: true,
    footer: "<button class='btn btn-secondary' id='smart-scan-again' type='button'>Scan Again</button><button class='btn btn-secondary' data-close-modal>Cancel</button><button class='btn btn-primary' id='smart-save-receipt'>Confirm Receipt</button>"
  });

  const form = modal.querySelector("#smart-receipt-form");

  function readItems() {
    return Array.from(modal.querySelectorAll(".smart-receipt-item")).map(function (row) {
      return {
        name: row.querySelector(".sri-name").value.trim(),
        category: row.querySelector(".sri-category").value,
        price: Number(row.querySelector(".sri-price").value || 0)
      };
    }).filter(function (item) { return item.name; });
  }

  function updateBalance() {
    const items = readItems();
    const itemSum = items.reduce(function (sum, item) { return sum + Number(item.price || 0); }, 0);
    const subtotal = Number(form.elements.subtotal.value || 0);
    const tax = Number(form.elements.tax.value || 0);
    const total = Number(form.elements.total.value || 0);
    const expected = (subtotal || itemSum) + tax;
    const difference = total - expected;
    const balanced = !total || Math.abs(difference) <= .08;
    modal.querySelector("#smart-reconcile").innerHTML =
      "<div class='smart-reconcile-card " + (balanced ? "ok" : "warn") + "'>" +
        "<div><span>Items</span><strong>" + money(itemSum) + "</strong></div>" +
        "<div><span>Subtotal</span><strong>" + money(subtotal) + "</strong></div>" +
        "<div><span>Tax</span><strong>" + money(tax) + "</strong></div>" +
        "<div><span>Total</span><strong>" + money(total) + "</strong></div>" +
        "<div class='smart-reconcile-result'><span>" + (balanced ? "✓ Balanced" : "△ Difference") + "</span><strong>" + (balanced ? "Looks good" : money(difference)) + "</strong></div>" +
      "</div>";
  }

  function bindRows() {
    modal.querySelectorAll(".smart-remove-item").forEach(function (button) {
      button.onclick = function () {
        button.closest(".smart-receipt-item").remove();
        updateBalance();
      };
    });
    modal.querySelectorAll(".sri-name,.sri-price,.sri-category").forEach(function (input) {
      input.addEventListener("input", updateBalance);
      input.addEventListener("change", updateBalance);
    });
  }

  bindRows();
  updateBalance();
  ["subtotal", "tax", "total"].forEach(function (name) {
    form.elements[name].addEventListener("input", updateBalance);
  });

  modal.querySelector("#smart-add-item").addEventListener("click", function () {
    modal.querySelector("#smart-receipt-items").insertAdjacentHTML("beforeend", receiptItemRow({name:"",category:"Other",price:""}, Date.now()));
    bindRows();
    updateBalance();
  });

  modal.querySelector("#smart-recategorize").addEventListener("click", function () {
    modal.querySelectorAll(".smart-receipt-item").forEach(function (row) {
      const name = row.querySelector(".sri-name").value.trim();
      if (name) row.querySelector(".sri-category").value = guessCategory(name);
    });
    N().toast("Categories refreshed", "NEXUS used your confirmed receipt history.", "success");
  });

  modal.querySelector("#smart-scan-again").addEventListener("click", function () {
    N().closeModal();
    openScanner();
  });

  modal.querySelector("#smart-save-receipt").addEventListener("click", async function () {
    if (!form.reportValidity()) return;
    const items = readItems();
    const total = Number(form.elements.total.value || 0);
    if (total <= 0) {
      form.elements.total.setCustomValidity("Enter a receipt total greater than zero.");
      form.elements.total.reportValidity();
      form.elements.total.setCustomValidity("");
      return;
    }

    const finalCandidate = {
      merchant: form.elements.merchant.value.trim(),
      date: form.elements.date.value,
      total: total
    };
    if (duplicateReceipt(finalCandidate) && !confirm("A matching receipt is already saved. Save another copy anyway?")) return;

    const subtotal = Number(form.elements.subtotal.value || 0);
    const tax = Number(form.elements.tax.value || 0);
    const itemSum = items.reduce(function (sum, item) { return sum + Number(item.price || 0); }, 0);
    const difference = total - ((subtotal || itemSum) + tax);
    const receipt = {
      merchant: finalCandidate.merchant,
      date: finalCandidate.date,
      subtotal: subtotal,
      tax: tax,
      total: total,
      paymentMethod: form.elements.paymentMethod.value.trim(),
      note: form.elements.note.value.trim(),
      items: items,
      rawText: String(parsed.rawText || "").slice(0, 30000),
      scanMeta: Object.assign({}, parsed.scanMeta || {}, {
        confirmedItemCount: items.length,
        confirmedItemSum: Number(itemSum.toFixed(2)),
        confirmedBalanceDifference: Number(difference.toFixed(2)),
        userReviewed: true
      }),
      imageStored: false,
      status: "confirmed",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const save = modal.querySelector("#smart-save-receipt");
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const ref = await addDoc(collection(N().db, "receipts"), receipt);
      await addDoc(collection(N().db, "transactions"), {
        merchant: receipt.merchant,
        date: receipt.date,
        amount: receipt.total,
        category: dominantCategory(items),
        type: "expense",
        note: receipt.note,
        sourceReceiptId: ref.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await N().writeActivity("receipt", "Receipt confirmed", "receipt", ref.id, receipt.merchant + " · " + money(receipt.total) + " · " + items.length + " items");
      N().closeModal();
      await N().refresh(["receipts", "transactions", "activity"]);
      N().toast("Receipt saved", "Spending and item-level data were created automatically.", "success");
    } catch (error) {
      console.error(error);
      save.disabled = false;
      save.textContent = "Confirm Receipt";
      N().toast("Receipt could not be saved", error.message || "Please try again.", "error");
    }
  });
}

function qualityMarkup(stats) {
  const warnings = [];
  if (stats.width < 900) warnings.push("Low resolution.");
  if (stats.brightness < 65) warnings.push("Photo looks dark.");
  if (stats.brightness > 240) warnings.push("Photo may be overexposed.");
  if (stats.contrast < 28) warnings.push("Text contrast is weak.");
  return "<div class='smart-quality-chips'>" +
    "<span class='badge " + (stats.width >= 1200 ? "green" : "amber") + "'>" + stats.width + "×" + stats.height + "</span>" +
    "<span class='badge " + (stats.brightness >= 70 && stats.brightness <= 235 ? "green" : "amber") + "'>Light " + Math.round(stats.brightness) + "</span>" +
    "<span class='badge " + (stats.contrast >= 36 ? "green" : "amber") + "'>Contrast " + Math.round(stats.contrast) + "</span></div>" +
    "<div class='microcopy'>" + esc(warnings.length ? warnings.join(" ") : "Image quality looks good for OCR.") + "</div>";
}

function openScanner() {
  const body =
    "<div class='smart-scan-intro'><div><div class='eyebrow'>LOCAL OCR</div><h3>Smart Receipt Scanner</h3><p>The image stays on this device. NEXUS stores only the data you confirm.</p></div><span class='badge green'>PRIVATE</span></div>" +
    "<div class='smart-mode-grid'><label class='smart-mode active'><input type='radio' name='smart-scan-mode' value='accurate' checked><span><strong>Accurate</strong><small>Two OCR passes · best for long receipts</small></span></label>" +
    "<label class='smart-mode'><input type='radio' name='smart-scan-mode' value='fast'><span><strong>Fast</strong><small>One enhanced OCR pass</small></span></label></div>" +
    "<div class='smart-capture-grid'><label class='ocr-drop smart-capture' for='smart-receipt-camera'><div><div class='smart-capture-icon'>▦</div><strong>Take Photo</strong><div class='microcopy'>Rear camera</div></div></label>" +
    "<label class='ocr-drop smart-capture' for='smart-receipt-file'><div><div class='smart-capture-icon'>⇧</div><strong>Choose Image</strong><div class='microcopy'>JPG, PNG, WEBP</div></div></label></div>" +
    "<input id='smart-receipt-camera' type='file' accept='image/*' capture='environment' hidden><input id='smart-receipt-file' type='file' accept='image/*' hidden>" +
    "<div id='smart-image-panel' class='smart-image-panel hidden'><div class='smart-preview-wrap'><canvas id='smart-receipt-preview'></canvas></div><div class='smart-photo-tools'><button class='btn btn-small btn-secondary' id='smart-rotate-left' type='button'>↶ Rotate</button><button class='btn btn-small btn-secondary' id='smart-rotate-right' type='button'>↷ Rotate</button><button class='btn btn-small btn-primary' id='smart-run-scan' type='button'>Analyze Receipt</button></div><div id='smart-image-quality'></div></div>" +
    "<div id='smart-ocr-status' class='smart-ocr-status'><span class='smart-status-dot'></span><span>Choose or photograph a receipt.</span></div><div class='ocr-progress'><span id='smart-progress'></span></div>" +
    "<div class='smart-scan-tips'><strong>Better scans</strong><span>Whole receipt visible · flat surface · no shadow · sharp focus</span></div>";

  const modal = N().openModal("Scan Receipt", body, {
    wide: true,
    footer: "<button class='btn btn-secondary' data-close-modal>Cancel</button>"
  });

  let file = null, rotation = 0, prepared = null, busy = false;

  function mode() {
    const selected = modal.querySelector("input[name='smart-scan-mode']:checked");
    return selected ? selected.value : "accurate";
  }

  function status(text, active) {
    const el = modal.querySelector("#smart-ocr-status");
    el.classList.toggle("active", !!active);
    el.innerHTML = "<span class='smart-status-dot'></span><span>" + esc(text) + "</span>";
  }

  function progress(value) {
    modal.querySelector("#smart-progress").style.width = Math.max(0, Math.min(100, Math.round(value))) + "%";
  }

  async function prepare() {
    if (!file) return;
    status("Preparing image…", true);
    progress(4);
    try {
      prepared = await prepareImage(file, rotation);
      const preview = modal.querySelector("#smart-receipt-preview");
      preview.width = prepared.preview.width;
      preview.height = prepared.preview.height;
      preview.getContext("2d").drawImage(prepared.preview, 0, 0);
      modal.querySelector("#smart-image-panel").classList.remove("hidden");
      modal.querySelector("#smart-image-quality").innerHTML = qualityMarkup(prepared.stats);
      status("Ready to analyze.", false);
      progress(0);
    } catch (error) {
      console.error(error);
      status("Could not prepare image.", false);
      N().toast("Image could not be opened", "Try a different photo.", "error");
    }
  }

  async function selectFile(next) {
    if (!next || busy) return;
    if (!/^image\//.test(next.type || "")) {
      N().toast("Unsupported file", "Choose an image file.", "error");
      return;
    }
    if (next.size > 25 * 1024 * 1024) {
      N().toast("Image too large", "Choose an image smaller than 25 MB.", "error");
      return;
    }
    file = next;
    rotation = 0;
    await prepare();
  }

  ["smart-receipt-camera", "smart-receipt-file"].forEach(function (id) {
    modal.querySelector("#" + id).addEventListener("change", function (event) {
      selectFile(event.target.files && event.target.files[0]);
    });
  });

  modal.querySelectorAll(".smart-mode").forEach(function (label) {
    label.addEventListener("click", function () {
      modal.querySelectorAll(".smart-mode").forEach(function (x) { x.classList.remove("active"); });
      label.classList.add("active");
    });
  });

  modal.querySelector("#smart-rotate-left").addEventListener("click", async function () {
    if (busy) return;
    rotation = (rotation + 270) % 360;
    await prepare();
  });
  modal.querySelector("#smart-rotate-right").addEventListener("click", async function () {
    if (busy) return;
    rotation = (rotation + 90) % 360;
    await prepare();
  });

  modal.querySelector("#smart-run-scan").addEventListener("click", async function () {
    if (busy || !prepared) return;
    if (!window.Tesseract) {
      N().toast("OCR unavailable", "The OCR library did not load.", "error");
      return;
    }

    busy = true;
    const button = modal.querySelector("#smart-run-scan");
    button.disabled = true;
    const scanMode = mode();
    const passes = scanMode === "accurate" ? [
      {name:"Enhanced",canvas:prepared.enhanced,start:5,end:53},
      {name:"High contrast",canvas:prepared.threshold,start:54,end:96}
    ] : [
      {name:"Enhanced",canvas:prepared.enhanced,start:5,end:96}
    ];

    try {
      const candidates = [];
      for (let i = 0; i < passes.length; i++) {
        const pass = passes[i];
        status(pass.name + " OCR…", true);
        const result = await window.Tesseract.recognize(pass.canvas, "eng", {
          logger: function (message) {
            if (typeof message.progress === "number") {
              progress(pass.start + (pass.end - pass.start) * message.progress);
            }
            if (message.status) status(pass.name + " · " + message.status.replaceAll("_", " "), true);
          }
        });
        const parsed = parseReceiptText(result.data.text || "");
        parsed.scanMeta = Object.assign({}, parsed.scanMeta || {}, {
          ocrConfidence: Number(result.data.confidence || 0),
          pass: pass.name,
          mode: scanMode,
          imageWidth: prepared.stats.width,
          imageHeight: prepared.stats.height,
          brightness: Math.round(prepared.stats.brightness),
          contrast: Math.round(prepared.stats.contrast)
        });
        candidates.push(parsed);
      }
      const parsed = bestCandidate(candidates);
      parsed.scanMeta.candidateCount = candidates.length;
      parsed.scanMeta.scannedAt = new Date().toISOString();
      progress(100);
      status("Extraction complete.", false);
      N().closeModal();
      openReview(parsed);
    } catch (error) {
      console.error(error);
      busy = false;
      button.disabled = false;
      progress(0);
      status("Could not read this receipt.", false);
      N().toast("Receipt scan failed", "Try a brighter, flatter photo or Fast mode.", "error");
    }
  });
}

function intercept(event) {
  const button = event.target.closest("[data-action='scan-receipt'],[data-quick='scan-receipt']");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (button.hasAttribute("data-quick")) N().closeModal();
  setTimeout(openScanner, 0);
}

document.addEventListener("click", intercept, true);
