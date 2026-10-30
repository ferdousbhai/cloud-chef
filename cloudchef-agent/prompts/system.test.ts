import { describe, expect, it } from 'vitest';
import { systemPrompt } from './system.js';

describe('builder system prompt', () => {
  it('starts with the same workspace description in both kinds of project, then the skills', () => {
    const app = systemPrompt('<builder_skills/>');
    const linked = systemPrompt('<builder_skills/>', { repository: 'ada/site', defaultBranch: 'main' });
    const shared = app.slice(0, app.indexOf('## This project'));

    expect(shared.length).toBeGreaterThan(0);
    expect(linked.startsWith(shared)).toBe(true);
    expect(app.endsWith('<builder_skills/>')).toBe(true);
  });

  it("describes how a CloudChef app's changes reach production, its one site", () => {
    const prompt = systemPrompt('');

    expect(prompt).toContain('/home/project');
    expect(prompt).toContain('deploys it to production in their account, the one site the person sees beside the chat');
    expect(prompt).not.toContain('hosted preview');
    expect(prompt).toContain('You do not deploy it yourself.');
    expect(prompt).toContain('onto the same address and the resources cloudflare.project.json declares each time');
    expect(prompt).toContain('Production serves main.');
    expect(prompt).toContain('git push origin main');
    expect(prompt).not.toContain('publish_preview');
  });

  it("describes a team project's pipeline and keeps production behind the person's say-so", () => {
    const prompt = systemPrompt('', { repository: 'Ada site', defaultBranch: 'main' });

    expect(prompt).toContain('A copy of Ada site');
    expect(prompt).toContain('commit and push a branch of your own');
    expect(prompt).toContain('Pushing main puts the change live');
    expect(prompt).toContain('only when the person wants the change live');
    expect(prompt).toContain('Workers Builds deploys it to production');
    expect(prompt).not.toContain('GitHub');
    expect(prompt).not.toContain('CloudChef app');
  });

  it('asks for everyday words with the person in both kinds of project', () => {
    for (const prompt of [systemPrompt(''), systemPrompt('', { repository: 'Ada site', defaultBranch: 'main' })]) {
      expect(prompt).toContain('use everyday words');
      expect(prompt).toContain('The person may not know git, so tell them what happened in everyday terms');
      expect(prompt).toContain('Leave out terms such as main, branch, commit, merge, repository, pipeline');
    }
  });

  it("has the work build on others' pushes, and leaves a real contradiction to the person", () => {
    for (const prompt of [systemPrompt(''), systemPrompt('', { repository: 'Ada site', defaultBranch: 'main' })]) {
      expect(prompt).toContain('says when main took commits since git here last fetched it, and whose');
      expect(prompt).toContain('`git pull` before changing files');
      expect(prompt).toContain("Sara's latest changes are in your copy now");
      expect(prompt).toContain('combine both sides yourself wherever they fit together');
      expect(prompt).toContain('ask which to keep');
    }
  });

  it('describes the environment without coaching behaviour', () => {
    const prompt = systemPrompt('');

    expect(prompt).not.toContain('new_context');
    expect(prompt).not.toContain('ask one short question');
    expect(prompt).not.toContain('Say only what');
    expect(prompt).not.toContain('refused');
  });
});
