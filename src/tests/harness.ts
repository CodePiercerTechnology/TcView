export type TestSuite = {
    name: string;
    run: () => Promise<void>;
};

export async function runSuites(suites: TestSuite[]): Promise<void> {
    const started = Date.now();
    for (const suite of suites) {
        const suiteStarted = Date.now();
        process.stdout.write(`\n[TEST] ${suite.name} ... `);
        await suite.run();
        const elapsed = Date.now() - suiteStarted;
        process.stdout.write(`ok (${elapsed} ms)\n`);
    }

    const totalElapsed = Date.now() - started;
    process.stdout.write(`\n[TEST] Completed ${suites.length} suite(s) in ${totalElapsed} ms.\n`);
}
