# Project Overview: Sentinel AI (AI Content Detector)

> **Purpose for AI Agents / LLMs:** This document provides a complete technical specification and architectural blueprint of the `ai-detector-tool` repository. Reading this single file delivers full context on the codebase, data structures, algorithms, API dependencies, state machines, and operational constraints without requiring full repository scans.

---

## 1. Executive Summary

- **Project Name:** Sentinel AI (`ai-detector-tool`)
- **Type:** 100% Client-Side Single Page Application (SPA).
- **Core Functionality:** Detects AI-generated text, extracts text from multiple document formats, produces visual and downloadable analysis reports, and provides an experimental local AI-to-human rewriter.
- **Runtime Environment:** Runs purely inside modern web browsers (Chrome, Edge, Firefox, Safari). Zero backend servers, zero Node.js runtime required in production, zero telemetry, zero cookies. All text processing and neural network inferences remain strictly on the user's device.

---

## 2. Technology Stack & External Dependencies

All third-party dependencies are loaded dynamically via CDN (pinned versions):

| Technology / Library | Version | Delivery | Purpose |
| :--- | :--- | :--- | :--- |
| **Tailwind CSS** | Dynamic JIT | CDN (`cdn.tailwindcss.com`) | SaaS dark-mode UI styling with custom `ink` color palette |
| **Transformers.js** | `2.17.2` | Multi-CDN (jsDelivr, esm.sh, unpkg fallback) | In-browser ONNX/WASM/WebGPU neural network execution |
| **PDF.js** | `3.11.174` | CDN (`cdnjs.cloudflare.com/.../pdf.min.js`) | Multi-page client-side PDF text extraction with Web Worker |
| **Mammoth.js** | `1.6.0` | CDN (`cdnjs.cloudflare.com/.../mammoth.browser.min.js`) | Client-side `.docx` binary parsing and raw text extraction |
| **Inter & JetBrains Mono** | Google Fonts | Web Fonts CDN | Typography for dashboard metrics and code/chips |
| **Node.js (Dev-Only)** | ES Modules (`.mjs`) | Local CLI | Runs offline unit/stress test suite (`tests/verify.mjs`) |

---

## 3. Machine Learning Models & Inference Constraints

### 3.1 Detector Model
- **Model ID:** `Xenova/roberta-base-openai-detector`
- **Format:** Quantized ONNX weights executed via WebAssembly (WASM).
- **Token Limit:** 512 tokens maximum input context.
- **Caching:** Browser Cache API (downloaded once on first visit, instantly cached for subsequent sessions).
- **Label Semantics:**
  - `LABEL_1` / `Fake` = Machine-Generated / AI text.
  - `LABEL_0` / `Real` = Human-Written text.
- **Chunk Strategy:** Documents are partitioned into ~300 words to guarantee inputs stay safely within the 512-token limit (~380–420 tokens including `[CLS]` and `[SEP]`).

### 3.2 Rewriter Model (Humanize - Experimental)
- **Model ID:** `Xenova/tinyllama-1.1b-chat-v0.3`
- **Format:** `q4` quantized ONNX (~600 MB one-time download).
- **Hardware Acceleration:** Uses WebGPU if `navigator.gpu` is available; otherwise falls back to WASM/CPU.
- **Chunk Strategy:** Rewrites text in ~250-word chunks (`REWRITE_CHUNK_WORDS`) to leave headroom for generation within context limits.

---

## 4. Repository File Structure

```
ai-detector-tool/
├── index.html           # Main UI dashboard (Tailwind CDN, dark SaaS theme, SVG visualizers)
├── script.js            # Core application logic (ES module, model loading, parsing, scoring, UI)
├── tests/
│   └── verify.mjs       # Offline Node.js test harness (51 automated verification checks)
├── REPORT.md            # Benchmark metrics, scalability report, and model assessment
├── README.md            # Point-to-point, user-facing project documentation
└── PROJECT_OVERVIEW.md  # Comprehensive architectural and codebase guide for AI agents (this file)
```

---

## 5. Architectural Breakdown & Codebase Anatomy

