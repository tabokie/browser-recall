# Save Page WE — Upstream Source

## Provenance
- **Extension**: Save Page WE v33.9
- **Author**: DW-dev
- **License**: GNU General Public License v2
- **Chrome Web Store**: https://chromewebstore.google.com/detail/save-page-we/dhhpefjklgkmgeafimnjhojgjamoafof
- **Source mirror**: https://github.com/nicholasdwebb/nicholasdwebb.github.io (may be stale)

## How to get latest source
The authoritative source is the Chrome Web Store .crx file:
1. Get extension ID from store page: `dhhpefjklgkmgeafimnjhojgjamoafof`
2. Download .crx:
   curl -L "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0&acceptformat=crx2,crx3&x=id%3Ddhhpefjklgkmgeafimnjhojgjamoafof%26uc" -o save-page-we.crx
3. Extract (CRX3 = 12-byte header + protobuf header + zip):
   python3 -c "
   with open('save-page-we.crx','rb') as f:
     f.read(4); f.read(4); hl=int.from_bytes(f.read(4),'little'); f.seek(12+hl)
     open('save-page-we.zip','wb').write(f.read())
   "
   unzip save-page-we.zip -d save-page-we-src/
4. Diff against `apps/extension/savepage/` to see our modifications.

## Our modifications (vs upstream)
- Initialization: hardcoded options instead of chrome.storage.local
- Output: sends HTML via chrome.runtime.sendMessage instead of downloading
- UI panels: all stripped (message, lazyload, comments, pageinfo, unsaved, download-iframe)
- Firefox code paths: kept intact (guarded by `isFirefox` flag — zero runtime cost on Chrome, preserves future Firefox portability)
- content-fontface.js: updated chrome.runtime.getURL path for savepage/ subdirectory
