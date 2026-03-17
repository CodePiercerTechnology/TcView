const fs = require('fs');
const path = require('path');

const DEFAULT_BUDGET_PATH = '.github/perf/ci-budget.json';
const DEFAULT_REPORT_PATH = '.test-results/perf/large-workspace.json';
const DEFAULT_HISTORY_DIR = '.test-results/perf/history';

function resolvePath(inputPath) {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function readJsonFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${label} not found: ${filePath}`);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`Failed to parse ${label} ${filePath}: ${String(error)}`);
    }
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
    const options = {
        budgetPath: DEFAULT_BUDGET_PATH,
        reportPaths: [],
        historyDir: DEFAULT_HISTORY_DIR,
        minSamples: 3,
        minGuardrailMs: 1500,
        write: false,
        allowLoosen: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--budget') {
            options.budgetPath = argv[++i];
            continue;
        }
        if (arg === '--report') {
            options.reportPaths.push(argv[++i]);
            continue;
        }
        if (arg === '--history-dir') {
            options.historyDir = argv[++i];
            continue;
        }
        if (arg === '--min-samples') {
            options.minSamples = Number.parseInt(argv[++i], 10);
            continue;
        }
        if (arg === '--min-guardrail-ms') {
            options.minGuardrailMs = Number.parseInt(argv[++i], 10);
            continue;
        }
        if (arg === '--write') {
            options.write = true;
            continue;
        }
        if (arg === '--allow-loosen') {
            options.allowLoosen = true;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function listHistoryReports(historyDirPath) {
    if (!fs.existsSync(historyDirPath)) {
        return [];
    }

    return fs.readdirSync(historyDirPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(entry => path.join(historyDirPath, entry.name))
        .sort((a, b) => a.localeCompare(b));
}

function percentile(values, p) {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function median(values) {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const budgetPath = resolvePath(options.budgetPath);
    const historyDirPath = resolvePath(options.historyDir);

    const budget = readJsonFile(budgetPath, 'budget');
    const thresholds = budget.thresholds || {};
    const expectedDigest = thresholds.expectedDigest;
    const expectedFragmentDigest = thresholds.expectedFragmentDigest;

    const reportCandidates = new Set();
    reportCandidates.add(resolvePath(process.env.TCVIEW_PERF_REPORT_FILE || DEFAULT_REPORT_PATH));
    for (const reportPath of options.reportPaths) {
        reportCandidates.add(resolvePath(reportPath));
    }
    for (const historyPath of listHistoryReports(historyDirPath)) {
        reportCandidates.add(historyPath);
    }

    const elapsedSamples = [];
    const skipped = [];

    for (const reportPath of reportCandidates) {
        if (!fs.existsSync(reportPath)) {
            continue;
        }
        const report = readJsonFile(reportPath, 'report');
        if (!Number.isFinite(report.elapsedMs)) {
            skipped.push(`${path.basename(reportPath)}: missing elapsedMs`);
            continue;
        }
        if (typeof expectedDigest === 'string' && expectedDigest.length > 0 && report.digest !== expectedDigest) {
            skipped.push(`${path.basename(reportPath)}: digest mismatch`);
            continue;
        }
        if (
            typeof expectedFragmentDigest === 'string'
            && expectedFragmentDigest.length > 0
            && report.fragmentDigest !== expectedFragmentDigest
        ) {
            skipped.push(`${path.basename(reportPath)}: fragmentDigest mismatch`);
            continue;
        }
        elapsedSamples.push(report.elapsedMs);
    }

    const currentMaxElapsedMs = Number.isFinite(thresholds.maxElapsedMs) ? thresholds.maxElapsedMs : undefined;
    if (!Number.isFinite(options.minSamples) || options.minSamples < 1) {
        throw new Error(`--min-samples must be >= 1. Received: ${String(options.minSamples)}`);
    }

    if (elapsedSamples.length < options.minSamples) {
        console.log(
            `[PERF][INFO] Not enough samples to update budget (${elapsedSamples.length}/${options.minSamples}). ` +
            `Current maxElapsedMs=${String(currentMaxElapsedMs)}`
        );
        if (skipped.length > 0) {
            console.log(`[PERF][INFO] Skipped reports: ${skipped.join('; ')}`);
        }
        return;
    }

    const p90 = percentile(elapsedSamples, 90);
    const med = median(elapsedSamples);
    if (!Number.isFinite(p90) || !Number.isFinite(med)) {
        throw new Error('Failed to compute percentile statistics from samples.');
    }

    const candidate = Math.ceil(
        Math.max(
            med * 1.75,
            p90 * 1.25,
            options.minGuardrailMs
        )
    );

    let nextMaxElapsedMs = candidate;
    if (Number.isFinite(currentMaxElapsedMs)) {
        if (options.allowLoosen) {
            nextMaxElapsedMs = candidate;
        } else {
            nextMaxElapsedMs = Math.min(currentMaxElapsedMs, candidate);
        }
    }

    console.log(
        `[PERF][INFO] samples=${elapsedSamples.length} median=${med}ms p90=${p90}ms ` +
        `candidate=${candidate}ms current=${String(currentMaxElapsedMs)} next=${nextMaxElapsedMs}ms`
    );
    if (skipped.length > 0) {
        console.log(`[PERF][INFO] Skipped reports: ${skipped.join('; ')}`);
    }

    if (!options.write) {
        console.log('[PERF][INFO] Dry run only. Re-run with --write to persist budget changes.');
        return;
    }

    if (!budget.thresholds) {
        budget.thresholds = {};
    }
    budget.thresholds.maxElapsedMs = nextMaxElapsedMs;
    writeJsonFile(budgetPath, budget);
    console.log(`[PERF][PASS] Updated ${budgetPath} maxElapsedMs=${nextMaxElapsedMs}`);
}

try {
    main();
} catch (error) {
    console.error(`[PERF][FAIL] ${String(error)}`);
    process.exit(1);
}