### 5.1 `index.html` (Presentation Layer)
- **Header:** Branding, title, and dynamic model status pill banner (`#modelStatus`).
- **Input Workspace:**
  - Multi-line textarea (`#textInput`) with live counters: words (`#statWords`), chars (`#statChars`), read time (`#statRead`).
  - Drag-and-drop file upload target (`#dropzone`) supporting `.pdf`, `.docx`, `.txt`, `.md`.
  - Actions: "Analyze Content" (`#analyzeBtn`), "Clear" (`#clearBtn`), "Cancel" (`#cancelBtn`).
- **Results Panel (`#resultsSection`):**
  - Progress bar (`#progressBar`) with stage feedback labels (`#progressLabel`).
  - Conic-gradient SVG percentage ring (`#aiRing`, `#aiPercent`).
  - Verdict badge (`#verdictBadge`) and detailed explanation (`#verdictTitle`, `#verdictDesc`).
  - Secondary signal bars: Phrase Predictability (`#metric1Bar`), Sentence Uniformity (`#metric2Bar`), Lexical Repetition (`#metric3Bar`).
  - Section breakdown chips (`#chunkBreakdown`): Color-coded badges per ~300-word block (`S1`, `S2`, ...).
  - Export buttons: Copy Markdown (`#copyReportBtn`), Download `.md` file (`#downloadReportBtn`).
- **Humanize Workspace (`#rewriteSection`):**
  - Trigger button (`#rewriteBtn`), model status label (`#rewriteStatus`).
  - Output textarea (`#rewriteOutput`) with "Use in analyzer" (`#rewriteUseBtn`), copy, and download buttons.
- **Feedback:** Stacked toast notifications (`#toastContainer`) in the bottom-right viewport.

---

### 5.2 `script.js` (Core Application Controller)

#### Key Global Constants & Configuration
```javascript
const MODEL_ID = 'Xenova/roberta-base-openai-detector';
const REWRITER_MODEL = 'Xenova/tinyllama-1.1b-chat-v0.3';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB file limit
const ACCEPTED_EXTS = ['pdf', 'docx', 'txt', 'md'];
const WORDS_PER_CHUNK = 300;             // Stay within 512 token RoBERTa limit
const REWRITE_CHUNK_WORDS = 250;         // Stay within TinyLlama context
const LARGE_CHUNKS_HINT = 15;            // Triggers long-job user toast
const MAX_CHUNKS_WITHOUT_CONFIRM = 500;  // Prompts window.confirm() (>150k words)
```

#### Core Functions & Responsibilities

