# CLAUDE.md — tag-graph-edges plugin

This file is for AI agents working on this Obsidian plugin. It documents what was tried, what failed, what works, and why.

## What this plugin does

Draws graph edges in Obsidian between notes that share YAML frontmatter tags (`tags: [a, b]`), and between tags that have declared parent/child relations. Works in both global and local graph views.

Standalone plugin. Zero dependencies on other plugins.

## The core problem

The vault's note files have a **leading blank line (0x0a) before the opening `---`**. Obsidian requires `---` at byte 0 to recognise YAML frontmatter. Because of this leading newline, Obsidian's `metadataCache` returns **no frontmatter, no tags** for these files. The graph shows disconnected orphan nodes.

**Hard constraint**: the source file format cannot be changed. The leading blank line must be tolerated.

## What was tried and failed

### Attempt 1: Graph engine `setData` patching only

Patched `GraphEngine.prototype.render` to wrap `renderer.setData()` and inject tag nodes + file-to-tag edges into the graph data object. Read tags from `metadataCache.getFileCache()` with a raw-content fallback.

**Result**: Plugin loaded, showed "0 tags 0 files". The tag index was empty.

**Root cause**: `buildIndex()` ran inside `onload()` using `await`. At that point `vault.getMarkdownFiles()` returns an empty array because the vault file tree is not yet populated during plugin `onload`. The raw-content fallback never executed because there were no files to iterate.

**Lesson**: Never call `vault.getMarkdownFiles()` during `onload()`. Always defer vault reads to `workspace.onLayoutReady()` or `metadataCache.on('resolved')`.

### Attempt 2: Graph engine patching alone (after fixing timing)

After moving initialisation to `onLayoutReady`, the tag index populated correctly. However, patching `renderer.setData` inside the engine's `render()` method only works reliably for the **local graph**. The global graph engine may not call `setData()` on every `render()` invocation — it appears to build its data once and then only re-renders the canvas.

**Lesson**: The global graph's render pipeline is not identical to the local graph. You cannot rely solely on intercepting `setData` for the global graph.

## What works and why (current architecture)

Three strategies run in parallel. Any one of them is sufficient; together they cover all observed Obsidian versions and graph states.

### Strategy 1 — Patch `metadataCache.getFileCache` / `getCache`

Monkey-patches the two metadata cache read methods. When the original returns a cache with no tags, the plugin enriches the return value with tags parsed from raw file content. Downstream consumers (including the graph engine) see a cache object that contains frontmatter tags as if Obsidian had parsed them natively.

**Why it helps**: Makes Obsidian's own tag-aware features (tag pane, graph `showTags`, search `tag:`) work for files with broken frontmatter.

### Strategy 2 — Inject into `resolvedLinks`

Writes entries directly into `app.metadataCache.resolvedLinks` for every pair of files sharing a tag. This is the data structure the global graph reads to draw edges.

**Why it helps**: This is the guaranteed fallback. The graph always reads `resolvedLinks` regardless of how the engine internally renders. Produces note-to-note edges (not tag-hub edges), so it's less informative than Strategy 3 but always works.

### Strategy 3 — Patch graph engine `renderer.setData`

Wraps `GraphEngine.prototype.render` to intercept `setData(data)`. Injects:
- Tag nodes (`{ type: 'tag', links: {} }`) for each tag in the index
- File-to-tag edges (`nodes[filePath].links[tag] = true`)
- Tag-to-tag edges from `_tag_relations.json` (`nodes[parentTag].links[childTag] = true`)

**Why it helps**: Produces the hub-and-spoke graph topology (files connect through tag nodes). Also the only strategy that injects tag-to-tag relation edges.

### Initialisation timing

All vault reads are deferred to `workspace.onLayoutReady()`. A retry fires on `metadataCache.on('resolved')` in case `onLayoutReady` was still too early. A startup Notice reports the tag/file/relation counts so problems are immediately visible.

## Tag-to-tag relations

Defined in `_tag_relations.json` at the vault root:

```json
{
  "parent-tag": ["child-tag-1", "child-tag-2"]
}
```

The plugin watches this file for changes and hot-reloads. Tags are normalised to lowercase with `#` prefix internally (`project-home` becomes `#project-home`). The file uses bare names without `#`.

## Key internal data structures

- `tagIndex`: `Map<filePath, Set<normalizedTag>>` — built from raw file content via regex, falls back to metadataCache if frontmatter is valid
- `tagRelations`: `Map<normalizedParentTag, Set<normalizedChildTag>>` — loaded from `_tag_relations.json`
- `enrichedCaches`: `Map<filePath, CachedMetadata>` — memoised enriched cache objects returned by patched `getFileCache`
- `unpatchers`: `Array<Function>` — cleanup callbacks for all monkey-patches, called on `onunload`

## Tag parsing from raw content

The regex `/---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[^\S\r\n]*---/` locates the YAML block. It tolerates a leading newline before `---` because it does not anchor to `^` at the start of the string. Within the captured YAML, it matches three formats:

- Flow sequence: `tags: [a, b, c]`
- Block sequence: `tags:\n  - a\n  - b`
- Single value: `tags: my-tag`

## Commands

