# Desktop release validation performance

## Current scheduling

Windows extension rendering uses a browser-only job with no Rust toolchain or
cache. Dependencies, npm caching, and Chromium installation run only when the
rendering scenario is selected.

macOS documentation validation shares the arm64 native job, reuses the finalized
production bundle, and builds only the no-tray app. Lightweight registration tests
always run. Regular CI has six jobs.

`scripts/select-platform-checks.mjs` selects both expensive scenarios from complete
push ranges or pull-request merge-base diffs, including renamed/deleted paths.
Manual and release runs select both. The measurements below describe earlier
policies and do not establish current performance.

## Hosted measurements

| Measurement                                          | Source                                                                                                                        | Windows native | macOS native | Other jobs                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------: | -----------: | -------------------------------------- |
| Baseline                                             | [39546319759](https://github.com/tabokie/browser-recall/actions/runs/39546319759)                                             |        23m 36s |      21m 06s | Font and documentation checks included |
| Parallel font check                                  | [39594940379](https://github.com/tabokie/browser-recall/actions/runs/39594940379), `d1f284fe175895e8f3adfa79d692d6f001966cdd` |        14m 17s |      25m 05s | Font: 6m 37s                           |
| Minimal frame package and separate documentation job | [39598601075](https://github.com/tabokie/browser-recall/actions/runs/39598601075), `a33f4aca875abeba4f79e83825432558cdda1626` |        10m 55s |      17m 24s | Font: 5m 04s; documentation: 8m 36s    |

All required jobs passed in both follow-up runs. The longest job fell from
23m 36s to 17m 24s in the second run. Runner/cache variation also changed build
times, so the entire reduction cannot be attributed to scheduling.

The initial font job used a cold Rust cache: Chromium setup took 3m 21s, the debug
daemon build/test 1m 30s, and Rust cache saving 48s. The current browser-only fixture
has since removed that daemon build and cache.

Reordering the macOS frame test alone left its duration unchanged at about 3m 38s.
Moving the same production-code test into `browser-recall-native-tests`, with only
AppKit dependencies, reduced the measured step to 19s. The historical separate
documentation job took 8m 36s, including a 3m 24s production-fixture build and
4m 05s for documentation compilation/scenario. Current scheduling reuses the
production bundle instead.

Record run URL, source commit, cache outcome, and job/phase durations together.
Compare cold and warm runs separately. Build/package/update phases report duration
and outcome in logs and GitHub step summaries; fixture compilation is separate
from installation/relaunch. Subtracting moved steps does not measure elapsed time.

## Link-time optimization comparison

Local exploratory benchmark: Apple M5, 10 CPU cores, 24 GB memory,
`aarch64-apple-darwin`, Rust/Cargo 1.97.0, source
`88eb6701ece9e8914def3a6453988f98c6504806`. Each profile used a separate target
directory, prepared dependencies, then cleaned only the desktop package. One
rebuild per profile ran sequentially without competing builds. `opt-level="z"`
and `CARGO_INCREMENTAL=0` stayed unchanged.

| Link-time optimization | Desktop rebuild | Executable bytes | App archive bytes |
| ---------------------- | --------------: | ---------------: | ----------------: |
| Full (current)         |          67.42s |       21,900,288 |         8,637,113 |
| Thin                   |          37.47s |       33,330,672 |        10,570,493 |

Thin optimization cut this rebuild by 44.4% but increased executable size by 52.2%
and archive size by 22.4%. Keep full optimization: scheduling improvements avoid
that size cost. This comparison does not measure hosted or runtime performance.

Both bundles were packaged, ad-hoc signed, and verified with production helpers;
neither was launched. Archives used ordinary tar/gzip rather than Release's
`--no-mac-metadata`, so byte sizes are comparative.

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
