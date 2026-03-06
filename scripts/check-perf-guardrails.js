const fs = require('fs');
const path = require('path');

const DEFAULT_REPORT_PATH = '.test-results/perf/large-workspace.json';
const DEFAULT_BUDGET_PATH = '.github/perf/ci-budget.json';

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

function readNumericOverride(envVarName, fallback) {
    const raw = process.env[envVarName];
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`${envVarName} must be a finite number. Received: ${raw}`);
    }
    return value;
}

function assertCondition(condition, message, failures) {
    if (!condition) {
        failures.push(message);
    }
}

function main() {
    const reportPath = resolvePath(process.env.TCVIEW_PERF_REPORT_FILE || DEFAULT_REPORT_PATH);
    const budgetPath = resolvePath(process.env.TCVIEW_PERF_BUDGET_FILE || DEFAULT_BUDGET_PATH);

    const report = readJsonFile(reportPath, 'performance report');
    const budget = readJsonFile(budgetPath, 'performance budget');
    const thresholds = budget.thresholds || {};

    const maxElapsedMs = readNumericOverride('TCVIEW_PERF_MAX_ELAPSED_MS', thresholds.maxElapsedMs);
    const minTotalConversions = readNumericOverride('TCVIEW_PERF_MIN_TOTAL_CONVERSIONS', thresholds.minTotalConversions);
    const minFragmentChecks = readNumericOverride('TCVIEW_PERF_MIN_FRAGMENT_CHECKS', thresholds.minFragmentChecks);
    const expectedDigest = process.env.TCVIEW_PERF_EXPECTED_DIGEST || thresholds.expectedDigest;
    const expectedFragmentDigest = process.env.TCVIEW_PERF_EXPECTED_FRAGMENT_DIGEST || thresholds.expectedFragmentDigest;

    const failures = [];
    assertCondition(Number.isFinite(report.elapsedMs), `report.elapsedMs must be finite. Received: ${String(report.elapsedMs)}`, failures);
    assertCondition(Number.isFinite(report.totalConversions), `report.totalConversions must be finite. Received: ${String(report.totalConversions)}`, failures);
    assertCondition(Number.isFinite(report.fragmentChecks), `report.fragmentChecks must be finite. Received: ${String(report.fragmentChecks)}`, failures);

    if (Number.isFinite(maxElapsedMs)) {
        assertCondition(report.elapsedMs <= maxElapsedMs, `elapsedMs ${report.elapsedMs} exceeds maxElapsedMs ${maxElapsedMs}`, failures);
    }
    if (Number.isFinite(minTotalConversions)) {
        assertCondition(report.totalConversions >= minTotalConversions, `totalConversions ${report.totalConversions} is below minTotalConversions ${minTotalConversions}`, failures);
    }
    if (Number.isFinite(minFragmentChecks)) {
        assertCondition(report.fragmentChecks >= minFragmentChecks, `fragmentChecks ${report.fragmentChecks} is below minFragmentChecks ${minFragmentChecks}`, failures);
    }
    if (typeof expectedDigest === 'string' && expectedDigest.length > 0) {
        assertCondition(report.digest === expectedDigest, `digest mismatch. expected=${expectedDigest} actual=${String(report.digest)}`, failures);
    }
    if (typeof expectedFragmentDigest === 'string' && expectedFragmentDigest.length > 0) {
        assertCondition(
            report.fragmentDigest === expectedFragmentDigest,
            `fragmentDigest mismatch. expected=${expectedFragmentDigest} actual=${String(report.fragmentDigest)}`,
            failures
        );
    }

    if (failures.length > 0) {
        console.error(`[PERF][FAIL] Guardrail validation failed for suite "${budget.suite || 'unknown'}".`);
        for (const failure of failures) {
            console.error(`[PERF][FAIL] ${failure}`);
        }
        process.exit(1);
    }

    console.log(
        `[PERF][PASS] ${budget.suite || 'large-workspace'} elapsed=${report.elapsedMs}ms ` +
        `conversions=${report.totalConversions} fragments=${report.fragmentChecks}`
    );
}

try {
    main();
} catch (error) {
    console.error(`[PERF][FAIL] ${String(error)}`);
    process.exit(1);
}