- **Refresh tag graph edges** — rebuilds the full index and re-injects everything
- **Dump tag-graph-edges debug info** — writes `_tag_debug.md` with vault file list, tag index, resolvedLinks snapshot, and graph view internal keys

## Files

```
.obsidian/plugins/tag-graph-edges/
  manifest.json        — plugin metadata (id, version, description)
  main.js              — all plugin logic, single file, no build step
  CLAUDE.md            — this file
  Developer/
    _tag_bug_report.md — auto-generated error log (written by plugin on errors)
    _tag_selftest.md   — on-demand self-test results (written by command)
_tag_relations.json    — tag hierarchy definitions (vault root)
_tag_debug.md          — on-demand debug snapshot (vault root, written by command)
```

## Planned Features (priority order)

### 1. Bug Report File ✓ DONE
Persistent file at `Developer/_tag_bug_report.md`. Auto-appended by the plugin on every caught exception and on bad init state. Each entry has: timestamp, plugin version, strategy name, context (file path or function), and error message. File is created on first error; subsequent entries append. A `Test bug report` command writes a manual test entry to confirm the system is working.

### 2. Script Debug Tool (Runtime Self-Test) ✓ DONE
Command `Run plugin self-test`. Runs 5 checks: vault has files, tagIndex is non-empty, sample file has resolvedLinks edges, patched `getFileCache` returns enriched tags, graph engine prototype carries the patch flag. Each check reports PASS/FAIL with a reason. Writes `Developer/_tag_selftest.md` and shows a summary Notice.

### 3. Per-File Debugger & Status Checker (pause until needed or untill no other tasks)
A command `Check active file tag status` that runs on whichever note is currently open. Reports:
- Raw YAML parse result (what `tagsFromContent` found)
- What `metadataCache.getFileCache()` returns for this file (native vs. enriched)
- Whether this file appears in `tagIndex` and what tags are stored
- Which other files this file is edge-connected to via `resolvedLinks`
- Which tag(s) create each of those edges

Currently `dumpDebug` dumps the whole vault — this focused per-file version is the fast daily-use tool.

### 4. Settings Tab
A `PluginSettingTab` with:
- **Excluded tags** — tags that should not generate edges (e.g. `project-home` shared by all notes creates noise)
- **Minimum shared-tag threshold** — only draw an edge if two notes share N or more tags
- **Strategy toggles** — enable/disable each of the 3 injection strategies independently for debugging

### 5. Status Bar Indicator
A small `addStatusBarItem()` entry showing `Tags: N | Edges: N` updated after each index rebuild. Instant at-a-glance confirmation the plugin is active without opening any debug output.

### 6. Stale Relations Warning ✓ DONE
After index build, compares `tagRelations` keys against all tags in `tagIndex`. Any parent or child tag declared in `_tag_relations.json` that appears in zero notes is appended to `Developer/_tag_bug_report.md`. Implemented in `initialize()` as part of the stale-relations check loop.

### 7. Edge Weight = Shared Tag Count
The `resolvedLinks` values are already numbers — the plugin currently increments by 1 per shared tag, so notes sharing 3 tags already get weight 3. Obsidian renders thicker/stronger edges for higher weights. This behaviour should be made explicit and documented: it is intentional design, not an accident. No code change needed — just make it deliberate and ensure it survives future refactors.

### 8. Orphan Detection Command
A command that reports all notes with zero tags — nodes that will always be isolated in the graph regardless of the plugin's work. Writes results to `Developer/_tag_orphans.md`. Useful for vault hygiene without touching any note content.

### 9. Bridge Note Detection Command
A command that identifies notes like `note_5` — nodes whose removal would disconnect tag clusters. Walks the `resolvedLinks` graph, finds articulation points, and writes a report to `Developer/_tag_bridges.md` listing each bridge note and which tag clusters it connects. Useful for understanding vault structure.

### 10. Tag Statistics View (Sidebar Panel)
A sidebar panel (`ItemView`) showing:
- Each tag → note count
- Which notes belong to each tag cluster
- Tags declared in `_tag_relations.json` that don't appear in any note (stale relations)

More informative than the status bar; gives a full map of the tag topology at a glance.

## Pitfalls for future AI agents

1. **Do not read vault files during `onload()`** — `vault.getMarkdownFiles()` returns `[]` before the vault is ready. Use `onLayoutReady` or the `resolved` event.
2. **`metadataCache.getFileCache()` returns nothing useful for these files** — the leading blank line means Obsidian sees no frontmatter. Always fall back to raw content parsing via `vault.cachedRead()`.
3. **The global graph engine does not reliably call `setData()` on re-render** — patching `setData` alone is insufficient. You need `resolvedLinks` injection as a fallback.
4. **Tag normalisation matters** — Obsidian uses `#tag-name` (lowercase, `#`-prefixed) as graph node IDs for tags. The plugin must match this format exactly or edges won't connect.
5. **`catch {}` without a parameter works in Electron but hides real errors** — always use `catch (e)` and at minimum log during development.
6. **The existing `local-graph-tag-links` plugin** in this vault is superseded and disabled. Do not re-enable it — it patches the same `GraphEngine.prototype.render` and only handles the local graph.
