# Desktop Release Validation performance investigation

Hosted baseline: [successful run 39546319759](https://github.com/tabokie/browser-recall/actions/runs/39546319759).

| Job or step | Duration |
| --- | ---: |
| Windows native validation | 23m 36s |
| Windows release build and signature verification | 12m 11s |
| Windows native update/relaunch fixture and scenario | 4m 01s |
| Windows Chromium installation | 3m 26s |
| Windows font regression including debug daemon build | 1m 30s |
| macOS native validation | 21m 06s |
| macOS release build and signature verification | 8m 21s |
| macOS native update/relaunch fixture and scenario | 4m 11s |
| macOS window frame check | 3m 37s |
| macOS documentation URL routing | 3m 50s |

## Implemented scheduling changes

- Windows font validation runs independently in the reusable workflow. Chromium installation and font regression previously added 4m 56s to the Windows native job. The new job has a separate debug Rust cache and failure artifact.
- The macOS window frame check runs before release compilation in a minimal native
  test package. The native test imports the production frame module and declares
  only its AppKit dependencies, avoiding the Tauri application's dependency graph.
- Every check remains present. Release publication still depends on the complete reusable workflow, including Windows font validation.
- macOS documentation URL routing runs independently. The documentation job builds
  and registers a real production bundle, then requires documentation registration
  and activation to preserve the production handler. Building that fixture adds
  runner work but keeps the same native operating-system coverage.

Extra runner setup, cache state, and queueing can affect elapsed time. The parallel
font and documentation checks add two runner jobs.

## Hosted verification

[Pull request #5](https://github.com/tabokie/browser-recall/pull/5) runs the updated
workflow at commit `d1f284fe175895e8f3adfa79d692d6f001966cdd` in
[validation run 39594940379](https://github.com/tabokie/browser-recall/actions/runs/39594940379).
All six jobs passed. The initial scheduling changes produced these job durations:

| Required job | Baseline | Initial parallel-font run |
| --- | ---: | ---: |
| Windows native validation | 23m 36s | 14m 17s |
| macOS native validation | 21m 06s | 25m 05s |
| Windows font validation | Included in Windows native job | 6m 37s |

The macOS job became the longest required job, so the first scheduling change did
not improve the overall elapsed time. Runner/cache variability also changed build
durations; the Windows duration difference cannot all be attributed to parallelism.
The independent Windows font job passed in **6m 37s**, including **3m 21s** for
Chromium setup, **1m 30s** for the debug daemon build and font test, and **48s** for
Rust cache saving. The dedicated Rust cache did not exist before the job and was
created under `refs/pull/5/merge` at `2026-10-21T11:57:01Z`; the job therefore
exercised a cold cache and stayed within its 15-minute deadline. The font job
finished while both native package jobs were still building.

The initial frame-check reorder did not improve its hosted duration: **3m 38s**
versus **3m 37s** in the baseline. The frame regression still belonged to the Tauri
desktop package, despite importing only the production AppKit frame module. The
follow-up change moves the same regression into `browser-recall-native-tests`,
with explicit AppKit dependencies and no Tauri or daemon dependency. The native
test still exercises five restorations of an invisible window with an inset
content view. The follow-up hosted run must measure this package isolation.

Compare a later cache hit separately. Record the run URL, source commit, cache
result, and job durations together; subtracting the moved steps from the baseline
does not measure the new workflow's elapsed time.

Release builds write each build and packaging phase's duration and success or
failure to both the job log and GitHub's step summary. The release phases distinguish
app signature verification, disk image creation, update archive creation or
installer staging, package signing, and Cargo signature verification. Native update
validation separately reports fixture compilation and installation/relaunch.

The macOS documentation URL routing scenario took **4m 12s** in the initial run.
The follow-up moves the scenario into its own required job. The new job measures
production-fixture compilation separately from the documentation build and native
scenario. Its complete duration, including runner setup and the production fixture,
must be compared with the native jobs; moving 4m 12s does not alone establish the
new elapsed time.

## Link-time optimization benchmark

Machine: Apple M5, 10 CPU cores, 24 GB memory; native aarch64-apple-darwin; Rust/Cargo 1.97.0. Source commit: 88eb6701ece9e8914def3a6453988f98c6504806, with only workflow/documentation changes. Each profile used its own temporary target directory. Dependencies were prepared first, then only browser-recall-desktop release artifacts were cleaned. One desktop-package rebuild per profile was timed sequentially, with no competing test/build execution during either timed interval. This is a local exploratory measurement, not a hosted-run or runtime-performance benchmark.

Command: `cargo build --offline --locked --release -p browser-recall-desktop --bin browser-recall-desktop --features tauri/custom-protocol`, with `CARGO_INCREMENTAL=0`, a dedicated `CARGO_TARGET_DIR`, and `CARGO_PROFILE_RELEASE_LTO=fat` or `thin`. `opt-level="z"` stayed unchanged.

| Link-time optimization | Desktop rebuild | Executable bytes | Signed app archive bytes |
| --- | ---: | ---: | ---: |
| Full (current) | 67.42s | 21,900,288 | 8,637,113 |
| Thin | 37.47s | 33,330,672 | 10,570,493 |

Thin link-time optimization reduced this local rebuild by 44.4%, increased the executable by 52.2%, and increased the compressed app archive by 22.4%. Keep the current full link-time optimization setting: the scheduling improvements avoid this release-size cost.

Both app bundles were packaged using the Tauri CLI, finalized with the production
ad-hoc signing helper, verified with the production bundle verifier, and compressed
using tar/gzip. Neither app bundle was launched. The archive measurements used
ordinary tar/gzip; published releases additionally use `--no-mac-metadata`, so the
measured archives are a comparison rather than byte-identical release packages.

### Reproduce the local comparison

Run on macOS with the repository's pinned Rust toolchain, installed npm dependencies,
and Cargo dependencies already downloaded. Each profile prepares its own dependency
cache before the timed desktop rebuild. Run the profiles sequentially without
competing builds. The commands create and sign bundles but do not launch either app.
Use a disposable output directory and keep the directory until measurements have
been recorded.

```bash
npm run build:desktop-ui
benchmark_root=$(mktemp -d)
for lto in fat thin; do
  (
    set -e
    export CARGO_TARGET_DIR="$benchmark_root/$lto"
    export CARGO_PROFILE_RELEASE_LTO="$lto"
    export CARGO_INCREMENTAL=0
    cargo build --offline --locked --release -p browser-recall-desktop \
      --bin browser-recall-desktop --features tauri/custom-protocol
    cargo clean --release -p browser-recall-desktop
    /usr/bin/time -p cargo build --offline --locked --release \
      -p browser-recall-desktop --bin browser-recall-desktop \
      --features tauri/custom-protocol
    stat -f '%z' "$CARGO_TARGET_DIR/release/browser-recall-desktop"
    (cd apps/desktop && node ../../node_modules/@tauri-apps/cli/tauri.js \
      bundle --ci --bundles app --no-sign)
    app="$CARGO_TARGET_DIR/release/bundle/macos/Browser Recall.app"
    APPLE_SIGNING_IDENTITY=- node scripts/finalize-macos-app-bundle.mjs "$app"
    node scripts/verify-macos-app-bundle.mjs "$app"
    tar -czf "$benchmark_root/$lto.app.tar.gz" \
      -C "$CARGO_TARGET_DIR/release/bundle/macos" 'Browser Recall.app'
    stat -f '%z' "$benchmark_root/$lto.app.tar.gz"
  ) || exit 1
done
```
