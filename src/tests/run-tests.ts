import { runSuites, TestSuite } from './harness';
import { runLanguageFeatureUtilityTests } from './languageFeatures.test';
import { runRegressionTests } from './regression/regression.test';

type SuiteName = 'functionality' | 'regression';

function parseSuiteSelection(argv: string[]): SuiteName[] {
    const requested = new Set<SuiteName>();
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--suite') {
            const next = argv[i + 1];
            if (next === 'functionality' || next === 'regression') {
                requested.add(next);
                i++;
            }
        }
    }

    if (requested.size === 0) {
        return ['functionality', 'regression'];
    }

    return [...requested];
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const suiteSelection = parseSuiteSelection(argv);
    const updateGoldens = argv.includes('--update') || process.env.TCVIEW_UPDATE_GOLDENS === '1';

    const suiteMap: Record<SuiteName, TestSuite> = {
        functionality: {
            name: 'Functionality',
            run: runLanguageFeatureUtilityTests
        },
        regression: {
            name: updateGoldens ? 'Regression (update goldens)' : 'Regression',
            run: () => runRegressionTests({ updateGoldens })
        }
    };

    const suites = suiteSelection.map(name => suiteMap[name]);
    await runSuites(suites);
}

Promise.resolve(main()).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