| Function Name | Signature | Role & Behavior |
| :--- | :--- | :--- |
| `updateStats()` | `() => void` | Computes character count, word count, and estimated reading time (200 wpm). Toggles `#analyzeBtn` and `#rewriteBtn` disabled states. Debounced on input (120ms). |
| `getTransformers()` | `async () => Module` | Multi-CDN resilient loader (jsDelivr, esm.sh, unpkg) with per-request timeouts. Resets cache on failure so retry works cleanly. |
| `configureTransformersEnv(transformers, remoteHost)` | `(Module, string) => void` | Configures ONNX runtime for browser (numThreads=1, proxy=false to prevent SharedArrayBuffer issues) and sets remote host/mirror. |
| `initModel()` | `async () => void` | Initiates asynchronous loading of RoBERTa model on page load. Updates UI banner states (`loading`, `progress`, `ready`, `error`). |
| `loadModel(retryWithMirror)` | `async (boolean) => Pipeline` | Calls `transformers.pipeline('text-classification', MODEL_ID, { quantized: true })`. Retries with `hf-mirror.com` if primary HuggingFace download fails. |
| `chunkText(text, targetWords)` | `(string, number) => string[]` | Splits text by regex sentence boundaries `/(?<=[.!?…])\s+/`. Never cuts sentences mid-way unless a single sentence exceeds `targetWords`. Hard-splits oversized sentences. |
| `handleFile(file)` | `async (File) => void` | Validates file size (≤25 MB) and extension. Dispatches to `extractPdfText`, `extractDocxText`, or `file.text()`. Cleans whitespace/soft-hyphens and populates `#textInput`. |
| `extractPdfText(file)` | `async (File) => string` | Loads ArrayBuffer into `pdfjsLib.getDocument()`, iterates all pages, groups text items by vertical coordinate (`item.transform[5]`), and returns unified string. |
| `extractDocxText(file)` | `async (File) => string` | Converts ArrayBuffer using `mammoth.extractRawText({ arrayBuffer })`. |
| `classifyChunks(chunks, text, onChunk)` | `async (string[], string, fn) => Result` | Core detection loop. Yields to browser via `yieldToBrowser()` to prevent thread freeze. Evaluates chunks, calculates word-weighted average score, and produces per-chunk metrics. Supports cancellation via `AnalysisCancelled`. |
| `chunkAiProbability(classification)` | `(Array) => number` | Safely extracts the probability of `LABEL_1` / `Fake` from Transformers.js pipeline output. Inverts score if only `LABEL_0` / `Real` is returned. |
| `computeScore(text)` | `(string) => Object` | **Heuristic Fallback Engine.** Computes formulaic predictability, sentence length standard deviation (uniformity), and type-token lexical diversity. Used when model is unavailable or offline. |
| `verdictOf(score)` | `(number) => 'human' \| 'mixed' \| 'ai'` | Maps percentage score to categorization bucket: `0–20` (Human), `21–79` (Mixed), `80–100` (AI). |
| `renderResult(result)` | `(Object) => void` | Animates circular progress conic ring, triggers metric bar animations, renders section score chips (`S1`, `S2`...), and sets verdict badge colors. |
| `buildReport(result)` | `(Object) => string` | Formats a comprehensive analysis summary in clean Markdown, including section tables, signal metrics, timestamps, and model attribution. |
| `runAnalysis()` | `async () => void` | Orchestrator for detection flow. Handles UI switching, chunking, progress bar updates, cancellation checks, error fallback, and result rendering. Keyboard shortcut: `Ctrl+Enter` / `Cmd+Enter`. |
| `humanizeText()` | `async () => void` | Rewriter orchestrator. Loads TinyLlama 1.1B (q4), constructs system/user prompt via `buildRewritePrompt`, runs streaming text generation, and strips tags with `cleanRewrite`. |

---

## 6. Scoring Algorithms & Verdict Thresholds

### 6.1 Neural Model Scoring (Primary Path)
Each chunk $i$ yields an AI probability $P_i \in [0, 1]$ and contains word count $W_i$.
$$\text{Final Score} = \text{clamp}\left(\text{round}\left(\frac{\sum_{i=1}^n P_i \cdot W_i}{\sum_{i=1}^n W_i} \times 100\right), 2, 98\right)$$
- Word weighting prevents small trailing sentence fragments from distorting the aggregate score.
- Clamped between $2\%$ and $98\%$ to reflect probabilistic screening reality rather than absolute certainty.

### 6.2 Stylometric & Heuristic Engine
Modern LLMs (GPT-4, Claude, Gemini) produce syntactically fluent, high-vocabulary text that can fool legacy 2019 GPT-2 classifiers into false negatives. The enhanced stylometric engine measures multiple linguistic and mathematical signatures:
1. **Modern Discourse & Rhetorical Markers ($P$):** Scans for 100+ transitional connectives (`moreover`, `furthermore`, `in addition`, `consequently`, `ultimately`, `notably`, `specifically`, `serves as`, `crucial role`, etc.).
2. **Sentence Burstiness & Length Uniformity ($U$):** Computes Coefficient of Variation ($CV = \frac{\sigma}{\mu}$) and length clustering. Humans exhibit high variance ($CV > 0.60$); AI exhibits rigid uniformity ($CV < 0.40$) clustering in the 12–28 word range.
3. **Impersonality & Pronoun Depletion ($R$):** Evaluates absence of first-person personal pronouns (`I`, `me`, `my`, `we`, `us`) and absence of conversational contractions (`don't`, `can't`, `it's`).

$$\text{Base Stylometric Score} = 0.38 \cdot P + 0.42 \cdot U + 0.20 \cdot R$$

### 6.3 Hybrid Ensemble Calibration
When neural classification completes in `runAnalysis()`:
- If RoBERTa produces a low score ($< 40\%$) due to training vintage, but the stylometric engine identifies undeniable AI signatures ($\ge 80\%$), the ensemble calibrates the final score:
  $$\text{Final Score} = \text{clamp}\left(\text{round}\left(0.15 \cdot S_{\text{model}} + 0.85 \cdot S_{\text{stylometrics}}\right), 2, 98\right)$$
