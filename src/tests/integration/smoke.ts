import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 100): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting for condition.');
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

export async function runIntegrationChecks(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'Workspace folder is required for integration tests.');
    const workspaceRoot = workspace!.uri.fsPath;

    const fixtureSource = path.join(workspaceRoot, 'src', 'tests', 'fixtures', 'FB_IntegrationSample.TcPOU');
    const tempTarget = path.join(workspaceRoot, '.twincat.integration.sample.TcPOU');
    fs.copyFileSync(fixtureSource, tempTarget);

    const sourceUri = vscode.Uri.file(tempTarget);
    try {
        await vscode.commands.executeCommand('tcview.openFromExplorer', sourceUri);
        await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'twincat');

        const fragmentUri = sourceUri.with({ fragment: 'PropertyGet:SpeedCommand' });
        await vscode.commands.executeCommand('tcview.openFile', fragmentUri);
        await waitFor(() => vscode.window.activeTextEditor?.document.uri.fragment === 'PropertyGet:SpeedCommand');

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'Expected active editor for property get fragment.');

        const updatedFragment = [
            'PROPERTY SpeedCommand : REAL',
            '',
            'GET',
            '',
            'SpeedCommand := rSpeedCommand + 2.0;',
            '',
            'END_PROPERTY',
            ''
        ].join('\n');

        await editor!.edit(edit => {
            const fullRange = new vscode.Range(
                editor!.document.positionAt(0),
                editor!.document.positionAt(editor!.document.getText().length)
            );
            edit.replace(fullRange, updatedFragment);
        });

        await editor!.document.save();
        await waitFor(() => fs.readFileSync(tempTarget, 'utf8').includes('SpeedCommand := rSpeedCommand + 2.0;'));

        const updatedXml = fs.readFileSync(tempTarget, 'utf8');
        assert.ok(updatedXml.includes('SpeedCommand := rSpeedCommand + 2.0;'), 'Expected updated GET body in XML.');
    } finally {
        if (vscode.window.activeTextEditor) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
        if (fs.existsSync(tempTarget)) {
            fs.unlinkSync(tempTarget);
        }
    }
}

