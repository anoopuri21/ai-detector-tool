# Sentinel AI — AI Content Detector

A 100% client-side AI content detection tool running directly in the browser via WebAssembly. Zero backend, zero telemetry, zero build steps.

---

## Overview

- **Architecture:** Single-Page Application (HTML5 + Tailwind CDN + Vanilla JS ES Module).
- **Primary Engine:** In-browser RoBERTa model (`Xenova/roberta-base-openai-detector`) via Transformers.js (WASM / ONNX).
- **Fallback Engine:** Local algorithmic heuristic (phrase predictability, sentence uniformity, lexical diversity) if offline or CDN is blocked.
- **Privacy:** All text extraction and neural inference execute locally in browser memory. Data never leaves the client.

---

## Features

- **Multi-Format Input:** Direct text pasting or drag-and-drop file upload for `.pdf`, `.docx`, `.txt`, and `.md` (up to 25 MB).
- **Sentence-Aware Chunking:** Automatically divides text into ~300-word blocks at sentence boundaries to fit the model's 512-token limit.
- **Large Document Support:** Stress-tested up to 1,000,000 words without text loss or browser freezing.
- **Visual Analytics:**
  - Animated AI probability conic gauge (0–100%).
  - Secondary signal bars (Phrase Predictability, Sentence Rhythm, Lexical Repetition).
  - Section-by-section score chips (`S1`, `S2`...) highlighting exactly where AI text is detected.
- **Report Export:** One-click copy or download of full Markdown analysis reports.
- **Humanize Text (Experimental):** In-browser local LLM rewriter (`TinyLlama 1.1B`, ~600 MB one-time download) with WebGPU acceleration to rephrase AI patterns into natural human style.
- **Async & Cancellable:** Live chunk progress tracking with immediate cancellation support.

---

## Technical Specifications

| Component | Technology | Version / Model | Notes |
| :--- | :--- | :--- | :--- |
| **Classification Model** | Transformers.js (ONNX) | `Xenova/roberta-base-openai-detector` | Multi-CDN fallback (jsDelivr, esm.sh, unpkg) + HF mirror failover |
| **Rewriter Model** | Transformers.js (ONNX) | `Xenova/tinyllama-1.1b-chat-v0.3` | `q4` quantization, WebGPU / CPU |
| **PDF Extraction** | Mozilla PDF.js | `3.11.174` | Extracts text from all pages via Web Worker |
| **DOCX Extraction** | Mammoth.js | `1.6.0` | Parses raw `.docx` XML client-side |
| **Styling** | Tailwind CSS | Latest JIT via CDN | Dark SaaS dashboard theme |

---

## Verdict Thresholds

| Score Range | Verdict | Meaning |
| :--- | :--- | :--- |
| **0% – 20%** | **Likely Human-Written** | Low AI probability; natural rhythm and lexical diversity. |
| **21% – 79%** | **Mixed Content** | Moderate AI probability; mix of human writing and AI assistance. |
| **80% – 100%** | **Highly Likely AI-Generated** | Strong synthetic patterns detected across multiple chunks. |

---

## Quick Start

Serve the project root with any static web server:

```bash
# Using Python 3
python3 -m http.server 8080

# Using Node.js
npx serve .
```

Open `http://localhost:8080` in any modern web browser.

> **Note:** Initial launch requires an active internet connection to download CDN dependencies and the quantized RoBERTa model weights. After the initial download, model weights are cached locally.

---

## Project Structure

| File | Purpose |
| :--- | :--- |
| `index.html` | Application markup, dashboard layout, and CDN script loaders. |
| `script.js` | Parsing, chunking, model lifecycle, inference orchestration, and UI events. |
| `tests/verify.mjs` | Headless verification suite (51 tests covering chunking, scoring, and edge cases). |
| `REPORT.md` | Benchmark metrics, verification data, and production readiness audit. |
| `PROJECT_OVERVIEW.md` | Comprehensive architectural guide and technical blueprint for AI agents. |
| `README.md` | Project summary and usage documentation. |

---

## Verification & Tests

Run the headless verification harness (requires Node.js):

```bash
node tests/verify.mjs
```

**Status:** 51 checks passing (100% coverage on chunking up to 1M words, word-weighted scoring, label resolution, cancellation, heuristic fallback, and report generation).

---

## AI Context

For AI agents, LLMs, or automated tools working in this repository: consult **`PROJECT_OVERVIEW.md`** for full architectural context, function specifications, data flows, and code conventions in a single read.
