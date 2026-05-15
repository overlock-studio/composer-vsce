import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { FormatFileDecorationProvider } from './decoration';
import { fetchBlockTypes } from '@overlock-studio/composer/oci';
import {
  parseLayoutYaml,
  serializeLayoutYaml,
  type LayoutByComposition,
} from '@overlock-studio/composer/lib/parser';
import {
  formats,
  findFormatForFilename,
  COMPOSER_VIEW_TYPE,
  type ConfigFormat,
} from './formats';

type FilePayload = { name: string; content: string };
type HashMap = Record<string, string>;
type SaveFileInput = { name: string; content: string };
type SaveDocumentMessage = {
  type: 'saveDocument';
  files: SaveFileInput[];
  hashes: HashMap;
  layout?: LayoutByComposition;
};

const sha256 = (text: string): string =>
  `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;

const LAYOUT_FILENAME = '.layout.yaml';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ComposerEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(COMPOSER_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'overlock.openVisualEditor',
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showWarningMessage(
            formats[0]?.noFileSelectedMessage ?? 'No file selected',
          );
          return;
        }
        const filename = path.basename(target.fsPath);
        const format = findFormatForFilename(filename);
        if (!format) {
          vscode.window.showWarningMessage(
            'Overlock Composer cannot open this file type',
          );
          return;
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          COMPOSER_VIEW_TYPE,
        );
      },
    ),
    vscode.commands.registerCommand('overlock.saveLayout', () => {
      provider.requestSaveOnActive();
    }),
  );

  const decorations = new FormatFileDecorationProvider(formats);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorations),
    decorations,
  );

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) provider.handleTabClosed(tab);
    }),
  );
}

const RELOAD_DEBOUNCE_MS = 150;
const SELF_WRITE_TTL_MS = 5000;

class ComposerEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly activePanels = new Set<vscode.WebviewPanel>();
  private readonly pendingSelfWrites = new Map<string, NodeJS.Timeout>();
  private readonly pendingDiffs = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private formatFor(uri: vscode.Uri): ConfigFormat | undefined {
    return findFormatForFilename(path.basename(uri.fsPath));
  }

  handleTabClosed(tab: vscode.Tab): void {
    if (!(tab.input instanceof vscode.TabInputTextDiff)) return;
    const fsPath = tab.input.modified.fsPath;
    const tempDir = this.pendingDiffs.get(fsPath);
    if (!tempDir) return;
    this.pendingDiffs.delete(fsPath);
    void fs
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
  }

  requestSaveOnActive(): boolean {
    for (const panel of this.activePanels) {
      if (panel.active) {
        panel.webview.postMessage({ type: 'requestSave' });
        return true;
      }
    }
    return false;
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
      ],
    };

    this.activePanels.add(webviewPanel);
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const liveReloadDisposables = this.setupLiveReload(document, webviewPanel);
    webviewPanel.onDidDispose(() => {
      this.activePanels.delete(webviewPanel);
      liveReloadDisposables.forEach((d) => d.dispose());
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        await this.postDocument(document, webviewPanel);
        return;
      }
      if (
        msg?.type === 'getBlockTypes' &&
        typeof msg.url === 'string' &&
        typeof msg.requestId === 'string'
      ) {
        try {
          const blockTypes = await fetchBlockTypes(msg.url);
          webviewPanel.webview.postMessage({
            type: 'getBlockTypesResult',
            requestId: msg.requestId,
            blockTypes,
          });
        } catch (err) {
          webviewPanel.webview.postMessage({
            type: 'getBlockTypesResult',
            requestId: msg.requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      if (msg?.type === 'saveDocument') {
        await this.handleSaveDocument(
          document,
          webviewPanel,
          msg as SaveDocumentMessage,
        );
        return;
      }
    });
  }

  private async postDocument(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const documentName = path.basename(document.uri.fsPath);
    const format = this.formatFor(document.uri);
    const onDisk = await this.readFileText(document.uri);
    const documentContent = onDisk ?? document.getText();
    const siblings = await this.gatherSiblingFiles(document.uri);
    const files: FilePayload[] = [
      { name: documentName, content: documentContent },
      ...siblings,
    ];
    const hashes: HashMap = {};
    for (const f of files) hashes[f.name] = sha256(f.content);
    const layout = await this.readLayout(document.uri);
    panel.webview.postMessage({
      type: 'document',
      uri: document.uri.toString(),
      format: format?.id,
      crossplaneFile: documentName,
      files,
      hashes,
      layout,
    });
  }

  private setupLiveReload(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): vscode.Disposable[] {
    const dir = vscode.Uri.joinPath(document.uri, '..');
    const yamlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, '*.{yaml,yml}'),
    );
    const layoutWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, LAYOUT_FILENAME),
    );

    let timer: NodeJS.Timeout | undefined;
    const schedulePost = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void this.postDocument(document, panel);
      }, RELOAD_DEBOUNCE_MS);
    };

    const onChange = (uri: vscode.Uri) => {
      if (this.consumeSelfWrite(uri.fsPath)) return;
      schedulePost();
    };

    return [
      yamlWatcher,
      yamlWatcher.onDidChange(onChange),
      yamlWatcher.onDidCreate(onChange),
      yamlWatcher.onDidDelete(onChange),
      layoutWatcher,
      layoutWatcher.onDidChange(onChange),
      layoutWatcher.onDidCreate(onChange),
      layoutWatcher.onDidDelete(onChange),
      new vscode.Disposable(() => {
        if (timer) clearTimeout(timer);
      }),
    ];
  }

  private markSelfWrite(fsPath: string): void {
    const existing = this.pendingSelfWrites.get(fsPath);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.pendingSelfWrites.delete(fsPath);
    }, SELF_WRITE_TTL_MS);
    this.pendingSelfWrites.set(fsPath, timeout);
  }

  private consumeSelfWrite(fsPath: string): boolean {
    const timeout = this.pendingSelfWrites.get(fsPath);
    if (!timeout) return false;
    clearTimeout(timeout);
    this.pendingSelfWrites.delete(fsPath);
    return true;
  }

  private layoutUri(documentUri: vscode.Uri): vscode.Uri {
    const dir = vscode.Uri.joinPath(documentUri, '..');
    return vscode.Uri.joinPath(dir, LAYOUT_FILENAME);
  }

  private async readLayout(
    documentUri: vscode.Uri,
  ): Promise<LayoutByComposition> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        this.layoutUri(documentUri),
      );
      const text = new TextDecoder('utf-8').decode(bytes);
      return parseLayoutYaml(text);
    } catch {
      return {};
    }
  }

  private async writeLayout(
    documentUri: vscode.Uri,
    layout: LayoutByComposition,
  ): Promise<void> {
    const text = serializeLayoutYaml(layout);
    const uri = this.layoutUri(documentUri);
    this.markSelfWrite(uri.fsPath);
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    } catch (err) {
      this.consumeSelfWrite(uri.fsPath);
      throw err;
    }
  }

  private async handleSaveDocument(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: SaveDocumentMessage,
  ): Promise<void> {
    if (!Array.isArray(msg.files) || !msg.hashes) {
      vscode.window.showErrorMessage('Overlock Composer: invalid save payload');
      return;
    }
    const dir = vscode.Uri.joinPath(document.uri, '..');
    const targets = msg.files.filter(
      (f): f is SaveFileInput =>
        !!f && typeof f.name === 'string' && typeof f.content === 'string',
    );
    if (targets.length === 0) {
      if (msg.layout) await this.tryWriteLayout(document.uri, msg.layout);
      panel.webview.postMessage({ type: 'saveResult', hashes: {} });
      return;
    }

    const cleanWrites: SaveFileInput[] = [];
    const conflicts: SaveFileInput[] = [];
    for (const file of targets) {
      const expected = msg.hashes[file.name];
      const current = await this.readFileText(
        vscode.Uri.joinPath(dir, file.name),
      );
      if (current === null) {
        cleanWrites.push(file);
        continue;
      }
      if (!expected || sha256(current) !== expected) {
        conflicts.push(file);
        continue;
      }
      cleanWrites.push(file);
    }

    const written: HashMap = {};
    try {
      for (const file of cleanWrites) {
        const targetUri = vscode.Uri.joinPath(dir, file.name);
        const existing = await this.readFileText(targetUri);
        if (existing === file.content) {
          written[file.name] = sha256(file.content);
          continue;
        }
        this.markSelfWrite(targetUri.fsPath);
        try {
          await vscode.workspace.fs.writeFile(
            targetUri,
            new TextEncoder().encode(file.content),
          );
          written[file.name] = sha256(file.content);
        } catch (err) {
          this.consumeSelfWrite(targetUri.fsPath);
          throw err;
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Overlock Composer: failed to save — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (msg.layout) await this.tryWriteLayout(document.uri, msg.layout);

    for (const conflict of conflicts) {
      await this.openConflictDiff(dir, conflict.name, conflict.content);
    }

    if (conflicts.length === 0) {
      vscode.window.setStatusBarMessage(
        `Overlock Composer: saved ${cleanWrites.length} file(s)`,
        3000,
      );
    } else {
      const names = conflicts.map((c) => c.name).join(', ');
      vscode.window.showWarningMessage(
        `Overlock Composer: ${conflicts.length} file(s) changed on disk — opened diff for ${names}`,
      );
    }

    panel.webview.postMessage({ type: 'saveResult', hashes: written });
  }

  private async openConflictDiff(
    workspaceDir: vscode.Uri,
    fileName: string,
    pendingContent: string,
  ): Promise<void> {
    const onDiskUri = vscode.Uri.joinPath(workspaceDir, fileName);

    const existingTempDir = [...this.pendingDiffs.entries()].find(
      ([fsPath]) => path.basename(fsPath) === fileName,
    );
    if (existingTempDir) {
      await fs.writeFile(existingTempDir[0], pendingContent, 'utf8');
      return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlock-'));
    const tempPath = path.join(tempDir, fileName);
    await fs.writeFile(tempPath, pendingContent, 'utf8');
    const pendingUri = vscode.Uri.file(tempPath);
    this.pendingDiffs.set(tempPath, tempDir);

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        onDiskUri,
        pendingUri,
        `${fileName} ↔ Overlock Composer (pending)`,
        { preview: false },
      );
    } catch (err) {
      this.pendingDiffs.delete(tempPath);
      await fs
        .rm(tempDir, { recursive: true, force: true })
        .catch(() => undefined);
      throw err;
    }
  }

  private async readFileText(uri: vscode.Uri): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return null;
    }
  }

  private async tryWriteLayout(
    documentUri: vscode.Uri,
    layout: LayoutByComposition,
  ): Promise<void> {
    try {
      await this.writeLayout(documentUri, layout);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Overlock Composer: failed to save layout — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async gatherSiblingFiles(
    documentUri: vscode.Uri,
  ): Promise<FilePayload[]> {
    const dir = vscode.Uri.joinPath(documentUri, '..');
    const self = path.basename(documentUri.fsPath).toLowerCase();
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }

    const yamlFiles = entries
      .filter(
        ([name, type]) =>
          type === vscode.FileType.File &&
          /\.ya?ml$/i.test(name) &&
          name.toLowerCase() !== self &&
          name.toLowerCase() !== LAYOUT_FILENAME,
      )
      .map(([name]) => name)
      .sort();

    const payloads = await Promise.all(
      yamlFiles.map(async (name): Promise<FilePayload | null> => {
        const fileUri = vscode.Uri.joinPath(dir, name);
        try {
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          return { name, content: new TextDecoder('utf-8').decode(bytes) };
        } catch {
          return null;
        }
      }),
    );

    return payloads.filter((p): p is FilePayload => !!p);
  }

  private getHtml(webview: vscode.Webview): string {
    const distRoot = vscode.Uri.file(
      path.join(this.context.extensionPath, 'dist'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distRoot, 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distRoot, 'webview.css'),
    );
    const nonce = makeNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <style>html,body,#root{height:100%;margin:0;padding:0;background:hsl(var(--background));color:hsl(var(--foreground));}</style>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++)
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
