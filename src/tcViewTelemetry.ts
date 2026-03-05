import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface PerfMetric {
    count: number;
    totalMs: number;
    maxMs: number;
    lastMs: number;
    errors: number;
}

type PerfBaselineCategory = {
    operations: number;
    totalCount: number;
    avgMs: number;
    maxMs: number;
    errorCount: number;
};

export type PerfSnapshot = {
    generatedAt: string;
    metrics: Record<string, PerfMetric>;
    baselines: {
        open: PerfBaselineCategory;
        reindex: PerfBaselineCategory;
        treeRefresh: PerfBaselineCategory;
        save: PerfBaselineCategory;
    };
};

const metrics = new Map<string, PerfMetric>();
let outputChannel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('TcView');
    }
    return outputChannel;
}

function createEmptyBaselineCategory(): PerfBaselineCategory {
    return {
        operations: 0,
        totalCount: 0,
        avgMs: 0,
        maxMs: 0,
        errorCount: 0
    };
}

function aggregateByPrefixes(prefixes: string[]): PerfBaselineCategory {
    const matched = [...metrics.entries()].filter(([name]) => prefixes.some(prefix => name.startsWith(prefix)));
    if (matched.length === 0) {
        return createEmptyBaselineCategory();
    }

    let totalCount = 0;
    let totalMs = 0;
    let maxMs = 0;
    let errorCount = 0;
    for (const [, stat] of matched) {
        totalCount += stat.count;
        totalMs += stat.totalMs;
        maxMs = Math.max(maxMs, stat.maxMs);
        errorCount += stat.errors;
    }

    return {
        operations: matched.length,
        totalCount,
        avgMs: Math.round(totalMs / Math.max(1, totalCount)),
        maxMs,
        errorCount
    };
}

function toRecordSnapshot(): Record<string, PerfMetric> {
    const snapshot: Record<string, PerfMetric> = {};
    [...metrics.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .forEach(([name, stat]) => {
            snapshot[name] = { ...stat };
        });
    return snapshot;
}

export function isPerfLoggingEnabled(): boolean {
    return vscode.workspace.getConfiguration('twincat').get<boolean>('performanceLogging', false);
}

export function logInfo(message: string): void {
    if (!isPerfLoggingEnabled()) return;
    getChannel().appendLine(`[TcView] ${message}`);
}

export function logError(message: string): void {
    getChannel().appendLine(`[TcView Error] ${message}`);
}

export async function withPerfMetric<T>(name: string, action: () => Promise<T> | Thenable<T>): Promise<T> {
    const start = Date.now();
    try {
        return await action();
    } catch (error) {
        const current = metrics.get(name) || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, errors: 0 };
        current.errors += 1;
        metrics.set(name, current);
        throw error;
    } finally {
        const elapsed = Date.now() - start;
        const current = metrics.get(name) || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, errors: 0 };
        current.count += 1;
        current.totalMs += elapsed;
        current.maxMs = Math.max(current.maxMs, elapsed);
        current.lastMs = elapsed;
        metrics.set(name, current);
        if (isPerfLoggingEnabled()) {
            getChannel().appendLine(`[TcView Perf] ${name}: ${elapsed} ms`);
        }
    }
}

export function getPerfSnapshot(): PerfSnapshot {
    return {
        generatedAt: new Date().toISOString(),
        metrics: toRecordSnapshot(),
        baselines: {
            open: aggregateByPrefixes(['open.']),
            reindex: aggregateByPrefixes(['reindex.']),
            treeRefresh: aggregateByPrefixes(['tree.']),
            save: aggregateByPrefixes(['save.'])
        }
    };
}

export function getPerfSummary(): string {
    if (metrics.size === 0) return 'No performance metrics recorded yet.';

    const baseline = getPerfSnapshot().baselines;
    const baselineLines = [
        `baseline.open => ops=${baseline.open.operations}, count=${baseline.open.totalCount}, avg=${baseline.open.avgMs}ms, max=${baseline.open.maxMs}ms, errors=${baseline.open.errorCount}`,
        `baseline.reindex => ops=${baseline.reindex.operations}, count=${baseline.reindex.totalCount}, avg=${baseline.reindex.avgMs}ms, max=${baseline.reindex.maxMs}ms, errors=${baseline.reindex.errorCount}`,
        `baseline.treeRefresh => ops=${baseline.treeRefresh.operations}, count=${baseline.treeRefresh.totalCount}, avg=${baseline.treeRefresh.avgMs}ms, max=${baseline.treeRefresh.maxMs}ms, errors=${baseline.treeRefresh.errorCount}`,
        `baseline.save => ops=${baseline.save.operations}, count=${baseline.save.totalCount}, avg=${baseline.save.avgMs}ms, max=${baseline.save.maxMs}ms, errors=${baseline.save.errorCount}`
    ];

    return [...metrics.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, stat]) => {
            const avg = Math.round(stat.totalMs / Math.max(1, stat.count));
            return `${name} => count=${stat.count}, avg=${avg}ms, max=${stat.maxMs}ms, last=${stat.lastMs}ms, errors=${stat.errors}`;
        })
        .concat(['', ...baselineLines])
        .join('\n');
}

export function showPerfSummary(): void {
    const summary = getPerfSummary();
    const channel = getChannel();
    channel.appendLine('[TcView Perf Summary]');
    summary.split('\n').forEach(line => channel.appendLine(line));
    channel.show(true);
}

export async function writePerfSnapshot(filePath: string): Promise<void> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, `${JSON.stringify(getPerfSnapshot(), null, 2)}\n`, 'utf8');
}

export function disposeTelemetry(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}
