import * as vscode from 'vscode';

interface PerfMetric {
    count: number;
    totalMs: number;
    maxMs: number;
    lastMs: number;
    errors: number;
}

const metrics = new Map<string, PerfMetric>();
let outputChannel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('TcView');
    }
    return outputChannel;
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

export function getPerfSummary(): string {
    if (metrics.size === 0) return 'No performance metrics recorded yet.';
    return [...metrics.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, stat]) => {
            const avg = Math.round(stat.totalMs / Math.max(1, stat.count));
            return `${name} => count=${stat.count}, avg=${avg}ms, max=${stat.maxMs}ms, last=${stat.lastMs}ms, errors=${stat.errors}`;
        })
        .join('\n');
}

export function showPerfSummary(): void {
    const summary = getPerfSummary();
    const channel = getChannel();
    channel.appendLine('[TcView Perf Summary]');
    summary.split('\n').forEach(line => channel.appendLine(line));
    channel.show(true);
}

export function disposeTelemetry(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}





