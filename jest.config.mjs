import nextJest from 'next/jest.js';

const createJestConfig = nextJest({ dir: './' });

const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  // Development worktrees live under .worktrees/ (git-ignored) but Jest's
  // default discovery doesn't honor .gitignore, so it would otherwise also
  // run every worktree's own copy of the test suite against its own nested
  // node_modules -- a different React instance per worktree, which produces
  // spurious failures with no relation to the actual code.
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/.worktrees/'],
};

export default createJestConfig(config);
