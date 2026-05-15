import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ConfigFormat } from './formats';

export class FormatFileDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly byFilename = new Map<string, ConfigFormat>();

  constructor(formats: ConfigFormat[]) {
    for (const format of formats) {
      if (!format.decoration) continue;
      for (const pattern of format.filenamePatterns) {
        this.byFilename.set(pattern.toLowerCase(), format);
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const format = this.byFilename.get(path.basename(uri.fsPath).toLowerCase());
    if (!format?.decoration) return undefined;
    return {
      tooltip: format.decoration.tooltip,
      color: format.decoration.color,
    };
  }

  dispose() {
    this._onDidChange.dispose();
  }
}
