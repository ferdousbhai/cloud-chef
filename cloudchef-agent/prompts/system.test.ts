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

  it("describes how a CloudChef app's changes reach a preview and production", () => {
    const prompt = systemPrompt('');

    expect(prompt).toContain('/home/project');
    expect(prompt).toContain('hosted preview');
    expect(prompt).toContain('a separate app with its own address, databases, bucket and namespace');
    expect(prompt).toContain('You do not deploy it yourself.');
    expect(prompt).toContain('onto the same address and the resources cloudflare.project.json declares each time');
    expect(prompt).not.toContain('publish_preview');
  });

  it('says a subchat is published as an app of its own, not onto its parent’s address and data', () => {
    expect(systemPrompt('')).toContain(
      "a subchat starts from its parent's files but is published as its own app, with its own address and data",
    );
  });

  it("describes a team project's pipeline and keeps production behind the person's say-so", () => {
    const prompt = systemPrompt('', { repository: 'Ada site', defaultBranch: 'main' });

    expect(prompt).toContain('A copy of Ada site');
    expect(prompt).toContain('publish_preview commits them to your branch');
    expect(prompt).toContain('publish merges them into main');
    expect(prompt).toContain('only when the person wants the change live');
    expect(prompt).toContain('Workers Builds deploys to production');
    expect(prompt).not.toContain('GitHub');
    expect(prompt).not.toContain('CloudChef app');
  });

  it('asks before building when the request is ambiguous in a way that matters', () => {
    expect(systemPrompt('')).toContain('ask one short question before building');
  });
});
