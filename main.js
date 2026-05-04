'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

const { Plugin, TFile, Notice, PluginSettingTab, Setting } = require('obsidian');

const PATCH_FLAG = '__tagGraphEdgesPatched';
const TAG_RELATIONS_FILE = '_tag_relations.json';
const BUG_REPORT_FILE = '.obsidian/plugins/tag-graph-edges/Developer/_tag_bug_report.md';
const SELF_TEST_FILE = '.obsidian/plugins/tag-graph-edges/Developer/_tag_selftest.md';

const DEFAULT_SETTINGS = {
  excludedTags: [],          // tags that generate no edges (bare names, no #)
  minSharedTags: 1,          // minimum shared tags to draw an edge between two notes
  enableMetadataPatch: true, // Strategy 1
  enableResolvedLinks: true, // Strategy 2
  enableGraphPatch: true,    // Strategy 3
};

/* ─── Tag extraction ─── */

function normalizeTag(raw) {
  const t = raw.trim();
  return (t.startsWith('#') ? t : '#' + t).toLowerCase();
}

function tagsFromCache(cache) {
  const out = new Set();
  if (!cache) return out;
  for (const ref of cache.tags || []) {
    if (ref && ref.tag) out.add(normalizeTag(ref.tag));
  }
  var fm = cache.frontmatter && cache.frontmatter.tags;
  if (Array.isArray(fm)) {
    for (var i = 0; i < fm.length; i++) {
      if (typeof fm[i] === 'string' && fm[i].trim()) out.add(normalizeTag(fm[i]));
    }
  } else if (typeof fm === 'string' && fm.trim()) {
    var parts = fm.split(',');
    for (var j = 0; j < parts.length; j++) {
      if (parts[j].trim()) out.add(normalizeTag(parts[j]));
    }
  }
  return out;
}

function tagsFromContent(content) {
  const out = new Set();
  const m = content.match(/---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[^\S\r\n]*---/);
  if (!m) return out;
  const yaml = m[1];

  const flow = yaml.match(/^[^\S\r\n]*tags:\s*\[([^\]]*)\]/m);
  if (flow) {
    var items = flow[1].split(',');
    for (var i = 0; i < items.length; i++) {
      if (items[i].trim()) out.add(normalizeTag(items[i]));
    }
    return out;
  }
  const block = yaml.match(
    /^[^\S\r\n]*tags:\s*\r?\n((?:[^\S\r\n]*-[^\S\r\n]+\S[^\r\n]*\r?\n?)+)/m
  );
  if (block) {
    var lines = block[1].split(/\r?\n/);
    for (var k = 0; k < lines.length; k++) {
      var lm = lines[k].match(/^\s*-\s+(.+)/);
      if (lm && lm[1] && lm[1].trim()) out.add(normalizeTag(lm[1].trim()));
    }
    return out;
  }
  const single = yaml.match(/^[^\S\r\n]*tags:\s+(\S+)/m);
  if (single) out.add(normalizeTag(single[1]));
  return out;
}

/* ─── Graph-engine patching ─── */

function patchEngine(plugin, engine) {
  var proto = engine && engine.constructor && engine.constructor.prototype;
  if (!proto || !proto.render || proto[PATCH_FLAG]) return null;

  var origRender = proto.render;
  proto[PATCH_FLAG] = true;

  proto.render = function () {
    if (!(this.options && this.options.showTags)) return origRender.call(this);
    var renderer = this.renderer;
    if (!renderer || !renderer.setData) return origRender.call(this);

    var origSD = renderer.setData;
    renderer.setData = function (data) {
      plugin.injectIntoGraphData(data);
      return origSD.call(this, data);
    };
    try {
      return origRender.call(this);
    } finally {
      renderer.setData = origSD;
    }
  };

  return function () {
    proto.render = origRender;
    delete proto[PATCH_FLAG];
  };
}

/* ─── Plugin ─── */

class TagGraphEdgesPlugin extends Plugin {

  constructor() {
    super(...arguments);
    this.tagIndex = new Map();
    this.tagRelations = new Map();  // parentTag → Set<childTag>
    this.enrichedCaches = new Map();
    this.unpatchers = [];
    this._initialized = false;
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
  }

