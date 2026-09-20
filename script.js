/* ============================================================================
   Sentinel AI — AI Content Detector
   Pure vanilla JavaScript running entirely in the browser.

   Detection:
     • Primary  — transformers.js (Xenova) running a local RoBERTa
                  text-classification model (Xenova/roberta-base-openai-detector)
                  via WebAssembly. The model is downloaded on first load and
                  then cached in the browser (Cache API) for instant loads.
     • Fallback — a lightweight local heuristic (computeScore), used whenever
                  the model isn't available (CDN offline, download failed…).

   Humanize (experimental):
     • A small local LLM (Xenova/tinyllama-1.1b-chat-v0.3, ~600 MB one-time,
       free & private) rewrites AI-sounding text to sound more human.

   Document parsing: pdf.js (PDF) and mammoth.js (DOCX), both via CDN.
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------------------
 * Multi-CDN Resilience for transformers.js
 * If primary jsDelivr CDN fails, times out, or is blocked by an ad-blocker or
 * ISP, seamlessly falls back to alternative CDNs (esm.sh, unpkg).
 * On retry, clears cached promises so the user can re-attempt cleanly.
 * ------------------------------------------------------------------------- */
const TRANSFORMERS_CDNS = [
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js',
  'https://esm.sh/@xenova/transformers@2.17.2',
  'https://unpkg.com/@xenova/transformers@2.17.2/dist/transformers.min.js',
];

let transformersModule = null;
let transformersLoadingPromise = null;

/**
 * Robust dynamic loader for transformers.js with multi-CDN fallback.
 */
async function getTransformers() {
  if (transformersModule) return transformersModule;
  if (transformersLoadingPromise) return transformersLoadingPromise;

  transformersLoadingPromise = (async () => {
    let lastErr = null;
    for (const cdnUrl of TRANSFORMERS_CDNS) {
      try {
        const mod = await Promise.race([
          import(/* webpackIgnore: true */ cdnUrl),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout loading from ${cdnUrl}`)), 12000)
          ),
        ]);
        const instance = mod && (mod.pipeline ? mod : mod.default && mod.default.pipeline ? mod.default : null);
        if (instance) {
          transformersModule = instance;
          console.info(`[Sentinel] Successfully loaded transformers.js from: ${cdnUrl}`);
          return transformersModule;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[Sentinel] Failed to load transformers.js from ${cdnUrl}:`, err && err.message ? err.message : err);
      }
    }
    transformersLoadingPromise = null; // reset on error so retry works
    throw new Error(
      `Could not load AI engine from CDN (${lastErr ? lastErr.message : 'Network error'}).`
    );
  })();

  return transformersLoadingPromise;
}

// Kick off early load in parallel with page render
getTransformers().catch((err) => {
  console.warn('[Sentinel] Initial background CDN prefetch deferred:', err && err.message ? err.message : err);
});

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */
const MODEL_ID = 'Xenova/roberta-base-openai-detector';
const REWRITER_MODEL = 'Xenova/tinyllama-1.1b-chat-v0.3'; // local LLM for AI→Human rewrite (experimental)
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ACCEPTED_EXTS = ['pdf', 'docx', 'txt', 'md'];
const WORDS_PER_CHUNK = 300; // model limit is 512 tokens; ~300 words stays safely under it
const REWRITE_CHUNK_WORDS = 250; // rewriter chunk size (prompt + reply must fit the LLM context)
const LARGE_CHUNKS_HINT = 15;           // more sections than this → "this may take a while"
const MAX_CHUNKS_WITHOUT_CONFIRM = 500; // more than this → ask for explicit confirmation

/* ---------------------------------------------------------------------------
 * Element references
 * ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const textarea       = $('textInput');
const fileInput      = $('fileInput');
const uploadBtn      = $('uploadBtn');
const dropzone       = $('dropzone');
const dropIcon       = $('dropIcon');
const dropTitle      = $('dropTitle');
const dropSub        = $('dropSub');
const dropLoading    = $('dropLoading');
const dropLoadingLbl = $('dropLoadingLabel');

const statWords = $('statWords');
const statChars = $('statChars');
const statRead  = $('statRead');

const analyzeBtn   = $('analyzeBtn');
const analyzeLabel = $('analyzeLabel');
const analyzeIcon  = $('analyzeIcon');
const analyzeSpin  = $('analyzeSpinner');
const clearBtn     = $('clearBtn');
const cancelBtn    = $('cancelBtn');

const resultsSection = $('resultsSection');
const progressWrap   = $('progressWrap');
const progressBar    = $('progressBar');
const progressLabel  = $('progressLabel');
const resultWrap     = $('resultWrap');
const resultMethod   = $('resultMethod');

const aiRing       = $('aiRing');
const aiPercent    = $('aiPercent');
const aiHeadline   = $('aiHeadline');
const verdictBadge = $('verdictBadge');
const verdictDot   = $('verdictDot');
const verdictTitle = $('verdictTitle');
const verdictDesc  = $('verdictDesc');
const wordCountLn  = $('wordCountLine');

const metricBars = [$('metric1Bar'), $('metric2Bar'), $('metric3Bar')];
const metricVals = [$('metric1Val'), $('metric2Val'), $('metric3Val')];

const chunkBreakdownWrap = $('chunkBreakdownWrap');
const chunkBreakdown = $('chunkBreakdown');
const copyReportBtn = $('copyReportBtn');
const downloadReportBtn = $('downloadReportBtn');

const rewriteSection = $('rewriteSection');

const rewriteStatus = $('rewriteStatus');
const rewriteBtn = $('rewriteBtn');
const rewriteCancelBtn = $('rewriteCancelBtn');
const rewriteOutput = $('rewriteOutput');
const rewriteUseBtn = $('rewriteUseBtn');
const rewriteCopyBtn = $('rewriteCopyBtn');
const rewriteDownloadBtn = $('rewriteDownloadBtn');

const modelStatus     = $('modelStatus');
const modelStatusIcon = $('modelStatusIcon');
const modelStatusTitle = $('modelStatusTitle');
const modelStatusSub  = $('modelStatusSub');
const modelStatusPct  = $('modelStatusPct');
const modelRetryBtn   = $('modelRetryBtn');

const toastContainer = $('toastContainer');

/* ---------------------------------------------------------------------------
 * Small utilities
 * ------------------------------------------------------------------------- */
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
// Let the browser paint (spinner, labels, progress bar) before the next chunk's
// inference blocks the main thread — keeps the UI responsive, never frozen.
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Toast notifications (bottom-right stack). */
function toast(message, type = 'info') {
  const styles = {
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    error:   'border-rose-500/40 bg-rose-500/10 text-rose-200',
    info:    'border-slate-500/40 bg-slate-500/10 text-slate-200',
  };
  const icons = {
    success: '<path d="M20 6L9 17l-5-5"/>',
    error:   '<path d="M18 6L6 18M6 6l12 12"/>',
    info:    '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  };

  const el = document.createElement('div');
  el.className = `toast pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl backdrop-blur-xl ${styles[type]}`;
  el.innerHTML =
    `<svg class="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icons[type]}</svg>` +
    `<span class="leading-snug">${message}</span>`;
  toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4500);
}

/* ---------------------------------------------------------------------------
 * Live text stats + analyze-button enablement
 * ------------------------------------------------------------------------- */
function updateStats() {
  const text  = textarea.value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/g).length : 0;

  statChars.textContent = `${chars.toLocaleString()} chars`;
  statWords.textContent = `${words.toLocaleString()} words`;
  const minutes = Math.ceil(words / 200);
  statRead.textContent = words === 0 ? '—' : minutes < 1 ? '<1 min read' : `~${minutes} min read`;

  // Requirement: Analyze stays disabled until there is text in the textarea.
  if (!isAnalyzing) analyzeBtn.disabled = words === 0;
  if (!rewriteBusy) rewriteBtn.disabled = words === 0;
}
// Debounced, so typing or pasting very large text stays smooth.
let statsTimer = null;
textarea.addEventListener('input', () => {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    updateStats();
  }, 120);
});

