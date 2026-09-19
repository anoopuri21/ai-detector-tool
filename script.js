/* ============================================================================
   Sentinel AI — AI Content Detector
   Pure vanilla JavaScript. No backend, no build step — everything runs
   in the browser. pdf.js parses PDFs, mammoth.js parses DOCX files.
   ========================================================================== */

'use strict';

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

const aiRing       = $('aiRing');
const aiPercent    = $('aiPercent');
const verdictBadge = $('verdictBadge');
const verdictDot   = $('verdictDot');
const verdictTitle = $('verdictTitle');
const verdictDesc  = $('verdictDesc');
const wordCountLn  = $('wordCountLine');

const metricBars = [$('metric1Bar'), $('metric2Bar'), $('metric3Bar')];
const metricVals = [$('metric1Val'), $('metric2Val'), $('metric3Val')];

const toastContainer = $('toastContainer');

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

const ACCEPTED_EXTS = ['pdf', 'docx', 'txt', 'md'];

/* ---------------------------------------------------------------------------
 * Small utilities
 * ------------------------------------------------------------------------- */
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

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
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  statChars.textContent = `${chars.toLocaleString()} chars`;
  statWords.textContent = `${words.toLocaleString()} words`;
  const minutes = Math.ceil(words / 200);
  statRead.textContent = words === 0 ? '—' : minutes < 1 ? '<1 min read' : `~${minutes} min read`;

  // Requirement: Analyze stays disabled until there is text in the textarea.
  if (!isAnalyzing) analyzeBtn.disabled = words === 0;
}
textarea.addEventListener('input', updateStats);

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
    if (ext === 'pdf')      text = await extractPdfText(file);
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
    // Non-fatal warnings from mammoth (e.g. unsupported styles) — ignore.
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
 * NOTE: computeScore() below is a lightweight PLACEHOLDER heuristic so the
 * demo works end-to-end. Swap its internals for a real detection engine when
 * available — the UI only consumes { score, metrics[] }.
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

const VERDICTS = {
  ai: {
    title: 'Likely AI-generated',
    desc: 'The rhythm, vocabulary and phrasing of this text match statistical patterns typical of large-language-model output. Treat it as AI-written until a human confirms otherwise.',
    color: '#fb7185',
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    dot: 'bg-rose-400',
  },
  mixed: {
    title: 'Mixed signals',
    desc: 'Some passages look machine-generated while others feel human. This often happens when AI text has been edited, expanded or paraphrased by a person.',
    color: '#fbbf24',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    dot: 'bg-amber-400',
  },
  human: {
    title: 'Likely human-written',
    desc: 'Sentence rhythm, word variety and phrasing look naturally human. No strong machine-writing signals were detected in this sample.',
    color: '#34d399',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    dot: 'bg-emerald-400',
  },
};

function verdictOf(score) {
  if (score >= 65) return 'ai';
  if (score >= 35) return 'mixed';
  return 'human';
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
  wordCountLn.textContent =
    `${result.total.toLocaleString()} words · ${result.sentences.toLocaleString()} sentences analyzed`;

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

  await animateProgress();
  renderResult(computeScore(text));

  progressWrap.classList.add('hidden');
  resultWrap.classList.remove('hidden');

  isAnalyzing = false;
  analyzeBtn.disabled = !textarea.value.trim();
  analyzeLabel.textContent = 'Analyze Content';
  analyzeIcon.classList.remove('hidden');
  analyzeSpin.classList.add('hidden');
  toast('Analysis complete.', 'success');
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
