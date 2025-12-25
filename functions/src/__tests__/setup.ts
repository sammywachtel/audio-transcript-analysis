// Jest setup for Firebase Functions tests
// Mock firebase-functions logger to prevent actual logging during tests

jest.mock('firebase-functions', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));
