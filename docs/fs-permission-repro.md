# File System Access Permission Repro in Brave

## Summary

On Brave, the extension can lose effective file access after a fresh install even when the user has already picked a real directory and granted access through the native directory picker.

The failure is reproducible with a real browser profile, a real directory on disk, and the normal onboarding flow. It is not limited to OPFS or test-only storage.

The characteristic failure is:

- the extension finishes onboarding successfully
- the storage directory appears configured
- the extension can usually read some files during initialization
- later, ordinary file operations from the extension start failing with a browser error similar to:

  `Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': The request is not allowed by the user agent or the platform in the current context.`

or:

  `Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': The request is not allowed by the user agent or the platform in the current context.`

- the extension then enters its `fs_permission` downtime state

This can happen immediately after onboarding, before any long idle period.

## Environment

The issue was reproduced on:

- macOS
- Brave Browser
- MV3 extension build
- real directory chosen through the browser's native directory picker
- sync not configured

Important Brave detail:

- Brave may require `brave://flags/#file-system-access-api` to be enabled before the picker works correctly.
- The browser may show a native "allow this site to edit files" prompt after the directory picker. The repro is only valid if that prompt is accepted.

## Real-World Reproduction Flow

These steps describe the issue in words so another person can reproduce it manually without using the test harness.

1. Start from a fresh Brave profile.
2. Install the extension.
3. Open the extension's onboarding / options page.
4. Use the normal "select directory" flow.
5. In the native macOS directory picker, choose a real directory on disk.
   Examples used during investigation:
   - `/tmp/browser-recall-real-fs-data`
   - `~/browser-data`
6. If Brave shows a native approval prompt asking whether the site / extension may edit files, click the allow button.
7. Finish onboarding by entering the main extension UI.
8. Keep at least one normal web page open so the browser window does not close when extension pages are closed.
9. Close the options page.
10. Let the extension process normal page activity.
    Useful examples:
    - open real web pages such as `https://example.com/`, `https://example.org/`, or a normal Wikipedia page
    - open the popup
    - open the history / main page and verify that visits are recorded
11. Observe that file access may fail after onboarding and subsequent page activity.

A faithful manual run should avoid special helper pages unless the goal is a separate diagnostic experiment. During the repro, the extension should behave like a user session:

1. one ordinary web page remains open at all times so Brave does not exit when extension pages close
2. the options / main page is closed for part of the run
3. normal web pages are opened to generate visits
4. the popup may be opened on those pages to exercise normal extension behavior
5. the history / main page is opened later to verify that visits were recorded or to observe the permission failure

## Observed Failure Shape

In the confirmed repro runs, the failure did **not** always wait for a long idle period.

A common failing sequence was:

1. onboarding succeeds
2. initialization succeeds
3. early reads such as device identity and settings may succeed
4. the first later page-related filesystem read fails
5. the extension pauses itself with `fs_permission`

In traced runs, the first failing operation after onboarding was often a normal page-file read, not the initial directory selection itself.

## Important Symptoms

When the issue happens, the user-visible behavior is roughly:

- the main page or popup reports that storage access was revoked
- the service pauses
- the options page shows the re-grant / recovery UI
- history stops loading normally because the extension has entered the filesystem-permission downtime state

The low-level browser errors observed during investigation were of the form:

- `getFileHandle(...) ... not allowed by the user agent or the platform in the current context`
- `getDirectoryHandle(...) ... not allowed by the user agent or the platform in the current context`

## What Was Ruled Out

### 1. Not an OPFS-only test artifact

The issue was reproduced using a real directory on disk, selected through the real Brave directory picker.

### 2. Not just a stale UI report

There was a product bug where the extension could continue reporting permission as granted after a real file access failure. That bug was identified during investigation.

After correcting that behavior in an experimental working tree:

- the underlying Brave failure still reproduces
- but the extension now reports the permission state more accurately after the failure

So the browser-side failure is real; only the extension's diagnosis improved.

### 3. Not fixed by avoiding cached child handles

One theory was that cached subdirectory or file handles had gone stale.

We tested a variant that stopped reusing cached child handles and reacquired them from the root handle each time.

Result:

- the failure still reproduced
- the failing call shifted from `getFileHandle(...)` in some runs to `getDirectoryHandle(...)` in others

Conclusion:

- stale cached child handles are not the main cause

### 4. Probably not solved by merely keeping a root handle reference alive

The extension already keeps a root directory handle reference in memory while the offscreen document is alive.

The failure still occurs even when that root handle exists.

Conclusion:

- simply "holding on to the handle" is not enough

## Offscreen-Specific Suspicion

The investigation strongly suggests that Brave may be denying File System Access operations specifically in the offscreen extension context, or in some extension document contexts after lifecycle changes.

Why this is suspected:

- real directory selection succeeds
- early reads succeed
- later ordinary reads fail inside extension-controlled filesystem code
- reacquiring child handles does not solve it

This makes the problem look more like a browser / platform limitation or Brave-specific behavior than a simple bug in the extension's in-memory handle caching.

## Why This Matters

Even if another extension page stays alive longer than offscreen, that is not an acceptable product workaround by itself:

- users cannot be asked to keep an extension page open
- MV3 does not provide the old persistent hidden background page
- the official hidden document-style background context is offscreen, which is one of the suspected failing contexts

So even if a visible extension page behaves differently, that would only be diagnostic evidence, not a solid product fix.

## Test Harness Notes

The committed repro harness automates the same flow with a real Brave profile and a real directory. The harness exists to make the issue repeatable, but the manual flow above is the source of truth for what the test is trying to model.

Important constraints learned during the investigation:

- Do not use a tight retry loop around GUI operations. It can freeze the macOS desktop and it can also mask which state transition actually failed.
- After each picker or prompt operation, inspect the browser / accessibility state before doing the next operation.
- Do not continue blindly if the directory was not selected correctly. A run that picks `/` or never enters the requested path is invalid.
- Do not keep a custom test-helper extension page open during the main repro. It may change extension-document lifecycle behavior and turn the run into a different experiment.
- If automation fails before the native allow prompt is accepted, the run is invalid. The expected prompt labels may be localized, for example Chinese Brave may show `允许`.

## Current Conclusion

The issue is reproducible in a real Brave setup with real directory permission.

The investigation supports this conclusion:

- the extension had a secondary bug in how it cached permission state
- that bug was real and was identified during investigation
- correcting that behavior in an experimental working tree did not remove the underlying Brave file-access failure
- the remaining failure looks consistent with a browser-context limitation or Brave-specific instability around File System Access in extension-managed contexts

## Practical Reproduction Checklist

For another engineer trying to reproduce manually:

1. Use Brave on macOS.
2. Ensure File System Access is enabled in Brave if the picker is blocked.
3. Start from a fresh profile.
4. Install the extension.
5. Pick a real directory on disk through onboarding.
6. Accept the native allow prompt.
7. Enter the main extension UI.
8. Close the options page but keep at least one ordinary tab open.
9. Drive normal activity:
   - open pages
   - open popup
   - check history
10. Watch for the extension to enter the `fs_permission` error state.

## Suggested Next Direction

If the product must be reliable across devices and browser setups, do not assume the current offscreen File System Access architecture is sufficient.

The evidence from this investigation supports evaluating an architectural split where persistent file access is handled outside the extension's current offscreen-based path.
