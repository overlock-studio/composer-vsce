import { crossplaneFormat } from './crossplane';
import type { ConfigFormat } from './types';

export type { ConfigFormat, FormatDecoration } from './types';
export { matchesFormat, COMPOSER_VIEW_TYPE } from './types';

export const formats: ConfigFormat[] = [crossplaneFormat];

export const findFormatForFilename = (
  filename: string,
): ConfigFormat | undefined => {
  const lower = filename.toLowerCase();
  return formats.find((f) => f.filenamePatterns.includes(lower));
};
