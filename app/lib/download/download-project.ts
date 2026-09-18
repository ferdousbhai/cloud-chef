import type { FileMap } from 'cloudchef-agent/types';
import { getRelativePath } from 'cloudchef-agent/utils/workDir';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import { cursorRulesContent } from './cursorRulesContent';
import { generateReadmeContent } from './readmeContent';

export async function downloadProject(files: FileMap, description: string): Promise<void> {
  const [{ default: JSZip }, { default: fileSaver }] = await Promise.all([import('jszip'), import('file-saver')]);
  const zip = new JSZip();
  let hasReadme = false;
  let hasCursorRules = false;

  for (const [filePath, dirent] of Object.entries(files)) {
    if (dirent?.type !== 'file' || dirent.isBinary) {
      continue;
    }
    const relativePath = getRelativePath(filePath);
    if (isLocalSecretFilePath(relativePath)) {
      continue;
    }
    zip.file(relativePath, dirent.content, { createFolders: true });
    hasReadme ||= relativePath.toLowerCase() === 'readme.md';
    hasCursorRules ||= relativePath === '.cursor/rules/cloudflare_rules.mdc';
  }

  const readmePath = hasReadme ? 'CLOUDCHEF_README.md' : 'README.md';
  zip.file(readmePath, generateReadmeContent(description));
  if (!hasCursorRules) {
    zip.file('.cursor/rules/cloudflare_rules.mdc', cursorRulesContent);
  }

  const archive = await zip.generateAsync({ type: 'blob' });
  fileSaver.saveAs(archive, `${projectFileName(description)}.zip`);
}

function projectFileName(description: string): string {
  return (description || 'project').toLocaleLowerCase().split(' ').join('_');
}