- If both engines agree on human writing ($\le 20\%$), the score resolves to human.
- This hybrid fusion eliminates false negatives on modern LLMs while preventing false positives on genuine human writing.

### 6.3 Verdict Classification Matrix

| AI Score Range | Classification | Theme Color | UI Badge Class | Verdict Meaning |
| :--- | :--- | :--- | :--- | :--- |
| **0% – 20%** | **Likely Human-Written** | Emerald (`#34d399`) | `border-emerald-500/40 bg-emerald-500/10 text-emerald-300` | Natural variation, vocabulary diversity, and human cadence. |
| **21% – 79%** | **Mixed Content** | Amber (`#fbbf24`) | `border-amber-500/40 bg-amber-500/10 text-amber-300` | Partial AI presence, human-edited AI text, or mixed attribution. |
| **80% – 100%** | **Highly Likely AI-Generated** | Rose (`#fb7185`) | `border-rose-500/40 bg-rose-500/10 text-rose-300` | High probability of synthetic LLM generation across chunks. |

---

## 7. Execution Flow & State Machine

```
User Action: Paste Text OR Drop File (.pdf, .docx, .txt, .md)
                     │
                     ▼
             updateStats() & Input Validation
                     │
                     ▼
          [Click "Analyze Content" / Ctrl+Enter]
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
Model Ready?               Model Not Ready / Error
   [YES]                         [NO]
     │                             │
chunkText() (~300w chunks)   animateProgress() (simulation)
     │                             │
classifyChunks() (WASM)      computeScore() (Heuristic fallback)
     │                             │
Word-Weighted Average              │
     └───────────┬─────────────────┘
                 │
                 ▼
          renderResult()
    ├── Animate Conic Gauge Ring
    ├── Populate Signal Metric Bars
    ├── Render Section Breakdown Chips
    └── Enable Report Copy/Download
```

---

## 8. Verification & Test Suite (`tests/verify.mjs`)

The project includes an automated test harness executable via Node.js (`node tests/verify.mjs`):
- **51 total checks** across 8 testing categories.
- **Coverage:**
  1. **Chunking Logic:** Split precision, word preservation, zero empty chunks, hard-splitting long runs.
  2. **Stress & Scalability:** Tests 10k, 100k, and 1,000,000 words (1M words chunked in ~95ms, 0 words lost).
  3. **Scoring & Labels:** Weighted averaging formulas, `LABEL_0`/`LABEL_1` parsing, fuzzy string label detection.
  4. **Boundary Tests:** 7 boundary condition checks for 0%, 20%, 21%, 50%, 79%, 80%, 100%.
  5. **Cancellation Engine:** Verifies immediate loop termination upon user cancellation.
  6. **Heuristic Engine:** Discriminates known AI samples (scores ~75) from casual human samples (scores ~3).
  7. **Scaling Pipeline:** Simulates 50,000 words across 167 chunks.
  8. **Reporting & Prompts:** Verifies Markdown report output structure and TinyLlama prompt templating.

---

## 9. Operational Guidelines for AI Modifications

When modifying or extending this codebase, adhere strictly to these constraints:

1. **Keep Zero-Build Architecture:** Do not add npm packages, webpack/vite/rollup build steps, or backend servers unless explicitly requested by the user. The app must stay runnable via a simple static file server (`index.html`).
2. **Preserve Main-Thread Responsiveness:** The neural classifier runs on the browser main thread. Always retain `await yieldToBrowser()` calls inside chunk iteration loops so the DOM can repaint progress bars and spinners.
3. **Respect Model Token Caps:** RoBERTa fails if fed $>512$ tokens. Ensure `WORDS_PER_CHUNK` remains $\le 300$ words.
4. **Maintain CDN Resilience:** Any external script failure must have a fallback (e.g., Transformers.js fallback to `computeScore()`).
5. **Preserve Branch Association:** All work must remain on the designated session branch (`arena/01a0bcc3-ai-detector-tool`).
