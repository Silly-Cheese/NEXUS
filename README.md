# NEXUS

NEXUS is a private, single-owner personal operating system for receipts, spending, possessions, QR tags, locations, and a personal library.

## Phase 1

Phase 1 includes:

- Google sign-in through Firebase Authentication
- Automatic owner recognition for `christophershelley257@gmail.com`
- Owner-only Firestore rules
- Dashboard and activity timeline
- Spending transactions, trends, category analysis, and deterministic spending insights
- Receipt photo OCR performed locally in the browser
- Structured receipt line items and automatic spending entries
- Asset registry with locations, warranties, serials, models, and QR tagging
- QR Registry with pre-generated blank tags
- Printable US Letter QR sheets for normal paper, scissors, and tape
- Owner/private QR behavior with a separate public-safe record
- Personal library catalog with ISBN lookup through Open Library
- Book QR labels, reading status, shelving, and lending
- Nested physical locations
- Universal scanning and global search
- JSON data export
- Responsive desktop/mobile interface

## Firebase services

NEXUS intentionally uses only:

1. **Firebase Authentication**
2. **Cloud Firestore**

There is no Firebase Storage dependency. Receipt images are OCR-processed on the device and are not uploaded or persisted by NEXUS.

## Deployment

NEXUS is hosted as a static site with **GitHub Pages**. Firebase is used only for Authentication and Cloud Firestore.

### GitHub Pages

For this repository, use GitHub Pages from the `main` branch and the repository root.

The expected default Pages URL is:

`https://silly-cheese.github.io/NEXUS/`

The repository includes `.nojekyll` and a GitHub Pages-friendly `404.html` fallback. QR URLs are generated from the live site base path, so they continue to work when NEXUS is hosted from the `/NEXUS/` repository path.

### Firebase Authentication

1. Enable the **Google** sign-in provider.
2. Under Firebase Authentication → Settings → Authorized domains, add:
   `silly-cheese.github.io`
3. No NEXUS account document, owner code, or UID setup is required.

On first successful sign-in with `christophershelley257@gmail.com`, NEXUS recognizes the account automatically and creates/merges the owner profile itself.

### Firestore rules

Deploy only the Firestore rules from this repository:

```bash
firebase deploy --only firestore:rules
```

The repository remains bound to Firebase project `nexus-5fd52`.

NEXUS does **not** use Firebase Hosting.

## Security model

Private NEXUS collections require a signed-in, email-verified Firebase user whose email is exactly:

`christophershelley257@gmail.com`

QR codes use a separate `publicQr` collection for anonymous scanning. Public QR records contain only safe display information; private asset, book, receipt, spending, and location records stay owner-only.

## Third-party browser libraries

Phase 1 loads Chart.js, QRCode.js, html5-qrcode, and Tesseract.js from public CDNs. Open Library is used only for optional ISBN metadata lookup.


## Phase 2

Phase 2 turns the original modules into a connected personal operating system.

### Connected purchases

- Detects likely durable goods and books from receipt line items
- Converts a receipt item directly into an Asset or Library record without retyping the purchase
- Preserves the source receipt, merchant, purchase date, price, and item index
- Shows the original receipt from linked Assets and Books
- Adds return-window tracking to receipts and individual assets

### Spending intelligence

- Merchant profiles with total spend, purchase count, average transaction, and top category
- Repeated-spending candidate detection across multiple months
- Personal item price history built from repeated receipt line items
- Transparent cutback observations based on category changes, merchant frequency, and small purchases
- Natural-language answers for common questions such as "How much did I spend at Walmart this month?"

### Asset intelligence

- Lost Mode changes the public QR response without exposing private asset data
- Warranty and return attention center
- Linked purchase history
- Asset event history
- Return deadline/status tracking

### QR lifecycle and Print Studio

- Reset an assigned tag back to reusable/unassigned state
- Permanently retire tags while preserving their history
- Correct public states for active, unassigned, lost, and retired tags
- Print Studio for selecting arbitrary tags and overriding print size
- Existing normal-paper US Letter workflow remains supported

### Library research layer

- Reading-history logs
- Page-specific research notes and tags
- Research-note search through NEXUS Search
- Bibliography builder with Chicago, Turabian, MLA, and APA-style output based on available catalog metadata
- Shelf report grouped by physical location
- Linked source receipts for books created from purchases
- Natural-language library queries such as "Where is my Mere Christianity?" and "How many books do I own?"

### Inventory scanning

- Continuous QR scanning sessions
- Audit a shelf, drawer, room, or other NEXUS location
- Report expected-but-not-scanned and unexpected items
- Move all scanned Assets/Books into a chosen location in one batch

Phase 2 still uses only Firebase Authentication and Cloud Firestore. It adds no Firebase Storage dependency and introduces no additional Firebase service requirement.


## Phase 3

Phase 3 is the audit, reliability, recovery, and final-polish pass.

### Mobile QR printing fix

The old popup-based print workflow has been removed.

NEXUS now:

- renders every QR code inside the active NEXUS page
- shows a full in-app print preview
- waits for all QR images to finish rendering
- invokes the browser print dialog only after the user taps **Print / Save PDF**
- never depends on an `about:blank` popup
- includes a print-calibration sheet for ordinary US Letter paper

This specifically addresses mobile Chrome hanging forever on **Preparing NEXUS QR sheet…**.

### Reliability

- explicit startup loading screen
- 18-second Firestore startup timeout
- retry screen instead of an infinite loading state
- owner profile sync timeout protection
- online/offline indicator
- GitHub Pages-aware QR base URLs
- GitHub Pages fallback routing

### Data Health

NEXUS now audits itself for:

- orphan QR tags
- receipt links pointing to missing Assets or Books
- duplicate ISBNs
- duplicate serial numbers
- Assets without locations
- Books without locations
- return windows that have passed
- expired warranties

Safe broken-link issues can be repaired automatically without deleting valid records.

### Backup recovery

Settings now supports:

- JSON export
- JSON restore
- merge-based recovery by original Firestore document ID
- automatic restoration of public QR records
- QR counter recovery after import

Restore never performs a destructive database wipe.

### Receipt correction

Saved receipts can now be edited after confirmation, including:

- merchant
- date
- subtotal
- tax
- total
- payment note
- line-item names
- line-item prices
- line-item categories

When a receipt is corrected, its linked spending transaction is synchronized automatically.

### Command Palette

Use **Ctrl/⌘ + K** or the command button in the top bar to quickly open:

- Dashboard
- Money
- Receipts
- Assets
- QR Registry
- Library
- Locations
- Settings
- Scanner
- Data Health
- Backup Restore

Anything else can be sent directly to NEXUS Search.

Phase 3 still uses only Firebase Authentication and Cloud Firestore.


### QR PDF printing

QR printing no longer relies on `window.print()` or a popup page.

NEXUS now renders QR images first, builds a real US-Letter PDF with jsPDF, and then provides:

- **Print / Open PDF** — opens the finished PDF in the device/browser PDF viewer
- **Download PDF** — saves `NEXUS-QR-Tags.pdf`
- **Calibration PDF** — provides a 1-inch square and 4-inch line for verifying printer scale

This is the preferred mobile flow for GitHub Pages and Android browsers.
