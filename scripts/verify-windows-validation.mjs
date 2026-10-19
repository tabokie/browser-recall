import { readFileSync } from 'node:fs';
import path from 'node:path';

const checks = {
  signing: process.env.WINDOWS_SIGNING_RESULT,
  cleanup: process.env.WINDOWS_CLEANUP_RESULT,
  artifacts: process.env.WINDOWS_ARTIFACTS_RESULT,
};
const failures = Object.entries(checks).filter(
  ([, outcome]) => outcome !== 'success',
);
for (const [name, outcome] of failures) {
  const file = path.join('test-results/windows-validation', `${name}.json`);
  console.error(
    `Windows ${name} validation: ${outcome}. See "Verify Windows ${name}" and ${file}.`,
  );
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    for (const suite of report.testResults) {
      for (const assertion of suite.assertionResults) {
        if (assertion.status !== 'failed') continue;
        console.error(assertion.fullName);
        for (const message of assertion.failureMessages) console.error(message);
      }
      if (suite.status === 'failed' && suite.message)
        console.error(suite.message);
    }
  } catch (error) {
    console.error(
      `Cannot read validation details from ${file}: ${error.message}`,
    );
  }
}
if (failures.length) {
  console.error(
    `Windows validation failed: ${failures.map(([name, outcome]) => `${name}: ${outcome}`).join(', ')}`,
  );
  process.exitCode = 1;
}
