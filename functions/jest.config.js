/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/__tests__/**'
  ],
  // Mock firebase-functions logger by default
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  // Ignore lib directory
  modulePathIgnorePatterns: ['<rootDir>/lib/']
};
