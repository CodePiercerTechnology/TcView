import { runIntegrationChecks } from './smoke';

export async function run(): Promise<void> {
    await runIntegrationChecks();
}

