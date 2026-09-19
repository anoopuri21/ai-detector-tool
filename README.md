# ai-detector-tool

**Sentinel AI** — a modern, dark-themed AI Content Detector that runs 100% in the browser.

Pure **HTML + CSS (Tailwind CDN) + Vanilla JavaScript**. No backend, no Node.js, no build step — your text and files never leave your machine.

## Features

- 📝 Large textarea for pasting long text (with live word / character / reading-time stats)
- 📄 File upload (button **or** drag & drop) for **`.pdf`, `.docx`, `.txt`, `.md`**
- 🔍 PDF text extraction from all pages via [pdf.js](https://mozilla.github.io/pdf.js/)
- 📃 DOCX raw-text extraction via [mammoth.js](https://github.com/mwilliamson/mammoth.js)
- ⚡ "Analyze Content" button, enabled only when the textarea has text
- 📊 Results panel with animated progress bar, AI-probability ring, verdict badge and metric breakdown
- 🔒 Fully client-side — no servers, no cookies, no tracking

## Run it

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8080
# → http://localhost:8080
```

> Internet access is required on first load: Tailwind, pdf.js and mammoth.js are loaded from CDNs.

## Files

| File         | Purpose                                                    |
| ------------ | ---------------------------------------------------------- |
| `index.html` | Dashboard UI (Tailwind via CDN, dark SaaS theme)           |
| `script.js`  | File parsing, live stats, analysis flow, results rendering |

## Note

The analysis in `script.js` (`computeScore`) is a lightweight **placeholder heuristic** (phrase predictability, sentence uniformity, lexical repetition) so the demo works end-to-end. Swap its internals for a real detection engine — the UI only consumes the returned `{ score, metrics[] }` shape.
