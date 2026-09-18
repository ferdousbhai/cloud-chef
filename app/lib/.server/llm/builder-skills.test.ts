import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BUILDER_TEMPLATE_GZIP_BASE64 } from '~/agents/builder-template.generated';
import { createBuilderSkillContext, isBuilderSkillPath } from './builder-skills';

/** The exact file set a fresh workspace is seeded with, decoded from the shipped seed module. */
function seededWorkspacePaths(): Set<string> {
  const entries = JSON.parse(
    gunzipSync(Buffer.from(BUILDER_TEMPLATE_GZIP_BASE64, 'base64')).toString('utf8'),
  ) as Array<{ path: string }>;
  return new Set(entries.map((entry) => entry.path));
}

describe('builder skills', () => {
  it('serves the bundled skills through the read tool namespace', async () => {
    const { reader } = createBuilderSkillContext();

    await expect(reader.read('/__skills__/project-stack/SKILL.md')).resolves.toEqual({
      kind: 'file',
      content: expect.stringContaining('cloudchef.projectType to "worker"'),
    });
    await expect(reader.read('/__skills__/frontend-design/SKILL.md')).resolves.toEqual({
      kind: 'file',
      content: expect.stringContaining('name: frontend-design'),
    });
    await expect(reader.read('/__skills__/frontend-design')).resolves.toEqual({
      kind: 'directory',
      content: 'SKILL.md',
    });
    await expect(reader.read('/__skills__/react-start/SKILL.md')).resolves.toEqual({
      kind: 'file',
      content: expect.stringContaining('name: react-start'),
    });
    // The entry skill's own relative reference resolves inside the bundle.
    await expect(reader.read('/__skills__/react-start/server-components/SKILL.md')).resolves.toEqual({
      kind: 'file',
      content: expect.stringContaining('name: server-components'),
    });
    await expect(reader.read('/__skills__/react-start')).resolves.toEqual({
      kind: 'directory',
      content: expect.stringContaining('SKILL.md'),
    });
    await expect(reader.read('/__skills__/frontend-design/LICENSE.txt')).resolves.toBeNull();
    await expect(reader.read('/__skills__/nothing/SKILL.md')).resolves.toBeNull();
    // The overlay is not a traversal into the project workspace.
    await expect(reader.read('/__skills__/../home/project/package.json')).resolves.toBeNull();
  });

  // Regression for #125: the catalog once advertised /home/project/node_modules/..., which a
  // freshly seeded workspace cannot serve — node_modules is never part of the seed and the
  // reviewed installer only rewrites package.json and pnpm-lock.yaml. Every advertised path
  // must be readable at the moment the catalog is handed to the model: either through the
  // bundled overlay reader or as a file the seed actually writes.
  it('advertises only files readable at turn start in a freshly seeded workspace', async () => {
    const { prompt, reader } = createBuilderSkillContext();
    const advertised = [...prompt.matchAll(/^- (\/\S+)/gm)].map((match) => match[1]!);
    expect(advertised.length).toBeGreaterThan(0);

    const seeded = seededWorkspacePaths();
    for (const path of advertised) {
      if (isBuilderSkillPath(path)) {
        await expect(reader.read(path), `${path} is not served by the bundled skill reader`).resolves.toMatchObject({
          kind: 'file',
        });
      } else {
        expect(seeded.has(path), `${path} is not part of the seeded workspace`).toBe(true);
      }
    }
  });
});
