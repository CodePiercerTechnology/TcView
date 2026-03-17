import * as fs from 'fs';
import * as path from 'path';

export type BackendInvocation = {
    command: string;
    args: string[];
};

export const getBackendMissingErrorMessage = (): string =>
    'TcView backend executable was not found. Reinstall TcView to restore the bundled backend, or set twincat.backend.executablePath to override it.';

export const getBackendInvocationCandidates = (extensionPath: string, configuredOverride?: string): string[] => {
    const configured = (configuredOverride || '').trim();
    return [
        ...(configured ? [configured] : []),
        path.join(extensionPath, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe'),
        path.join(extensionPath, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll'),
        path.join(extensionPath, 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.exe'),
        path.join(extensionPath, 'backend', 'TcView.Backend', 'bin', 'Debug', 'net8.0-windows', 'TcView.Backend.dll')
    ];
};

export const resolveBackendInvocationFromCandidates = (
    candidates: string[],
    existsSyncFn: (candidate: string) => boolean = fs.existsSync
): BackendInvocation | undefined => {
    for (const candidate of candidates) {
        if (!candidate || !existsSyncFn(candidate)) {
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
};

export const formatBackendCommandError = (error: unknown): string => {
    const detail = String(error ?? 'Unknown backend error');
    const lower = detail.toLowerCase();

    if (lower.includes('backend executable was not found')) {
        return 'TcView backend was not found. Reinstall TcView to restore the bundled backend, or clear twincat.backend.executablePath if it points to an old override.';
    }

    if (lower.includes('spawn dotnet enoent')) {
        return 'TcView backend could not start because dotnet was not found. Install the .NET 8 runtime or point twincat.backend.executablePath to a working backend executable.';
    }

    if (lower.includes('exited with code')) {
        return `TcView backend started but failed to complete the request. ${detail}`;
    }

    return detail;
};
