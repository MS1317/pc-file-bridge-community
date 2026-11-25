/** @type {import('jest').Config} */
const fastify = require('../../jest.fastify.js');

module.exports = {
  transformIgnorePatterns: fastify.transformIgnorePatterns,
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    ...fastify.transform,
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@bridge/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@bridge/core$': '<rootDir>/../../packages/core/src/index.ts',
  },
};
