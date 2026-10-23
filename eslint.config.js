// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'supabase/.temp/*', 'playwright-report/*', 'test-results/*'],
  },
  {
    files: ['**/*.test.{ts,tsx,js}', 'jest.config.js', 'scripts/**', 'e2e/**'],
    languageOptions: { globals: { jest: 'readonly', describe: 'readonly', it: 'readonly', expect: 'readonly', beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly', test: 'readonly' } },
  },
]);
