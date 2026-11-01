/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: { ignoreCodes: [18047] },
    }],
  },
  moduleNameMapper: {
    '^\\./deviceRegistry\\.js$': '<rootDir>/src/deviceRegistry.ts',
    '^shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
};
