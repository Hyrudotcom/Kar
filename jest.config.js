/**
 * Jest projects:
 *  - app:  React Native components/screens (jest-expo preset) -> src/ui/**, src/features/** (never put tests in app/: expo-router treats files there as routes)
 *  - unit: pure TypeScript in Node                                  -> src/shared/**, src/price/**, src/contracts/**
 *  - sync: sync engine in Node with better-sqlite3 + fake transport -> src/sync/**
 *  - db:   SQL/RLS/RPC integration against the local Supabase stack -> supabase/tests/** (npm run test:db)
 *  - integration: real auth users + real sync engine + Supabase API/Realtime of the local stack
 *          -> tests/integration/** (npm run test:integration; needs the API on :54321, see README)
 */
const moduleNameMapper = { '^@/(.*)$': '<rootDir>/$1' };
const nodeTransform = { '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] };

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'app',
      preset: 'jest-expo',
      moduleNameMapper,
      testMatch: [
        '<rootDir>/src/ui/**/*.test.[jt]s?(x)',
        '<rootDir>/src/features/**/*.test.[jt]s?(x)',
      ],
    },
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform: nodeTransform,
      moduleNameMapper,
      testMatch: [
        '<rootDir>/src/shared/**/*.test.[jt]s',
        '<rootDir>/src/price/**/*.test.[jt]s',
        '<rootDir>/src/contracts/**/*.test.[jt]s',
      ],
    },
    {
      displayName: 'sync',
      testEnvironment: 'node',
      transform: nodeTransform,
      moduleNameMapper,
      testMatch: ['<rootDir>/src/sync/**/*.test.[jt]s'],
    },
    {
      displayName: 'db',
      testEnvironment: 'node',
      transform: nodeTransform,
      moduleNameMapper,
      testMatch: ['<rootDir>/supabase/tests/**/*.test.[jt]s'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform: nodeTransform,
      moduleNameMapper,
      testMatch: ['<rootDir>/tests/integration/**/*.test.[jt]s'],
      globalSetup: '<rootDir>/tests/integration/globalSetup.js',
    },
  ],
};
