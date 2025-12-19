# Local Development Guide

Guide for running the Audio Transcript Analysis App locally.

## Quick Start

```bash
# Install dependencies (if not done)
npm install

# Start dev server
npm run dev
```

Open http://localhost:3000

## Development Setup Options

### Option A: Full Stack (Recommended)

Run everything locally with Firebase emulators:

```bash
# Terminal 1: Start Firebase emulators
npx firebase emulators:start

# Terminal 2: Start frontend
npm run dev
```

### Option B: Frontend Only

Connect to deployed Firebase backend:

```bash
npm run dev
```

Requires `.env` configured with your Firebase project.

### Option C: Docker Compose

Run frontend and alignment service together:

```bash
docker compose up
```

- **Frontend**: http://localhost:3000
- **Alignment Service**: http://localhost:8080

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase sender ID |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |

## Project Structure

```
audio-transcript-analysis-app/
├── components/              # React components
│   ├── auth/               # Authentication components
│   └── viewer/             # Transcript viewer components
├── contexts/               # React contexts
│   ├── AuthContext.tsx     # Authentication state
│   └── ConversationContext.tsx  # Conversation state
├── hooks/                  # Custom React hooks
├── pages/                  # Page components
│   ├── Library.tsx         # Conversation list
│   └── Viewer.tsx          # Transcript viewer
├── services/               # Firebase services
│   ├── firestoreService.ts # Firestore operations
│   └── storageService.ts   # Storage operations
├── functions/              # Cloud Functions (Node.js)
│   └── src/
│       ├── index.ts        # Function exports
│       └── transcribe.ts   # Gemini transcription
└── docs/                   # Documentation
```

## Common Tasks

### Adding a New Component

1. Create component in `components/`:
   ```typescript
   // components/MyComponent.tsx
   export const MyComponent: React.FC<Props> = ({ ... }) => {
     return <div>...</div>;
   };
   ```

2. Import and use:
   ```typescript
   import { MyComponent } from '../components/MyComponent';
   ```

### Adding a New Hook

1. Create hook in `hooks/`:
   ```typescript
   // hooks/useMyHook.ts
   export const useMyHook = () => {
     const [state, setState] = useState();
     return { state, setState };
   };
   ```

2. Export from barrel:
   ```typescript
   // hooks/index.ts
   export { useMyHook } from './useMyHook';
   ```

### Modifying Cloud Functions

1. Edit functions in `functions/src/`
2. Test locally:
   ```bash
   cd functions
   npm run build
   npm run serve
   ```
3. Deploy:
   ```bash
   npx firebase deploy --only functions
   ```

## Testing

```bash
# Run all tests
npm test

# Run tests with UI
npm run test:ui

# Run tests once (CI mode)
npm run test:run

# Generate coverage report
npm run test:coverage
```

See [Testing Guide](testing.md) for more details.

## Building for Production

```bash
# Build frontend
npm run build

# Preview production build
npm run preview
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm test` | Run tests in watch mode |
| `npm run test:run` | Run tests once |
| `npm run lint` | Run ESLint |
| `npx firebase deploy` | Deploy to Firebase |

## Debugging

### Browser DevTools

- **Console**: Look for `[Auth]` and `[Storage]` prefixed logs
- **Network**: Monitor Firebase API calls
- **Application → IndexedDB**: View local cache (Firebase offline persistence)

### Firebase Emulator UI

When running emulators, open http://localhost:4000 for:
- Firestore data viewer
- Storage browser
- Function logs
- Auth user management

### Cloud Function Logs

```bash
# View recent logs
npx firebase functions:log

# Stream logs
npx firebase functions:log --follow
```

## Troubleshooting

### Hot reload not working

```bash
# Clear Vite cache
rm -rf node_modules/.vite
npm run dev
```

### Firebase auth issues

1. Check authorized domains in Firebase Console
2. Verify `.env` has correct config
3. Try incognito mode to rule out cookie issues

### Functions not deploying

```bash
# Rebuild functions
cd functions
npm run build

# Check for TypeScript errors
npm run lint

# Deploy with verbose logging
npx firebase deploy --only functions --debug
```
