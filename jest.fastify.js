// Fastify 5 pulls in the ESM-only `cookie` package. Node loads it directly, but
// Jest has to compile it to CommonJS first. `.` stands for either path separator.
module.exports = {
  transform: {
    'node_modules.cookie.dist.+[.]js$': ['ts-jest', {
      tsconfig: { allowJs: true, module: 'CommonJS', target: 'ES2022', esModuleInterop: true },
      diagnostics: false,
    }],
  },
  transformIgnorePatterns: ['node_modules.(?!([.]pnpm.cookie@|cookie.))'],
};