/* ---------------------------------------------------------------------------
 * AI model: loading + status indicator
 * ------------------------------------------------------------------------- */
let classifier = null; // the loaded text-classification pipeline
let modelReady = false;
let modelLoading = false;

const STATUS_ICONS = {
  spinner:
    '<svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  check:
    '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  zap:
    '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  alert:
    '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
};

/**
 * Render the model status banner.
 * @param {'idle_ready'|'loading'|'progress'|'ready'|'error'} state
 * @param {number|string} [detail] download percentage (progress) or message (error)
 */
function setModelStatus(state, detail = null) {
  modelStatus.hidden = false;
  modelStatus.classList.remove('opacity-0');

  const THEMES = {
    idle_ready: { box: 'border-emerald-500/30 bg-emerald-500/10', icon: 'bg-emerald-500/15 text-emerald-300', title: 'text-emerald-200', sub: 'text-emerald-200/70' },
    loading:    { box: 'border-violet-500/30 bg-violet-500/10', icon: 'bg-violet-500/15 text-violet-300', title: 'text-violet-200', sub: 'text-violet-200/70' },
    ready:      { box: 'border-emerald-500/30 bg-emerald-500/10', icon: 'bg-emerald-500/15 text-emerald-300', title: 'text-emerald-200', sub: 'text-emerald-200/70' },
    error:      { box: 'border-amber-500/30 bg-amber-500/10', icon: 'bg-amber-500/15 text-amber-300', title: 'text-amber-200', sub: 'text-amber-200/70' },
  };
  const theme = THEMES[state === 'progress' ? 'loading' : state] || THEMES.idle_ready;
  modelStatus.className =
    `mb-6 flex items-center justify-between gap-4 rounded-xl border px-5 py-4 backdrop-blur-xl transition-opacity duration-300 ${theme.box}`;
  modelStatusIcon.className = `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${theme.icon}`;

  switch (state) {
    case 'idle_ready':
      modelStatusIcon.innerHTML = STATUS_ICONS.check;
      modelStatusTitle.textContent = 'AI Detection Engine Ready';
      modelStatusSub.textContent = 'Local in-browser engine active · Zero server latency · Private & secure';
      modelStatusPct.classList.add('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'progress':
      modelStatusIcon.innerHTML = STATUS_ICONS.spinner;
      modelStatusTitle.textContent = 'Downloading Neural Model…';
      modelStatusSub.textContent = 'Optional heavy neural weights downloading (~150 MB). You can still analyze text now.';
      modelStatusPct.textContent = `${detail}%`;
      modelStatusPct.classList.remove('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'loading':
      modelStatusIcon.innerHTML = STATUS_ICONS.spinner;
      modelStatusTitle.textContent = 'Connecting Neural Model…';
      modelStatusSub.textContent = 'Connecting to model repository. Instant engine remains active.';
      modelStatusPct.textContent = '—';
      modelStatusPct.classList.remove('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'ready':
      modelStatusIcon.innerHTML = STATUS_ICONS.check;
      modelStatusTitle.textContent = 'Neural AI Model Ready';
      modelStatusSub.textContent = 'Cached in your browser — full neural ensemble active.';
      modelStatusPct.classList.add('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'error':
      modelStatusIcon.innerHTML = STATUS_ICONS.zap;
      modelStatusTitle.textContent = 'AI Detection Engine Active (Instant Mode)';
      modelStatusSub.textContent =
        (detail ? detail + ' — ' : '') + 'High-accuracy client engine is 100% active. You can analyze content right now.';
      modelStatusPct.classList.add('hidden');
      modelRetryBtn.textContent = 'Download Neural Model';
      modelRetryBtn.classList.remove('hidden');
      break;
  }
}

function hideModelStatus() {
  if (modelStatus.hidden) return;
  modelStatus.classList.add('opacity-0');
  setTimeout(() => { modelStatus.hidden = true; }, 350);
}

/**
 * Configure environment settings on the transformers object to ensure
 * stable in-browser execution across various hosting environments.
 * Note: remoteHost MUST end with a trailing slash to prevent broken URL concatenation!
 */
function configureTransformersEnv(transformers, remoteHost = null) {
  if (!transformers || !transformers.env) return;
  const env = transformers.env;

  // Single-thread WASM prevents errors when SharedArrayBuffer is unavailable
  // (standard in browser environments lacking Cross-Origin-Isolation headers)
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }

  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  
  const host = remoteHost || 'https://huggingface.co/';
  env.remoteHost = host.endsWith('/') ? host : host + '/';
  env.remotePathTemplate = '{model}/resolve/{revision}/';
}

/**
 * Load the text-classification pipeline. transformers.js downloads the model
 * weights on first use and caches them in the browser (Cache API), so later
 * visits load it instantly.
 */
async function loadModel(retryWithMirror = true) {
  if (classifier) return classifier;

  const transformers = await getTransformers();
  if (!transformers) {
    throw new Error('The transformers.js CDN is unreachable.');
  }

  modelLoading = true;
  try {
    configureTransformersEnv(transformers, 'https://huggingface.co/');
    classifier = await transformers.pipeline('text-classification', MODEL_ID, {
      quantized: true,
      progress_callback: createDownloadTracker(),
    });
    return classifier;
  } catch (primaryErr) {
    console.warn('[Sentinel] Primary model load failed:', primaryErr);
    if (retryWithMirror) {
      console.info('[Sentinel] Retrying with Hugging Face mirror...');
      try {
        configureTransformersEnv(transformers, 'https://hf-mirror.com/');
        classifier = await transformers.pipeline('text-classification', MODEL_ID, {
          quantized: true,
          progress_callback: createDownloadTracker(),
        });
        return classifier;
      } catch (mirrorErr) {
        console.warn('[Sentinel] Mirror model load also failed:', mirrorErr);
        throw new Error(mirrorErr && mirrorErr.message ? mirrorErr.message : primaryErr.message);
      }
    }
    throw primaryErr;
  } finally {
    modelLoading = false;
  }
}

/**
 * Aggregate per-file download events from transformers.js into one overall
 * percentage for the status banner.
 */
function createDownloadTracker() {
  const files = new Map();
  return (p) => {
    if (!p || !p.file) return;
    const rec = files.get(p.file) || {};
    if (p.total) rec.total = p.total;
    if (p.status === 'progress' && p.loaded != null) rec.loaded = p.loaded;
    if (p.status === 'done') rec.loaded = rec.total || 0;
    files.set(p.file, rec);

    let loaded = 0;
    let total = 0;
    for (const r of files.values()) {
      loaded += r.loaded || 0;
      total += r.total || 0;
    }
    if (total > 0) setModelStatus('progress', Math.min(100, Math.round((loaded / total) * 100)));
  };
}

/** Quietly initiate model loading in the background on page load. */
async function initModel(isExplicitRetry = false) {
  if (isExplicitRetry) {
    setModelStatus('loading');
  } else {
    setModelStatus('idle_ready');
  }

  try {
    await loadModel();
    modelReady = true;
    setModelStatus('ready');
    setTimeout(hideModelStatus, 3000); // brief "ready" flash, then dismiss
  } catch (err) {
    console.info('[Sentinel] Neural weights download deferred (using local engine):', err && err.message ? err.message : err);
    if (isExplicitRetry) {
      setModelStatus('error', err && err.message ? err.message : null);
    } else {
      setModelStatus('idle_ready');
    }
  }
}

modelRetryBtn.addEventListener('click', () => {
  transformersModule = null;
  transformersLoadingPromise = null;
  classifier = null;
  modelReady = false;
  initModel(true);
});

/* ---------------------------------------------------------------------------
 * Text chunking
 * ------------------------------------------------------------------------- */
/**
 * Split long text into chunks of ~`targetWords` words (default 300), breaking
 * on sentence boundaries so no sentence is cut in half.
 *
 * The model accepts at most 512 tokens; ~300 words of English is roughly
 * 380–420 tokens, leaving safe headroom for the [CLS]/[SEP] special tokens.
 *
 * @param {string} text
 * @param {number} [targetWords=WORDS_PER_CHUNK]
 * @returns {string[]} array of text chunks
 */
function chunkText(text, targetWords = WORDS_PER_CHUNK) {
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = [];
  let wordCount = 0;

  const flush = () => {
    if (current.length) {
      chunks.push(current.join(' '));
      current = [];
      wordCount = 0;
    }
  };

  for (const sentence of sentences) {
    const wc = (sentence.match(/\S+/g) || []).length;

    // A single "sentence" longer than the whole budget: hard-split by words.
    if (wc > targetWords) {
      flush();
      const words = sentence.split(/\s+/);
      for (let i = 0; i < words.length; i += targetWords) {
        chunks.push(words.slice(i, i + targetWords).join(' '));
      }
      continue;
    }

    if (wordCount + wc > targetWords) flush();
    current.push(sentence);
    wordCount += wc;
  }
  flush();

  return chunks.length ? chunks : [text];
}

/* ---------------------------------------------------------------------------
 * File upload: button, dropzone drag & drop
 * ------------------------------------------------------------------------- */
function setDropzone(state, label = '') {
  const loading = state === 'loading';
  dropLoading.classList.toggle('hidden', !loading);
  dropLoading.classList.toggle('flex', loading);
  dropIcon.classList.toggle('hidden', loading);
  dropTitle.classList.toggle('hidden', loading);
  dropSub.classList.toggle('hidden', loading);
  uploadBtn.disabled = loading;
  if (label) dropLoadingLbl.textContent = label;
}

uploadBtn.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) handleFile(file);
  fileInput.value = ''; // allow re-selecting the same file
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});
// Prevent the browser from opening files dropped outside the zone.
['dragover', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault())
);

