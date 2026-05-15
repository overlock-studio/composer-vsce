import * as vscode from 'vscode';
import type { ConfigFormat } from './types';

export const crossplaneFormat: ConfigFormat = {
  id: 'crossplane',
  label: 'Crossplane',
  filenamePatterns: ['crossplane.yaml', 'crossplane.yml'],
  noFileSelectedMessage: 'No crossplane.yaml file selected',
  wrongFileMessage: 'Overlock Studio Composer can only open crossplane.yaml',
  decoration: {
    tooltip: 'Crossplane configuration',
    color: new vscode.ThemeColor('charts.purple'),
  },
};
