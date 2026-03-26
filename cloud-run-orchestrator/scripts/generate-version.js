#!/usr/bin/env node
/**
 * Generate version.ts with git info at build time.
 * Mirrors functions/scripts/generate-version.js for the orchestrator service.
 *
 * This is a BUILD SCRIPT with hardcoded git commands — no user input.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getGitInfo() {
  try {
    let version;
    try {
      // execSync with hardcoded commands is safe — no user input
      version = execSync('git describe --tags --exact-match 2>/dev/null', { encoding: 'utf8' }).trim();
    } catch {
      version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    }

    const isCI = process.env.CI === 'true';
    let isDirty = false;

    if (!isCI) {
      const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
      isDirty = status.length > 0;
      if (isDirty) {
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
        version = `${version}-dirty-${timestamp}`;
      }
    }

    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return { version, branch, isDirty };
  } catch (error) {
    console.warn('Could not get git info:', error.message);
    return { version: 'unknown', branch: 'unknown', isDirty: false };
  }
}

const { version, branch, isDirty } = getGitInfo();

const content = `// Auto-generated at build time - do not edit manually
// Generated: ${new Date().toISOString()}

export const BUILD_VERSION = '${version}';
export const BUILD_BRANCH = '${branch}';
export const BUILD_TIMESTAMP = '${new Date().toISOString()}';
export const IS_DIRTY_BUILD = ${isDirty};
`;

const outputPath = path.join(__dirname, '..', 'src', 'version.ts');
fs.writeFileSync(outputPath, content);

console.log(`[generate-version] Generated version.ts: ${version} (branch: ${branch}${isDirty ? ', DIRTY' : ''})`);
