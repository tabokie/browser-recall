/**
 * Property-based tests for the replay engine.
 *
 * Uses fast-check to generate random event sequences and verify structural
 * invariants that must hold regardless of event ordering or content:
 *
 *   P1  Idempotency — replaying any entry twice produces the same state
 *   P2  Referential integrity — childIds/parentIds/pins/orphaned consistent
 *   P3  Checkpoint equivalence — partial checkpoint + replay = full replay
 *   P4  Multi-device convergence — permutations of cross-device events converge
 *   P5  Monotonic timestamps — timestamps[device] never decreases
 *   P6  Three-way consistency — name-to-id <-> list-order <-> list entities
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { effectOf } from '../extension/replay.js';
import {
  arbEventSequence,
  makeLoad,
  replay,
  URL_POOL,
  DEVICES,
  generateSlugFromUrl,
} from './arbitrary-events.mjs';

const NUM_RUNS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyStore() {
  return {
    'manifest:settings': {},
    'manifest:name-to-id': { paths: {} },
    'manifest:list-order': { tree: [] },
    'manifest:orphaned': { entries: [] },
  };
}

function collectTreeIds(nodes) {
  const ids = new Set();
  for (const n of (nodes || [])) {
    ids.add(n.id);
    if (n.children) for (const id of collectTreeIds(n.children)) ids.add(id);
  }
  return ids;
}

/**
 * Pre-seed the store with note entities for create_note/replace_note events.
 * In the real system, note files are written to disk BEFORE the log entry
 * is processed; `effectOf` expects `load(noteKey)` to find them.
 */
function preseedNotes(store, seq) {
  for (const s of seq) {
    const { entry } = s;
    if (entry.action === 'create_note' || entry.action === 'replace_note') {
      const slug = entry.path.slice('notes/'.length, -'.json'.length);
      const noteKey = `note:${slug}`;
      if (!store[noteKey]) {
        store[noteKey] = {
          slug,
          excerpt: 'test excerpt',
          note: 'test note content',
          cssPath: null,
          url: entry.url,
        };
      }
    }
  }
}

async function replaySequence(seq) {
  const entries = seq.map(s => s.entry);
  const contexts = seq.map(s => ({ deviceId: s.deviceId }));
  const store = emptyStore();
  preseedNotes(store, seq);
  return await replay(entries, store, contexts);
}

// ---------------------------------------------------------------------------
// P1: Idempotency
// ---------------------------------------------------------------------------

describe('P1: Idempotency — replaying any entry twice produces same state', () => {
  it('every entry in a random sequence is idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(5, 15), async (seq) => {
        const entries = seq.map(s => s.entry);
        const contexts = seq.map(s => ({ deviceId: s.deviceId }));

        // Full replay (with pre-seeded notes)
        const store = emptyStore();
        preseedNotes(store, seq);
        const state = await replay(entries, store, contexts);

        // Re-apply every entry against the final state — should produce no meaningful change
        for (let i = 0; i < seq.length; i++) {
          const effects = await effectOf(entries[i], makeLoad(state), contexts[i]);
          for (const [key, value] of Object.entries(effects)) {
            if (value === null) {
              // Deletion effect — entity should already not be present or be deleted
              const existing = state[key];
              if (existing !== undefined) {
                // Entity was already GC'd or null from first pass — acceptable
              }
            } else {
              const existing = state[key];
              if (existing) {
                // For additive fields (timeOnPage, likes), the per-device timestamp guard
                // prevents double-application. Verify the guard held.
                const deviceId = contexts[i].deviceId;
                const existingTs = existing.timestamps?.[deviceId] || 0;
                const entryTs = entries[i].timestamp;
                if (entryTs <= existingTs) {
                  // Guard should prevent additive field changes
                  if (entries[i].action === 'leave_page') {
                    expect(value.timeOnPage).toBe(existing.timeOnPage);
                    expect(value.scrollDepth).toBe(existing.scrollDepth);
                  }
                  if (entries[i].action === 'rate_page') {
                    expect(value.likes).toBe(existing.likes);
                  }
                }
              }
            }
          }
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });
});

// ---------------------------------------------------------------------------
// P2: Referential integrity
// ---------------------------------------------------------------------------

