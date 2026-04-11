/**
 * Generative E2E tests — verify UI invariants against randomly seeded data.
 *
 * Uses fast-check to generate random event sequences, builds seed files via
 * buildSeedFiles + effectOf, loads them into the real extension, and checks
 * that the UI reflects the underlying data correctly.
 *
 *   P7   Sidebar list count matches non-deleted lists
 *   P8   List pin count matches entity pins array
 *   P9   Recycle bin matches orphaned manifest
 *   P10  History sorted newest-first
 */
import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  openOptionsPage,
  openHelperPage,
  waitForListView,
} from './helpers.js';
import fc from 'fast-check';
import { buildSeedFiles } from '../seed-builder.mjs';
import { effectOf, defaultEntity } from '../../extension/replay.js';
import {
  generateSlugFromUrl,
  generateNoteSlug,
} from '../../extension/utils.js';

// Fixed seed for reproducibility across CI runs. Override with PROP_SEED env.
const SEED = process.env.PROP_SEED ? parseInt(process.env.PROP_SEED) : 20260411;
const SAMPLES_PER_TEST = 3;

// ---------------------------------------------------------------------------
// Lightweight event generators (no fast-check dependency on stateful tracking)
// ---------------------------------------------------------------------------

const URL_POOL = Array.from(
  { length: 6 },
  (_, i) => `https://example.com/page-${i}`,
);
const LIST_NAMES = ['Alpha', 'Beta', 'Gamma'];
const DEVICE = 'test-device';

function randomFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Generate a deterministic random event sequence using a seeded PRNG.
 * Simpler than the fast-check approach — produces sequences that always
 * include a mix of lists, pins, notes, snapshots, and visits.
 */
function generateScenario(seed) {
  let s = seed;
  function rng() {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  }

  const events = [];
  const entities = {};
  const createdLists = [];
  const usedListNames = new Set();
  let ts = Date.now() - 100000;

  // Phase 1: Create 1-3 lists
  const numLists = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < numLists && i < LIST_NAMES.length; i++) {
    const name = LIST_NAMES[i];
    if (usedListNames.has(name)) continue;
    usedListNames.add(name);
    ts += 100;
    events.push({
      timestamp: ts,
      action: 'create_list',
      name,
      listOwner: DEVICE,
    });
    createdLists.push(name);
  }

  // Phase 2: Visit some pages to ensure page entities exist
  const visitedUrls = [];
  const numVisits = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < numVisits; i++) {
    const url = randomFrom(URL_POOL, rng);
    ts += 1000;
    events.push({
      timestamp: ts,
      action: 'visit_page',
      url,
      title: `Title for ${url.split('/').pop()}`,
      checkpoint: true,
    });
    visitedUrls.push({ url, ts });
  }

  // Phase 3: Pin some pages to lists
  if (createdLists.length > 0 && visitedUrls.length > 0) {
    const numPins = 1 + Math.floor(rng() * Math.min(visitedUrls.length, 4));
    const pinned = new Set();
    for (let i = 0; i < numPins; i++) {
      const listName = randomFrom(createdLists, rng);
      const { url } = randomFrom(visitedUrls, rng);
      const key = `${listName}:${url}`;
      if (pinned.has(key)) continue;
      pinned.add(key);
      ts += 100;
      events.push({
        timestamp: ts,
        action: 'pin_to_list',
        name: listName,
        listOwner: DEVICE,
        items: [url],
      });
    }
  }

  // Phase 4: Create some notes
  const createdNotes = [];
  const numNotes = Math.floor(rng() * 3);
  for (let i = 0; i < numNotes; i++) {
    const url = randomFrom(URL_POOL, rng);
    ts += 100;
    const noteSlug = generateNoteSlug(ts, url.slice(0, 20));
    entities[`note:${noteSlug}`] = {
      slug: noteSlug,
      excerpt: `Excerpt for ${url}`,
      note: `Note content for ${url}`,
      cssPath: null,
      url,
    };
    events.push({
      timestamp: ts,
      action: 'create_note',
      url,
      path: `notes/${noteSlug}.json`,
    });
    createdNotes.push({ slug: noteSlug, url });
  }

  // Phase 5: Optionally delete some entities (for recycle bin testing)
  if (createdNotes.length > 0 && rng() > 0.5) {
    const note = createdNotes[0];
    ts += 100;
    events.push({
      timestamp: ts,
      action: 'delete_note',
      url: note.url,
      path: `notes/${note.slug}.json`,
    });
  }

  if (createdLists.length > 1 && rng() > 0.5) {
    const listToDelete = createdLists[createdLists.length - 1];
    ts += 100;
    events.push({
      timestamp: ts,
      action: 'delete_list',
      name: listToDelete,
      listOwner: DEVICE,
    });
  }

  // Phase 6: More visits (to give history ordering variety)
  const numLateVisits = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < numLateVisits; i++) {
    const url = randomFrom(URL_POOL, rng);
    ts += 2000;
    events.push({
      timestamp: ts,
      action: 'visit_page',
      url,
      title: `Late visit ${url.split('/').pop()}`,
      checkpoint: true,
    });
    visitedUrls.push({ url, ts });
  }

  return { events, entities, visitedUrls };
}