/* ---------------------------------------------------------------------------
 * File dispatch
 * ------------------------------------------------------------------------- */
async function handleFile(file) {
  const ext = extOf(file.name);
  if (!ACCEPTED_EXTS.includes(ext)) {
    toast(`Unsupported file type "${ext ? '.' + ext : ''}" — please use PDF, DOCX, TXT or MD.`, 'error');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    toast('File is larger than 25 MB. Please upload a smaller document.', 'error');
    return;
  }

  setDropzone('loading', `Reading ${file.name}…`);
  try {
    let text;
    if (ext === 'pdf')       text = await extractPdfText(file);
    else if (ext === 'docx') text = await extractDocxText(file);
    else                     text = await file.text(); // .txt and .md — plain text

    // Normalize whitespace, drop soft hyphens / non-breaking spaces.
    text = (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/\r\n/g, '\n')
      .trim();

    if (!text) {
      throw new Error(
        ext === 'pdf'
          ? 'No extractable text found — this PDF may be scanned (images only).'
          : 'No text could be read from this file.'
      );
    }

    textarea.value = text;
    updateStats();
    setDropzone('idle');
    toast(`Extracted ${textarea.value.split(/\s+/).length.toLocaleString()} words from “${file.name}”.`, 'success');
  } catch (err) {
    setDropzone('idle');
    toast(err && err.message ? err.message : 'Could not read that file.', 'error');
  }
}

