import { runIntegrationChecks } from './smoke';

export async function run(): Promise<void> {
    await runIntegrationChecks();
}

const globalScope = globalThis as unknown as {
    suite?: (name: string, callback: () => void) => void;
    test?: (name: string, callback: () => Promise<void> | void) => void;
};

if (typeof globalScope.suite === 'function' && typeof globalScope.test === 'function') {
    globalScope.suite('TcView Integration', () => {
        globalScope.test!('smoke checks', async () => {
            await runIntegrationChecks();
        });
    });
}

