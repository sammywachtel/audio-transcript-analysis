#!/usr/bin/env node
/**
 * Generate version.ts with git info at build time.
 *
 * This is a BUILD SCRIPT with hardcoded git commands - no user input.
 *
 * Output format:
 * - Clean deploy from tag: "v1.5.0"
 * - Clean deploy from commit: "abc1234"
 * - Dirty deploy (uncommitted changes): "abc1234-dirty-20240112T153045"
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getGitInfo() {
  try {
    // Get the current tag if HEAD is tagged, otherwise get short commit hash
    let version;
    try {
      // execSync with hardcoded commands is safe - no user input
      version = execSync('git describe --tags --exact-match 2>/dev/null', { encoding: 'utf8' }).trim();
    } catch {
      // No tag on current commit, use short hash
      version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    }

    // Check for uncommitted changes
    const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    const isDirty = status.length > 0;

    if (isDirty) {
      // Add dirty marker with timestamp for manual deploys
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
      version = `${version}-dirty-${timestamp}`;
    }

    // Get branch name for context
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