  async onload() {
    var plugin = this;

    // Load settings before anything else
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Register settings tab
    this.addSettingTab(new TagGraphEdgesSettingTab(this.app, this));

    // Defer ALL work until the workspace + vault are ready
    this.app.workspace.onLayoutReady(function () {
      plugin.initialize();
    });

    // Retry on metadata-resolved in case layoutReady was too early
    this.registerEvent(
      this.app.metadataCache.on('resolved', function () {
        if (!plugin._initialized) {
          plugin.initialize();
        }
      })
    );

    // Keep index in sync with vault changes
    this.registerEvent(
      this.app.metadataCache.on('changed', function (file) {
        plugin.enrichedCaches.delete(file.path);
        plugin.indexFile(file).then(function () {
          plugin.injectResolvedLinks();
          plugin.refreshGraphViews();
        });
      })
    );
    this.registerEvent(
      this.app.vault.on('create', function (file) {
        if (file instanceof TFile && file.extension === 'md') {
          plugin.indexFile(file).then(function () {
            plugin.injectResolvedLinks();
            plugin.refreshGraphViews();
          });
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', function (file) {
        plugin.tagIndex.delete(file.path);
        plugin.enrichedCaches.delete(file.path);
        plugin.injectResolvedLinks();
        plugin.refreshGraphViews();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', function (file, oldPath) {
        plugin.tagIndex.delete(oldPath);
        plugin.enrichedCaches.delete(oldPath);
        if (file instanceof TFile && file.extension === 'md') {
          plugin.indexFile(file).then(function () {
            plugin.injectResolvedLinks();
            plugin.refreshGraphViews();
          });
        }
      })
    );

    // Watch for tag relations file changes
    this.registerEvent(
      this.app.vault.on('modify', function (file) {
        if (file.path === TAG_RELATIONS_FILE) {
          plugin.loadTagRelations().then(function () {
            plugin.refreshGraphViews();
            new Notice('Tag relations reloaded');
          });
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('create', function (file) {
        if (file.path === TAG_RELATIONS_FILE) {
          plugin.loadTagRelations().then(function () {
            plugin.refreshGraphViews();
          });
        }
      })
    );

    // Watch for new graph views opening
    this.registerEvent(
      this.app.workspace.on('layout-change', function () {
        if (plugin._initialized) plugin.patchGraphEngines();
      })
    );

    // Manual refresh command
    this.addCommand({
      id: 'refresh-tag-edges',
      name: 'Refresh tag graph edges',
      callback: function () {
        plugin._initialized = false;
        plugin.enrichedCaches.clear();
        plugin.initialize();
      },
    });

    // Debug dump command
    this.addCommand({
      id: 'debug-tag-edges',
      name: 'Dump tag-graph-edges debug info',
      callback: function () { plugin.dumpDebug(); },
    });

    // Bug report test command
    this.addCommand({
      id: 'test-bug-report',
      name: 'Test bug report (write a test entry)',
      callback: function () {
        plugin.appendBugReport(
          'Manual test entry — bug report is working',
          'test command',
          'test'
        ).then(function () {
          new Notice('Test entry written to ' + BUG_REPORT_FILE);
        });
      },
    });

    // Runtime self-test command
    this.addCommand({
      id: 'run-self-test',
      name: 'Run plugin self-test',
      callback: function () { plugin.runSelfTest(); },
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Remove all injected edges and patches before re-initializing with new settings
    this.removeAllResolvedLinks();
    for (var i = 0; i < this.unpatchers.length; i++) {
      try { this.unpatchers[i](); } catch (e) { /* ignore */ }
    }
    this.unpatchers = [];
    this.enrichedCaches.clear();
    this._initialized = false;
    await this.initialize();
  }

  async initialize() {
    try {
      var mdFiles = this.app.vault.getMarkdownFiles();

      // If vault isn't populated yet, bail — we'll retry on 'resolved'
      if (mdFiles.length === 0) {
        new Notice('Tag Graph Edges: vault has 0 md files — waiting...');
        await this.appendBugReport('vault.getMarkdownFiles() returned 0 files after layout-ready', 'initialize()', 'init');
        return;
      }

      // Build tag index
      this.tagIndex.clear();
      this.enrichedCaches.clear();
      var errors = [];
      for (var i = 0; i < mdFiles.length; i++) {
        try {
          await this.indexFile(mdFiles[i]);
        } catch (e) {
          errors.push(mdFiles[i].path + ': ' + String(e));
          await this.appendBugReport(String(e), mdFiles[i].path, 'indexFile');
        }
      }

      // Load tag-to-tag relations
      await this.loadTagRelations();

      // Check for stale tag relations (declared tags not present in any note)
      var uniqueTags = new Set();
      for (var entry of this.tagIndex.values()) {
        for (var t of entry) uniqueTags.add(t);
      }
      for (var relEntry of this.tagRelations) {
        var parentTag = relEntry[0];
        if (!uniqueTags.has(parentTag)) {
          await this.appendBugReport(
            'Tag "' + parentTag + '" declared in ' + TAG_RELATIONS_FILE + ' as parent but appears in no notes',
            TAG_RELATIONS_FILE, 'stale-relations'
          );
        }
        for (var childTag of relEntry[1]) {
          if (!uniqueTags.has(childTag)) {
            await this.appendBugReport(
              'Tag "' + childTag + '" declared in ' + TAG_RELATIONS_FILE + ' as child of "' + parentTag + '" but appears in no notes',
              TAG_RELATIONS_FILE, 'stale-relations'
            );
          }
        }
      }

      var relCount = 0;
      for (var children of this.tagRelations.values()) relCount += children.size;

      var msg = 'Tag Graph Edges: ' + uniqueTags.size + ' tags in ' +
        this.tagIndex.size + '/' + mdFiles.length + ' files, ' +
        relCount + ' tag relations';
      if (errors.length > 0) msg += ' (' + errors.length + ' errors)';
      new Notice(msg, 8000);

      if (errors.length > 0) {
        new Notice('Errors: ' + errors.join('; '), 10000);
      }

      // Strategy 1: Patch metadataCache (only once per load, respects settings)
      if (!this._initialized && this.settings.enableMetadataPatch) {
        this.patchMetadataCache();
      }

      // Strategy 2: Inject resolvedLinks (respects settings)
      if (this.settings.enableResolvedLinks) {
        this.injectResolvedLinks();
      }

      // Strategy 3: Patch graph engines + refresh (respects settings)
      if (this.settings.enableGraphPatch) {
        this.patchGraphEngines();
      }
      this.triggerFullRefresh();

      this._initialized = true;

    } catch (e) {
      new Notice('Tag Graph Edges INIT ERROR: ' + String(e), 15000);
      try { await this.appendBugReport(String(e), 'initialize()', 'init'); } catch (_) {}
    }
  }

  onunload() {
    this.removeAllResolvedLinks();
    for (var i = 0; i < this.unpatchers.length; i++) {
      try { this.unpatchers[i](); } catch (e) { /* ignore */ }
    }
    this.unpatchers = [];
    this.enrichedCaches.clear();
    this.refreshGraphViews();
  }

  /* ── Index a single file ── */

  async indexFile(file) {
    // Try Obsidian's native cache first
    var nativeCache = this.app.metadataCache.getFileCache(file);
    var tags = tagsFromCache(nativeCache);

    // Fallback: read raw content and parse YAML ourselves
    if (tags.size === 0) {
      var content = await this.app.vault.cachedRead(file);
      tags = tagsFromContent(content);
    }

    if (tags.size > 0) {
      this.tagIndex.set(file.path, tags);
    } else {
      this.tagIndex.delete(file.path);
    }
  }

  /* ── Tag-to-tag relations ── */

  async loadTagRelations() {
    this.tagRelations.clear();
    try {
      var content = await this.app.vault.adapter.read(TAG_RELATIONS_FILE);
      var data = JSON.parse(content);
      for (var parent in data) {
        if (!Object.prototype.hasOwnProperty.call(data, parent)) continue;
        var children = data[parent];
        if (!Array.isArray(children)) continue;
        var parentNorm = normalizeTag(parent);
        var childSet = new Set();
        for (var i = 0; i < children.length; i++) {
          if (typeof children[i] === 'string' && children[i].trim()) {
            childSet.add(normalizeTag(children[i]));
          }
        }
        if (childSet.size > 0) this.tagRelations.set(parentNorm, childSet);
      }
    } catch (e) {
      if (String(e).toLowerCase().includes('json') || String(e).toLowerCase().includes('parse')) {
        await this.appendBugReport(String(e), TAG_RELATIONS_FILE, 'loadTagRelations');
      }
      // File simply not existing is normal — no report needed
    }
  }

  /* ── Strategy 1: Patch metadataCache ── */

  patchMetadataCache() {
    var plugin = this;

    var origGFC = this.app.metadataCache.getFileCache;
    this.app.metadataCache.getFileCache = function (file) {
      var cache = origGFC.call(this, file);
      return plugin.enrichCache(file.path, cache);
    };
    this.unpatchers.push(function () {
      plugin.app.metadataCache.getFileCache = origGFC;
    });

    if (typeof this.app.metadataCache.getCache === 'function') {
      var origGC = this.app.metadataCache.getCache;
      this.app.metadataCache.getCache = function (path) {
        var cache = origGC.call(this, path);
        return plugin.enrichCache(path, cache);
      };
      this.unpatchers.push(function () {
        plugin.app.metadataCache.getCache = origGC;
      });
    }
  }

  enrichCache(filePath, cache) {
    var tags = this.tagIndex.get(filePath);
    if (!tags || tags.size === 0) return cache;

    // Don't override if Obsidian already parsed tags
    if (cache && cache.tags && cache.tags.length > 0) return cache;
    var fmTags = cache && cache.frontmatter && cache.frontmatter.tags;
    if (Array.isArray(fmTags) && fmTags.length > 0) return cache;

    if (this.enrichedCaches.has(filePath)) return this.enrichedCaches.get(filePath);

    var enriched = cache ? Object.assign({}, cache) : {};

    var tagStrings = [];
    for (var t of tags) tagStrings.push(t.replace(/^#/, ''));

    enriched.frontmatter = Object.assign(
      {}, enriched.frontmatter || {}, { tags: tagStrings }
    );

    var tagEntries = [];
    for (var tag of tags) {
      tagEntries.push({
        tag: tag,
        position: {
          start: { line: 0, col: 0, offset: 0 },
          end: { line: 0, col: 0, offset: 0 },
        },
      });
    }
    enriched.tags = (enriched.tags || []).concat(tagEntries);

    this.enrichedCaches.set(filePath, enriched);
    return enriched;
  }

  /* ── Strategy 2: Inject resolvedLinks (guaranteed edges) ── */

  // Returns a Map of "fileA\0fileB" (sorted) → shared-tag count,
  // filtered by excludedTags and minSharedTags settings.
  buildInjectionPairs() {
    var excluded = new Set(
      this.settings.excludedTags.map(function (t) { return normalizeTag(t); })
    );
    var minShared = this.settings.minSharedTags || 1;

    var tagToFiles = new Map();
    for (var entry of this.tagIndex) {
      var filePath = entry[0], tags = entry[1];
      for (var tag of tags) {
        if (excluded.has(tag)) continue;
        var arr = tagToFiles.get(tag);
        if (!arr) { arr = []; tagToFiles.set(tag, arr); }
        arr.push(filePath);
      }
    }

    var rawCounts = new Map();
    for (var pair of tagToFiles) {
      var files = pair[1];
      for (var i = 0; i < files.length; i++) {
        for (var j = i + 1; j < files.length; j++) {
          var a = files[i] < files[j] ? files[i] : files[j];
          var b = files[i] < files[j] ? files[j] : files[i];
          var key = a + '\0' + b;
          rawCounts.set(key, (rawCounts.get(key) || 0) + 1);
        }
      }
    }

    var result = new Map();
    for (var rc of rawCounts) {
      if (rc[1] >= minShared) result.set(rc[0], rc[1]);
    }
    return result;
  }

  injectResolvedLinks() {
    var rl = this.app.metadataCache.resolvedLinks;
    for (var pc of this.buildInjectionPairs()) {
      var parts = pc[0].split('\0');
      var a = parts[0], b = parts[1], count = pc[1];
      if (!rl[a]) rl[a] = {};
      if (!rl[b]) rl[b] = {};
      rl[a][b] = (rl[a][b] || 0) + count;
      rl[b][a] = (rl[b][a] || 0) + count;
    }
  }

  // Removes ALL tag-driven edges regardless of current settings.
  // Used during cleanup so stale edges are never left behind.
  removeAllResolvedLinks() {
    var rl = this.app.metadataCache.resolvedLinks;
    var tagToFiles = new Map();
    for (var entry of this.tagIndex) {
      var filePath = entry[0], tags = entry[1];
      for (var tag of tags) {
        var arr = tagToFiles.get(tag);
        if (!arr) { arr = []; tagToFiles.set(tag, arr); }
        arr.push(filePath);
      }
    }
    for (var pair of tagToFiles) {
      var files = pair[1];
      for (var i = 0; i < files.length; i++) {
        for (var j = i + 1; j < files.length; j++) {
          if (rl[files[i]]) delete rl[files[i]][files[j]];
          if (rl[files[j]]) delete rl[files[j]][files[i]];
        }
      }
    }
  }

  /* ── Strategy 3: Patch graph engine setData ── */

  patchGraphEngines() {
    var viewTypes = ['graph', 'localgraph'];
    for (var v = 0; v < viewTypes.length; v++) {
      var leaves = this.app.workspace.getLeavesOfType(viewTypes[v]);
      for (var i = 0; i < leaves.length; i++) {
        var view = leaves[i].view;
        if (!view) continue;
        var engine = view.engine || view.dataEngine || view.renderer;
        if (!engine) continue;
        var unpatch = patchEngine(this, engine);
        if (unpatch) {
          this.unpatchers.push(unpatch);
          if (typeof engine.render === 'function') engine.render();
        }
      }
    }
  }

  injectIntoGraphData(data) {
    var nodes = data.nodes;
    var excluded = new Set(
      this.settings.excludedTags.map(function (t) { return normalizeTag(t); })
    );

    // Actively remove excluded tag nodes the engine may have added from its own
    // cache read (Strategy 1 enriches the cache, so the engine sees all tags
    // including excluded ones and adds them before setData fires).
    for (var excTag of excluded) {
      delete nodes[excTag];
    }
    // Also remove any links pointing TO excluded tags from every other node
    var nodeKeys = Object.keys(nodes);
    for (var k = 0; k < nodeKeys.length; k++) {
      var node = nodes[nodeKeys[k]];
      if (node && node.links) {
        for (var excTag2 of excluded) {
          delete node.links[excTag2];
        }
      }
    }

    // File → tag edges (skip excluded tags)
    for (var entry of this.tagIndex) {
      var filePath = entry[0], tags = entry[1];
      if (!nodes[filePath]) continue;
      for (var tag of tags) {
        if (excluded.has(tag)) continue;
        if (!nodes[tag]) nodes[tag] = { type: 'tag', links: {} };
        nodes[filePath].links[tag] = true;
      }
    }

    // Tag → tag edges from _tag_relations.json (skip excluded tags)
    for (var rel of this.tagRelations) {
      var parentTag = rel[0], childTags = rel[1];
      if (excluded.has(parentTag)) continue;
      if (!nodes[parentTag]) nodes[parentTag] = { type: 'tag', links: {} };
      for (var childTag of childTags) {
        if (excluded.has(childTag)) continue;
        if (!nodes[childTag]) nodes[childTag] = { type: 'tag', links: {} };
        nodes[parentTag].links[childTag] = true;
      }
    }
  }

  /* ── Refresh ── */

  triggerFullRefresh() {
    this.app.metadataCache.trigger('resolved');
    this.refreshGraphViews();
  }

  refreshGraphViews() {
    var viewTypes = ['graph', 'localgraph'];
    for (var v = 0; v < viewTypes.length; v++) {
      var leaves = this.app.workspace.getLeavesOfType(viewTypes[v]);
      for (var i = 0; i < leaves.length; i++) {
        var view = leaves[i].view;
        if (!view) continue;
        var engine = view.engine || view.dataEngine || view.renderer;
        if (engine && typeof engine.render === 'function') engine.render();
      }
    }
  }

  /* ── Bug report ── */

  async appendBugReport(message, context, strategy) {
    var ts = new Date().toISOString();
    var version = (this.manifest && this.manifest.version) || '?';
    var header = '## ' + ts + ' — v' + version;
    if (strategy) header += ' [' + strategy + ']';
    var lines = [header];
    if (context) lines.push('**Context:** ' + context);
    lines.push('**Error:** ' + message);
    lines.push('');
    var entry = lines.join('\n');

    var existing = '';
    try {
      existing = await this.app.vault.adapter.read(BUG_REPORT_FILE);
    } catch (e) {
      // File doesn't exist yet — start fresh with a header
      existing = '# Tag Graph Edges — Bug Report\n\nAuto-generated. Each entry is appended by the plugin on error or unexpected state.\n\n';
    }
    await this.app.vault.adapter.write(BUG_REPORT_FILE, existing + entry);
  }

  /* ── Self-test ── */

  async runSelfTest() {
    var results = [];
    var pass = 0, fail = 0;
    var plugin = this;

    function check(name, ok, reason) {
      results.push({ name: name, ok: ok, reason: reason });
      if (ok) pass++; else fail++;
    }

    // Step 1: Vault has markdown files
    var mdFiles = this.app.vault.getMarkdownFiles();
    check(
      'Vault has markdown files',
      mdFiles.length > 0,
      mdFiles.length + ' markdown file(s) found'
    );

    // Step 2: tagIndex is non-empty
    check(
      'Tag index is non-empty',
      this.tagIndex.size > 0,
      this.tagIndex.size + ' file(s) indexed'
    );

    // Pick the first indexed file for remaining tests
    var testPath = null, testTags = null;
    for (var e of this.tagIndex) { testPath = e[0]; testTags = e[1]; break; }

    if (!testPath) {
      check('Sample file available for further tests', false, 'tagIndex is empty — skipping remaining tests');
    } else {
      // Step 3: That file has edges in resolvedLinks
      var rl = this.app.metadataCache.resolvedLinks;
      var rlEntry = rl[testPath];
      var edgeCount = rlEntry ? Object.keys(rlEntry).length : 0;
      check(
        'Sample file has resolvedLinks edges',
        edgeCount > 0,
        '"' + testPath + '" → ' + edgeCount + ' edge(s) in resolvedLinks'
      );

      // Step 4: Patched getFileCache returns enriched tags for the sample file
      var testFile = this.app.vault.getAbstractFileByPath(testPath);
      var enrichedCache = testFile ? this.app.metadataCache.getFileCache(testFile) : null;
      var cacheTags = enrichedCache ? tagsFromCache(enrichedCache) : new Set();
      var firstIndexedTag = testTags ? testTags.values().next().value : null;
      var tagFound = firstIndexedTag !== null && (
        cacheTags.has(firstIndexedTag) ||
        cacheTags.has(firstIndexedTag.replace(/^#/, ''))
      );
      check(
        'Patched getFileCache returns enriched tags',
        tagFound,
        'cache tags: [' + Array.from(cacheTags).join(', ') + '] | index tags: [' + Array.from(testTags || []).join(', ') + ']'
      );

      // Step 5: PATCH_FLAG exists on at least one open graph engine prototype
      var patched = false;
      var viewTypes = ['graph', 'localgraph'];
      outer: for (var v = 0; v < viewTypes.length; v++) {
        var leaves = this.app.workspace.getLeavesOfType(viewTypes[v]);
        for (var l = 0; l < leaves.length; l++) {
          var view = leaves[l].view;
          if (!view) continue;
          var engine = view.engine || view.dataEngine || view.renderer;
          if (!engine) continue;
          var proto = engine.constructor && engine.constructor.prototype;
          if (proto && proto[PATCH_FLAG]) { patched = true; break outer; }
        }
      }
      check(
        'Graph engine prototype is patched (' + PATCH_FLAG + ')',
        patched,
        patched
          ? 'flag found on engine prototype'
          : 'no open graph/localgraph view has the patch flag — open a graph view then retry'
      );
    }

    // Write results to _tag_selftest.md
    var ts = new Date().toISOString();
    var version = (this.manifest && this.manifest.version) || '?';
    var lines = [
      '# Tag Graph Edges — Self-Test',
      '',
      '**Run:** ' + ts + '  |  **Version:** v' + version,
      '**Result:** ' + pass + ' PASS / ' + fail + ' FAIL',
      '',
      '## Steps',
      '',
    ];
    for (var r = 0; r < results.length; r++) {
      var res = results[r];
      lines.push((res.ok ? '- ✅ PASS' : '- ❌ FAIL') + ' — **' + res.name + '**');
      lines.push('  - ' + res.reason);
    }
    await this.app.vault.adapter.write(SELF_TEST_FILE, lines.join('\n'));

    var summary = 'Self-test: ' + pass + '/' + (pass + fail) + ' passed';
    if (fail > 0) summary += ' — see Developer/_tag_selftest.md for details';
    new Notice(summary, 8000);
  }

  /* ── Debug ── */

  async dumpDebug() {
    var lines = ['# Tag Graph Edges Debug', ''];

    lines.push('## Vault');
    var mdFiles = this.app.vault.getMarkdownFiles();
    lines.push('- getMarkdownFiles(): ' + mdFiles.length + ' files');
    for (var f = 0; f < mdFiles.length; f++) {
      lines.push('  - ' + mdFiles[f].path);
    }

    lines.push('', '## Tag index (' + this.tagIndex.size + ' entries)');
    for (var entry of this.tagIndex) {
      lines.push('- ' + entry[0] + ': ' + Array.from(entry[1]).join(', '));
    }

    lines.push('', '## resolvedLinks');
    var rl = this.app.metadataCache.resolvedLinks;
    var rlKeys = Object.keys(rl);
    lines.push('- Total source files: ' + rlKeys.length);
    for (var r = 0; r < rlKeys.length; r++) {
      var targets = Object.keys(rl[rlKeys[r]]);
      if (targets.length > 0) {
        lines.push('- ' + rlKeys[r] + ' -> ' + targets.join(', '));
      }
    }

    lines.push('', '## Graph views');
    var viewTypes = ['graph', 'localgraph'];
    for (var v = 0; v < viewTypes.length; v++) {
      var leaves = this.app.workspace.getLeavesOfType(viewTypes[v]);
      lines.push('- ' + viewTypes[v] + ': ' + leaves.length + ' leaves');
      for (var l = 0; l < leaves.length; l++) {
        var view = leaves[l].view;
        lines.push('  - view: ' + !!view);
        if (view) {
          var vKeys = [];
          try {
            vKeys = Object.getOwnPropertyNames(view).concat(
              Object.getOwnPropertyNames(Object.getPrototypeOf(view) || {})
            );
          } catch (e) { vKeys = ['(error: ' + e + ')']; }
          lines.push('  - view own+proto keys: ' + vKeys.join(', '));
          var engine = view.engine || view.dataEngine || view.renderer;
          lines.push('  - engine: ' + !!engine + ' (via ' +
            (view.engine ? 'engine' : view.dataEngine ? 'dataEngine' : view.renderer ? 'renderer' : 'none') + ')');
          if (engine) {
            var eKeys = [];
            try {
              eKeys = Object.getOwnPropertyNames(engine).concat(
                Object.getOwnPropertyNames(Object.getPrototypeOf(engine) || {})
              );
            } catch (e) { eKeys = ['(error: ' + e + ')']; }
            lines.push('  - engine keys: ' + eKeys.join(', '));
          }
        }
      }
    }

    lines.push('', '## Raw content test (note_1.md)');
    try {
      var testFile = this.app.vault.getAbstractFileByPath('note_1.md');
      if (testFile && testFile instanceof TFile) {
        var content = await this.app.vault.cachedRead(testFile);
        lines.push('- length: ' + content.length);
        lines.push('- first 20 chars: ' + JSON.stringify(content.slice(0, 20)));
        var parsedTags = tagsFromContent(content);
        lines.push('- parsed tags: ' + (parsedTags.size > 0 ? Array.from(parsedTags).join(', ') : '(none)'));
      } else {
        lines.push('- note_1.md not found via getAbstractFileByPath');
      }
    } catch (e) {
      lines.push('- ERROR: ' + String(e));
    }

    var dump = lines.join('\n');
    await this.app.vault.adapter.write('_tag_debug.md', dump);
    new Notice('Debug written to _tag_debug.md — open it to see results');
  }
}

/* ─── Settings tab ─── */

class TagGraphEdgesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    var plugin = this.plugin;
    var tab = this;
    var containerEl = this.containerEl;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Tag Graph Edges' });

    // ── Excluded tags ──
    containerEl.createEl('h3', { text: 'Excluded tags' });

    // Build tag → note count from current index, sorted by count descending
    var tagNoteCounts = new Map();
    for (var idxEntry of plugin.tagIndex) {
      for (var idxTag of idxEntry[1]) {
        tagNoteCounts.set(idxTag, (tagNoteCounts.get(idxTag) || 0) + 1);
      }
    }
    var sortedTags = Array.from(tagNoteCounts.keys()).sort(function (a, b) {
      return tagNoteCounts.get(b) - tagNoteCounts.get(a);
    });

    // Normalised set for quick lookup
    var excludedNormSet = new Set(
      plugin.settings.excludedTags.map(function (t) { return normalizeTag(t); })
    );
    var excludedCount = sortedTags.filter(function (t) { return excludedNormSet.has(t); }).length;

    // Intro row with refresh button
    var introEl = containerEl.createEl('div', { cls: 'setting-item-description' });
    introEl.style.marginBottom = '12px';
    introEl.createEl('span', {
      text: 'Each tag found in the vault is listed below with a note count. ' +
        'Toggle a tag ' + '\u2019' + 'off\u2019 to stop it generating any graph edges across all three strategies ' +
        '— useful for tags shared by every note that create a fully-connected mess. ' +
        'Notes still appear in the graph; only the edges driven by that tag are removed.',
    });
    introEl.createEl('br');
    introEl.createEl('br');
    introEl.createEl('b', { text: 'Example: ' });
    introEl.createEl('code', { text: 'project-home' });
    introEl.createEl('span', {
      text: ' is on every note. With it enabled, all 5 notes are directly connected to each other.' +
        ' Toggle it off and only notes that share a second tag stay connected.',
    });
    introEl.createEl('br');
    introEl.createEl('br');

    new Setting(containerEl)
      .setName(sortedTags.length + ' tag(s) in vault \u2014 ' + excludedCount + ' excluded')
      .addButton(function (button) {
        button
          .setButtonText('Refresh tag list')
          .setTooltip('Re-scan the vault index for tags — use after adding or removing notes')
          .onClick(function () { tab.display(); });
      });

    if (sortedTags.length === 0) {
      containerEl.createEl('p', {
        text: 'No tags found. Make sure the plugin has finished initialising (check for the startup Notice), then click Refresh.',
        cls: 'setting-item-description',
      });
    }

    sortedTags.forEach(function (tag) {
      var isExcluded = excludedNormSet.has(tag);
      var noteCount = tagNoteCounts.get(tag) || 0;
      var bareTag = tag.replace(/^#/, '');

      var row = new Setting(containerEl)
        .setName(tag)
        .setDesc(noteCount + (noteCount === 1 ? ' note' : ' notes'))
        .addToggle(function (toggle) {
          toggle
            .setValue(!isExcluded)   // ON = included in graph, OFF = excluded
            .onChange(async function (value) {
              if (value) {
                // Re-include: remove from excludedTags
                plugin.settings.excludedTags = plugin.settings.excludedTags.filter(function (t) {
                  return normalizeTag(t) !== tag;
                });
              } else {
                // Exclude: add bare tag name (no #)
                var normBare = bareTag.toLowerCase();
                var already = plugin.settings.excludedTags.some(function (t) {
                  return t.toLowerCase().trim() === normBare;
                });
                if (!already) plugin.settings.excludedTags.push(bareTag);
              }
              await plugin.saveSettings();
            });
        });

      // Dim excluded rows so the active set is visually clear
      if (isExcluded) {
        row.nameEl.style.opacity = '0.45';
        row.descEl.style.opacity = '0.45';
      }
    });

    // ── Min shared tags ──
    var minSetting = new Setting(containerEl)
      .setName('Minimum shared tags')
      .addSlider(function (slider) {
        slider
          .setLimits(1, 5, 1)
          .setValue(plugin.settings.minSharedTags)
          .setDynamicTooltip()
          .onChange(async function (value) {
            plugin.settings.minSharedTags = value;
            await plugin.saveSettings();
          });
      });

    var minDesc = minSetting.descEl;
    minDesc.createEl('span', {
      text: 'Controls how many tags two notes must share before a direct note-to-note edge is drawn. Only affects Strategy 2 (resolvedLinks). Default is 1 — any shared tag creates an edge.',
    });
    minDesc.createEl('br');
    minDesc.createEl('br');
    minDesc.createEl('b', { text: 'When to use: ' });
    minDesc.createEl('span', {
      text: 'When you want only "strong" connections visible. Raise the threshold to filter out notes that happen to share one broad tag but are otherwise unrelated.',
    });
    minDesc.createEl('br');
    minDesc.createEl('br');
    minDesc.createEl('b', { text: 'Example: ' });
    minDesc.createEl('span', { text: 'Set to 2. note_1 and note_2 share ' });
    minDesc.createEl('code', { text: 'project-home' });
    minDesc.createEl('span', { text: ' + ' });
    minDesc.createEl('code', { text: 'project-1' });
    minDesc.createEl('span', { text: ' (2 tags) → edge kept. note_1 and note_3 share only ' });
    minDesc.createEl('code', { text: 'project-home' });
    minDesc.createEl('span', { text: ' (1 tag) → edge removed.' });
    minDesc.createEl('br');
    minDesc.createEl('br');
    minDesc.createEl('b', { text: 'Why it may look unchanged: ' });
    minDesc.createEl('span', {
      text: 'When Strategy 3 is active and "Show tags" is on in the graph, notes still appear visually connected through shared tag hub nodes even after their direct edge is removed. To see this setting take effect clearly, either disable Strategy 3 below, or turn off "Show tags" in the graph panel.',
    });

    // ── Strategy toggles ──
    containerEl.createEl('h3', { text: 'Strategy toggles' });

    var stratIntro = containerEl.createEl('p', { cls: 'setting-item-description' });
    stratIntro.createEl('span', {
      text: 'The plugin uses three independent strategies to inject edges. All are active by default. ' +
        'They are designed to work together — disabling one is useful for debugging or isolating behaviour, ' +
        'not for normal use.',
    });

    // Strategy 1
    var s1 = new Setting(containerEl)
      .setName('Strategy 1 — Patch metadataCache')
      .addToggle(function (toggle) {
        toggle
          .setValue(plugin.settings.enableMetadataPatch)
          .onChange(async function (value) {
            plugin.settings.enableMetadataPatch = value;
            await plugin.saveSettings();
          });
      });

    var s1Desc = s1.descEl;
    s1Desc.createEl('span', {
      text: 'Monkey-patches Obsidian\'s internal cache read methods (',
    });
    s1Desc.createEl('code', { text: 'getFileCache' });
    s1Desc.createEl('span', { text: ' / ' });
    s1Desc.createEl('code', { text: 'getCache' });
    s1Desc.createEl('span', {
      text: '). When the native cache has no tags (because of the leading blank line before ' +
        '--- in these notes), this strategy inserts the tags parsed from raw file content. ' +
        'Downstream Obsidian features — tag pane, ',
    });
    s1Desc.createEl('code', { text: 'tag:' });
    s1Desc.createEl('span', { text: ' search, backlinks — all start working correctly.' });
    s1Desc.createEl('br');
    s1Desc.createEl('br');
    s1Desc.createEl('b', { text: 'When to turn off: ' });
    s1Desc.createEl('span', {
      text: 'Debugging only. Disabling lets you confirm what Obsidian would return natively — ' +
        'the tag pane and tag: search will go blank for notes with a leading blank line.',
    });

    // Strategy 2
    var s2 = new Setting(containerEl)
      .setName('Strategy 2 — Inject resolvedLinks')
      .addToggle(function (toggle) {
        toggle
          .setValue(plugin.settings.enableResolvedLinks)
          .onChange(async function (value) {
            plugin.settings.enableResolvedLinks = value;
            await plugin.saveSettings();
          });
      });

    var s2Desc = s2.descEl;
    s2Desc.createEl('span', {
      text: 'Writes note-to-note edges directly into ',
    });
    s2Desc.createEl('code', { text: 'metadataCache.resolvedLinks' });
    s2Desc.createEl('span', {
      text: ' — the data structure the global graph reads to draw connections. ' +
        'This is the most reliable strategy: it works regardless of which graph view is open ' +
        'or whether "Show tags" is on. Edges are direct note-to-note lines (no hub node).',
    });
    s2Desc.createEl('br');
    s2Desc.createEl('br');
    s2Desc.createEl('b', { text: 'Respects: ' });
    s2Desc.createEl('span', {
      text: 'excluded tags and the minimum shared-tag threshold above.',
    });
    s2Desc.createEl('br');
    s2Desc.createEl('br');
    s2Desc.createEl('b', { text: 'When to turn off: ' });
    s2Desc.createEl('span', {
      text: 'Debugging. Disabling removes all direct note-to-note edges from the global graph. ' +
        'Use this to confirm that Strategy 3 alone is sufficient in your Obsidian version.',
    });

    // Strategy 3
    var s3 = new Setting(containerEl)
      .setName('Strategy 3 — Patch graph engine')
      .addToggle(function (toggle) {
        toggle
          .setValue(plugin.settings.enableGraphPatch)
          .onChange(async function (value) {
            plugin.settings.enableGraphPatch = value;
            await plugin.saveSettings();
          });
      });

    var s3Desc = s3.descEl;
    s3Desc.createEl('span', {
      text: 'Intercepts the graph engine\'s ',
    });
    s3Desc.createEl('code', { text: 'setData()' });
    s3Desc.createEl('span', {
      text: ' call to inject tag hub nodes and file-to-tag edges. ' +
        'Produces hub-and-spoke topology: notes connect through visible tag nodes rather than ' +
        'directly to each other. Also the only strategy that draws tag-to-tag relation edges ' +
        'defined in ',
    });
    s3Desc.createEl('code', { text: '_tag_relations.json' });
    s3Desc.createEl('span', { text: '.' });
    s3Desc.createEl('br');
    s3Desc.createEl('br');
    s3Desc.createEl('b', { text: 'Requires: ' });
    s3Desc.createEl('span', {
      text: '"Show tags" must be enabled in the graph panel for this strategy to fire. ' +
        'If "Show tags" is off, the engine skips tag rendering entirely and this strategy has no effect.',
    });
    s3Desc.createEl('br');
    s3Desc.createEl('br');
    s3Desc.createEl('b', { text: 'When to turn off: ' });
    s3Desc.createEl('span', {
      text: 'If you prefer direct note-to-note lines without tag hub nodes in the graph, ' +
        'or to make the "Minimum shared tags" threshold visually testable ' +
        '(Strategy 2 direct edges become the only visible connections).',
    });
  }
}

exports.default = TagGraphEdgesPlugin;
