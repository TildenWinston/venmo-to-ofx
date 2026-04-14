# Venmo to OFX Converter

A browser-based tool that converts Venmo CSV statement files into the widely-supported [OFX/QFX format](https://financialdataexchange.org/FDX/About/OFX-Work-Group.aspx) for import into bookkeeping software such as [GnuCash](https://www.gnucash.org/), Quicken, and others.

🔒 **Privacy first** — your files never leave your browser. All processing happens locally on your device.

👉 **[Use the converter](https://TildenWinston.github.io/venmo-to-ofx/)**

## Features

- **Consumer & Business formats** — auto-detects Venmo consumer and business CSV layouts
- **Multi-file support** — combine multiple monthly CSV exports into a single OFX file
- **Full transaction fidelity**
  - Detects payment direction (debit/credit) automatically
  - Identifies the other party based on transaction type
  - Preserves notes/memos (with all those emojis 🎉)
  - Generates secondary bank-debit transactions when payments use an external funding source
  - Standard Transfers (cash-outs) include destination bank account metadata
- **Account validation** — rejects mixing of different Venmo account IDs
- **Drag & drop** — drop CSV files directly onto the page, or use the file picker
- **No installation, no dependencies** — runs entirely in the browser as a static page

## How to Use

1. Go to your [Venmo statements page](https://account.venmo.com/statement) and download one or more monthly CSV files
2. Open the [converter](https://TildenWinston.github.io/venmo-to-ofx/)
3. Drag and drop your CSV file(s) or click **Browse Files**
4. Click **Convert to OFX**
5. Review the summary and click **Download OFX**
6. Import the `.ofx` file into your bookkeeping software

## Supported Formats

| Format | ID Column | Date Column | Amount Column |
|--------|-----------|-------------|---------------|
| Consumer | `ID` | `Datetime` (ISO 8601) | `Amount (total)` |
| Business | `Transaction ID` | `Date` + `Time (UTC)` | `Amount (net)`, falls back to `Amount (total)` |

## Known Limitations

- Only fully supports USD transactions
- Not tested with debit card transactions or unfulfilled requests

## GitHub Pages Deployment

This site is deployed automatically via GitHub Pages from the `main` branch. No build step is required — it's a static HTML file.

To deploy your own instance:
1. Fork this repository
2. Go to **Settings → Pages**
3. Set source to **GitHub Actions** (or deploy from the `main` branch root)

## Attribution

This project is a browser-based port of [mfisk/venmo2ofx](https://github.com/mfisk/venmo2ofx), a Python CLI tool by Mike Fisk. All core conversion logic has been faithfully ported to client-side JavaScript.