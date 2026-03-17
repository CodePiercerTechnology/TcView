const fs = require('fs');
const path = require('path');

const DEFAULT_BASELINE_PATH = 'runtime-baseline.json';
const DEFAULT_THRESHOLDS_PATH = '.github/perf/runtime-baselines.json';

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

function normalizeRuntimeSnapshot(document) {
    if (document && document.metrics && document.generatedAt) {
        return document;
    }
    if (document && document.baseline && document.baseline.metrics) {
        return document.baseline;
    }
    throw new Error('Input JSON is not a runtime baseline and does not contain an embedded baseline payload.');
}

function parseArgs(argv) {
    const options = {
        baselinePath: DEFAULT_BASELINE_PATH,
        thresholdsPath: DEFAULT_THRESHOLDS_PATH,
        failOn: 'none'
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--baseline') {
            options.baselinePath = argv[++i];
            continue;
        }
        if (arg === '--thresholds') {
            options.thresholdsPath = argv[++i];
            continue;
        }
        if (arg === '--fail-on') {
            options.failOn = argv[++i] || 'none';
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    if (!['none', 'bad', 'acceptable'].includes(options.failOn)) {
        throw new Error(`--fail-on must be one of: none, bad, acceptable. Received: ${options.failOn}`);
    }

    return options;
}

function getMetricValue(snapshot, metricName, statName) {
    const metric = snapshot.metrics?.[metricName];
    if (!metric) {
        return undefined;
    }
    const value = metric[statName];
    return Number.isFinite(value) ? value : undefined;
}

function classify(value, threshold) {
    if (!Number.isFinite(value)) {
        return 'missing';
    }
    if (value <= threshold.ideal) {
        return 'ideal';
    }
    if (value <= threshold.acceptable) {
        return 'acceptable';
    }
    return 'bad';
}

function shouldFail(level, failOn) {
    if (failOn === 'none') {
        return false;
    }
    if (failOn === 'bad') {
        return level === 'bad';
    }
    return level === 'acceptable' || level === 'bad';
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const baselinePath = resolvePath(options.baselinePath);
    const thresholdsPath = resolvePath(options.thresholdsPath);
    const snapshotDocument = readJsonFile(baselinePath, 'runtime baseline');
    const snapshot = normalizeRuntimeSnapshot(snapshotDocument);
    const thresholds = readJsonFile(thresholdsPath, 'runtime thresholds');

    const failures = [];
    const lines = [];

    const metricEntries = Object.entries(thresholds.metrics || {});
    for (const [metricName, threshold] of metricEntries) {
        const statName = threshold.stat || 'maxMs';
        const value = getMetricValue(snapshot, metricName, statName);
        const level = classify(value, threshold);
        const renderedValue = Number.isFinite(value) ? `${value}${threshold.unit || ''}` : 'not-recorded';
        lines.push(
            `[RUNTIME PERF] ${metricName} (${threshold.label}) => ${renderedValue} ` +
            `[${level}] ideal<=${threshold.ideal}${threshold.unit || ''} acceptable<=${threshold.acceptable}${threshold.unit || ''}`
        );

        if (shouldFail(level, options.failOn)) {
            failures.push(`${metricName} rated ${level}`);
        }
    }

    lines.forEach(line => console.log(line));

    if (failures.length > 0) {
        console.error(`[RUNTIME PERF][FAIL] ${failures.join('; ')}`);
        process.exit(1);
    }

    console.log('[RUNTIME PERF][PASS] Runtime baseline classification complete.');
}

try {
    main();
} catch (error) {
    console.error(`[RUNTIME PERF][FAIL] ${String(error)}`);
    process.exit(1);
}
