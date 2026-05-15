import * as vscode from 'vscode';

export const COMPOSER_VIEW_TYPE = 'overlock.composer';

export type FormatDecoration = {
  tooltip: string;
  color: vscode.ThemeColor;
};

export type ConfigFormat = {
  id: string;
  label: string;
  filenamePatterns: string[];
  noFileSelectedMessage: string;
  wrongFileMessage: string;
  decoration?: FormatDecoration;
};

export const matchesFormat = (
  format: ConfigFormat,
  filename: string,
): boolean => format.filenamePatterns.includes(filename.toLowerCase());
