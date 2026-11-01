# Multi-Device Sync Plan

Historical design and implementation record for the extension-era sync system.
Sync now runs in the daemon. Use [Architecture](../docs/ARCHITECTURE.md#search-rules-settings-and-sync)
and the [data-folder contract](../crates/daemon/resources/data-AGENTS.md) for current
ownership, paths, schemas, and write procedures. Historical pseudocode and completed
checklists have been condensed below.

## Design decisions

| Topic           | Decision and rationale                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Scope           | Recent logs and all notes; snapshots stay local because of size.                                                      |
| Transport       | GitHub REST API, with a small transport interface for future adapters.                                                |
| Repository      | One shared repository; each device owns a branch and reads peer branches.                                             |
| Retention       | Replace the branch with one orphan commit containing a rolling log window; preserve older local files.                |
| Device identity | Derive identity from the log location and pass identity into replay, rather than duplicating identity in every event. |
| Lists           | `(owner, name)` lookup permits same-name lists on different devices.                                                  |
| Notes           | Edits create immutable replacements; concurrent replacements both remain visible.                                     |
| Deletion        | Timestamp-based delete/restore resolution; preserve deleted entities for later restoration.                           |
| Migration       | Migrate stored data explicitly instead of carrying parallel legacy readers.                                           |

The first draft proposed filename suffixes and conditional sync-mode schemas.
Implementation instead made device identity always present and used
`logs/<device>/YYYY-MM-DD.jsonl`. The original global tree timestamp proposal also
predates current per-device tree handling.

## Push and pull

A push collects recent current-device logs and note objects, compares saved hashes,
uploads changed blobs, creates a tree and parentless commit, then force-updates the
device branch. A pull discovers peers, compares trees/cursors, downloads new files,
replays remote events, and advances cursors. Remote events must not enter the local
log buffer again.

The retention window bounds published log history, not local storage. A device
offline longer than the window can miss peer events and needs manual catch-up.
Force-pushing does not guarantee immediate server-side removal of unreachable data.
Repository permissions and token access remain part of the user's setup.

## Replay requirements

- Track per-device watermarks for additive page fields so duplicate events do not
  double-count ratings or attention.
- Keep a record's display timestamp at the maximum applied time without using that
  single timestamp to suppress another device's additive changes.
- Load deleted lists for pin and rule mutations so later restoration retains edits.
- Keep concurrent note replacements linked to the page. Replacement creates a new
  note independently of deletion of the old note.
- Reconcile list trees with live lists: include new lists, remove deleted nodes,
  and preserve surviving children.
- Treat garbage-collection sentinels as absent records so remote events can recreate
  eligible pages.

## Historical regression scenarios

The original suite compared replay orders and repeated events. These scenarios
record design intent; current schemas and timestamp rules take precedence.

| Cases | Scenario                                                          | Expected result                                                                                               |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| T1    | Two devices replace the same note                                 | Both replacements survive; the original is replaced. Original pin-transfer behavior depended on replay order. |
| T2–T3 | Replace and delete the original note, with either timestamp order | Replacement survives independently.                                                                           |
| T4–T5 | Delete/restore a note                                             | Newer deletion state wins.                                                                                    |
| T6–T7 | Delete/restore a list                                             | Newer deletion state wins; restoration retains pins.                                                          |
| T8    | Pin to a concurrently deleted list                                | Pin is retained for restoration.                                                                              |
| T9    | Pin, delete, restore                                              | Restored list retains the pin.                                                                                |
| T10   | Unpin from a deleted list                                         | Restored list excludes the pin.                                                                               |
| T11   | Concurrent tree changes                                           | Resolve using the applicable tree timestamp rules.                                                            |
| T12   | Tree change and list creation                                     | Include the new list.                                                                                         |
| T13   | Tree change and list deletion                                     | Remove the deleted node.                                                                                      |
| T14   | Two devices rate one page                                         | Apply both contributions.                                                                                     |
| T15   | Repeat one rating event                                           | Count the contribution once.                                                                                  |
| T16   | Replace, delete, restore the original note                        | Preserve replacement and restored original where valid.                                                       |
| T17   | Delete, pin, restore a list                                       | Preserve the pin.                                                                                             |
| T18   | Create a list, reorganize, delete a parent                        | Include missing live lists and promote surviving children.                                                    |
| T19   | Remote visit after page garbage collection                        | Recreate the page.                                                                                            |
| T20   | Add a rule to a deleted list, then restore                        | Preserve the rule.                                                                                            |
| T21   | Create a list without a separate tree event                       | Add the list to the tree.                                                                                     |

## Implementation record

Extension-era replay, transport, push/pull, cursors, scheduling, status, and retention
were completed. Key commits included `e1635f5` (tree events), `593ac8e` (replay device
context and watermarks), and `1c85e49` (owner lookup and device directories). The
desktop port later moved authority and credentials into the daemon.

Deferred ideas included additional Git hosts, explicit conflict notifications,
better catch-up beyond retention, and cross-user sharing. These are proposals,
not supported product behavior. Current priorities belong in a new scoped plan.
