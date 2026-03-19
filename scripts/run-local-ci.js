#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const perfReportFile = path.join(root, '.test-results', 'perf', 'large-workspace.json');
const perfBudgetFile = path.join(root, '.github', 'perf', 'ci-budget.json');
const vsixPath = path.join(root, 'tcview-ci-local.vsix');

function parseArgs(argv) {
  const args = argv.slice(2);
  let lane = 'all';
  let skipInstall = false;

  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--skip-install') {
      skipInstall = true;
      continue;
    }

    if (value === '--lane') {
      const next = args[i + 1];
      if (!next || !['all', 'regression', 'integration', 'package'].includes(next)) {
        throw new Error('Expected --lane to be one of: all, regression, integration, package');
      }
      lane = next;
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return { lane, skipInstall };
}

function runStep(label, command, args, extraEnv = {}) {
  console.log(`\n[LOCAL-CI] ${label}`);
  console.log(`[LOCAL-CI] > ${command} ${args.join(' ')}`);

  const spawnCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : command;
  const spawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', command, ...args]
    : args;

  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  if (result.status !== 0) {
    const code = result.status == null ? 'unknown' : result.status;
    if (result.error) {
      throw new Error(`${label} failed before exit: ${result.error.message}`);
    }
    throw new Error(`${label} failed with exit code ${code}`);
  }
}

function runRegressionLane() {
  runStep('Compile', 'npm', ['run', 'compile']);
  runStep(
    'Regression tests',
    'npm',
    ['run', 'test:regression:compiled'],
    { TCVIEW_PERF_REPORT_FILE: perfReportFile }
  );
  runStep(
    'Performance guardrails',
    'npm',
    ['run', 'test:perf:guardrails'],
    {
      TCVIEW_PERF_REPORT_FILE: perfReportFile,
      TCVIEW_PERF_BUDGET_FILE: perfBudgetFile
    }
  );
}

function runIntegrationLane() {
  runStep('Compile', 'npm', ['run', 'compile']);
  runStep('Integration smoke tests', 'npm', ['run', 'test:integration:compiled']);
}

function runPackageLane() {
  runStep('Build packaged extension assets', 'npm', ['run', 'vscode:prepublish']);
  runStep(
    'Package VSIX',
    'npm',
    ['exec', '--package', '@vscode/vsce', '--', 'vsce', 'package', '--out', vsixPath]
  );
  runStep(
    'Validate bundled backend packaging',
    'npm',
    ['run', 'test:packaging:backend'],
    { TCVIEW_VSIX_PATH: vsixPath }
  );
}

function main() {
  const { lane, skipInstall } = parseArgs(process.argv);

  if (process.platform !== 'win32') {
    console.warn('[LOCAL-CI] Warning: this repository is Windows-first; local CI parity is best on Windows.');
  }

  if (!skipInstall) {
    runStep('Install dependencies', 'npm', ['ci', '--no-audit', '--no-fund']);
  }

  if (lane === 'all' || lane === 'regression') {
    runRegressionLane();
  }

  if (lane === 'all' || lane === 'integration') {
    runIntegrationLane();
  }

  if (lane === 'all' || lane === 'package') {
    runPackageLane();
  }

  console.log('\n[LOCAL-CI] Completed successfully.');
}

try {
  main();
} catch (error) {
  console.error(`\n[LOCAL-CI] ${error.message}`);
  process.exitCode = 1;
}
