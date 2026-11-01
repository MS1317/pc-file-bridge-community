/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@bridge/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@bridge/core$': '<rootDir>/../../packages/core/src/index.ts',
  },
};
