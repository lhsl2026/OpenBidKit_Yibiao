// Run from the isolated consumer checkout. Full server type checking is a separate build step.
const rootDir = process.cwd();
module.exports = {
  rootDir,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/server/**/*.spec.ts'],
  transform: { '^.+\\.tsx?$': [require.resolve('ts-jest', { paths: [rootDir] }), { tsconfig: 'tsconfig.node.json', isolatedModules: true, diagnostics: false }] },
};
