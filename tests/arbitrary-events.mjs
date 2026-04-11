// arbitrary-events.mjs — fast-check arbitraries for all replay action types.
// Shared by both Vitest property tests and E2E generative tests.

import fc from 'fast-check';
import { generateSlugFromUrl, generateNoteSlug } from '../extension/utils.js';

const URL_POOL = Array.from({ length: 8 }, (_, i) => `https://example.com/page-${i}`);
const LIST_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const DEVICES = ['device-a', 'device-b'];
const SETTING_KEYS = ['theme', 'workspace', 'urlBlacklist'];

const arbUrl = fc.constantFrom(...URL_POOL);
const arbDevice = fc.constantFrom(...DEVICES);
const arbListName = fc.constantFrom(...LIST_NAMES);
const arbSettingKey = fc.constantFrom(...SETTING_KEYS);

function noteSlugForUrl(url, ts) {
  return generateNoteSlug(ts, url.slice(0, 20));
}

function snapshotStemForUrl(url, ts) {
  return `${generateSlugFromUrl(url)}-${ts}`;
}

// Each entry generator returns { entry, deviceId } so we can track per-device context.
// Timestamps are assigned externally to ensure monotonicity within a device.

function arbVisitPage(ts) {
  return fc.record({
    url: arbUrl,
    title: fc.constantFrom('Page A', 'Page B', 'Page C', 'Page D', 'Untitled'),
    referrerUrl: fc.option(arbUrl, { nil: undefined }),
    deviceId: arbDevice,
    checkpoint: fc.boolean(),
  }).map(({ url, title, referrerUrl, deviceId, checkpoint }) => ({
    entry: {
      timestamp: ts,
      action: 'visit_page',
      url,
      title,
      ...(referrerUrl && referrerUrl !== url ? { referrerUrl } : {}),
      ...(checkpoint ? { checkpoint: true } : {}),
    },
    deviceId,
  }));
}

function arbLeavePage(ts) {
  return fc.record({
    url: arbUrl,
    title: fc.constantFrom('Page A', 'Page B', undefined),
    scrollDepth: fc.integer({ min: 0, max: 100 }),
    timeOnPage: fc.integer({ min: 100, max: 30000 }),
    deviceId: arbDevice,
  }).map(({ url, title, scrollDepth, timeOnPage, deviceId }) => ({
    entry: {
      timestamp: ts,
      action: 'leave_page',
      url,
      ...(title ? { title } : {}),
      scrollDepth,
      timeOnPage,
    },
    deviceId,
  }));
}

function arbRenamePage(ts) {
  return fc.record({
    url: arbUrl,
    user_title: fc.constantFrom('My Custom Title', 'Renamed', 'Important Page'),
    deviceId: arbDevice,
  }).map(({ url, user_title, deviceId }) => ({
    entry: { timestamp: ts, action: 'rename_page', url, user_title },
    deviceId,
  }));
}

function arbRatePage(ts) {
  return fc.record({
    url: arbUrl,
    likes: fc.constantFrom(1, -1),
    deviceId: arbDevice,
  }).map(({ url, likes, deviceId }) => ({
    entry: { timestamp: ts, action: 'rate_page', url, likes },
    deviceId,
  }));
}

function arbCreateSnapshot(ts) {
  return fc.record({
    url: arbUrl,
    title: fc.constantFrom('Snapshot Title', undefined),
    deviceId: arbDevice,
  }).map(({ url, title, deviceId }) => ({
    entry: {
      timestamp: ts,
      action: 'create_snapshot',
      url,
      path: `snapshots/${snapshotStemForUrl(url, ts)}`,
      ...(title ? { title } : {}),
    },
    deviceId,
  }));
}

function arbDeleteSnapshot(ts, createdSnapshots) {
  if (createdSnapshots.length === 0) return null;
  return fc.constantFrom(...createdSnapshots).chain(snap =>
    arbDevice.map(deviceId => ({
      entry: {
        timestamp: ts,
        action: 'delete_snapshot',
        url: snap.url,
        path: snap.path,
      },
      deviceId,
    }))
  );
}

function arbRestoreSnapshot(ts, deletedSnapshots) {
  if (deletedSnapshots.length === 0) return null;
  return fc.constantFrom(...deletedSnapshots).chain(snap =>
    arbDevice.map(deviceId => ({
      entry: {
        timestamp: ts,
        action: 'restore_snapshot',
        url: snap.url,
        path: snap.path,
      },
      deviceId,
    }))
  );
}

