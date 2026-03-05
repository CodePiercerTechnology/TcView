import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

type BackendResponse<T> = {
    id: number;
    result: T;
};

export type InstallLibraryProjectResult = {
    success: boolean;
    installedLibraryPath?: string;
    diagnostics: string[];
};

export type UpdateProjectLibraryReferenceResult = {
    success: boolean;
    diagnostics: string[];
};

export class TwinCATBackendClient {
    private queue: Promise<unknown> = Promise.resolve();
    // Monotonic request ids let the backend correlate responses to each invocation.
    private requestId = 0;

    constructor(private readonly extensionPath: string) {}

    public installLibraryProject(params: { tsprojPath: string; plcprojPath: string; solutionPath?: string; outputDirectory?: string }): Promise<InstallLibraryProjectResult> {
        return this.enqueue(() => this.invokeBackend<InstallLibraryProjectResult>('installLibraryProject', params));
    }

    public addLibraryReference(params: { tsprojPath?: string; plcprojPath: string; solutionPath?: string; libraryName: string; version?: string; vendor?: string }): Promise<UpdateProjectLibraryReferenceResult> {
        return this.enqueue(() => this.invokeBackend<UpdateProjectLibraryReferenceResult>('addLibraryReference', params));
    }

    public removeLibraryReference(params: { tsprojPath?: string; plcprojPath: string; solutionPath?: string; referenceName: string; version?: string; vendor?: string; displayName?: string }): Promise<UpdateProjectLibraryReferenceResult> {
        return this.enqueue(() => this.invokeBackend<UpdateProjectLibraryReferenceResult>('removeLibraryReference', params));
    }

    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const next = this.queue.then(action, action);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }

    private async invokeBackend<T>(method: string, params: unknown): Promise<T> {
        const invocation = this.resolveBackendInvocation();
        if (!invocation) {
            throw new Error('TcView backend executable was not found. Build backend/TcView.Backend or set twincat.backend.executablePath.');
        }

        return new Promise<T>((resolve, reject) => {
            const child = spawn(invocation.command, invocation.args, {
                cwd: this.extensionPath,
                windowsHide: true
            });

            let stdoutBuffer = '';
            let stderrBuffer = '';
            let settled = false;

            const finishWithError = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(error);
            };

            child.stdout.on('data', chunk => {
                stdoutBuffer += chunk.toString();
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        continue;
                    }

                    try {
                        const payload = JSON.parse(trimmed) as BackendResponse<T>;
                        if (!settled) {
                            settled = true;
                            resolve(payload.result);
                        }
                    } catch {
                        // Ignore backend log noise.
                    }
                }
            });

            child.stderr.on('data', chunk => {
                stderrBuffer += chunk.toString();
            });

            child.on('error', error => {
                finishWithError(error);
            });

            child.on('close', code => {
                if (settled) {
                    return;
                }
                const stderr = stderrBuffer.trim();
                if (stderr) {
                    finishWithError(new Error(stderr));
                    return;
                }
                finishWithError(new Error(`TcView backend exited with code ${code ?? 'unknown'}.`));
            });

            const request = JSON.stringify({
                id: ++this.requestId,
                method,
                params
            });
            child.stdin.write(`${request}\n`);
            child.stdin.end();
        });
    }

    private resolveBackendInvocation(): { command: string; args: string[] } | undefined {
        const configured = vscode.workspace.getConfiguration('twincat').get<string>('backend.executablePath', '').trim();
        const candidates = configured
            ? [configured]
            : [
                path.join(this.extensionPath, 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.exe'),
                path.join(this.extensionPath, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe'),
                path.join(this.extensionPath, 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.dll'),
                path.join(this.extensionPath, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll')
            ];

        for (const candidate of candidates) {
            if (!candidate || !fs.existsSync(candidate)) {
                continue;
            }

            if (candidate.toLowerCase().endsWith('.dll')) {
                return {
                    command: 'dotnet',
                    args: [candidate]
                };
            }

            return {
                command: candidate,
                args: []
            };
        }

        return undefined;
    }
}
