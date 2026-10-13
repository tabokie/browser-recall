export async function withCleanup(run, cleanups) {
  const errors = [];
  try {
    await run();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Desktop smoke or teardown failed', {
      cause: errors[0],
    });
  }
}
