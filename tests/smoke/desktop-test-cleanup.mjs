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

export async function stopNativeUpdateProcesses({
  pid,
  child,
  findPid,
  stopPid,
}) {
  const pids = new Set();
  // The original child remains available if readiness fails before PID lookup.
  // After an update, rediscover the executable because the last PID can be stale.
  if (child?.pid && child.exitCode === null && child.signalCode === null)
    pids.add(child.pid);
  if (pid && pid !== child?.pid) pids.add(pid);
  await withCleanup(async () => {
    const current = await findPid();
    if (current) pids.add(current);
  }, [
    () =>
      withCleanup(
        async () => {},
        [...pids].map((target) => () => stopPid(target)),
      ),
  ]);
}
