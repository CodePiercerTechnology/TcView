const fs = require('fs');
const path = require('path');

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
        baselinePaths: [],
        thresholdsPath: DEFAULT_THRESHOLDS_PATH
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--baseline') {
            options.baselinePaths.push(argv[++i]);
            continue;
        }
        if (arg === '--thresholds') {
            options.thresholdsPath = argv[++i];
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    if (options.baselinePaths.length === 0) {
        throw new Error('Provide at least one --baseline <path>.');
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

function levelRank(level) {
    switch (level) {
        case 'ideal':
            return 0;
        case 'acceptable':
            return 1;
        case 'bad':
            return 2;
        case 'missing':
        default:
            return -1;
    }
}

function summarizeMetric(metricName, threshold, snapshots) {
    const statName = threshold.stat || 'maxMs';
    const entries = snapshots.map(snapshot => {
        const value = getMetricValue(snapshot.data, metricName, statName);
        const level = classify(value, threshold);
        return {
            label: snapshot.label,
            value,
            level
        };
    });

    const recorded = entries.filter(entry => Number.isFinite(entry.value));
    const recordedEntries = entries.filter(entry => Number.isFinite(entry.value));
    const worst = recordedEntries.length > 0
        ? recordedEntries.reduce((currentWorst, entry) => {
            if (!currentWorst || levelRank(entry.level) > levelRank(currentWorst.level)) {
                return entry;
            }
            if (currentWorst.level === entry.level && entry.value > (currentWorst.value || -Infinity)) {
                return entry;
            }
            return currentWorst;
        }, null)
        : entries[0] || null;

    const average = recorded.length > 0
        ? Math.round(recorded.reduce((sum, entry) => sum + entry.value, 0) / recorded.length)
        : undefined;

    return {
        entries,
        worst,
        average
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const thresholds = readJsonFile(resolvePath(options.thresholdsPath), 'runtime thresholds');
    const snapshots = options.baselinePaths.map(inputPath => {
        const fullPath = resolvePath(inputPath);
        return {
            label: path.basename(fullPath),
            path: fullPath,
            data: normalizeRuntimeSnapshot(readJsonFile(fullPath, 'runtime baseline'))
        };
    });

    console.log(`[RUNTIME PERF] Comparing ${snapshots.length} runtime baseline(s).`);
    console.log(`[RUNTIME PERF] Thresholds: ${resolvePath(options.thresholdsPath)}`);

    for (const [metricName, threshold] of Object.entries(thresholds.metrics || {})) {
        const summary = summarizeMetric(metricName, threshold, snapshots);
        const averageText = Number.isFinite(summary.average) ? `${summary.average}${threshold.unit || ''}` : 'n/a';
        const worstValueText = Number.isFinite(summary.worst?.value) ? `${summary.worst.value}${threshold.unit || ''}` : 'not-recorded';
        console.log(
            `[RUNTIME PERF] ${metricName} => avg=${averageText}, worst=${worstValueText} ` +
            `[${summary.worst?.level || 'missing'}] (${summary.worst?.label || 'n/a'})`
        );

        for (const entry of summary.entries) {
            const renderedValue = Number.isFinite(entry.value) ? `${entry.value}${threshold.unit || ''}` : 'not-recorded';
            console.log(`  - ${entry.label}: ${renderedValue} [${entry.level}]`);
        }
    }
}

try {
    main();
} catch (error) {
    console.error(`[RUNTIME PERF][FAIL] ${String(error)}`);
    process.exit(1);
}
