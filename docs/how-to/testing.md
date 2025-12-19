# Testing Guide

Guide for running and writing tests.

## Quick Start

```bash
# Run all tests
npm test

# Run tests once (CI mode)
npm run test:run

# Run with UI
npm run test:ui

# Generate coverage report
npm run test:coverage
```

## Test Structure

```
src/__tests__/
├── contexts/           # Context provider tests
├── components/         # Component tests
├── mocks/             # Firebase and service mocks
└── setup.ts           # Test configuration
```

## Running Tests

| Command | Description |
|---------|-------------|
| `npm test` | Watch mode, re-runs on changes |
| `npm run test:run` | Run once, exit with status |
| `npm run test:ui` | Visual test runner in browser |
| `npm run test:coverage` | Generate coverage report |

### Run Specific Tests

```bash
# By file name
npm test -- AuthContext.test.tsx

# By test name pattern
npm test -- --grep "sign-in"
```

## Writing Tests

### Basic Structure

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('Feature Name', () => {
  beforeEach(() => {
    // Reset state before each test
  });

  it('should do something specific', async () => {
    // Arrange - set up test data
    const input = 'test-data';

    // Act - execute the code
    const result = await doSomething(input);

    // Assert - verify results
    expect(result).toBe('expected-output');
  });
});
```

### Testing React Components

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyComponent } from '../MyComponent';

it('should render correctly', () => {
  render(<MyComponent title="Test" />);
  expect(screen.getByText('Test')).toBeInTheDocument();
});

it('should handle clicks', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();

  render(<MyComponent onClick={onClick} />);
  await user.click(screen.getByRole('button'));

  expect(onClick).toHaveBeenCalled();
});
```

### Testing Hooks

```typescript
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMyHook } from '../hooks/useMyHook';

it('should update state', async () => {
  const { result } = renderHook(() => useMyHook());

  act(() => {
    result.current.updateValue('new value');
  });

  await waitFor(() => {
    expect(result.current.value).toBe('new value');
  });
});
```

### Testing Auth Context

```typescript
import { renderHook, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import { createMockUser, setMockAuthState } from '../mocks/firebase';

it('should sign in successfully', async () => {
  const { result } = renderHook(() => useAuth(), {
    wrapper: AuthProvider
  });

  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    await result.current.signInWithGoogle();
  });

  expect(result.current.user).not.toBe(null);
});
```

## Mocking

### Firebase Auth Mocks

```typescript
import {
  createMockUser,
  setMockAuthState,
  createAuthError,
  resetAuthMocks
} from '../mocks/firebase';

beforeEach(() => {
  resetAuthMocks();
});

it('should handle auth error', async () => {
  mockFirebaseAuth.signInWithPopup.mockRejectedValueOnce(
    createAuthError('auth/popup-blocked', 'Popup blocked')
  );

  // Test error handling...
});
```

### Service Mocks

Services are auto-mocked in `setup.ts`:

```typescript
// Already mocked in setup.ts
vi.mock('../../services/firestoreService', () => ({
  firestoreService: {
    subscribeToUserConversations: vi.fn(() => () => {}),
    save: vi.fn(),
    delete: vi.fn(),
    getById: vi.fn()
  }
}));
```

## Coverage

Generate coverage report:

```bash
npm run test:coverage
```

Open the HTML report:

```bash
open coverage/index.html
```

### Coverage Targets

- **Statements**: 90%+
- **Branches**: 85%+
- **Functions**: 90%+

## Best Practices

### Do

- Write tests before implementation (TDD)
- Test one thing per test case
- Use descriptive test names
- Reset mocks between tests
- Test error scenarios
- Use async/await for promises

### Don't

- Share state between tests
- Use real Firebase/external services
- Skip error case testing
- Depend on test execution order
- Use hardcoded delays (`setTimeout`)
- Test implementation details

## Pre-commit Hooks

Tests run automatically on commit:

```bash
# Install hooks
npm run precommit:install

# Run checks manually
npm run precommit:run
```

## Debugging Tests

### Verbose Output

```bash
npm test -- --reporter=verbose
```

### Visual Debugging

```bash
npm run test:ui
```

Opens browser with:
- Test results visualization
- Coverage view
- File watching

### Console Logging

```typescript
it('should debug', () => {
  console.log('Debug info:', someValue);
  // Output shows in test results
});
```

## CI/CD Integration

Tests run on:
- Every pull request
- Push to `main` branch

The workflow runs:

```bash
npm run test:run --coverage
```

Failed tests block merge.
