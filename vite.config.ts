import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

// Git info for build metadata
// Priority: git commands (local dev) > env vars (CI/Docker) > fallback
// Note: execSync is safe here - hardcoded commands, no user input, build-time only
function getGitInfo(env: Record<string, string>) {
    try {
        // Version from release tags (v2.0.3)
        const version = execSync('git describe --tags --abbrev=0 --match "v*" 2>/dev/null', { encoding: 'utf-8' }).trim();
        // Build number from build/N tags (monotonically increasing)
        const buildNum = execSync('git tag -l "build/*" | sed "s|build/||" | sort -n | tail -1', { encoding: 'utf-8' }).trim() || '0';
        return { version, buildNum };
    } catch {
        // Fallback to env vars (set by Dockerfile from GitHub Actions)
        return {
            version: env.APP_VERSION || 'dev',
            buildNum: env.BUILD_NUM || '0'
        };
    }
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const gitInfo = getGitInfo(env);

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.ALIGNMENT_SERVICE_URL': JSON.stringify(env.ALIGNMENT_SERVICE_URL || ''),
        // Build metadata for deployment tracking
        '__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
        '__APP_VERSION__': JSON.stringify(gitInfo.version),
        '__BUILD_NUM__': JSON.stringify(gitInfo.buildNum),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
