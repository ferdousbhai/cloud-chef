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

describe('comment threads in the environment', () => {
  it('says nothing of comments for a project without a public post', () => {
    expect(systemPrompt('', APP)).not.toContain('## Comments');
  });

  it("names the post's open threads and the command in every chat on a project with a public post", () => {
    const prompt = systemPrompt('', APP, { comments: { post: '/sara/recipes', open: 3, onItsWay: 1 } });
    expect(prompt).toContain('/sara/recipes, has 3 open comment threads and 1 on its way');
    expect(prompt).toContain('`cloudchef comments`');
    expect(prompt).not.toContain('cloudchef comments close');
  });

  it('says the post runs the app, and asks for a fix when the live site refuses to be framed there', () => {
    const allowed = systemPrompt('', APP, {
      comments: { post: '/sara/recipes', open: 0, onItsWay: 0, runsInPost: true },
    });
    expect(allowed).toContain('frame-ancestors');
    expect(allowed).not.toContain('refuses to be framed');
    const refused = systemPrompt('', APP, {
      comments: { post: '/sara/recipes', open: 0, onItsWay: 0, runsInPost: false },
    });
    expect(refused).toContain('refuses to be framed by https://cloudchef.build now');
  });

  it('tells a mention-started chat which thread, that its final message is public, and its length', () => {
    const prompt = systemPrompt('', APP, {
      comments: { post: '/sara/recipes', open: 1, onItsWay: 0 },
      mention: { number: 4, post: '/sara/recipes', access: 'edit' },
    });
    expect(prompt).toContain('mention in thread #4 on /sara/recipes');
    expect(prompt).toContain('posted publicly in that thread');
    expect(prompt).toContain('at most 1,000 characters');
    expect(prompt).toContain('cloudchef comments close 4 --changed');
  });

  it('describes a read-only chat in place of the project, and offers no closing', () => {
    const prompt = systemPrompt('', APP, {
      comments: { post: '/sara/recipes', open: 1, onItsWay: 0 },
      mention: { number: 2, post: '/sara/recipes', access: 'read' },
      question: { post: '/sara/recipes' },
    });
    expect(prompt).toContain('A read-only copy of the public project /sara/recipes');
    expect(prompt).toContain('as a read-only run');
    expect(prompt).not.toContain("Tip calculator, made from CloudChef's starter");
    expect(prompt).not.toContain('cloudchef comments close');
  });
});