/**
 * Build seed files and compute the expected final state by replaying events.
 */
async function buildScenarioData(seed) {
  const scenario = generateScenario(seed);
  const files = await buildSeedFiles(scenario.events, {
    deviceId: DEVICE,
    settings: { trimRules: [], blacklist: [] },
    entities: scenario.entities,
  });

  // Replay to compute expected state
  const store = new Map();
  if (scenario.entities) {
    for (const [key, value] of Object.entries(scenario.entities)) {
      store.set(key, value);
    }
  }
  function load(key, opts) {
    const entity = store.get(key) ?? null;
    if (!opts?.includeDeleted && entity?.deleted) return null;
    return entity;
  }
  for (const entry of scenario.events) {
    const context = { deviceId: DEVICE };
    const effects = await effectOf(entry, load, context);
    for (const [key, value] of Object.entries(effects)) {
      if (value === null) store.delete(key);
      else store.set(key, value);
    }
  }

  return { files, store, scenario };
}

// ---------------------------------------------------------------------------
// Generate sample seeds
// ---------------------------------------------------------------------------

function generateSeeds(count, baseSeed) {
  const seeds = [];
  let s = baseSeed;
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    seeds.push(s);
  }
  return seeds;
}

const testSeeds = generateSeeds(SAMPLES_PER_TEST, SEED);

// ---------------------------------------------------------------------------
// P7: Sidebar list count matches non-deleted lists
// ---------------------------------------------------------------------------

test.describe('P7: Sidebar list count matches non-deleted lists', () => {
  for (let i = 0; i < testSeeds.length; i++) {
    test(`seed ${testSeeds[i]}`, async ({
      extContext,
      extensionId,
      setupDir,
    }) => {
      const { files, store } = await buildScenarioData(testSeeds[i]);
      await resetAndSeed(extContext, extensionId, files);

      const options = await openOptionsPage(extContext, extensionId);

      // Count non-deleted, non-system lists from replay state
      let expectedListCount = 0;
      for (const [key, entity] of store) {
        if (
          key.startsWith('list:') &&
          !key.startsWith('list:system/') &&
          entity &&
          !entity.deleted
        ) {
          expectedListCount++;
        }
      }

      if (expectedListCount > 0) {
        // Wait for sidebar items to render
        await options.waitForFunction(
          (expected) =>
            document.querySelectorAll('.sidebar-item[data-list-id]').length >=
            expected,
          expectedListCount,
          { timeout: 10000 },
        );
      }

      const sidebarItems = await options.$$('.sidebar-item[data-list-id]');
      expect(
        sidebarItems.length,
        `Expected ${expectedListCount} lists in sidebar (seed: ${testSeeds[i]})`,
      ).toBe(expectedListCount);

      await options.close();
    });
  }
});

// ---------------------------------------------------------------------------
// P8: List pin count matches entity pins array
// ---------------------------------------------------------------------------

test.describe('P8: List pin count matches entity pins array', () => {
  for (let i = 0; i < testSeeds.length; i++) {
    test(`seed ${testSeeds[i]}`, async ({
      extContext,
      extensionId,
      setupDir,
    }) => {
      const { files, store } = await buildScenarioData(testSeeds[i]);
      await resetAndSeed(extContext, extensionId, files);

      // Find a non-deleted list with pins
      let targetList = null;
      for (const [key, entity] of store) {
        if (
          key.startsWith('list:') &&
          !key.startsWith('list:system/') &&
          entity &&
          !entity.deleted
        ) {
          if (entity.pins && entity.pins.length > 0) {
            targetList = { key, entity };
            break;
          }
        }
      }

      if (!targetList) return; // no list with pins in this seed

      const options = await openOptionsPage(extContext, extensionId);
      const listId = targetList.key.slice('list:'.length);

      // Click into the list
      const listItem = options.locator(
        `.sidebar-item[data-list-id="${listId}"]`,
      );
      await expect(listItem).toBeVisible({ timeout: 5000 });
      await listItem.click();
      await waitForListView(options);

      // Wait for pinned rows to appear
      const expectedPinCount = targetList.entity.pins.length;
      await options.waitForFunction(
        (expected) =>
          document.querySelectorAll('#relatedResults .result-row').length >=
          expected,
        expectedPinCount,
        { timeout: 10000 },
      );

      const pinnedRows = await options.$$('#relatedResults .result-row');
      expect(
        pinnedRows.length,
        `Expected ${expectedPinCount} pins in list "${targetList.entity.name}" (seed: ${testSeeds[i]})`,
      ).toBe(expectedPinCount);

      await options.close();
    });
  }
});

