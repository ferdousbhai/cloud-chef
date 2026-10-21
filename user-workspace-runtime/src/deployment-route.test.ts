import { describe, expect, it } from 'vitest';
import { matchDeploymentRoute } from './deployment-route';

describe('deployment routes', () => {
  it('starts a deployment only on POST, so a link or redirect cannot deploy', () => {
    expect(matchDeploymentRoute('POST', '/v1/deployments/dep%201/deploy')).toEqual({
      deploymentId: 'dep 1',
      operation: 'deploy',
    });
    expect(matchDeploymentRoute('GET', '/v1/deployments/dep-1/deploy')).toEqual({ allow: 'POST' });
  });

  it('reads a deployment on GET only', () => {
    expect(matchDeploymentRoute('GET', '/v1/deployments/dep-1')).toEqual({ deploymentId: 'dep-1', operation: 'get' });
    expect(matchDeploymentRoute('POST', '/v1/deployments/dep-1')).toEqual({ allow: 'GET' });
  });

  it('leaves other paths to the other routes', () => {
    expect(matchDeploymentRoute('POST', '/v1/deployments/dep-1/promote')).toBeNull();
    expect(matchDeploymentRoute('GET', '/v1/models')).toBeNull();
  });
});
