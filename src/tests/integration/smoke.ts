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

function closeActiveEditorIfAny(): Thenable<void> {
    if (vscode.window.activeTextEditor) {
        return vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    return Promise.resolve();
}

async function runLargeWorkspaceTreeRefreshCheck(workspaceRoot: string): Promise<void> {
    const tempFolder = path.join(workspaceRoot, '.twincat.integration.large');
    const fixturePou = path.join(workspaceRoot, 'src', 'tests', 'fixtures', 'FB_IntegrationSample.TcPOU');
    const fixtureItf = path.join(workspaceRoot, 'src', 'tests', 'fixtures', 'I_IntegrationSample.TcITF');
    const fixtureDut = path.join(workspaceRoot, 'src', 'tests', 'fixtures', 'ST_CiA402_Drive_PDO.TcDUT');

    const copies = 180;
    fs.mkdirSync(tempFolder, { recursive: true });
    for (let i = 0; i < copies; i++) {
        const source = i % 3 === 0 ? fixturePou : i % 3 === 1 ? fixtureItf : fixtureDut;
        const ext = path.extname(source);
        const target = path.join(tempFolder, `Synthetic_${String(i).padStart(4, '0')}${ext}`);
        fs.copyFileSync(source, target);
    }

    const targetUri = vscode.Uri.file(path.join(tempFolder, 'Synthetic_0000.TcPOU'));

    try {
        const started = Date.now();
        await vscode.commands.executeCommand('tcview.refreshFiles');
        await vscode.commands.executeCommand('tcview.openFromExplorer', targetUri);
        await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'twincat');

        const elapsedMs = Date.now() - started;
        const maxElapsedMs = Number.parseInt(process.env.TCVIEW_INTEGRATION_LARGE_OPEN_MAX_MS ?? '15000', 10);
        assert.ok(
            elapsedMs <= maxElapsedMs,
            `Large-workspace integration refresh/open exceeded ${maxElapsedMs} ms (actual ${elapsedMs} ms).`
        );

        const editorText = vscode.window.activeTextEditor?.document.getText() ?? '';
        assert.ok(editorText.includes('FUNCTION_BLOCK'), 'Expected to open synthetic TwinCAT POU content in large-workspace check.');
    } finally {
        await closeActiveEditorIfAny();
        fs.rmSync(tempFolder, { recursive: true, force: true });
        await vscode.commands.executeCommand('tcview.refreshFiles');
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
        await closeActiveEditorIfAny();
        if (fs.existsSync(tempTarget)) {
            fs.unlinkSync(tempTarget);
        }
    }

    await runLargeWorkspaceTreeRefreshCheck(workspaceRoot);
}