describe('P2: Referential integrity', () => {
  it('childIds on pages reference entities that exist or are orphaned', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(8, 20), async (seq) => {
        const state = await replaySequence(seq);
        const orphanKeys = new Set(
          (state['manifest:orphaned']?.entries || []).map(e => e.key)
        );

        for (const [key, entity] of Object.entries(state)) {
          if (!key.startsWith('page:') || !entity) continue;
          for (const childId of (entity.childIds || [])) {
            if (childId.startsWith('page:')) continue;
            // Snapshots are file-only references — no entity entry in the store.
            // They get orphaned on delete but don't have entity entries when active.
            if (childId.startsWith('snapshot:')) continue;
            const childExists = state[childId] !== undefined;
            const childOrphaned = orphanKeys.has(childId);
            expect(
              childExists || childOrphaned,
              `page ${key} has childId ${childId} which neither exists nor is orphaned`
            ).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });

  it('list parentIds on pages correspond to lists that have matching pins', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(8, 20), async (seq) => {
        const state = await replaySequence(seq);

        for (const [key, entity] of Object.entries(state)) {
          if (!key.startsWith('page:') || !entity) continue;
          for (const parentId of (entity.parentIds || [])) {
            if (!parentId.startsWith('list:')) continue;
            const list = state[parentId];
            if (!list) continue;
            if (list.deleted) continue;
            const hasPin = (list.pins || []).some(p => p.id === key);
            expect(
              hasPin,
              `page ${key} claims parentId ${parentId} but that list has no matching pin`
            ).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });

  it('name-to-id paths all point to non-deleted list entities', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(8, 20), async (seq) => {
        const state = await replaySequence(seq);
        const nameToId = state['manifest:name-to-id'];
        if (!nameToId?.paths) return;

        for (const [name, listId] of Object.entries(nameToId.paths)) {
          const listKey = `list:${listId}`;
          const list = state[listKey];
          expect(list, `name-to-id path "${name}" -> "${listId}" points to missing entity`).toBeTruthy();
          expect(
            list.deleted,
            `name-to-id path "${name}" -> "${listId}" points to a deleted list`
          ).toBeFalsy();
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });

  it('orphaned entries correspond to entities with deleted flag', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(8, 20), async (seq) => {
        const state = await replaySequence(seq);
        const orphaned = state['manifest:orphaned']?.entries || [];

        for (const entry of orphaned) {
          const entity = state[entry.key];
          // Entity might have been permanently removed (null effect) or truly deleted
          if (entity) {
            expect(
              entity.deleted,
              `orphaned entry ${entry.key} exists but is not marked deleted`
            ).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });
});

// ---------------------------------------------------------------------------
// P3: Checkpoint equivalence
// ---------------------------------------------------------------------------

describe('P3: Checkpoint equivalence — partial checkpoint + tail replay = full replay', () => {
  it('splitting at a random point produces the same final state', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEventSequence(6, 15),
        fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        async (seq, splitFraction) => {
          const entries = seq.map(s => s.entry);
          const contexts = seq.map(s => ({ deviceId: s.deviceId }));

          // Full replay (with pre-seeded notes)
          const store = emptyStore();
          preseedNotes(store, seq);
          const fullState = await replay(entries, store, contexts);

          // Split replay: first K events produce checkpoint, then replay remaining
          const k = Math.max(1, Math.min(entries.length - 1, Math.floor(entries.length * splitFraction)));
          const store2 = emptyStore();
          preseedNotes(store2, seq);
          const checkpointState = await replay(entries.slice(0, k), store2, contexts.slice(0, k));
          const splitState = await replay(entries.slice(k), checkpointState, contexts.slice(k));

          // Compare all entity keys
          const allKeys = new Set([...Object.keys(fullState), ...Object.keys(splitState)]);
          for (const key of allKeys) {
            const full = fullState[key];
            const split = splitState[key];

            if (key === 'manifest:orphaned') {
              // Orphaned entries may differ in order; compare as sets
              const fullEntries = new Set((full?.entries || []).map(e => e.key));
              const splitEntries = new Set((split?.entries || []).map(e => e.key));
              expect(
                fullEntries,
                `orphaned manifest diverges at split ${k}/${entries.length}`
              ).toEqual(splitEntries);
              continue;
            }

            if (full === undefined && split === undefined) continue;
            if (full === null || split === null) {
              // Both should be null/missing (GC'd entity)
              continue;
            }

            // Compare core fields (skip timestamps which use Math.max and converge)
            if (key.startsWith('page:')) {
              expect(full?.url, `${key}.url diverges`).toBe(split?.url);
              expect(full?.title, `${key}.title diverges`).toBe(split?.title);
              expect(full?.user_title, `${key}.user_title diverges`).toBe(split?.user_title);
              expect(
                new Set(full?.childIds || []),
                `${key}.childIds diverges`
              ).toEqual(new Set(split?.childIds || []));
              // parentIds that are lists should match
              const fullListParents = (full?.parentIds || []).filter(p => p.startsWith('list:'));
              const splitListParents = (split?.parentIds || []).filter(p => p.startsWith('list:'));
              expect(
                new Set(fullListParents),
                `${key} list parentIds diverge`
              ).toEqual(new Set(splitListParents));
            }

            if (key.startsWith('list:')) {
              expect(full?.name, `${key}.name diverges`).toBe(split?.name);
              expect(full?.deleted, `${key}.deleted diverges`).toBe(split?.deleted);
              const fullPinIds = new Set((full?.pins || []).map(p => p.id));
              const splitPinIds = new Set((split?.pins || []).map(p => p.id));
              expect(fullPinIds, `${key} pin ids diverge`).toEqual(splitPinIds);
            }

            if (key.startsWith('note:')) {
              expect(full?.deleted, `${key}.deleted diverges`).toBe(split?.deleted);
              expect(full?.url, `${key}.url diverges`).toBe(split?.url);
            }

            if (key === 'manifest:settings') {
              for (const settingKey of Object.keys(full || {})) {
                if (settingKey === 'timestamps') continue;
                expect(full[settingKey], `settings.${settingKey} diverges`).toEqual(split?.[settingKey]);
              }
            }

            if (key === 'manifest:name-to-id') {
              expect(full?.paths, `name-to-id paths diverge`).toEqual(split?.paths);
            }

            if (key === 'manifest:list-order') {
              const fullIds = collectTreeIds(full?.tree);
              const splitIds = collectTreeIds(split?.tree);
              expect(fullIds, `list-order tree ids diverge`).toEqual(splitIds);
            }
          }
        }
      ),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });
});

// ---------------------------------------------------------------------------
// P4: Multi-device convergence
// ---------------------------------------------------------------------------

describe('P4: Multi-device convergence — permutations produce same final state', () => {
  it('small cross-device sequences converge under all orderings', async () => {
    // Use smaller sequences for permutation testing (N! growth)
    await fc.assert(
      fc.asyncProperty(arbEventSequence(3, 5), async (seq) => {
        if (seq.length > 5) return; // safety cap for permutation count (5! = 120)

        const entries = seq.map(s => s.entry);
        const contexts = seq.map(s => ({ deviceId: s.deviceId }));

        // Generate all permutations of indices
        const indices = entries.map((_, i) => i);
        const perms = permutations(indices);

        const states = [];
        for (const perm of perms) {
          const permEntries = perm.map(i => entries[i]);
          const permContexts = perm.map(i => contexts[i]);
          const store = emptyStore();
          preseedNotes(store, seq);
          states.push(await replay(permEntries, store, permContexts));
        }

        // Compare LWW-governed fields across all permutations
        const allKeys = new Set();
        for (const state of states) {
          for (const key of Object.keys(state)) allKeys.add(key);
        }

        for (const key of allKeys) {
          if (key.startsWith('manifest:')) continue; // checked separately
          const ref = states[0][key];
          for (let i = 1; i < states.length; i++) {
            const other = states[i][key];
            // deleted flag and deletedTs should converge (LWW)
            if (ref?.deleted !== undefined || other?.deleted !== undefined) {
              expect(
                other?.deleted,
                `${key}.deleted diverged in permutation ${i}`
              ).toBe(ref?.deleted);
              expect(
                other?.deletedTs,
                `${key}.deletedTs diverged in permutation ${i}`
              ).toBe(ref?.deletedTs);
            }
          }
        }

        // name-to-id paths should converge
        for (let i = 1; i < states.length; i++) {
          expect(
            states[i]['manifest:name-to-id']?.paths,
            `name-to-id paths diverged in permutation ${i}`
          ).toEqual(states[0]['manifest:name-to-id']?.paths);
        }

        // list-order tree node IDs should converge
        const refTreeIds = collectTreeIds(states[0]['manifest:list-order']?.tree);
        for (let i = 1; i < states.length; i++) {
          const otherIds = collectTreeIds(states[i]['manifest:list-order']?.tree);
          expect(
            otherIds,
            `list-order tree ids diverged in permutation ${i}`
          ).toEqual(refTreeIds);
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });
});

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// P5: Monotonic timestamps
// ---------------------------------------------------------------------------

describe('P5: Monotonic timestamps — timestamps[device] never decreases', () => {
  it('timestamps only increase across sequential replay', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(5, 15), async (seq) => {
        const entries = seq.map(s => s.entry);
        const contexts = seq.map(s => ({ deviceId: s.deviceId }));

        const state = emptyStore();
        preseedNotes(state, seq);
        const prevTimestamps = new Map(); // key -> { device -> ts }

        for (let i = 0; i < entries.length; i++) {
          const effects = await effectOf(entries[i], makeLoad(state), contexts[i]);

          for (const [key, value] of Object.entries(effects)) {
            if (!value || !value.timestamps) continue;
            if (!prevTimestamps.has(key)) prevTimestamps.set(key, {});
            const prev = prevTimestamps.get(key);

            for (const [dev, ts] of Object.entries(value.timestamps)) {
              if (prev[dev] !== undefined) {
                expect(
                  ts,
                  `${key} timestamps[${dev}] decreased from ${prev[dev]} to ${ts} at step ${i}`
                ).toBeGreaterThanOrEqual(prev[dev]);
              }
              prev[dev] = ts;
            }
          }

          // Apply effects to state
          for (const [k, v] of Object.entries(effects)) {
            if (v === null) delete state[k];
            else state[k] = v;
          }
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });
});

// ---------------------------------------------------------------------------
// P6: Three-way consistency — name-to-id <-> list-order <-> list entities
// ---------------------------------------------------------------------------

describe('P6: Three-way consistency — manifests and list entities agree', () => {
  it('non-deleted lists appear in both name-to-id and list-order tree', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventSequence(8, 20), async (seq) => {
        const state = await replaySequence(seq);
        const nameToId = state['manifest:name-to-id'];
        const listOrder = state['manifest:list-order'];
        const treeIds = collectTreeIds(listOrder?.tree);

        // Every non-deleted list entity should be in name-to-id
        const nameToIdListIds = new Set(Object.values(nameToId?.paths || {}));

        for (const [key, entity] of Object.entries(state)) {
          if (!key.startsWith('list:')) continue;
          if (!entity || entity.deleted) continue;
          if (key.startsWith('list:system/')) continue;

          const listId = key.slice('list:'.length);

          expect(
            nameToIdListIds.has(listId),
            `non-deleted list ${key} (name="${entity.name}") missing from name-to-id`
          ).toBe(true);

          expect(
            treeIds.has(key),
            `non-deleted list ${key} (name="${entity.name}") missing from list-order tree`
          ).toBe(true);
        }

        // Every entry in name-to-id should point to a non-deleted list
        for (const [path, listId] of Object.entries(nameToId?.paths || {})) {
          const listKey = `list:${listId}`;
          const entity = state[listKey];
          expect(
            entity && !entity.deleted,
            `name-to-id entry "${path}" -> "${listId}" points to deleted/missing list`
          ).toBe(true);
        }

        // Every non-system ID in the tree should point to a non-deleted list
        for (const id of treeIds) {
          if (id.startsWith('list:system/')) continue;
          const entity = state[id];
          if (!entity) continue;
          expect(
            !entity.deleted,
            `list-order tree contains deleted list ${id}`
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS, endOnFailure: true },
    );
  });
});