function arbCreateNote(ts) {
  return fc.record({
    url: arbUrl,
    title: fc.constantFrom('Note Page', undefined),
    deviceId: arbDevice,
  }).map(({ url, title, deviceId }) => {
    const noteSlug = noteSlugForUrl(url, ts);
    return {
      entry: {
        timestamp: ts,
        action: 'create_note',
        url,
        path: `notes/${noteSlug}.json`,
        ...(title ? { title } : {}),
      },
      deviceId,
      noteSlug,
      noteUrl: url,
    };
  });
}

function arbDeleteNote(ts, createdNotes) {
  if (createdNotes.length === 0) return null;
  return fc.constantFrom(...createdNotes).chain(note =>
    arbDevice.map(deviceId => ({
      entry: {
        timestamp: ts,
        action: 'delete_note',
        url: note.url,
        path: `notes/${note.slug}.json`,
      },
      deviceId,
    }))
  );
}

function arbRestoreNote(ts, deletedNotes) {
  if (deletedNotes.length === 0) return null;
  return fc.constantFrom(...deletedNotes).chain(note =>
    arbDevice.map(deviceId => ({
      entry: {
        timestamp: ts,
        action: 'restore_note',
        url: note.url,
        path: `notes/${note.slug}.json`,
      },
      deviceId,
    }))
  );
}

function arbReplaceNote(ts, createdNotes) {
  if (createdNotes.length === 0) return null;
  return fc.constantFrom(...createdNotes).chain(note =>
    arbDevice.map(deviceId => {
      const newSlug = noteSlugForUrl(note.url, ts);
      return {
        entry: {
          timestamp: ts,
          action: 'replace_note',
          url: note.url,
          oldPath: `notes/${note.slug}.json`,
          path: `notes/${newSlug}.json`,
        },
        deviceId,
        newNoteSlug: newSlug,
        noteUrl: note.url,
      };
    })
  );
}

function arbCreateList(ts) {
  return fc.record({
    name: arbListName,
    deviceId: arbDevice,
  }).map(({ name, deviceId }) => ({
    entry: {
      timestamp: ts,
      action: 'create_list',
      name,
      listOwner: deviceId,
    },
    deviceId,
  }));
}

function arbDeleteList(ts, createdLists) {
  if (createdLists.length === 0) return null;
  return fc.constantFrom(...createdLists).chain(list =>
    fc.constant({
      entry: {
        timestamp: ts,
        action: 'delete_list',
        name: list.name,
        listOwner: list.owner,
      },
      deviceId: list.owner,
    })
  );
}

function arbRestoreList(ts, deletedLists) {
  if (deletedLists.length === 0) return null;
  return fc.constantFrom(...deletedLists).chain(list =>
    fc.constant({
      entry: {
        timestamp: ts,
        action: 'restore_list',
        name: list.name,
        listOwner: list.owner,
      },
      deviceId: list.owner,
    })
  );
}

function arbPinToList(ts, createdLists) {
  if (createdLists.length === 0) return null;
  return fc.constantFrom(...createdLists).chain(list =>
    arbUrl.chain(url =>
      fc.constant({
        entry: {
          timestamp: ts,
          action: 'pin_to_list',
          name: list.name,
          listOwner: list.owner,
          items: [url],
        },
        deviceId: list.owner,
      })
    )
  );
}

function arbUnpinFromList(ts, createdLists) {
  if (createdLists.length === 0) return null;
  return fc.constantFrom(...createdLists).chain(list =>
    arbUrl.chain(url =>
      fc.constant({
        entry: {
          timestamp: ts,
          action: 'unpin_from_list',
          name: list.name,
          listOwner: list.owner,
          items: [url],
        },
        deviceId: list.owner,
      })
    )
  );
}

function arbAddRule(ts, createdLists) {
  if (createdLists.length === 0) return null;
  return fc.constantFrom(...createdLists).chain(list =>
    fc.constantFrom('test', 'example', 'page').chain(pattern =>
      fc.constant({
        entry: {
          timestamp: ts,
          action: 'add_rule',
          name: list.name,
          listOwner: list.owner,
          rule: { type: 'keyword', config: { pattern, fields: ['title'] } },
        },
        deviceId: list.owner,
      })
    )
  );
}

function arbRemoveRule(ts, ruleIds) {
  if (ruleIds.length === 0) return null;
  return fc.constantFrom(...ruleIds).chain(({ ruleId, listName, listOwner }) =>
    fc.constant({
      entry: {
        timestamp: ts,
        action: 'remove_rule',
        name: listName,
        listOwner,
        ruleId,
      },
      deviceId: listOwner,
    })
  );
}

