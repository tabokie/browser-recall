import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JS_UNIT_TEST_LOC_BASELINE = 7288;
const INLINE_RUST_UNIT_TEST_LOC_BASELINE = 2317;
const COVERAGE_GAP_LIMIT = Number(process.env.COVERAGE_GAP_LIMIT || 25);
const COVERAGE_GAP_RANGES_PER_FILE = Number(
  process.env.COVERAGE_GAP_RANGES_PER_FILE || 12,
);

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function walk(relDir, predicate, files = []) {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return files;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'target' ||
        entry.name === 'dist' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      walk(relPath, predicate, files);
    } else if (predicate(relPath)) {
      files.push(relPath);
    }
  }
  return files;
}

function linesInFile(relPath) {
  const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const newlineCount = content.match(/\n/g)?.length ?? 0;
  return newlineCount === 0 && content.length > 0 ? 1 : newlineCount;
}

function sumLines(files) {
  return files.reduce((sum, file) => sum + linesInFile(file), 0);
}

function ext(file) {
  return path.extname(file);
}

function isJsTest(file) {
  return file.endsWith('.test.js');
}

function isSpec(file) {
  return file.endsWith('.spec.js');
}

function inlineRustTestLines() {
  const files = [
    ...walk(
      'crates',
      (file) => ext(file) === '.rs' && !file.includes('/tests/'),
    ),
    ...walk(
      'apps/desktop/src-tauri/src',
      (file) => ext(file) === '.rs' && !file.includes('/tests/'),
    ),
  ];
  let total = 0;

  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes('#[cfg(test)]')) continue;
      let modLine = index + 1;
      while (
        modLine < lines.length &&
        !/mod\s+tests\s*\{/.test(lines[modLine])
      ) {
        modLine += 1;
      }
      if (modLine >= lines.length) continue;

      let depth = 0;
      let endLine = modLine;
      for (; endLine < lines.length; endLine += 1) {
        for (const char of lines[endLine]) {
          if (char === '{') depth += 1;
          if (char === '}') depth -= 1;
        }
        if (depth === 0 && endLine > modLine) break;
      }
      total += endLine - index + 1;
      index = endLine;
    }
  }

  return total;
}

function percent(value, total) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function row(label, value, total) {
  console.log(
    `${label.padEnd(34)} ${String(value).padStart(6)} ${percent(value, total).padStart(7)}`,
  );
}

