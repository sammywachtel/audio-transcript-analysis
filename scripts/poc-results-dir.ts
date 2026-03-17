import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_ITERATION = 'iteration_01';

function parseCurrentIterationConf(confPath: string): { scope?: string; iteration?: string } {
  if (!fs.existsSync(confPath)) {
    return {};
  }

  const lines = fs.readFileSync(confPath, 'utf-8').split('\n');
  const values: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) values[key] = value;
  }

  return {
    scope: values.SCOPE,
    iteration: values.ITERATION,
  };
}

function isValidIteration(value?: string): value is string {
  return Boolean(value && /^iteration_\d+(?:_[a-z])?$/.test(value));
}

export function resolvePocResultsDir(
  projectRoot: string,
  scope: string,
  cliIteration?: string
): { iteration: string; resultsDir: string } {
  if (isValidIteration(cliIteration)) {
    return {
      iteration: cliIteration,
      resultsDir: path.join(projectRoot, '.agent_process', 'work', scope, cliIteration, 'results'),
    };
  }

  const envIteration = process.env.AP_ITERATION || process.env.ITERATION;
  if (isValidIteration(envIteration)) {
    return {
      iteration: envIteration,
      resultsDir: path.join(projectRoot, '.agent_process', 'work', scope, envIteration, 'results'),
    };
  }

  const confPath = path.join(projectRoot, '.agent_process', 'work', 'current_iteration.conf');
  const { scope: confScope, iteration: confIteration } = parseCurrentIterationConf(confPath);
  if (confScope === scope && isValidIteration(confIteration)) {
    return {
      iteration: confIteration,
      resultsDir: path.join(projectRoot, '.agent_process', 'work', scope, confIteration, 'results'),
    };
  }

  return {
    iteration: DEFAULT_ITERATION,
    resultsDir: path.join(projectRoot, '.agent_process', 'work', scope, DEFAULT_ITERATION, 'results'),
  };
}
