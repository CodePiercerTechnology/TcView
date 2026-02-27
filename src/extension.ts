import * as vscode from 'vscode';
import * as path from 'path';
import { TwinCATFileExplorerProvider, TwinCATFileTreeItem } from './twinCATFileExplorerProvider';
import { TwinCATFileSystemProvider } from './twinCATFileSystemProvider';
import { registerLanguageFeatures } from './iecStLanguageFeatures';
import { initializeProjectAnalyzer } from './twinCATProjectAnalyzer';
import { disposeTelemetry, logError, showPerfSummary, withPerfMetric } from './twinCATTelemetry';

export function activate(context: vscode.ExtensionContext) {
    console.log('TcView extension is now active!');
    const supportedTwinCATExts = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcprg', '.tcapp', '.tccom', '.tcvar', '.tcgds', '.tcio', '.tcitf']);
    const redirectInProgress = new Set<string>();
    const skipNextAutoRedirect = new Set<string>();
    const lastFragmentBySource = new Map<string, string>();

    // Initialize TwinCAT Project Analyzer
    initializeProjectAnalyzer().then(() => {
        console.log('TwinCAT Project Analyzer initialized');
    }).catch(err => {
        console.error('Failed to initialize TwinCAT Project Analyzer:', err);
    });

    // Register language features (IntelliSense, snippets, diagnostics)
    registerLanguageFeatures(context);


    // Register the file explorer provider

    const fileExplorerProvider = new TwinCATFileExplorerProvider(
        vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined
    );
    
    vscode.window.registerTreeDataProvider('twincat.files', fileExplorerProvider);

    // Register the file system provider for editable virtual documents
    const fileSystemProvider = new TwinCATFileSystemProvider();
    const registration = vscode.workspace.registerFileSystemProvider(
        TwinCATFileSystemProvider.scheme,
        fileSystemProvider,
        { isCaseSensitive: true }
    );

    // Command: Refresh files in sidebar
    const refreshCommand = vscode.commands.registerCommand('tcview.refreshFiles', () => {
        fileExplorerProvider.refresh();
    });

    // Command: Open file from sidebar
    const openFileCommand = vscode.commands.registerCommand('tcview.openFile', async (item: TwinCATFileTreeItem | vscode.Uri, itemType?: string) => {
        // Handle both direct URI and TreeItem with resourceUri
        let fileUri: vscode.Uri;
        let type = itemType;
        
        if (item instanceof vscode.Uri) {
            fileUri = item;
        } else if (item && item.resourceUri) {
            fileUri = item.resourceUri;
            type = item.itemType;
        } else {
            vscode.window.showErrorMessage('No file selected');
            return;
        }
        
        await openTwinCATFile(fileUri, type);
    });


    // Command: Open file from explorer context menu
    const openFromExplorerCommand = vscode.commands.registerCommand('tcview.openFromExplorer', async (uri: vscode.Uri) => {
        await openTwinCATFile(uri);
    });

    // Command: Switch to XML view
    const switchToXmlCommand = vscode.commands.registerCommand('tcview.switchToXml', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const document = editor.document;
        const viewColumn = editor.viewColumn;
        const cursor = editor.selection.active;

        try {
            if (document.uri.scheme === TwinCATFileSystemProvider.scheme) {
                // Switch virtual ST -> source XML (same editor column)
                const originalPath = TwinCATFileSystemProvider.getOriginalPath(document.uri);
                const originalUri = vscode.Uri.file(originalPath);
                lastFragmentBySource.set(originalPath.toLowerCase(), document.uri.fragment || '');
                skipNextAutoRedirect.add(originalUri.toString());

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                const xmlDocument = await vscode.workspace.openTextDocument(originalUri);
                const xmlEditor = await vscode.window.showTextDocument(xmlDocument, {
                    preview: false,
                    viewColumn
                });

                const line = Math.max(0, Math.min(cursor.line, Math.max(0, xmlDocument.lineCount - 1)));
                const char = Math.max(0, Math.min(cursor.character, xmlDocument.lineAt(line).text.length));
                const position = new vscode.Position(line, char);
                xmlEditor.selection = new vscode.Selection(position, position);
                xmlEditor.revealRange(new vscode.Range(position, position));
                return;
            }

            if (document.uri.scheme === 'file') {
                const ext = path.extname(document.uri.fsPath).toLowerCase();
                if (!supportedTwinCATExts.has(ext)) {
                    vscode.window.showErrorMessage('Not a TwinCAT XML file');
                    return;
                }

                const rememberedFragment = lastFragmentBySource.get(document.uri.fsPath.toLowerCase()) || '';
                const targetUri = rememberedFragment
                    ? document.uri.with({ fragment: rememberedFragment })
                    : document.uri;

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await openTwinCATFile(targetUri);
                return;
            }

            vscode.window.showErrorMessage('Not a TwinCAT file');
        } catch (error) {
            logError(`Switch to XML failed: ${String(error)}`);
            vscode.window.showErrorMessage('Failed to switch TcView view: ' + error);
        }
    });

    const showPerfStatsCommand = vscode.commands.registerCommand('tcview.showPerfStats', () => {
        showPerfSummary();
        vscode.window.showInformationMessage('TcView performance stats written to the TcView output channel.');
    });

    // Helper function to open TwinCAT file
    async function openTwinCATFile(uri: vscode.Uri, itemType?: string) {
        try {
            const fragment = uri.fragment;
            if (fragment) {
                const baseUri = uri.with({ fragment: '' });
                const virtualUri = await withPerfMetric(`preload fragment ${path.basename(baseUri.fsPath)}#${fragment}`, () =>
                    fileSystemProvider.preloadFile(baseUri.fsPath, fragment)
                );

                const document = await withPerfMetric(`open fragment doc ${path.basename(baseUri.fsPath)}#${fragment}`, () =>
                    vscode.workspace.openTextDocument(virtualUri)
                );
                await withPerfMetric(`show fragment editor ${path.basename(baseUri.fsPath)}#${fragment}`, () =>
                    vscode.window.showTextDocument(document, { preview: false })
                );

                await vscode.languages.setTextDocumentLanguage(document, 'iec-st');
            } else {
                // Regular file - preload and open
                const virtualUri = await withPerfMetric(`preload ${path.basename(uri.fsPath)}`, () =>
                    fileSystemProvider.preloadFile(uri.fsPath)
                );
                
                // Open the virtual file
                const document = await withPerfMetric(`open doc ${path.basename(uri.fsPath)}`, () =>
                    vscode.workspace.openTextDocument(virtualUri)
                );
                await withPerfMetric(`show editor ${path.basename(uri.fsPath)}`, () =>
                    vscode.window.showTextDocument(document, { preview: false })
                );
                
                // Set language mode explicitly for syntax highlighting
                await vscode.languages.setTextDocumentLanguage(document, 'iec-st');
            }
            
        } catch (error) {
            logError(`Open TcView file failed: ${String(error)}`);
            vscode.window.showErrorMessage('Failed to open TcView file: ' + error);
        }
    }



    // Auto-save: Listen for native save events and sync to XML
    const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (document.uri.scheme === TwinCATFileSystemProvider.scheme) {
            try {
                await withPerfMetric('save to original XML', () => fileSystemProvider.saveToOriginal(document.uri));
                vscode.window.showInformationMessage('Saved to ' + path.basename(TwinCATFileSystemProvider.getOriginalPath(document.uri)));
            } catch (error) {
                logError(`Auto-save failed: ${String(error)}`);
                vscode.window.showErrorMessage('Failed to auto-save: ' + error);
            }
        }
    });

    // Auto-open: Intercept TwinCAT file opens and redirect to ST editor
    const openListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (document.uri.scheme !== 'file') {
            return;
        }

        const uriKey = document.uri.toString();
        if (skipNextAutoRedirect.has(uriKey)) {
            skipNextAutoRedirect.delete(uriKey);
            return;
        }

        const fileName = document.uri.fsPath;
        const ext = path.extname(fileName).toLowerCase();
        if (!supportedTwinCATExts.has(ext)) {
            return;
        }

        // Only redirect if this is the actively visible editor document.
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()) {
            return;
        }

        if (redirectInProgress.has(document.uri.toString())) {
            return;
        }

        redirectInProgress.add(document.uri.toString());
        try {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await openTwinCATFile(document.uri);
        } finally {
            redirectInProgress.delete(document.uri.toString());
        }
    });

    // Recovery for restored virtual tabs from previous session.
    const recoverRestoredTwincatTabs = async () => {
        const active = vscode.window.activeTextEditor;
        const docs = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === TwinCATFileSystemProvider.scheme);
        if (docs.length === 0) {
            return;
        }

        for (const doc of docs) {
            try {
                const originalPath = TwinCATFileSystemProvider.getOriginalPath(doc.uri);
                if (!originalPath) continue;
                const originalUri = vscode.Uri.file(originalPath);
                const fragment = doc.uri.fragment || '';
                const targetUri = fragment ? originalUri.with({ fragment }) : originalUri;
                await openTwinCATFile(targetUri);
            } catch (error) {
                logError(`Recovered tab open failed for ${doc.uri.toString()}: ${String(error)}`);
            }
        }

        if (active && active.document.uri.scheme === 'file') {
            await vscode.window.showTextDocument(active.document, { preview: false, viewColumn: active.viewColumn });
        }
    };

    void recoverRestoredTwincatTabs();

    // Clean up on deactivate

    context.subscriptions.push(
        registration,
        refreshCommand,
        openFileCommand,
        openFromExplorerCommand,
        switchToXmlCommand,
        showPerfStatsCommand,
        saveListener,
        openListener
    );




}

export function deactivate() {
    disposeTelemetry();
}





