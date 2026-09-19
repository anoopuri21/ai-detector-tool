# ai-detector-tool

**Sentinel AI** — a modern, dark-themed AI Content Detector that runs 100% in the browser.

Pure **HTML + CSS (Tailwind CDN) + Vanilla JavaScript**. No backend, no Node.js, no build step — your text and files never leave your machine.

## Features

- 📝 Large textarea for pasting long text (with live word / character / reading-time stats)
- 📄 File upload (button **or** drag & drop) for **`.pdf`, `.docx`, `.txt`, `.md`**
- 🧠 **Real AI detection** in the browser: [transformers.js](https://github.com/Xenova/transformers.js) (`@xenova/transformers` via CDN) runs a local RoBERTa model — `Xenova/roberta-base-openai-detector` — via WebAssembly
- 📦 First load downloads the model (status banner with live progress); afterwards it's **cached in the browser** for instant loads
- ✂️ Long documents are split into ~300-word sentence-aligned chunks (the model's limit is 512 tokens) and each chunk is classified
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

## Detection pipeline

1. On page load, `loadModel()` fetches the `text-classification` pipeline (`Xenova/roberta-base-openai-detector`, quantized) via transformers.js. A status banner shows download progress until the model is cached in the browser.
2. On **Analyze**, `chunkText()` splits the input into ~300-word, sentence-aligned chunks (safe under the model's 512-token limit).
3. Each chunk is classified locally; the per-chunk AI probabilities are averaged into the final score and verdict.

If the model can't be loaded (offline, CDN blocked…), the app degrades gracefully to the built-in heuristic in `computeScore()` (phrase predictability, sentence uniformity, lexical repetition) and tells the user via the status banner and result subtitle.
