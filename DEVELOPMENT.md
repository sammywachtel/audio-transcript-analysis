# Development Guide

## Quality Gates Overview

This project uses comprehensive quality gates to ensure code quality and prevent issues from reaching CI/CD.

### 🚨 Important: All commits MUST pass strict quality checks

Quality gates are enforced at multiple levels:

1. **Pre-commit hooks** - Run automatically on every commit
2. **CI/CD pipeline** - Validates all changes on push/PR
3. **Manual checks** - Run locally before committing

### Quality Commands

```bash
# Run all quality checks
npm run quality:gate

# Run specific checks
npm run quality:frontend     # Frontend only (ESLint, TypeScript, tests)
npm run quality:backend      # Backend only (Black, isort, flake8, MyPy)
npm run quality:precommit    # Run pre-commit hooks

# Manual hook management
npm run precommit:install    # Install pre-commit hooks
npm run precommit:run        # Run all pre-commit hooks manually
```

## Quick Setup

**New team member? Run this once:**
```bash
./setup-dev.sh --with-quality-gates  # Comprehensive setup with quality gates
# OR
./setup-dev.sh --basic               # Basic setup without quality gates
```

**Upgrade existing project:**
```bash
./add-quality-gates.sh
```

This automatically:
- Creates a Python virtual environment in `backend/.venv` (Python 3.11+)
- Installs all dependencies in isolated environments
- Sets up pre-commit hooks and verifies your environment
- Prevents system-wide Python package conflicts

## Development Workflow

### 1. Start Development Environment

```bash
# Start both frontend and backend
npm run dev

# OR start them separately
npm run frontend:dev  # Frontend only (port 5173)
npm run backend:dev   # Backend only (port 8001)
```

### 2. Make Your Changes

- Edit files in `frontend/src/` for React components
- Edit files in `backend/app/` for API endpoints
- Write tests as you develop (mandatory for all features)

### 3. Quality Gate Validation

**IMPORTANT: With quality gates enabled, run checks before committing:**

```bash
# Run all quality checks
npm run quality:gate

# Fix any issues reported
# Then commit normally
git add .
git commit -m "Your commit message"
```

**Pre-commit hooks run automatically and MUST pass:**
- ✅ ESLint strict validation (no auto-fixing)
- ✅ TypeScript compilation check
- ✅ Tests for affected files
- ✅ Python formatting and linting
- ✅ Security scanning
- ✅ File hygiene checks

**If hooks fail:**
- Fix the reported issues using quality commands
- Commit again - hooks will re-run
- **Cannot bypass without --no-verify (not recommended)**

### 4. Push and CI Validation

```bash
git push origin feature-branch
```

The CI pipeline validates:
- ✅ ESLint compliance (no auto-fixing)
- ✅ TypeScript compilation
- ✅ All tests pass
- ✅ Code quality standards

## Code Quality Commands

### Linting
```bash
# Check for lint issues
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Run from project root
npm run lint        # Delegates to frontend
npm run lint:fix    # Delegates to frontend
```

### TypeScript
```bash
# Check TypeScript compilation
cd frontend && npx tsc --noEmit

# Via project root
npm run test  # Includes TypeScript check in build process
```

### Python Environment & Formatting
```bash
# Activate backend virtual environment
cd backend && source .venv/bin/activate

# Format Python code
cd backend && source .venv/bin/activate && black . && isort .

# Check Python code formatting
cd backend && source .venv/bin/activate && black --check . && isort --check-only .

# Run Python linting
cd backend && source .venv/bin/activate && flake8

# Run Python type checking
cd backend && source .venv/bin/activate && mypy .

# Install new Python package
cd backend && source .venv/bin/activate && pip install package-name

# Update requirements.txt after adding packages
cd backend && source .venv/bin/activate && pip freeze > requirements.txt
```

### Testing
```bash
# Run all tests once
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run specific test
cd frontend && npm test -- ComponentName.test.tsx
```

### Pre-commit Management
```bash
# Manually run all pre-commit hooks
npm run precommit:run

# Reinstall hooks (if needed)
npm run setup:hooks

# Run pre-commit on specific files
pre-commit run --files frontend/src/components/MyComponent.tsx
```

## Development Best Practices

### 1. Test-Driven Development
- Write tests alongside feature development
- Use `npm run test:watch` for interactive testing
- Aim for comprehensive test coverage

### 2. Clean Commits
- Pre-commit hooks ensure clean, consistent code
- Write meaningful commit messages
- Make atomic commits (one logical change per commit)

### 3. Fast Feedback Loop
- Pre-commit hooks provide instant feedback (< 10 seconds)
- Fix issues locally before they reach CI
- Use watch mode for tests and development

### 4. Code Quality Standards
- ESLint enforces consistent code style
- TypeScript ensures type safety
- Tests verify functionality
- All checks run both locally and in CI

## Troubleshooting

### Pre-commit Hooks Not Running
```bash
# Reinstall hooks
./setup-dev.sh

# Or manually
pre-commit install
```

### CI Failing After Local Success
```bash
# Run the same checks CI uses
npm run lint      # ESLint validation
npx tsc --noEmit  # TypeScript check (from frontend/)
npm test          # Full test suite

# If still failing, check CI logs for specific errors
```

### Performance Issues
```bash
# Skip hooks temporarily (NOT recommended)
git commit --no-verify -m "Emergency fix"

# Better: Fix the underlying issue and commit normally
```

### Test Failures
```bash
# Run tests with more details
npm test -- --verbose

# Run specific failing test
npm test -- --testNamePattern="your test name"

# Debug failing test
npm test -- --no-coverage --verbose ComponentName.test.tsx
```

## File Structure Reference

```
lyrics/
├── .pre-commit-config.yaml    # Pre-commit hook configuration
├── setup-dev.sh               # One-command environment setup
├── .github/workflows/lint.yml # CI validation pipeline
├── frontend/                  # React TypeScript frontend
│   ├── src/components/        # React components
│   │   └── __tests__/         # Component tests
│   ├── src/utils/             # Utility functions
│   │   └── __tests__/         # Utility tests
│   └── package.json           # Frontend dependencies
├── backend/                   # FastAPI Python backend
│   ├── .venv/                 # Python virtual environment (auto-created)
│   ├── app/                   # Backend application code
│   └── requirements.txt       # Python dependencies
└── package.json               # Root scripts and tooling
```

## Team Workflow Summary

| Stage | Local (Pre-commit) | CI (GitHub Actions) |
|-------|-------------------|---------------------|
| **Speed** | < 10 seconds | 2-5 minutes |
| **Purpose** | Fix issues before commit | Validate clean code |
| **Actions** | Auto-fix lint, check TS, run tests | Validate only, no fixing |
| **Failure** | Fix locally and re-commit | Fix locally and push |

This hybrid approach ensures:
- ⚡ **Fast feedback** during development
- 🧹 **Clean commit history** without auto-fix commits
- 🔒 **Quality assurance** at every stage
- 🚀 **Efficient CI** that focuses on validation
- 👥 **Consistent code** across the team

## Getting Help

- **Setup Issues**: Run `./setup-dev.sh` again
- **Hook Problems**: Check `.pre-commit-config.yaml` configuration
- **CI Failures**: Compare local commands with CI steps
- **Test Issues**: Use `npm run test:watch` for interactive debugging

Happy coding! 🎵
