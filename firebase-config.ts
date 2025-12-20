import { initializeApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth';
import {
  getFirestore,
  Firestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator
} from 'firebase/firestore';
import { getStorage, FirebaseStorage, connectStorageEmulator } from 'firebase/storage';
import { getFunctions, Functions, connectFunctionsEmulator } from 'firebase/functions';

/**
 * Firebase Configuration
 *
 * Initializes Firebase services for the Audio Transcript Analysis App:
 * - Authentication (Google OAuth)
 * - Firestore (conversation data)
 * - Storage (audio files)
 * - Functions (server-side transcription)
 *
 * Config values are loaded from environment variables (VITE_ prefix for Vite).
 */

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Validate configuration before initializing
const requiredEnvVars = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID'
];

const missingVars = requiredEnvVars.filter(key => !import.meta.env[key]);
if (missingVars.length > 0) {
  console.warn(
    `Missing Firebase environment variables: ${missingVars.join(', ')}\n` +
    `Firebase services will not work until these are configured in .env`
  );
}

// Initialize Firebase App
export const app: FirebaseApp = initializeApp(firebaseConfig);

// Initialize Auth service
export const auth: Auth = getAuth(app);

// Configure Google Auth Provider
export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');

/**
 * Initialize Firestore with offline persistence
 *
 * Using persistentLocalCache for offline support - data is cached in IndexedDB
 * and synced when back online. This gives us the best of both worlds:
 * - Fast reads from local cache
 * - Automatic sync to cloud
 * - Works offline
 */
export const db: Firestore = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

/**
 * Initialize Firebase Storage
 * Used for storing audio files (too large for Firestore's 1MB doc limit)
 */
export const storage: FirebaseStorage = getStorage(app);

/**
 * Initialize Cloud Functions
 * Used for server-side Gemini API calls (keeps API key secure)
 */
export const functions: Functions = getFunctions(app);

// Connect to emulators in development
// Set VITE_USE_FIREBASE_EMULATORS=true in .env or run with npm run dev:full
if (import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  console.log('[Firebase] Connecting to local emulators...');
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8081);
  connectStorageEmulator(storage, 'localhost', 9199);
  connectFunctionsEmulator(functions, 'localhost', 5001);
  console.log('[Firebase] ✅ Connected to emulators (Auth:9099, Firestore:8081, Storage:9199, Functions:5001)');
}
