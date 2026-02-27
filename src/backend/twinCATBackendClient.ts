import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import {
    TwinCATLibraryRef,
    TwinCATScanResult
} from './twinCATBackendTypes';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
}

export interface TwinCATBackendClientOptions {
    executablePath?: string;
    args?: string[];
    useExternalBackend: boolean;
    preferAutomationInterface: boolean;
    librarySourceRoots: string[];
    tmcRoots: string[];
    autoBuildTmcIfMissing: boolean;
}

export interface TwinCATBackendStatus {
    mode: 'external' | 'fallback';
    externalConfigured: boolean;
    externalRunning: boolean;
    lastError?: string;
}

export class TwinCATBackendClient implements vscode.Disposable {
    private process: ChildProcessWithoutNullStreams | undefined;
    private pending = new Map<number, PendingRequest>();
    private nextRequestId = 1;
    private libraries: TwinCATLibraryRef[] = [];
    private lastDiagnostics: string[] = [];
    private stdoutBuffer = '';
    private lastError: string | undefined;
    private resolvedExecutablePath: string | undefined;
    private readonly options: TwinCATBackendClientOptions;

    constructor(options?: Partial<TwinCATBackendClientOptions>) {
        this.options = {
            executablePath: options?.executablePath,
            args: options?.args ?? [],
            useExternalBackend: options?.useExternalBackend ?? true,
            preferAutomationInterface: options?.preferAutomationInterface ?? true,
            librarySourceRoots: options?.librarySourceRoots ?? [],
            tmcRoots: options?.tmcRoots ?? [],
            autoBuildTmcIfMissing: options?.autoBuildTmcIfMissing ?? true
        };
    }

    public async initialize(workspaceRoot: string): Promise<void> {
        if (!this.options.useExternalBackend) {
            return;
        }

        const launch = this.resolveBackendLaunch(workspaceRoot);
        if (!launch) {
            this.lastError = 'Backend executable could not be auto-discovered.';
            return;
        }
        this.resolvedExecutablePath = launch.path;

        try {
            this.process = spawn(launch.command, launch.args, {
                stdio: 'pipe',
                windowsHide: true
            });
            this.process.stdout.setEncoding('utf8');
            this.process.stderr.setEncoding('utf8');
            this.process.stdout.on('data', chunk => this.handleStdoutChunk(String(chunk)));
            this.process.stderr.on('data', chunk => console.warn(`[TcView Backend] ${String(chunk).trim()}`));
            this.process.on('exit', () => {
                this.process = undefined;
                this.lastError = 'Backend process exited unexpectedly.';
                for (const pending of this.pending.values()) {
                    pending.reject(new Error('TcView backend exited unexpectedly.'));
                }
                this.pending.clear();
            });

            await this.sendRequest('initialize', { workspacePath: workspaceRoot });
        } catch (error) {
            console.error('Failed to start TcView backend process:', error);
            this.process = undefined;
            this.lastError = String(error);
        }
    }

    public async scanProject(projectPath: string): Promise<TwinCATScanResult> {
        if (this.process) {
            try {
                const result = await this.sendRequest('scanProject', { projectPath });
                const typedResult = this.normalizeScanResult(result);
                this.libraries = typedResult.libraries;
                this.lastDiagnostics = typedResult.diagnostics;
                return typedResult;
            } catch (error) {
                console.error('TcView backend scan failed, falling back to local scanner:', error);
                this.lastError = String(error);
            }
        }

        const localLibraries = await this.scanLibrariesFromWorkspace(projectPath);
        this.libraries = localLibraries;
        return {
            libraries: localLibraries,
            symbols: [],
            librarySymbols: [],
            diagnostics: ['Using local fallback scanner. External backend unavailable.']
        };
    }

    public getLibraries(): TwinCATLibraryRef[] {
        return [...this.libraries];
    }

    public getStatus(): TwinCATBackendStatus {
        return {
            mode: this.process ? 'external' : 'fallback',
            externalConfigured: this.options.useExternalBackend && !!this.resolvedExecutablePath,
            externalRunning: !!this.process,
            lastError: this.lastError
        };
    }

    public getDiagnostics(): string[] {
        return [...this.lastDiagnostics];
    }

    public dispose(): void {
        for (const pending of this.pending.values()) {
            pending.reject(new Error('TcView backend client disposed.'));
        }
        this.pending.clear();

        if (this.process) {
            this.process.kill();
            this.process = undefined;
        }
    }

    private normalizeScanResult(result: any): TwinCATScanResult {
        const libraries = Array.isArray(result?.libraries) ? result.libraries : [];
        const symbols = Array.isArray(result?.symbols) ? result.symbols : [];
        const librarySymbols = Array.isArray(result?.librarySymbols) ? result.librarySymbols : symbols;
        const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
        return { libraries, symbols, librarySymbols, diagnostics };
    }