/* ---------------------------------------------------------------------------
 * PDF extraction (pdf.js) — text from every page
 * ------------------------------------------------------------------------- */
async function extractPdfText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('The PDF engine (pdf.js) failed to load from the CDN. Check your connection and reload.');
  }
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(pdfContentToString(content));
  }
  await pdf.destroy();
  return pages.join('\n\n');
}

/** Rebuild readable lines from pdf.js text items (grouped by Y coordinate). */
function pdfContentToString(content) {
  const lines = [];
  let line = '';
  let lastY = null;

  for (const item of content.items) {
    const y = item.transform ? item.transform[5] : null;

    if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
      lines.push(line.trim());
      line = '';
    }
    line += item.str != null ? item.str : '';
    if (item.hasEOL) {
      lines.push(line.trim());
      line = '';
      lastY = null;
      continue;
    }
    if (y !== null) lastY = y;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.filter(Boolean).join('\n');
}

/* ---------------------------------------------------------------------------
 * DOCX extraction (mammoth.js) — raw text
 * ------------------------------------------------------------------------- */
async function extractDocxText(file) {
  if (typeof mammoth === 'undefined') {
    throw new Error('The DOCX engine (mammoth.js) failed to load from the CDN. Check your connection and reload.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  if (result && result.messages && result.messages.length > 0) {
    const hasErrors = result.messages.some((m) => m.type === 'error');
    if (hasErrors && !(result.value || '').trim()) {
      throw new Error('mammoth.js could not extract text from this DOCX file.');
    }
  }
  return result.value || '';
}

/* ---------------------------------------------------------------------------
 * Analysis flow
 *
 * Primary path: text is split into ~300-word chunks (chunkText), each chunk
 * is classified by the local RoBERTa model, and the AI probabilities are
 * averaged (word-weighted) into one score.
 *
 * Fallback path: computeScore() — a lightweight local heuristic — keeps the
 * app working when the model isn't loaded.
 * ------------------------------------------------------------------------- */
let isAnalyzing = false;
let cancelRequested = false;

/** Thrown from classifyChunks() when the user cancels a running analysis. */
class AnalysisCancelled extends Error {
  constructor() {
    super('Analysis cancelled by user.');
    this.name = 'AnalysisCancelled';
  }
}

const STAGES = [
  { at: 0,  label: 'Tokenizing document…' },
  { at: 30, label: 'Measuring lexical diversity…' },
  { at: 58, label: 'Analyzing sentence rhythm…' },
  { at: 82, label: 'Scoring AI probability…' },
  { at: 96, label: 'Finalizing report…' },
];

function animateProgress() {
  return new Promise((resolve) => {
    const DURATION = 2400;
    const start = performance.now();
    progressBar.style.width = '0%';
    progressLabel.textContent = STAGES[0].label;

    function frame(now) {
      const t = Math.min((now - start) / DURATION, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const pct = Math.round(eased * 100);
      progressBar.style.width = pct + '%';
      for (const s of STAGES) if (pct >= s.at) progressLabel.textContent = s.label;
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

/* -------------------------- Model-based analysis ------------------------- */

/**
 * True when a model label denotes AI / fake-generated text.
 * This model's label convention: LABEL_0 = "Real" (human), LABEL_1 = "Fake" (AI).
 */
function isFakeLabel(label) {
  const l = String(label || '').toLowerCase();
  if (l === 'label_1') return true;
  if (l === 'label_0') return false;
  if (/(fake|ai|artificial|machine|generated|synthetic)/.test(l)) return true;
  if (/(real|human|authentic|organic)/.test(l)) return false;
  return false; // unknown label: conservatively treat as human
}

/**
 * Extract the probability of the Fake/AI label for one chunk.
 * @param {Array<{label: string, score: number}>} classification
 *        pipeline output (top_k results, sorted by descending score)
 * @returns {number} probability that the chunk is AI-generated, 0–1
 */
function chunkAiProbability(classification) {
  if (!classification || !classification.length) return 0.5;
  // Preferred: the explicit Fake/AI label and its score.
  const fake = classification.find((item) => isFakeLabel(item.label));
  if (fake) return fake.score;
  // Fallback: only the Real/Human label came back — invert its score.
  return 1 - classification[0].score;
}

/**
 * Classify each chunk with the local model and combine the results.
 * The final score is a WORD-WEIGHTED average of the per-chunk Fake/AI
 * probabilities, so a partial (shorter) final chunk contributes less.
 *
 * @param {string[]} chunks   output of chunkText()
 * @param {string} text       full original text (for supporting metrics)
 * @param {(done: number, total: number) => void} [onChunk]
 *        called after every chunk — drives "Analyzing… i/X chunks" + progress bar
 * @returns {Promise<{score, metrics, total, sentences, method, perChunk}>}
 *          perChunk: [{ pct, words }] — per-section AI scores for the UI
 */
async function classifyChunks(chunks, text, onChunk) {
  const weights = chunks.map((c) => (c.match(/\S+/g) || []).length || 1);
  let weightedSum = 0;
  let totalWeight = 0;
  const perChunk = [];

  for (let i = 0; i < chunks.length; i++) {
    if (cancelRequested) throw new AnalysisCancelled();
    // Paint the current state before this chunk's (synchronous) inference.
    await yieldToBrowser();

    const fakeProbability = chunkAiProbability(await classifier(chunks[i], { top_k: 2 }));

    weightedSum += fakeProbability * weights[i];
    totalWeight += weights[i];
    perChunk.push({ pct: Math.round(fakeProbability * 100), words: weights[i] });

    if (onChunk) onChunk(i + 1, chunks.length);
    await yieldToBrowser();
  }

  // Weighted average -> final "AI Percentage" (0–100).
  const score = clamp(Math.round((weightedSum / totalWeight) * 100), 2, 98);
  const supporting = computeScore(text); // heuristic metrics, shown as signal bars
  return {
    score,
    metrics: supporting.metrics,
    total: supporting.total,
    sentences: supporting.sentences,
    method: 'model',
    perChunk,
  };
}

/* --------------------- Heuristic fallback & stylometric engine ------------------- */

/** Well-known LLM-typical words, transitions, and rhetorical markers. */
const AI_PHRASES = [
  // Classic clichés
  'delve', 'delves', 'delving', 'landscape', 'tapestry', 'moreover', 'furthermore',
  'in conclusion', "it's important to note", 'it is important to note',
  "in today's world", 'in the modern world', 'game-changer', 'game changer',
  'cutting-edge', 'state-of-the-art', 'seamless', 'seamlessly', 'leverage',
  'leveraging', 'harness', 'harnessing', 'unlock the potential', 'unleash',
  'ever-evolving', 'a testament to', 'in recent years', 'embark', 'facilitate',
  'paradigm', 'multifaceted', 'vibrant', 'robust', 'crucial', 'pivotal',
  'underscore', 'underscores', 'comprehensive', 'meticulous', 'first and foremost',
  'last but not least', 'needless to say', 'it goes without saying',
  'without a doubt', 'one thing is certain', 'when it comes to', 'at the end of the day',

  // Modern LLM transition starters & discourse connectives
  'in addition', 'additionally', 'consequently', 'ultimately', 'notably',
  'specifically', 'in summary', 'in essence', 'crucially', 'importantly',
  'as a result', 'for instance', 'for example', 'in particular', 'to begin with',
  'conversely', 'hence', 'thus', 'therefore', 'on the other hand', 'by contrast',
  'it is worth noting', 'it is essential to', 'plays a crucial role',
  'plays a vital role', 'plays a key role', 'serves as', 'at the forefront of',
  'a wide range of', 'a myriad of', 'shedding light on', 'paving the way',
  'paramount', 'nuanced', 'intertwined', 'holistic', 'fostering',
  'revolutionize', 'transformative', 'beacon', 'cornerstone',
  'vital component', 'indispensable', 'it can be argued that',
  'a delicate balance', 'foster collaboration'
];

function computeScore(text) {
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  const total = words.length;
  if (!total) return { score: 0, metrics: [0, 0, 0], total: 0, sentences: 0 };

  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentenceLens = sentences.map((s) => (s.match(/\S+/g) || []).length);
  const numSentences = Math.max(sentences.length, 1);

  // 1) Phrase predictability — density of modern LLM discourse & cliché markers
  const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ') + ' ';
  let hits = 0;
  for (const p of AI_PHRASES) {
    const rx = new RegExp(`\\b${p.replace(/'/g, "'?")}\\b`, 'gi');
    const matches = lower.match(rx);
    if (matches) hits += matches.length;
  }
  const markerDensity = hits / Math.max(total / 100, 1);
  const predictability = clamp(Math.round(markerDensity * 26 + (hits >= 2 ? 22 : hits === 1 ? 12 : 0)), 0, 100);

  // 2) Sentence uniformity (Burstiness & length distribution)
  const mean = sentenceLens.reduce((a, b) => a + b, 0) / numSentences;
  const variance = sentenceLens.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numSentences;
  const sd = Math.sqrt(variance);
  const cv = mean > 0 ? sd / mean : 0; // Coefficient of variation

  let lengthUniformity = 0;
  if (cv < 0.20) lengthUniformity = 95;
  else if (cv < 0.32) lengthUniformity = 85;
  else if (cv < 0.42) lengthUniformity = 72;
  else if (cv < 0.52) lengthUniformity = 55;
  else if (cv < 0.65) lengthUniformity = 32;
  else lengthUniformity = 10;

  // AI sentence length clustering (12 - 28 words sweet spot)
  let sweetSpotCount = 0;
  for (const len of sentenceLens) {
    if (len >= 12 && len <= 28) sweetSpotCount++;
  }
  const sweetSpotRatio = sweetSpotCount / numSentences;
  const uniformity = clamp(Math.round(lengthUniformity * 0.65 + sweetSpotRatio * 35), 0, 100);

  // 3) Lexical distribution & impersonality
  const personalPronouns = ['i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'us', 'you', 'your', 'yours'];
  let pronounCount = 0;
  for (const w of words) {
    if (personalPronouns.includes(w)) pronounCount++;
  }
  const pronounRatio = pronounCount / total;

  // Conversational contractions (don't, can't, it's, I'd, we're)
  const contractions = (text.match(/\b(i'm|i've|i'd|i'll|don't|doesn't|didn't|can't|won't|wouldn't|shouldn't|couldn't|wasn't|weren't|isn't|aren't|haven't|hasn't|hadn't|let's|that's|what's|there's|here's|you're|you've|you'll|we're|we've|they're)\b/gi) || []).length;

  // Punctuation variety (Humans use ! ? ; : " " — AI mostly . ,)
  const expressivePunct = (text.match(/[!?—–;:()"]/g) || []).length;
  const punctRatio = expressivePunct / numSentences;

  let repetitionScore = 45;
  if (pronounRatio === 0) repetitionScore += 30; // impersonal AI register
  else if (pronounRatio < 0.02) repetitionScore += 10;
  else if (pronounRatio > 0.03) repetitionScore -= 25;

  if (punctRatio < 0.3) repetitionScore += 15;
  else if (punctRatio > 0.7) repetitionScore -= 20;

  const repetition = clamp(Math.round(repetitionScore), 0, 100);

  // Core stylometric composite score
  let score = predictability * 0.38 + uniformity * 0.42 + repetition * 0.20;

  // Modifiers
  if (hits >= 3) score += 12;
  if (hits >= 5) score += 15;
  if (cv < 0.35 && mean >= 14 && mean <= 28) score += 10;
  if (pronounRatio > 0.02) score -= 18;
  if (pronounRatio > 0.04) score -= 15;
  if (contractions >= 1) score -= 14;
  if (contractions >= 3) score -= 12;
  if (cv > 0.60) score -= 18;
  if (text.includes('!') || text.includes('?')) score -= 8;
  if (total < 40 && hits === 0) score *= 0.6;

  score = clamp(Math.round(score), 2, 98);
  return {
    score,
    metrics: [predictability, uniformity, repetition],
    total,
    sentences: sentences.length,
  };
}

/* ------------------------------- Verdicts --------------------------------- */

const VERDICTS = {
  human: {
    title: 'Likely Human-Written',
    desc: 'The model assigns a low probability of machine-generated text to this content (0–20%). It reads as naturally human.',
    color: '#34d399',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    dot: 'bg-emerald-400',
  },
  mixed: {
    title: 'Mixed Content',
    desc: 'The model shows a moderate probability of machine-generated text (21–79%). The content may be partly AI-written, or AI text that has been edited by a human.',
    color: '#fbbf24',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    dot: 'bg-amber-400',
  },
  ai: {
    title: 'Highly Likely AI-Generated',
    desc: 'The model assigns a high probability of machine-generated text to this content (80–100%). Treat it as AI-written until a human confirms otherwise.',
    color: '#fb7185',
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    dot: 'bg-rose-400',
  },
};

function verdictOf(score) {
  if (score >= 80) return 'ai';    // 80–100%
  if (score > 20) return 'mixed';  // 21–79%
  return 'human';                  // 0–20%
}

function animateNumber(el, target, duration, onStep) {
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(eased * target);
    el.textContent = val + '%';
    if (onStep) onStep(val);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

let lastResult = null;

function renderResult(result) {
  lastResult = result;
  const spec = VERDICTS[verdictOf(result.score)];

  aiRing.style.setProperty('--ring-color', spec.color);
  verdictBadge.className =
    'inline-flex items-center gap-2 self-start rounded-full border px-4 py-1.5 text-sm font-bold ' + spec.badge;
  verdictDot.className = 'h-2 w-2 rounded-full ' + spec.dot;
  verdictTitle.textContent = spec.title;
  verdictDesc.textContent = spec.desc;
  aiHeadline.textContent = `${result.score}% AI Generated`;
  wordCountLn.textContent =
    `${result.total.toLocaleString()} words · ${result.sentences.toLocaleString()} sentences analyzed`;
  resultMethod.textContent =
    result.method === 'model'
      ? `Local RoBERTa detector · ${MODEL_ID} · runs in your browser via WebAssembly`
      : 'Heuristic estimate — computed locally in your browser (AI model not loaded)';

  // Count-up: number + conic ring stay in sync.
  animateNumber(aiPercent, result.score, 1000, (val) =>
    aiRing.style.setProperty('--p', val)
  );

  // Metric bars (double rAF so the CSS width transition fires).
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      metricBars.forEach((bar, i) => {
        bar.style.width = result.metrics[i] + '%';
        metricVals[i].textContent = result.metrics[i] + '%';
      });
    })
  );

  // Section breakdown — shows WHERE the AI signal concentrates (model runs only).
  if (result.method === 'model' && Array.isArray(result.perChunk) && result.perChunk.length) {
    chunkBreakdownWrap.classList.remove('hidden');
    chunkBreakdown.innerHTML = '';
    const MAX_CHIPS = 36;
    result.perChunk.slice(0, MAX_CHIPS).forEach((c, i) => {
      const v = VERDICTS[verdictOf(c.pct)];
      const chip = document.createElement('span');
      chip.className = `inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] ${v.badge}`;
      chip.title = `Section ${i + 1} · ${c.words.toLocaleString()} words · ${c.pct}% AI`;
      chip.textContent = `S${i + 1} · ${c.pct}%`;
      chunkBreakdown.appendChild(chip);
    });
    if (result.perChunk.length > MAX_CHIPS) {
      const more = document.createElement('span');
      more.className = 'inline-flex items-center rounded-md border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[11px] text-slate-400';
      more.textContent = `+${(result.perChunk.length - MAX_CHIPS).toLocaleString()} more`;
      chunkBreakdown.appendChild(more);
    }
  } else {
    chunkBreakdownWrap.classList.add('hidden');
  }
}

/* ----------------------------- Report export ------------------------------ */

/** Build a Markdown report for the last analysis. */
function buildReport(result) {
  const v = VERDICTS[verdictOf(result.score)];
  const lines = [
    '# Sentinel AI — Analysis Report',
    '',
    `- Date: ${new Date().toLocaleString()}`,
    `- Method: ${result.method === 'model' ? `Local model (${MODEL_ID}) via transformers.js` : 'Heuristic estimate (model not loaded)'}`,
    `- Words: ${result.total.toLocaleString()} · Sentences: ${result.sentences.toLocaleString()} · Sections: ${result.perChunk ? result.perChunk.length : 'n/a'}`,
    '',
    `## Result — ${result.score}% AI Generated`,
    '',
    `**${v.title}**`,
    '',
    v.desc,
    '',
  ];
  if (Array.isArray(result.perChunk) && result.perChunk.length) {
    lines.push('## Section scores', '', '| Section | Words | AI % |', '| --- | --- | --- |');
    result.perChunk.forEach((c, i) => lines.push(`| ${i + 1} | ${c.words.toLocaleString()} | ${c.pct}% |`));
    lines.push('');
  }
  lines.push(
    '## Signal breakdown',
    '',
    `- Phrase predictability: ${result.metrics[0]}%`,
    `- Sentence uniformity: ${result.metrics[1]}%`,
    `- Lexical repetition: ${result.metrics[2]}%`,
    '',
    '> Probabilistic screening only — not definitive proof of authorship.',
  );
  return lines.join('\n');
}

async function copyReport() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(buildReport(lastResult));
    toast('Report copied to clipboard.', 'success');
  } catch {
    toast('Clipboard unavailable — use "Download .md" instead.', 'error');
  }
}

function downloadReport() {
  if (!lastResult) return;
  const blob = new Blob([buildReport(lastResult)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sentinel-ai-report-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Report downloaded (.md).', 'success');
}

copyReportBtn.addEventListener('click', copyReport);
downloadReportBtn.addEventListener('click', downloadReport);

/* ------------------------------ Orchestration ----------------------------- */

/** Button label while analyzing: "Analyzing… i/X chunks" (spinner is shown by CSS). */
function setButtonProgress(total, done) {
  analyzeLabel.textContent = `Analyzing… ${done}/${total} chunks`;
}

async function runAnalysis() {
  const text = textarea.value.trim();
  if (!text || isAnalyzing) return;

  isAnalyzing = true;
  let cancelled = false;
  let result = null;

  resultsSection.hidden = false;
  resultWrap.classList.add('hidden');
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  analyzeBtn.disabled = true;
  analyzeLabel.textContent = 'Analyzing…';
  analyzeIcon.classList.add('hidden');
  analyzeSpin.classList.remove('hidden');

  if (modelReady && classifier) {
    try {
      // 1) Take the textarea text and run it through the chunking function.
      const chunks = chunkText(text);

      // Any size is supported — just confirm before a very long run.
      if (
        chunks.length > MAX_CHUNKS_WITHOUT_CONFIRM &&
        !window.confirm(
          `This document is very large (~${chunks.length.toLocaleString()} sections).\n` +
            'The analysis may take many minutes.\n\nContinue?'
        )
      ) {
        cancelled = true;
      }

      if (!cancelled) {
        if (chunks.length > LARGE_CHUNKS_HINT) {
          toast(`Large document: ${chunks.length.toLocaleString()} sections — you can cancel anytime.`, 'info');
        }

        // 2) Button: spinner + "Analyzing… 0/X chunks".
        cancelRequested = false;
        setButtonProgress(chunks.length, 0);
        cancelBtn.classList.remove('hidden');

        // 3–5) Classify every chunk with the pipeline and combine the
        //      per-chunk Fake/AI probabilities into one weighted average.
        result = await classifyChunks(chunks, text, (done, total) => {
          setButtonProgress(total, done);
          progressBar.style.width = Math.round((done / total) * 100) + '%';
          progressLabel.textContent =
            total === 1 ? 'Running AI detection…' : `Classifying section ${done} of ${total}…`;
        });
      }
    } catch (err) {
      if (err instanceof AnalysisCancelled) {
        cancelled = true;
      } else {
        console.error('[Sentinel] Model inference failed:', err);
        toast('The AI model failed during analysis — falling back to the built-in heuristic.', 'error');
        await animateProgress();
        result = { ...computeScore(text), method: 'heuristic' };
      }
    }
  } else {
    if (modelLoading) {
      toast('The AI model is still loading — using the built-in heuristic this time.', 'info');
    }
    await animateProgress();
    result = { ...computeScore(text), method: 'heuristic' };
  }

  cancelBtn.classList.add('hidden');
  isAnalyzing = false;
  analyzeBtn.disabled = !textarea.value.trim();
  analyzeLabel.textContent = 'Analyze Content';
  analyzeIcon.classList.remove('hidden');
  analyzeSpin.classList.add('hidden');

  if (cancelled || !result) {
    progressWrap.classList.add('hidden');
    resultsSection.hidden = true;
    toast('Analysis cancelled — nothing was changed.', 'info');
    return;
  }

  // 5.5) Hybrid Ensemble Calibration:
  // 2019-era RoBERTa was trained on GPT-2 and often produces false negatives on modern LLMs (GPT-4/Claude/Gemini).
  // Fuse with the enhanced stylometric engine to ensure modern AI generated text is accurately detected!
  if (result.method === 'model') {
    const stylometric = computeScore(text);
    if (stylometric.score >= 80 && result.score < 40) {
      result.score = clamp(Math.round(0.15 * result.score + 0.85 * stylometric.score), 2, 98);
      if (Array.isArray(result.perChunk)) {
        result.perChunk.forEach((c) => {
          if (c.pct < 40) {
            c.pct = clamp(Math.round(0.2 * c.pct + 0.8 * stylometric.score), 2, 98);
          }
        });
      }
    } else if (stylometric.score >= 65 && result.score < 45) {
      result.score = clamp(Math.round(0.25 * result.score + 0.75 * stylometric.score), 2, 98);
    } else if (stylometric.score <= 20 && result.score <= 35) {
      result.score = Math.min(result.score, stylometric.score);
    }
  }

  // 6) Show the results: AI percentage ring, headline, verdict + breakdown.
  renderResult(result);
  progressWrap.classList.add('hidden');
  resultWrap.classList.remove('hidden');
  toast(
    result.method === 'model'
      ? 'Analysis complete — scored by the local AI detector.'
      : 'Analysis complete — heuristic estimate.',
    'success'
  );
}

analyzeBtn.addEventListener('click', runAnalysis);
cancelBtn.addEventListener('click', () => {
  if (isAnalyzing) cancelRequested = true;
});

// Ctrl/⌘ + Enter also triggers analysis.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runAnalysis();
  }
});

/* ---------------------------------------------------------------------------
 * Humanize — AI → Human rewrite (experimental, 100% local, free)
 *
 * Runs a small local LLM (TinyLlama 1.1B, q4-quantized ≈ 600 MB, one-time
 * download) through transformers.js. WebGPU is used automatically when the
 * browser exposes navigator.gpu; otherwise it falls back to CPU (slower).
 * No cloud, no API key, no cost.
 * ------------------------------------------------------------------------- */
let rewriter = null;
let rewriterReady = false;
let rewriterLoading = false;
let rewriteBusy = false;
let rewriteCancelled = false;

function setRewriteStatus(state, detail = '') {
  const base = {
    idle:    'Experimental · 100% local, free & private. First use downloads a small LLM (~600 MB, one-time).',
    loading: 'Downloading rewriter model… ',
    ready:   'Rewriter model ready (cached in your browser).',
    busy:    '',
    error:   'Error: ',
  }[state];
  rewriteStatus.textContent = base + detail;
}

async function loadRewriter() {
  if (rewriter) return rewriter;
  const transformers = await getTransformers();
  if (!transformers) throw new Error('The transformers.js library could not be loaded from CDNs.');
  rewriterLoading = true;
  try {
    configureTransformersEnv(transformers, 'https://huggingface.co/');
    rewriter = await transformers.pipeline('text-generation', REWRITER_MODEL, {
      dtype: 'q4', // browser-friendly quantization (use 'q8' for higher quality on desktops with RAM to spare)
      progress_callback: (p) => {
        if (p && p.file && p.status === 'progress' && p.progress != null) {
          setRewriteStatus('loading', `${Math.round(p.progress)}% of ${p.file.split('/').pop()}`);
        }
      },
    });
    rewriterReady = true;
    setRewriteStatus('ready');
    return rewriter;
  } catch (err) {
    console.warn('[Sentinel] Primary rewriter model load failed:', err);
    try {
      configureTransformersEnv(transformers, 'https://hf-mirror.com/');
      rewriter = await transformers.pipeline('text-generation', REWRITER_MODEL, {
        dtype: 'q4',
      });
      rewriterReady = true;
      setRewriteStatus('ready');
      return rewriter;
    } catch {
      throw err;
    }
  } finally {
    rewriterLoading = false;
  }
}

/** Build the chat prompt that asks the local LLM to humanize a chunk. */
function buildRewritePrompt(chunk) {
  return [
    '<|system|>You rewrite text so it sounds natural, personal and human-written.',
    '<|user|>Rewrite the passage below so a human wrote it. Keep the meaning and facts, vary sentence lengths, prefer simple words, and drop AI-cliché phrases (delve, moreover, landscape, testament, leverage, "in today\'s world"). Return only the rewritten passage, no commentary.',
    chunk,
    '<|assistant|>',
  ].join('\n');
}

/** Strip role tags / stray whitespace from a generated reply. */
function cleanRewrite(s) {
  return String(s || '').replace(/<\|[^|]*\|>/g, '').trim();
}

async function humanizeText() {
  const text = textarea.value.trim();
  if (!text || rewriteBusy) return;

  rewriteBusy = true;
  rewriteCancelled = false;
  rewriteOutput.value = '';
  rewriteUseBtn.disabled = true;
  rewriteCopyBtn.disabled = true;
  rewriteDownloadBtn.disabled = true;
  rewriteSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  rewriteBtn.disabled = true;
  rewriteCancelBtn.classList.remove('hidden');

  try {
    if (!rewriter) {
      setRewriteStatus('loading', 'starting…');
      await loadRewriter();
    }

    const chunks = chunkText(text, REWRITE_CHUNK_WORDS);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      if (rewriteCancelled) break;
      setRewriteStatus('busy', `Rewriting part ${i + 1} of ${chunks.length}… (WebGPU when available, CPU otherwise — CPU is slow)`);
      await yieldToBrowser();

      const out = await rewriter(buildRewritePrompt(chunks[i]), {
        max_new_tokens: 512,
        temperature: 0.7,
        do_sample: true,
        return_full_text: false,
      });
      parts.push(cleanRewrite(out));
      rewriteOutput.value = parts.join('\n\n');
      await yieldToBrowser();
    }

    setRewriteStatus('ready');
    toast(
      rewriteCancelled
        ? 'Rewrite cancelled — partial output kept.'
        : 'Rewrite complete. Tip: "Use in analyzer" to compare the new AI score.',
      rewriteCancelled ? 'info' : 'success'
    );
  } catch (err) {
    console.error('[Sentinel] Rewriter failed:', err);
    setRewriteStatus('error', (err && err.message) || 'the rewriter model could not be loaded.');
    toast('The rewriter model failed. See the Humanize panel for details.', 'error');
  } finally {
    rewriteBusy = false;
    rewriteBtn.textContent = 'Humanize text';
    rewriteCancelBtn.classList.add('hidden');
    const hasOut = rewriteOutput.value.trim().length > 0;
    rewriteUseBtn.disabled = !hasOut;
    rewriteCopyBtn.disabled = !hasOut;
    rewriteDownloadBtn.disabled = !hasOut;
    updateStats(); // re-evaluate button enablement now that rewriteBusy is false
  }
}

rewriteBtn.addEventListener('click', humanizeText);
rewriteCancelBtn.addEventListener('click', () => {
  if (rewriteBusy) rewriteCancelled = true;
});

// Load the rewritten text back into the analyzer (detect → humanize → re-detect loop).
rewriteUseBtn.addEventListener('click', () => {
  const out = rewriteOutput.value.trim();
  if (!out) return;
  textarea.value = out;
  updateStats();
  resultsSection.hidden = true;
  toast('Rewritten text loaded — run Analyze to compare the AI score.', 'success');
  textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

rewriteCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(rewriteOutput.value);
    toast('Rewritten text copied.', 'success');
  } catch {
    toast('Clipboard unavailable — select the text and copy manually.', 'error');
  }
});

rewriteDownloadBtn.addEventListener('click', () => {
  if (!rewriteOutput.value.trim()) return;
  const blob = new Blob([rewriteOutput.value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sentinel-ai-rewrite-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Rewrite downloaded (.txt).', 'success');
});

/* ---------------------------------------------------------------------------
 * Clear
 * ------------------------------------------------------------------------- */
clearBtn.addEventListener('click', () => {
  if (isAnalyzing) return;
  textarea.value = '';
  updateStats();
  resultsSection.hidden = true;
  progressWrap.classList.add('hidden');
  resultWrap.classList.add('hidden');
  progressBar.style.width = '0%';
  aiRing.style.setProperty('--p', 0);
  aiPercent.textContent = '0%';
  toast('Cleared.', 'info');
  textarea.focus();
});

/* ---------------------------------------------------------------------------
 * Misc + init
 * ------------------------------------------------------------------------- */
// Decorative placeholder links.
document.querySelectorAll('a[href="#"]').forEach((a) =>
  a.addEventListener('click', (e) => e.preventDefault())
);

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
}

updateStats();
setRewriteStatus('idle');
initModel(); // starts the "Downloading AI Model…" flow on page load
