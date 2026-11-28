import { bindings, defineConfig, exports } from 'cf/config';

// A Durable Object hosting the builder's pi-durable setup on real Durable Object SQLite, for
// tests/workerd/pi/harness.integration.ts only.
export default defineConfig({
  worker: {
    name: 'cloudchef-pi-harness-test',
    entrypoint: './worker.ts',
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
    exports: { BuilderPiTestObject: exports.durableObject({ storage: 'sqlite' }) },
    env: {
      BUILDER: bindings.durableObject({ worker: 'cloudchef-pi-harness-test', exportName: 'BuilderPiTestObject' }),
    },
  },
});