    private handleStdoutChunk(chunk: string): void {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() ?? '';

        const normalized = lines.map(line => line.trim()).filter(Boolean);
        for (const line of normalized) {
            try {
                const message = JSON.parse(line);
                if (typeof message.id === 'number' && this.pending.has(message.id)) {
                    const request = this.pending.get(message.id)!;
                    this.pending.delete(message.id);
                    if (message.error) {
                        request.reject(new Error(String(message.error)));
                    } else {
                        request.resolve(message.result);
                    }
                }
            } catch {
                // Ignore non-JSON lines from backend logs.
            }
        }
    }

    private async sendRequest(method: string, params: any): Promise<any> {
        if (!this.process) {
            throw new Error('TcView backend process is not running.');
        }

        const id = this.nextRequestId++;
        const mergedParams = method === 'scanProject'
            ? {
                ...params,
                preferAutomationInterface: this.options.preferAutomationInterface,
                librarySourceRoots: this.options.librarySourceRoots,
                tmcRoots: this.options.tmcRoots,
                autoBuildTmcIfMissing: this.options.autoBuildTmcIfMissing
            }
            : params;
        const payload = JSON.stringify({ id, method, params: mergedParams }) + '\n';
        const resultPromise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.process.stdin.write(payload);
        return resultPromise;
    }

    private resolveBackendLaunch(workspaceRoot: string): { command: string; args: string[]; path: string } | undefined {
        const explicit = (this.options.executablePath ?? '').trim();
        const candidates: string[] = [];
        if (explicit) {
            candidates.push(explicit);
        }

        const relativeCandidates = [
            path.resolve(__dirname, '..', 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe'),
            path.resolve(__dirname, '..', 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.exe'),
            path.resolve(__dirname, '..', '..', 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe'),
            path.resolve(__dirname, '..', '..', 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.exe'),
            path.resolve(__dirname, '..', '..', '..', 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe'),
            path.resolve(__dirname, '..', '..', '..', 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.exe'),
            path.join(workspaceRoot, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe'),
            path.join(workspaceRoot, 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.exe')
        ];
        candidates.push(...relativeCandidates);

        const exe = candidates.find(p => !!p && fs.existsSync(p));
        if (exe) {
            return { command: exe, args: this.options.args ?? [], path: exe };
        }

        const dllCandidates = [
            path.resolve(__dirname, '..', 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll'),
            path.resolve(__dirname, '..', 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.dll'),
            path.resolve(__dirname, '..', '..', 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll'),
            path.resolve(__dirname, '..', '..', 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.dll'),
            path.resolve(__dirname, '..', '..', '..', 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll'),
            path.resolve(__dirname, '..', '..', '..', 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.dll'),
            path.join(workspaceRoot, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll'),
            path.join(workspaceRoot, 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.dll')
        ];
        const dll = dllCandidates.find(p => fs.existsSync(p));
        if (dll) {
            return { command: 'dotnet', args: [dll], path: dll };
        }

        return undefined;
    }

    private async scanLibrariesFromWorkspace(projectPath: string): Promise<TwinCATLibraryRef[]> {
        const queryPatterns = [
            '**/_Libraries/**/*.library',
            '**/_Libraries/**/*.compiled-library*'
        ];

        const uris = await Promise.all(queryPatterns.map(pattern =>
            vscode.workspace.findFiles(pattern, '**/node_modules/**')
        ));

        const projectRootLower = projectPath.toLowerCase();
        const seen = new Set<string>();
        const refs: TwinCATLibraryRef[] = [];

        for (const uri of uris.flat()) {
            if (!uri.fsPath.toLowerCase().startsWith(projectRootLower)) {
                continue;
            }

            const ref = this.createLibraryRef(uri.fsPath);
            const key = `${ref.vendor ?? ''}|${ref.name}|${ref.version}|${ref.path}`.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            refs.push(ref);
        }

        refs.sort((a, b) => {
            const byVendor = (a.vendor ?? '').localeCompare(b.vendor ?? '');
            if (byVendor !== 0) return byVendor;
            const byName = a.name.localeCompare(b.name);
            if (byName !== 0) return byName;
            return a.version.localeCompare(b.version);
        });

        return refs;
    }

    private createLibraryRef(filePath: string): TwinCATLibraryRef {
        const parts = filePath.split(/[\\/]+/);
        const libsIndex = parts.findIndex(segment => segment.toLowerCase() === '_libraries');
        const fileName = path.basename(filePath);
        const extension = path.extname(fileName).toLowerCase();

        const vendor = libsIndex >= 0 && parts.length > libsIndex + 1 ? parts[libsIndex + 1] : undefined;
        let name = path.basename(fileName, extension);
        let version = 'unknown';

        if (libsIndex >= 0 && parts.length > libsIndex + 2) {
            name = parts[libsIndex + 2] || name;
        }
        if (libsIndex >= 0 && parts.length > libsIndex + 3) {
            version = parts[libsIndex + 3] || version;
        }

        return {
            name,
            version,
            vendor,
            path: filePath,
            mode: 'metadata_only'
        };
    }
}