function readVitestCoverageSummary() {
  const summaryPath = path.join(ROOT, 'coverage/vitest/coverage-summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  return summary.total;
}

function readVitestCoverageDetail() {
  const detailPath = path.join(ROOT, 'coverage/vitest/coverage-final.json');
  if (!fs.existsSync(detailPath)) return null;
  return JSON.parse(fs.readFileSync(detailPath, 'utf8'));
}

function readRustCoverageSummary() {
  const summaryPath = path.join(ROOT, 'coverage/rust/coverage-summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const totals = summary?.data?.[0]?.totals || summary?.totals || null;
  if (!totals) return null;
  return totals;
}

function readRustMissingLines() {
  const missingPath = path.join(ROOT, 'coverage/rust/missing.txt');
  if (!fs.existsSync(missingPath)) return [];
  const lines = fs.readFileSync(missingPath, 'utf8').split('\n');
  const gaps = [];
  let currentFile = null;

  for (const line of lines) {
    const fileMatch = line.match(/^(.+\.rs):$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    const lineMatch = line.match(/^\s*(\d+)\|\s*0\|/);
    if (!lineMatch || !currentFile) continue;
    if (!currentFile.includes('/src/')) continue;
    gaps.push({
      file: path.relative(ROOT, currentFile),
      line: Number(lineMatch[1]),
    });
  }

  const byFile = new Map();
  for (const gap of gaps) {
    if (!byFile.has(gap.file)) byFile.set(gap.file, new Set());
    byFile.get(gap.file).add(gap.line);
  }

  return [...byFile.entries()]
    .map(([file, lines]) => ({
      file,
      uncoveredLineCount: lines.size,
      ranges: mergeLineRanges(lines),
    }))
    .sort(
      (left, right) =>
        right.uncoveredLineCount - left.uncoveredLineCount ||
        left.file.localeCompare(right.file),
    );
}

function rustMetricEntry(totals, metric) {
  const entry = totals?.[metric];
  if (!entry) return null;
  const total = entry.count ?? entry.total;
  const covered = entry.covered;
  if (typeof total !== 'number' || typeof covered !== 'number') return null;
  const pct =
    typeof entry.percent === 'number'
      ? entry.percent
      : total === 0
        ? 100
        : (covered / total) * 100;
  return { total, covered, pct };
}

function mergeLineRanges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line <= last.end + 1) {
      last.end = Math.max(last.end, line);
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

function formatRanges(ranges) {
  const shown = ranges.slice(0, COVERAGE_GAP_RANGES_PER_FILE);
  const formatted = shown
    .map(({ start, end }) =>
      start === end ? String(start) : `${start}-${end}`,
    )
    .join(', ');
  const hidden = ranges.length - shown.length;
  return hidden > 0 ? `${formatted}, ... +${hidden} more ranges` : formatted;
}

function collectCoverageGaps(coverageDetail) {
  if (!coverageDetail) return [];
  const gaps = [];

  for (const [absFile, fileCoverage] of Object.entries(coverageDetail)) {
    const uncoveredLines = new Set();
    for (const [statementId, hitCount] of Object.entries(
      fileCoverage.s || {},
    )) {
      if (hitCount !== 0) continue;
      const statement = fileCoverage.statementMap?.[statementId];
      if (!statement?.start?.line || !statement?.end?.line) continue;
      for (
        let line = statement.start.line;
        line <= statement.end.line;
        line += 1
      ) {
        uncoveredLines.add(line);
      }
    }
    if (uncoveredLines.size === 0) continue;

    gaps.push({
      file: path.relative(ROOT, absFile),
      uncoveredLineCount: uncoveredLines.size,
      ranges: mergeLineRanges(uncoveredLines),
    });
  }

  return gaps.sort(
    (left, right) =>
      right.uncoveredLineCount - left.uncoveredLineCount ||
      left.file.localeCompare(right.file),
  );
}

const jsUnitFiles = [
  ...walk('tests/unit', isJsTest),
  ...walk('packages', (file) => file.includes('/test/') && isJsTest(file)),
  ...walk('apps', isJsTest),
];
const jsIntegrationFiles = walk('tests/integration', isJsTest);
const extensionE2eFiles = walk(
  'tests/e2e',
  (file) => isSpec(file) && !file.endsWith('desktop-visual.spec.js'),
);
const desktopVisualFiles = exists('tests/e2e/desktop-visual.spec.js')
  ? ['tests/e2e/desktop-visual.spec.js']
  : [];
const smokeFiles = walk('tests/smoke', isSpec);
const testHelperFiles = [
  ...walk('tests/e2e', (file) => ext(file) === '.js' && !isSpec(file)),
  ...walk('tests/fixtures', () => true),
];
const rustDaemonTestFiles = walk(
  'crates/daemon/tests',
  (file) => ext(file) === '.rs' && !file.includes('/support/'),
);
const rustReplayTestFiles = walk(
  'crates/replay/tests',
  (file) => ext(file) === '.rs',
);
const rustSupportFiles = walk(
  'crates/daemon/tests/support',
  (file) => ext(file) === '.rs',
);

const categories = [
  ['JS unit', sumLines(jsUnitFiles)],
  ['JS integration', sumLines(jsIntegrationFiles)],
  ['Extension E2E specs', sumLines(extensionE2eFiles)],
  ['Desktop visual E2E', sumLines(desktopVisualFiles)],
  ['Firefox/Orion smoke E2E', sumLines(smokeFiles)],
  ['E2E/shared test helpers', sumLines(testHelperFiles)],
  ['Rust daemon external tests', sumLines(rustDaemonTestFiles)],
  ['Rust replay external tests', sumLines(rustReplayTestFiles)],
  ['Rust test support', sumLines(rustSupportFiles)],
  ['Inline Rust unit tests', inlineRustTestLines()],
];

const totalTestLines = categories.reduce((sum, [, value]) => sum + value, 0);
const unitLines = categories[0][1];
const rustInlineUnitLines =
  categories.find(([label]) => label === 'Inline Rust unit tests')?.[1] ?? 0;
const e2eLines = categories
  .filter(([label]) => label.includes('E2E') || label.includes('smoke'))
  .reduce((sum, [, value]) => sum + value, 0);

console.log('Test coverage investment monitor');
console.log('');
for (const [label, value] of categories) row(label, value, totalTestLines);
console.log(''.padEnd(50, '-'));
row('Total test code', totalTestLines, totalTestLines);
console.log('');
console.log(`E2E/smoke LoC: ${e2eLines}`);
console.log(`JS unit LoC baseline: ${JS_UNIT_TEST_LOC_BASELINE}`);
console.log(`Current JS unit LoC: ${unitLines}`);
console.log(
  `Inline Rust unit LoC baseline: ${INLINE_RUST_UNIT_TEST_LOC_BASELINE}`,
);
console.log(`Current inline Rust unit LoC: ${rustInlineUnitLines}`);

let failed = false;
if (
  unitLines > JS_UNIT_TEST_LOC_BASELINE &&
  process.env.ALLOW_UNIT_TEST_GROWTH !== '1'
) {
  console.error(
    `\nJS unit test LoC grew by ${unitLines - JS_UNIT_TEST_LOC_BASELINE}. Convert coverage to E2E, or rerun with ALLOW_UNIT_TEST_GROWTH=1 only for an explicit architecture exception.`,
  );
  failed = true;
}
if (
  rustInlineUnitLines > INLINE_RUST_UNIT_TEST_LOC_BASELINE &&
  process.env.ALLOW_UNIT_TEST_GROWTH !== '1'
) {
  console.error(
    `\nInline Rust unit test LoC grew by ${rustInlineUnitLines - INLINE_RUST_UNIT_TEST_LOC_BASELINE}. Prefer Rust integration/E2E coverage, or rerun with ALLOW_UNIT_TEST_GROWTH=1 only for an explicit architecture exception.`,
  );
  failed = true;
}

const vitestCoverage = readVitestCoverageSummary();
if (vitestCoverage) {
  console.log('');
  console.log('Vitest V8 coverage summary (context only)');
  for (const metric of ['lines', 'statements', 'branches', 'functions']) {
    const entry = vitestCoverage[metric];
    console.log(
      `${metric.padEnd(12)} ${String(entry.pct).padStart(6)}% (${entry.covered}/${entry.total})`,
    );
  }

  const gaps = collectCoverageGaps(readVitestCoverageDetail());
  if (gaps.length > 0) {
    console.log('');
    console.log(
      `Uncovered production line ranges for review (top ${Math.min(COVERAGE_GAP_LIMIT, gaps.length)} of ${gaps.length})`,
    );
    for (const gap of gaps.slice(0, COVERAGE_GAP_LIMIT)) {
      console.log(
        `${gap.file}:${formatRanges(gap.ranges)} (${gap.uncoveredLineCount} lines)`,
      );
    }
  }
} else {
  console.log('');
  console.log(
    'No Vitest coverage summary found. Run `npm run coverage:js` first.',
  );
}

const rustCoverage = readRustCoverageSummary();
if (rustCoverage) {
  console.log('');
  console.log('Rust llvm-cov coverage summary (context only)');
  for (const metric of ['lines', 'functions', 'branches', 'regions']) {
    const entry = rustMetricEntry(rustCoverage, metric);
    if (!entry) continue;
    console.log(
      `${metric.padEnd(12)} ${String(entry.pct.toFixed(2)).padStart(6)}% (${entry.covered}/${entry.total})`,
    );
  }

  const rustGaps = readRustMissingLines();
  if (rustGaps.length > 0) {
    console.log('');
    console.log(
      `Rust uncovered production line ranges for review (top ${Math.min(COVERAGE_GAP_LIMIT, rustGaps.length)} of ${rustGaps.length})`,
    );
    for (const gap of rustGaps.slice(0, COVERAGE_GAP_LIMIT)) {
      console.log(
        `${gap.file}:${formatRanges(gap.ranges)} (${gap.uncoveredLineCount} lines)`,
      );
    }
  } else if (!fs.existsSync(path.join(ROOT, 'coverage/rust/missing.txt'))) {
    console.log('');
    console.log(
      'No Rust missing-line report found. Run `npm run coverage:rust` first.',
    );
  }
} else {
  console.log('');
  console.log(
    'No Rust coverage summary found. Run `npm run coverage:rust` first.',
  );
}

if (failed) process.exit(1);
