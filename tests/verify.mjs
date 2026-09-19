#!/usr/bin/env node
/* ============================================================================
   Sentinel AI — logic verification suite (dev-only, runs in Node).

   The app itself needs no Node.js — this script exists so the core logic can
   be verified headlessly: it extracts the pure functions from script.js and
   stress-tests them (large content, chunking, scoring, verdicts, cancellation).

   Run:  node tests/verify.mjs
   ========================================================================== */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'script.js'), 'utf8');

/* ---------- helpers ---------- */

function extractFunction(name) {
  let start = src.indexOf(`function ${name}`);
  if (start === -1) throw new Error('not found: ' + name);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('unbalanced braces: ' + name);
}

function extractClass(name) {
  const start = src.indexOf(`class ${name}`);
  if (start === -1) throw new Error('not found: ' + name);
  return src.slice(start, src.indexOf('\n}', start) + 2);
}

function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start === -1) throw new Error('not found: ' + name);
  const endArr = src.indexOf('\n];', start);
  const endObj = src.indexOf('\n};', start);
  const end = endArr === -1 ? endObj : endObj === -1 ? endArr : Math.min(endArr, endObj);
  return src.slice(start, end + 3);
}

function extractLine(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start === -1) throw new Error('not found: ' + name);
  return src.slice(start, src.indexOf('\n', start));
}

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${extra ? `  (${extra})` : ''}`);
  }
}
async function timed(label, fn) {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  console.log(`  TIME  ${label}: ${ms.toFixed(1)} ms`);
  return { r, ms };
}
const wc = (s) => (s.match(/\S+/g) || []).length;

/* ---------- build a harness module from script.js ---------- */

const template = [
  'const clamp = (n, a, b) => Math.min(b, Math.max(a, n));',
  'const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));',
  'const WORDS_PER_CHUNK = 300;',
  'const wc = (s) => (s.match(/\\S+/g) || []).length;',
  'let cancelRequested = false;',
  extractClass('AnalysisCancelled'),
  'const classifierLog = [];',
  'let stubCalls = 0;',
  'let cancelAfter = 0; // for cancellation test: cancel after N calls',
  'let classifier = async (chunk) => {',
  '  classifierLog.push(wc(chunk));',
  '  stubCalls++;',
  '  if (cancelAfter && stubCalls >= cancelAfter) { cancelRequested = true; return [{ label: "LABEL_0", score: 1 }]; }',
  '  const p = stubScores[wc(chunk)] ?? stubScores._default ?? 0.5;',
  '  return [{ label: "LABEL_1", score: p }, { label: "LABEL_0", score: 1 - p }];',
  '};',
  'const stubScores = { _default: 0.5 };',
  'function resetState() { classifierLog.length = 0; stubCalls = 0; cancelRequested = false; }',
  'function setScoreDefault(p) { for (const k of Object.keys(stubScores)) delete stubScores[k]; stubScores._default = p; }',
  extractConst('AI_PHRASES'),
  extractLine('MODEL_ID'),
  extractConst('VERDICTS'),
  'const computeScore = (text) => {',
  '  const words = (text.match(/\\S+/g) || []).length;',
  '  const sentences = text.split(/(?<=[.!?])\\s+/).map((s) => s.trim()).filter(Boolean).length;',
  '  return { score: 50, metrics: [10, 20, 30], total: words, sentences };',
  '};',
  extractFunction('isFakeLabel'),
  extractFunction('chunkAiProbability'),
  extractFunction('chunkText'),
  extractFunction('classifyChunks'),
  extractFunction('verdictOf'),
  extractFunction('buildReport'),
  extractFunction('buildRewritePrompt'),
  'const realComputeScore = (() => {',
  // real computeScore (for the discrimination test) — eval in this scope:
  extractFunction('computeScore').replace(/^function computeScore/, 'function _cs'),
  '  return _cs;',
  '})();',
  'function setCancel(v) { cancelRequested = v; }',
  'function setCancelAfter(n) { cancelAfter = n; }',
  'export { chunkText, classifyChunks, chunkAiProbability, isFakeLabel, verdictOf,',
  '         AnalysisCancelled, classifierLog, stubScores, wc,',
  '         setCancel, setCancelAfter, resetState, setScoreDefault, realComputeScore,',
  '         buildReport, buildRewritePrompt };',
].join('\n');

// The real computeScore uses a local name; keep the stub for classifyChunks.
writeFileSync('/tmp/sentinel-core.mjs', template);
const core = await import('/tmp/sentinel-core.mjs');

/* ---------- 1. Chunking correctness ---------- */

console.log('\n[1] Chunking correctness');

const sentences = Array.from({ length: 200 }, (_, i) =>
  `Sentence number ${i} in this test corpus has exactly ten words.`
); // 11 words each
const text2k = sentences.join(' '); // 2,200 words
const chunks2k = core.chunkText(text2k);
check('2,200-word text -> 8 chunks', chunks2k.length === 8, `got ${chunks2k.length}`);
check('every chunk <= 300 words', chunks2k.every((c) => wc(c) <= 300), chunks2k.map(wc).join(','));
check('no words lost', chunks2k.reduce((a, c) => a + wc(c), 0) === wc(text2k));
check('no empty chunks', chunks2k.every((c) => c.trim().length > 0));
check('single short text -> 1 chunk', core.chunkText('Just a short sentence.').length === 1);
check('empty input does not crash', Array.isArray(core.chunkText('')));

const giant = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
const gc = core.chunkText(giant);
check('1000-word run w/o punctuation hard-splits', gc.length === 4 && gc.map(wc).join(',') === '300,300,300,100', gc.map(wc).join(','));

/* ---------- 2. Large-content stress ---------- */

console.log('\n[2] Large-content stress');

function makeCorpus(wordCount) {
  const per = 10; // words per sentence
  const n = Math.ceil(wordCount / per);
  return Array.from({ length: n }, (_, i) =>
    `Statement ${i} of the corpus contains exactly ten plain words.`
  ).join(' ');
}

for (const size of [10_000, 100_000, 1_000_000]) {
  const corpus = makeCorpus(size);
  const chars = corpus.length;
  const { r } = await timed(`chunkText ${size.toLocaleString()} words (${(chars / 1048576).toFixed(1)} MB)`, () =>
    core.chunkText(corpus)
  );
  const expected = Math.ceil(size / 300);
  check(
    `${size.toLocaleString()} words: all chunks <= 300 words`,
    r.every((c) => wc(c) <= 300)
  );
  check(
    `${size.toLocaleString()} words: chunk count sane`,
    r.length === expected,
    `got ${r.length}, expected ~${expected}`
  );
  check(`${size.toLocaleString()} words: no words lost`, r.reduce((a, c) => a + wc(c), 0) === wc(corpus));
}

/* ---------- 3. Scoring: weighted average ---------- */

console.log('\n[3] Weighted average + label extraction');

const A = Array.from({ length: 300 }, (_, i) => `alpha${i}`).join(' ');
const B = Array.from({ length: 100 }, (_, i) => `beta${i}`).join(' ');

core.stubScores._default = 0;
core.stubScores[300] = 1.0;
core.stubScores[100] = 0.0;
const r1 = await core.classifyChunks([A, B], A + ' ' + B);
check('word-weighted (300w@1.0 + 100w@0.0) = 75', r1.score === 75, `got ${r1.score}`);
check('both chunks classified', core.classifierLog.join(',') === '300,100', core.classifierLog.join(','));

core.stubScores[300] = 0.8;
core.stubScores[100] = 0.8;
const r2 = await core.classifyChunks([A, B], A + ' ' + B);
check('uniform 0.8 -> 80 -> "ai" verdict', r2.score === 80 && core.verdictOf(r2.score) === 'ai', `score ${r2.score}`);

core.stubScores[300] = 0.05;
core.stubScores[100] = 0.05;
const r3 = await core.classifyChunks([A, B], A + ' ' + B);
check('uniform 0.05 -> 5 -> "human" verdict', r3.score === 5 && core.verdictOf(r3.score) === 'human', `score ${r3.score}`);

check('isFakeLabel LABEL_1', core.isFakeLabel('LABEL_1') === true);
check('isFakeLabel LABEL_0', core.isFakeLabel('LABEL_0') === false);
check('isFakeLabel "Fake"', core.isFakeLabel('Fake') === true);
check('isFakeLabel "Real"', core.isFakeLabel('Real') === false);
check(
  'prob extracted from Fake label (LABEL_0@0.95 tops -> 0.05)',
  Math.abs(core.chunkAiProbability([{ label: 'LABEL_0', score: 0.95 }, { label: 'LABEL_1', score: 0.05 }]) - 0.05) < 1e-9
);
check(
  'prob extracted from Fake label (LABEL_1@0.85 tops -> 0.85)',
  Math.abs(core.chunkAiProbability([{ label: 'LABEL_1', score: 0.85 }, { label: 'LABEL_0', score: 0.15 }]) - 0.85) < 1e-9
);

/* ---------- 4. Verdict thresholds ---------- */

console.log('\n[4] Verdict thresholds (0-20 human / 21-79 mixed / 80-100 ai)');
check('0 -> human', core.verdictOf(0) === 'human');
check('20 -> human', core.verdictOf(20) === 'human');
check('21 -> mixed', core.verdictOf(21) === 'mixed');
check('50 -> mixed', core.verdictOf(50) === 'mixed');
check('79 -> mixed', core.verdictOf(79) === 'mixed');
check('80 -> ai', core.verdictOf(80) === 'ai');
check('100 -> ai', core.verdictOf(100) === 'ai');

/* ---------- 5. Cancellation ---------- */

console.log('\n[5] Cancellation');

core.resetState();
core.setScoreDefault(0.5);
core.setCancelAfter(3);
let cancelledThrew = false;
try {
  await core.classifyChunks([A, A, A, A], A);
} catch (err) {
  cancelledThrew = err instanceof core.AnalysisCancelled;
}
check('AnalysisCancelled thrown mid-loop', cancelledThrew);
check('stopped after 3 chunks (not 4)', core.classifierLog.length === 3, `calls=${core.classifierLog.length}`);
core.setCancelAfter(0);
core.resetState();

/* ---------- 6. Heuristic fallback discrimination ---------- */

console.log('\n[6] Heuristic fallback separates AI-ish vs human-ish text');

const aiText =
  'In today\'s world, it is important to note that technology is a testament to human ingenuity. ' +
  'Moreover, we can leverage cutting-edge tools to unlock the potential of artificial intelligence. ' +
  'Furthermore, it is crucial to harness robust and seamless frameworks that empower organizations. ' +
  'In conclusion, the ever-evolving landscape demands that we embark on a comprehensive journey to foster innovation. ' +
  'Additionally, it goes without saying that a paradigm shift is essential for sustainable growth in our modern world.';

const humanText =
  'So yeah, I went to the market yesterday. It was packed. Bought some mangoes (they were surprisingly cheap), ' +
  'then got stuck in traffic for like two hours. Ugh. Also forgot my wallet at home, had to go back. ' +
  'Classic me, honestly. The chai was bad. Not going again, probably.';

const aiScore = core.realComputeScore(aiText).score;
const humanScore = core.realComputeScore(humanText).score;
check('AI-ish sample scores high', aiScore > 40, `score ${aiScore}`);
check('human-ish sample scores low', humanScore < 35, `score ${humanScore}`);
check('AI-ish > human-ish', aiScore > humanScore, `${aiScore} vs ${humanScore}`);

/* ---------- 7. End-to-end scaling (stubbed model) ---------- */

console.log('\n[7] End-to-end scaling with 50k words');

const big = makeCorpus(50_000);
const bigChunks = core.chunkText(big);
core.setScoreDefault(0.9);
await timed('classifyChunks 50k words (stubbed model, 167 chunks)', async () => {
  await core.classifyChunks(bigChunks, big);
});
const rBig = await core.classifyChunks(bigChunks, big);
check('50k words -> 167 chunks', bigChunks.length === 167, `got ${bigChunks.length}`);
check('50k words @ 0.9 -> 90% -> ai', rBig.score === 90 && core.verdictOf(rBig.score) === 'ai', `score ${rBig.score}`);

/* ---------- 8. Per-section scores, report, rewrite prompt ---------- */

console.log('\n[8] Per-section scores + report + rewrite prompt');

core.resetState();
core.setScoreDefault(0.8);
const r8 = await core.classifyChunks([A, B], A + ' ' + B);
check('perChunk has one entry per chunk', r8.perChunk.length === 2, `got ${r8.perChunk.length}`);
check(
  'perChunk pct+words correct',
  r8.perChunk[0].pct === 80 && r8.perChunk[0].words === 300 && r8.perChunk[1].pct === 80 && r8.perChunk[1].words === 100,
  JSON.stringify(r8.perChunk)
);

const report = core.buildReport({ score: 85, metrics: [70, 60, 30], total: 2200, sentences: 200, method: 'model', perChunk: r8.perChunk });
check('report has headline', report.includes('85% AI Generated'));
check('report has verdict title', report.includes('Highly Likely AI-Generated'));
check('report has model id', report.includes('Xenova/roberta-base-openai-detector'));
check('report has section table rows', report.includes('| 1 | 300 | 80% |'));
check('report has disclaimer', report.includes('Probabilistic screening'));
check('report works without perChunk', core.buildReport({ score: 10, metrics: [5, 20, 30], total: 500, sentences: 40, method: 'heuristic' }).includes('Heuristic estimate'));

const prompt = core.buildRewritePrompt('The quick brown fox. More testing here.');
check('rewrite prompt contains the chunk', prompt.includes('The quick brown fox. More testing here.'));
check('rewrite prompt asks for human style', prompt.toLowerCase().includes('human'));
check('rewrite prompt ends with <|assistant|>', prompt.trimEnd().endsWith('<|assistant|>'));

/* ---------- summary ---------- */

console.log('\n============================================');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('============================================');
process.exitCode = failed ? 1 : 0;
