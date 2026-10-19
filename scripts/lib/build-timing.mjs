import { appendFileSync } from 'node:fs';

function report(name, started, status, environment) {
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const message = `${name}: ${seconds}s (${status})`;
  console.log(message);
  if (environment.GITHUB_STEP_SUMMARY)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `- ${message}\n`);
}

export function timeBuildStep(name, operation, environment = process.env) {
  const started = performance.now();
  let status = 'failed';
  try {
    const result = operation();
    status = 'passed';
    return result;
  } finally {
    report(name, started, status, environment);
  }
}

export async function timeAsyncBuildStep(
  name,
  operation,
  environment = process.env,
) {
  const started = performance.now();
  let status = 'failed';
  try {
    const result = await operation();
    status = 'passed';
    return result;
  } finally {
    report(name, started, status, environment);
  }
}
