export function lifecycleWindowFrame(workArea, minimumSize) {
  if (
    workArea.width < minimumSize.width ||
    workArea.height < minimumSize.height
  ) {
    throw new Error(
      `The usable display area cannot fit the desktop minimum size: ${JSON.stringify({ workArea, minimumSize })}`,
    );
  }
  const width = Math.min(Math.max(980, minimumSize.width), workArea.width);
  const height = Math.min(Math.max(680, minimumSize.height), workArea.height);
  return {
    x: Math.max(workArea.x, Math.min(170, workArea.x + workArea.width - width)),
    y: Math.max(
      workArea.y,
      Math.min(160, workArea.y + workArea.height - height),
    ),
    width,
    height,
  };
}
