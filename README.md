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

## First deployment

The owner account does not need to be manually created in Firestore.

1. In Firebase Authentication, enable the **Google** sign-in provider.
2. Create/enable the Cloud Firestore database if it does not already exist.
3. Make sure the domain you deploy to is listed as an authorized Authentication domain.
4. Install/login to the Firebase CLI if needed.
5. From this repository, deploy:

```bash
firebase deploy --only hosting,firestore:rules
```

The repository is already bound to Firebase project `nexus-5fd52`.

On first successful sign-in with `christophershelley257@gmail.com`, NEXUS creates/merges the owner's profile automatically. Firestore authorization is based on the verified Firebase Auth email claim, so the owner profile document is not required in advance.

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
