import { describe, expect, it } from 'vitest';
import { workspaceImageAdmissionError } from './workspace-image-reference';

const ACCOUNT = '0af9e0921b880657d84a6c07307f8aef';
const OTHER = 'ffffffffffffffffffffffffffffffff';
const BASE = `docker.io/cloudflare/sandbox:0.13.0-next.724.1@sha256:${'d'.repeat(64)}`;

describe('image admission', () => {
  it('accepts the digest-pinned public base image', () => {
    expect(workspaceImageAdmissionError(BASE, ACCOUNT)).toBeNull();
  });

  it("accepts this account's own Cloudflare registry image", () => {
    const image = `registry.cloudflare.com/${ACCOUNT}/cloudchef-workspace:v1@sha256:${'a'.repeat(64)}`;
    expect(workspaceImageAdmissionError(image, ACCOUNT)).toBeNull();
  });

  it("refuses another account's registry namespace", () => {
    // The Containers REST API declares `image` as a bare string with no validation, so nothing
    // downstream catches this. The pull would fail with an authentication error instead.
    const image = `registry.cloudflare.com/${OTHER}/cloudchef-workspace:v1@sha256:${'a'.repeat(64)}`;
    expect(workspaceImageAdmissionError(image, ACCOUNT)).toMatch(/different Cloudflare account/);
  });

  it.each([
    ['a mutable tag with no digest', `registry.cloudflare.com/${ACCOUNT}/cloudchef-workspace:latest`],
    ['a mutable Docker Hub tag', 'docker.io/cloudflare/sandbox:0.13.0'],
    ['an unknown registry', `ghcr.io/cloudchef/workspace:v1@sha256:${'a'.repeat(64)}`],
    [
      'a registry-shaped host suffix attack',
      `registry.cloudflare.com.evil.test/${ACCOUNT}/x:v1@sha256:${'a'.repeat(64)}`,
    ],
  ])('refuses %s', (_name, image) => {
    expect(workspaceImageAdmissionError(image, ACCOUNT)).not.toBeNull();
  });
});
