/** @type {import('jest').Config} */
const fastify = require('../../jest.fastify.js');

module.exports = {
  transformIgnorePatterns: fastify.transformIgnorePatterns,
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  transform: {
    ...fastify.transform,
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: { ignoreCodes: [18047] },
    }],
  },
  moduleNameMapper: {
    '^@bridge/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
};
