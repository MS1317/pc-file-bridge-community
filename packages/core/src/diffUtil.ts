import { createPatch } from 'diff';

export function createUnifiedDiff(
  relativePath: string,
  oldContent: string,
  newContent: string
): string {
  return createPatch(relativePath, oldContent, newContent, 'original', 'modified', {
    context: 3,
  });
}
