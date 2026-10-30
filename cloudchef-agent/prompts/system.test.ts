import { describe, expect, it } from 'vitest';
import { systemPrompt } from './system.js';

const APP = { name: 'Tip calculator', defaultBranch: 'main', starterApp: true };
const SITE = { name: 'Ada site', defaultBranch: 'main', starterApp: false };

describe('builder system prompt', () => {
  it('starts with the same workspace description in every kind of project, then the skills', () => {
    const app = systemPrompt('<builder_skills/>', APP);
    const site = systemPrompt('<builder_skills/>', SITE);
    const shared = app.slice(0, app.indexOf('## This project'));

    expect(shared.length).toBeGreaterThan(0);
    expect(site.startsWith(shared)).toBe(true);
    expect(app.endsWith('<builder_skills/>')).toBe(true);
  });

  it('describes one way to publish every project: a branch for a preview, main to go live', () => {
    for (const prompt of [systemPrompt('', APP), systemPrompt('', SITE)]) {
      expect(prompt).toContain('/home/project');
      expect(prompt).toContain('you do not deploy anything yourself');
      expect(prompt).toContain('commit and push a branch of your own');
      expect(prompt).toContain('Pushing main puts the change live');
      expect(prompt).toContain('only when the person wants the change live');
      expect(prompt).toContain('by CloudChef, or by Workers Builds for a project connected to it');
      expect(prompt).not.toContain('when your turn ends');
      expect(prompt).not.toContain('publish_preview');
      expect(prompt).not.toContain('GitHub');
    }
  });

  it("describes what CloudChef does for an app made from its starter, and a project's own conventions otherwise", () => {
    const app = systemPrompt('', APP);
    expect(app).toContain("Tip calculator, made from CloudChef's starter");
    expect(app).toContain('The project-stack skill describes how it is wired');
    expect(app).toContain('the resources its cloudflare.project.json declares');
    expect(app).toContain('an applied migration never runs again');

    const site = systemPrompt('', SITE);
    expect(site).toContain('Ada site, kept in its own repository');
    expect(site).toContain('Its own conventions');
    expect(site).not.toContain('project-stack');
  });

  it('asks for everyday words with the person in every kind of project', () => {
    for (const prompt of [systemPrompt('', APP), systemPrompt('', SITE)]) {
      expect(prompt).toContain('use everyday words');
      expect(prompt).toContain('The person may not know git, so tell them what happened in everyday terms');
      expect(prompt).toContain('Leave out terms such as main, branch, commit, merge, repository, pipeline');
    }
  });

  it("has the work build on others' pushes, and leaves a real contradiction to the person", () => {
    for (const prompt of [systemPrompt('', APP), systemPrompt('', SITE)]) {
      expect(prompt).toContain('says when main took commits since git here last fetched it, and whose');
      expect(prompt).toContain('`git pull` before changing files');
      expect(prompt).toContain("Sara's latest changes are in your copy now");
      expect(prompt).toContain('combine both sides yourself wherever they fit together');
      expect(prompt).toContain('ask which to keep');
    }
  });

  it('describes the environment without coaching behaviour', () => {
    const prompt = systemPrompt('', APP);

    expect(prompt).not.toContain('new_context');
    expect(prompt).not.toContain('ask one short question');
    expect(prompt).not.toContain('Say only what');
    expect(prompt).not.toContain('refused');
  });
});