// ---------------------------------------------------------------------------
// P9: Recycle bin matches orphaned manifest
// ---------------------------------------------------------------------------

test.describe('P9: Recycle bin matches orphaned manifest', () => {
  for (let i = 0; i < testSeeds.length; i++) {
    test(`seed ${testSeeds[i]}`, async ({
      extContext,
      extensionId,
      setupDir,
    }) => {
      const { files, store } = await buildScenarioData(testSeeds[i]);
      await resetAndSeed(extContext, extensionId, files);

      const orphaned = store.get('manifest:orphaned');
      const expectedCount = orphaned?.entries?.length || 0;

      const helper = await openHelperPage(extContext, extensionId);

      // Read orphaned manifest through background to verify it matches
      const resp = await helper.evaluate(() =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key: 'manifest:orphaned',
        }),
      );
      expect(resp.success !== false).toBe(true);

      const actualCount = resp.value?.entries?.length || 0;
      expect(
        actualCount,
        `Expected ${expectedCount} orphaned entries (seed: ${testSeeds[i]})`,
      ).toBe(expectedCount);

      // Verify each orphaned key is indeed deleted in the extension state
      if (actualCount > 0) {
        for (const entry of resp.value.entries) {
          const entityResp = await helper.evaluate(
            (key) =>
              chrome.runtime.sendMessage({
                action: 'readCacheable',
                key,
                includeDeleted: true,
              }),
            entry.key,
          );
          if (entityResp.value) {
            expect(
              entityResp.value.deleted,
              `Orphaned entry ${entry.key} should be marked deleted (seed: ${testSeeds[i]})`,
            ).toBe(true);
          }
        }
      }

      await helper.close();
    });
  }
});

// ---------------------------------------------------------------------------
// P10: History sorted newest-first
// ---------------------------------------------------------------------------

test.describe('P10: History sorted newest-first', () => {
  for (let i = 0; i < testSeeds.length; i++) {
    test(`seed ${testSeeds[i]}`, async ({
      extContext,
      extensionId,
      setupDir,
    }) => {
      const { files, scenario } = await buildScenarioData(testSeeds[i]);
      await resetAndSeed(extContext, extensionId, files);

      const options = await openOptionsPage(extContext, extensionId);

      // Wait for at least some history results to appear
      await options.waitForFunction(
        () => document.querySelectorAll('.result-row').length >= 1,
        { timeout: 10000 },
      );

      // Extract titles from rendered rows — the extension deduplicates by URL
      // and shows each page's latest visit, sorted newest-first
      const titles = await options.$$eval('.result-row .result-title', (els) =>
        els.map((el) => el.textContent.trim()),
      );
      expect(titles.length).toBeGreaterThan(0);

      // Build expected order: last occurrence of each URL's visit_page,
      // sorted by timestamp descending, then mapped to title.
      const visitsByUrl = new Map();
      for (const evt of scenario.events) {
        if (evt.action === 'visit_page') {
          visitsByUrl.set(evt.url, evt);
        }
      }
      const uniqueVisits = [...visitsByUrl.values()].sort(
        (a, b) => b.timestamp - a.timestamp,
      );
      const expectedTitles = uniqueVisits.map((v) => v.title);

      // The first displayed title should be the newest visit's title.
      // (Exact match may vary due to enrichment, but the newest should be first.)
      if (expectedTitles.length > 0) {
        expect(
          titles[0],
          `Newest entry should appear first (seed: ${testSeeds[i]})`,
        ).toBe(expectedTitles[0]);
      }

      // Verify ordering: for each pair of consecutive displayed titles that
      // both appear in our expected list, the first should come before or at
      // the same position as the second in the expected order.
      const expectedIndexMap = new Map(
        expectedTitles.map((t, idx) => [t, idx]),
      );
      for (let j = 0; j < titles.length - 1; j++) {
        const idxA = expectedIndexMap.get(titles[j]);
        const idxB = expectedIndexMap.get(titles[j + 1]);
        if (idxA !== undefined && idxB !== undefined) {
          expect(
            idxA,
            `"${titles[j]}" should appear before "${titles[j + 1]}" (seed: ${testSeeds[i]})`,
          ).toBeLessThanOrEqual(idxB);
        }
      }

      await options.close();
    });
  }
});