function arbUpdateRule(ts, ruleIds) {
  if (ruleIds.length === 0) return null;
  return fc.constantFrom(...ruleIds).chain(({ ruleId, listName, listOwner }) =>
    fc.constantFrom('updated', 'changed', 'new-pattern').chain(pattern =>
      fc.constant({
        entry: {
          timestamp: ts,
          action: 'update_rule',
          name: listName,
          listOwner,
          ruleId,
          config: { pattern },
        },
        deviceId: listOwner,
      })
    )
  );
}

function arbUpdateSetting(ts) {
  return fc.record({
    key: arbSettingKey,
    deviceId: arbDevice,
  }).chain(({ key, deviceId }) =>
    fc.constantFrom('dark', 'light', 'default', true, false).map(value => ({
      entry: { timestamp: ts, action: 'update_setting', key, value },
      deviceId,
    }))
  );
}

// ---------------------------------------------------------------------------
// Stateful event sequence generator
// ---------------------------------------------------------------------------

/**
 * Generate a sequence of N random events that are internally consistent:
 * delete/restore/replace/unpin only reference previously created entities.
 *
 * Returns fc.Arbitrary<Array<{ entry, deviceId }>>
 */
export function arbEventSequence(minLen = 5, maxLen = 25) {
  return fc.integer({ min: minLen, max: maxLen }).chain(n => {
    return fc.tuple(
      fc.array(fc.integer({ min: 0, max: 99 }), { minLength: n, maxLength: n }),
      fc.array(fc.integer({ min: 0, max: 999 }), { minLength: n, maxLength: n }),
    ).chain(([actionSlots, seeds]) => {

      const createdNotes = [];
      const deletedNotes = [];
      const createdSnapshots = [];
      const deletedSnapshots = [];
      const createdLists = [];
      const deletedLists = [];
      const ruleIds = [];
      // NOTE: createdListKeys cannot prevent duplicates at generation time because
      // fc.tuple evaluates all arbitraries after this loop. Dedup in post-processing.

      const arbitraries = [];
      let baseTs = 1000;

      for (let i = 0; i < n; i++) {
        const ts = baseTs + i * 10;
        const w = actionSlots[i];
        const seed = seeds[i];
        let arb = null;

        // Uniform integer [0,99] for even distribution across action categories.
        if (w < 12) {
          arb = arbVisitPage(ts);
        } else if (w < 20) {
          arb = arbLeavePage(ts);
        } else if (w < 25) {
          arb = arbRenamePage(ts);
        } else if (w < 30) {
          arb = arbRatePage(ts);
        } else if (w < 35) {
          arb = arbUpdateSetting(ts);
        } else if (w < 43) {
          arb = arbCreateNote(ts);
        } else if (w < 48) {
          arb = arbDeleteNote(ts, [...createdNotes]) || arbCreateNote(ts);
        } else if (w < 52) {
          arb = arbRestoreNote(ts, [...deletedNotes]) || arbCreateNote(ts);
        } else if (w < 56) {
          arb = arbReplaceNote(ts, [...createdNotes]) || arbCreateNote(ts);
        } else if (w < 63) {
          arb = arbCreateSnapshot(ts);
        } else if (w < 67) {
          arb = arbDeleteSnapshot(ts, [...createdSnapshots]) || arbCreateSnapshot(ts);
        } else if (w < 70) {
          arb = arbRestoreSnapshot(ts, [...deletedSnapshots]) || arbCreateSnapshot(ts);
        } else if (w < 78) {
          arb = arbCreateList(ts);
        } else if (w < 82) {
          arb = arbDeleteList(ts, [...createdLists]) || arbCreateList(ts);
        } else if (w < 85) {
          arb = arbRestoreList(ts, [...deletedLists]) || arbCreateList(ts);
        } else if (w < 90) {
          arb = arbPinToList(ts, [...createdLists]) || arbCreateList(ts);
        } else if (w < 93) {
          arb = arbUnpinFromList(ts, [...createdLists]) || arbCreateList(ts);
        } else if (w < 96) {
          arb = arbAddRule(ts, [...createdLists]) || arbCreateList(ts);
        } else if (w < 98) {
          arb = arbRemoveRule(ts, [...ruleIds]) || arbUpdateSetting(ts);
        } else {
          arb = arbUpdateRule(ts, [...ruleIds]) || arbUpdateSetting(ts);
        }

        // We track state imperatively for prerequisite resolution.
        // This means the *structure* of the sequence depends on the generated weights,
        // but each individual entry is still random within its type.
        // We update tracking when the arbitrary is resolved via map.
        arb = arb.map(result => {
          const { entry } = result;
          switch (entry.action) {
            case 'create_note':
              createdNotes.push({ slug: result.noteSlug, url: result.noteUrl });
              break;
            case 'delete_note': {
              const path = entry.path;
              const slug = path.slice('notes/'.length, -'.json'.length);
              const idx = createdNotes.findIndex(n => n.slug === slug);
              if (idx >= 0) {
                deletedNotes.push(createdNotes[idx]);
                createdNotes.splice(idx, 1);
              }
              break;
            }
            case 'restore_note': {
              const path = entry.path;
              const slug = path.slice('notes/'.length, -'.json'.length);
              const idx = deletedNotes.findIndex(n => n.slug === slug);
              if (idx >= 0) {
                createdNotes.push(deletedNotes[idx]);
                deletedNotes.splice(idx, 1);
              }
              break;
            }
            case 'replace_note': {
              const oldSlug = entry.oldPath.slice('notes/'.length, -'.json'.length);
              const idx = createdNotes.findIndex(n => n.slug === oldSlug);
              if (idx >= 0) {
                deletedNotes.push(createdNotes[idx]);
                createdNotes.splice(idx, 1);
              }
              createdNotes.push({ slug: result.newNoteSlug, url: result.noteUrl });
              break;
            }
            case 'create_snapshot':
              createdSnapshots.push({ url: entry.url, path: entry.path });
              break;
            case 'delete_snapshot': {
              const idx = createdSnapshots.findIndex(s => s.path === entry.path);
              if (idx >= 0) {
                deletedSnapshots.push(createdSnapshots[idx]);
                createdSnapshots.splice(idx, 1);
              }
              break;
            }
            case 'restore_snapshot': {
              const idx = deletedSnapshots.findIndex(s => s.path === entry.path);
              if (idx >= 0) {
                createdSnapshots.push(deletedSnapshots[idx]);
                deletedSnapshots.splice(idx, 1);
              }
              break;
            }
            case 'create_list':
              createdLists.push({ name: entry.name, owner: entry.listOwner });
              break;
            case 'delete_list': {
              const idx = createdLists.findIndex(l => l.name === entry.name && l.owner === entry.listOwner);
              if (idx >= 0) {
                deletedLists.push(createdLists[idx]);
                createdLists.splice(idx, 1);
              }
              break;
            }
            case 'restore_list': {
              const idx = deletedLists.findIndex(l => l.name === entry.name && l.owner === entry.listOwner);
              if (idx >= 0) {
                createdLists.push(deletedLists[idx]);
                deletedLists.splice(idx, 1);
              }
              break;
            }
            case 'add_rule':
              if (entry.rule?.type) {
                const id = `rule-${entry.rule.type[0]}-${entry.timestamp.toString(36)}-${seed.toString(36).slice(0, 4)}`;
                ruleIds.push({ ruleId: id, listName: entry.name, listOwner: entry.listOwner });
              }
              break;
            case 'remove_rule': {
              const idx = ruleIds.findIndex(r => r.ruleId === entry.ruleId);
              if (idx >= 0) ruleIds.splice(idx, 1);
              break;
            }
          }
          return result;
        });

        arbitraries.push(arb);
      }

      return fc.tuple(...arbitraries).map(results => {
        // Deduplicate create_list events: keep only the first for each owner/name pair
        const seenListKeys = new Set();
        return results.filter(r => {
          if (r.entry.action === 'create_list') {
            const key = `${r.entry.listOwner}/${r.entry.name}`;
            if (seenListKeys.has(key)) return false;
            seenListKeys.add(key);
          }
          return true;
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Replay helper: apply events sequentially to a store
// ---------------------------------------------------------------------------

import { effectOf, defaultEntity } from '../extension/replay.js';

export function makeLoad(store) {
  return async (key, opts) => {
    const entity = store[key] ?? null;
    if (!opts?.includeDeleted && entity?.deleted) return null;
    return entity;
  };
}

export async function replay(events, baseStore, contexts) {
  const s = JSON.parse(JSON.stringify(baseStore));
  for (let i = 0; i < events.length; i++) {
    const ctx = Array.isArray(contexts) ? contexts[i] : contexts;
    const effects = await effectOf(events[i], makeLoad(s), ctx);
    for (const [k, v] of Object.entries(effects)) {
      if (v === null) {
        delete s[k];
      } else {
        s[k] = v;
      }
    }
  }
  return s;
}

// Exported constants for tests
export { URL_POOL, LIST_NAMES, DEVICES, generateSlugFromUrl };
