import { pathToFileURL } from 'node:url';

export function runVerifierIfMain(importMetaUrl, verify) {
  if (!process.argv[1] || importMetaUrl !== pathToFileURL(process.argv[1]).href) {
    return;
  }
  Promise.resolve(verify()).then(
    (errors) => {
      if (errors.length > 0) {
        console.error(errors.map((error) => `- ${error}`).join('\n'));
        process.exitCode = 1;
      }
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
