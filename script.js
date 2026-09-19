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

   Document parsing: pdf.js (PDF) and mammoth.js (DOCX), both via CDN.
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------------------
 * transformers.js — loaded from the CDN as an ES module (see <script
 * type="module"> in index.html). The import is kicked off immediately so it
 * downloads in parallel with the page, but we deliberately do NOT block the
 * rest of the app on it: if the CDN is unreachable, the UI still works and
 * analysis falls back to the built-in heuristic.
 * ------------------------------------------------------------------------- */
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers';
const transformersPromise = import(TRANSFORMERS_CDN).catch((err) => {
  console.warn('[Sentinel] transformers.js failed to load:', err);
  return null;
});

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */
const MODEL_ID = 'Xenova/roberta-base-openai-detector';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ACCEPTED_EXTS = ['pdf', 'docx', 'txt', 'md'];
const WORDS_PER_CHUNK = 300; // model limit is 512 tokens; ~300 words stays safely under it

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
}
textarea.addEventListener('input', updateStats);

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
  alert:
    '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
};

/**
 * Render the model status banner.
 * @param {'loading'|'progress'|'ready'|'error'} state
 * @param {number|string} [detail] download percentage (progress) or message (error)
 */
function setModelStatus(state, detail = null) {
  modelStatus.hidden = false;
  modelStatus.classList.remove('opacity-0');

  const THEMES = {
    loading: { box: 'border-amber-500/30 bg-amber-500/10', icon: 'bg-amber-500/15 text-amber-300', title: 'text-amber-200', sub: 'text-amber-200/60' },
    ready:   { box: 'border-emerald-500/30 bg-emerald-500/10', icon: 'bg-emerald-500/15 text-emerald-300', title: 'text-emerald-200', sub: 'text-emerald-200/60' },
    error:   { box: 'border-rose-500/30 bg-rose-500/10', icon: 'bg-rose-500/15 text-rose-300', title: 'text-rose-200', sub: 'text-rose-200/70' },
  };
  const theme = THEMES[state === 'progress' ? 'loading' : state];
  modelStatus.className =
    `mb-6 flex items-center gap-4 rounded-xl border px-5 py-4 backdrop-blur-xl transition-opacity duration-300 ${theme.box}`;
  modelStatusIcon.className = `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${theme.icon}`;

  switch (state) {
    case 'progress':
      modelStatusIcon.innerHTML = STATUS_ICONS.spinner;
      modelStatusTitle.textContent = 'Downloading AI Model…';
      modelStatusSub.textContent = '(This may take a minute on first load)';
      modelStatusPct.textContent = `${detail}%`;
      modelStatusPct.classList.remove('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'loading':
      modelStatusIcon.innerHTML = STATUS_ICONS.spinner;
      modelStatusTitle.textContent = 'Downloading AI Model…';
      modelStatusSub.textContent = '(This may take a minute on first load)';
      modelStatusPct.textContent = '—';
      modelStatusPct.classList.remove('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'ready':
      modelStatusIcon.innerHTML = STATUS_ICONS.check;
      modelStatusTitle.textContent = 'AI detection model ready';
      modelStatusSub.textContent = 'Cached in your browser — all analysis stays on your device.';
      modelStatusPct.classList.add('hidden');
      modelRetryBtn.classList.add('hidden');
      break;
    case 'error':
      modelStatusIcon.innerHTML = STATUS_ICONS.alert;
      modelStatusTitle.textContent = 'Model failed to load';
      modelStatusSub.textContent =
        detail || 'Check your internet connection. Analysis will use the built-in heuristic until the model is available.';
      modelStatusPct.classList.add('hidden');
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
 * Load the text-classification pipeline. transformers.js downloads the model
 * weights on first use and caches them in the browser (Cache API), so later
 * visits load it instantly.
 */
async function loadModel() {
  if (classifier) return classifier;

  const transformers = await transformersPromise;
  if (!transformers) {
    throw new Error('The transformers.js CDN is unreachable.');
  }

  modelLoading = true;
  try {
    classifier = await transformers.pipeline('text-classification', MODEL_ID, {
      quantized: true,
      progress_callback: createDownloadTracker(),
    });
    return classifier;
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

/** Kick off model loading on page load. */
async function initModel() {
  setModelStatus('loading');
  try {
    await loadModel();
    modelReady = true;
    setModelStatus('ready');
    setTimeout(hideModelStatus, 2000); // brief "ready" flash, then dismiss
  } catch (err) {
    console.error('[Sentinel] Model load failed:', err);
    setModelStatus('error', err && err.message ? err.message : null);
  }
}

modelRetryBtn.addEventListener('click', () => {
  setModelStatus('loading');
  initModel();
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
 * averaged into one score.
 *
 * Fallback path: computeScore() — a lightweight local heuristic — keeps the
 * demo working when the model isn't loaded.
 * ------------------------------------------------------------------------- */
let isAnalyzing = false;

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
 */
async function classifyChunks(chunks, text, onChunk) {
  const weights = chunks.map((c) => (c.match(/\S+/g) || []).length || 1);
  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < chunks.length; i++) {
    // Paint the current state before this chunk's (synchronous) inference.
    await yieldToBrowser();

    const fakeProbability = chunkAiProbability(await classifier(chunks[i], { top_k: 2 }));

    weightedSum += fakeProbability * weights[i];
    totalWeight += weights[i];

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
  };
}

/* --------------------- Heuristic fallback (placeholder) ------------------- */

/** Well-known LLM-typical words and phrases. */
const AI_PHRASES = [
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
];

function computeScore(text) {
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  const total = words.length;
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const sentenceLens = sentences.map((s) => (s.match(/\S+/g) || []).length);

  // 1) Phrase predictability — density of LLM-typical phrasing (per 1k words).
  const lower = ' ' + text.toLowerCase() + ' ';
  let hits = 0;
  for (const p of AI_PHRASES) if (lower.includes(p)) hits++;
  const density = hits / Math.max(total / 1000, 1);
  const predictability = clamp(Math.round(density * 22), 0, 100);

  // 2) Sentence uniformity — AI text has very even sentence lengths.
  const mean = sentenceLens.length
    ? sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length
    : 0;
  const sd = sentenceLens.length
    ? Math.sqrt(sentenceLens.reduce((a, b) => a + (b - mean) ** 2, 0) / sentenceLens.length)
    : 0;
  const cv = mean ? sd / mean : 0;
  const uniformity = clamp(Math.round((1 - Math.min(cv, 1)) * 100), 0, 100);

  // 3) Lexical repetition — low vocabulary variety.
  const unique = new Set(words).size;
  const diversity = total ? unique / total : 0;
  const repetition = clamp(Math.round(((0.6 - diversity) / 0.6) * 100), 0, 100);

  let score = predictability * 0.45 + uniformity * 0.35 + repetition * 0.2;
  if (mean > 24) score += 6;                 // long, smooth sentences
  if (mean > 0 && mean < 8) score -= 6;      // choppy, human-like rhythm
  if (total < 40) score *= 0.6;              // very short samples → less confident

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

function renderResult(result) {
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
}

/* ------------------------------ Orchestration ----------------------------- */

/** Button label while analyzing: "Analyzing… i/X chunks" (spinner is shown by CSS). */
function setButtonProgress(total, done) {
  analyzeLabel.textContent = `Analyzing… ${done}/${total} chunks`;
}

async function runAnalysis() {
  const text = textarea.value.trim();
  if (!text || isAnalyzing) return;

  isAnalyzing = true;
  resultsSection.hidden = false;
  resultWrap.classList.add('hidden');
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  analyzeBtn.disabled = true;
  analyzeLabel.textContent = 'Analyzing…';
  analyzeIcon.classList.add('hidden');
  analyzeSpin.classList.remove('hidden');

  let result;
  if (modelReady && classifier) {
    try {
      // 1) Take the textarea text and run it through the chunking function.
      const chunks = chunkText(text);

      // 2) Button: spinner + "Analyzing… 0/X chunks".
      setButtonProgress(chunks.length, 0);

      // 3–5) Classify every chunk with the pipeline and combine the
      //      per-chunk Fake/AI probabilities into one weighted average.
      result = await classifyChunks(chunks, text, (done, total) => {
        setButtonProgress(total, done);
        progressBar.style.width = Math.round((done / total) * 100) + '%';
        progressLabel.textContent =
          total === 1 ? 'Running AI detection…' : `Classifying section ${done} of ${total}…`;
      });
    } catch (err) {
      console.error('[Sentinel] Model inference failed:', err);
      toast('The AI model failed during analysis — falling back to the built-in heuristic.', 'error');
      await animateProgress();
      result = { ...computeScore(text), method: 'heuristic' };
    }
  } else {
    if (modelLoading) {
      toast('The AI model is still loading — using the built-in heuristic this time.', 'info');
    }
    await animateProgress();
    result = { ...computeScore(text), method: 'heuristic' };
  }

  // 6) Show the results: AI percentage ring, headline and verdict.
  renderResult(result);
  progressWrap.classList.add('hidden');
  resultWrap.classList.remove('hidden');

  isAnalyzing = false;
  analyzeBtn.disabled = !textarea.value.trim();
  analyzeLabel.textContent = 'Analyze Content';
  analyzeIcon.classList.remove('hidden');
  analyzeSpin.classList.add('hidden');
  toast(
    result.method === 'model'
      ? 'Analysis complete — scored by the local AI detector.'
      : 'Analysis complete — heuristic estimate.',
    'success'
  );
}

analyzeBtn.addEventListener('click', runAnalysis);

// Ctrl/⌘ + Enter also triggers analysis.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runAnalysis();
  }
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
initModel(); // starts the "Downloading AI Model…" flow on page load
