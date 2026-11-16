"use strict";
// Consistent System Design
//
// 1. Component styles (styles.css): tag a node `:::db`, `:::service`, ...
// 2. Automatic shapes: a tagged node that has no shape of its own gets its
//    role's shape (db -> cylinder, queue -> horizontal cylinder, ...).
// 3. Keep direction: Obsidian's diagram renderer, Pele, re-lays out an
//    LR/RL diagram top-down when it is wider than the note.
//
// Obsidian draws every diagram through the global `pele.mount()`, so this
// plugin swaps in a copy of `pele` whose mount() adjusts the source (2) and
// passes Pele's own `autoDirection: false` option (3).

const { Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = { keepDirection: true, autoShapes: true };

// patched pele -> the pele it wraps
const originals = new WeakMap();

// Shape each component class gets when the node has none of its own.
// Classes not listed here (gateway, service, worker, external) stay boxes.
const SHAPES = {
  client: "stadium",
  cdn: "cloud",
  lb: "hex",
  db: "cyl",
  cache: "cyl",
  queue: "h-cyl",
  storage: "bucket",
};

const COMPONENTS = new Set(["client", "cdn", "gateway", "lb", "service", "worker", "db", "cache", "queue", "storage", "external"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A node, optionally with a shape and label, followed by `:::classes`.
// Unquoted labels can't contain closing brackets, which keeps a match from
// running across `A[x] --> B[y]:::db`.
const NODE_WITH_CLASS = new RegExp(
  String.raw`(?:^|[^\w-])([A-Za-z0-9_][\w-]*)\s*` +
  String.raw`(?:@\{[^}\n]*\}|(?:\[\(|\(\[|\[\[|\{\{|\(\(\(|\(\(|\[\/|\[\\|\[|\(|\{|>)(?:"[^"\n]*"|[^\]\)\}\n"])*(?:\)\]|\]\)|\]\]|\}\}|\)\)\)|\)\)|\/\]|\\\]|\]|\)|\}))?` +
  String.raw`:::([\w-]+(?:,[\w-]+)*)`,
  "g"
);
const CLASS_STATEMENT = /^\s*class\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*;?\s*$/gm;
const SUBGRAPH = /^\s*subgraph\s+([\w-]+)/gm;

// Give tagged nodes their role's shape by appending `ID@{ shape: ... }`
// lines, which Pele applies on top of the node's earlier definition.
function addShapes(source) {
  if (!/^\s*(?:flowchart|graph)\b/m.test(source)) return source;
  if (/^\s*%%\s*csd:\s*no-shapes\s*$/m.test(source)) return source;

  const classesOf = new Map();
  const tag = (id, classes) => {
    for (const cls of classes) {
      if (!COMPONENTS.has(cls)) continue;
      if (!classesOf.has(id)) classesOf.set(id, cls);
    }
  };
  for (const m of source.matchAll(NODE_WITH_CLASS)) tag(m[1], m[2].split(","));
  for (const m of source.matchAll(CLASS_STATEMENT)) {
    const classes = m[2].split(",").map((s) => s.trim());
    for (const id of m[1].split(",")) tag(id.trim(), classes);
  }

  const subgraphs = new Set([...source.matchAll(SUBGRAPH)].map((m) => m[1]));
  const lines = [];
  for (const [id, cls] of classesOf) {
    const shape = SHAPES[cls];
    if (!shape || subgraphs.has(id)) continue;
    // Leave nodes whose shape was written out: anything but a plain [box].
    const explicit = new RegExp(
      String.raw`(?:^|[^\w-])${escapeRe(id)}\s*(?:\[\(|\(\[|\[\[|\[\/|\[\\|\{|\(|>|@\{)`,
      "m"
    );
    if (explicit.test(source)) continue;
    lines.push(`${id}@{ shape: ${shape} }`);
  }
  return lines.length ? `${source.replace(/\s*$/, "")}\n${lines.join("\n")}\n` : source;
}

module.exports = class ConsistentSystemDesign extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new ConsistentSystemDesignSettingTab(this.app, this));
    this.patchPele();
  }

  onunload() {
    this.active = false;
    this.restorePele?.();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  patchPele() {
    this.active = true;
    const plugin = this;

    const wrap = (pele) => {
      if (!pele || typeof pele.mount !== "function" || originals.has(pele)) return pele;
      const realMount = pele.mount;
      // Pele's exports are read-only getters, so build a plain copy. Own,
      // enumerable properties keep the copy usable by other plugins that
      // spread `pele` into their own wrapper.
      const prepareSource = (source) =>
        plugin.active && plugin.settings.autoShapes && typeof source === "string" ? addShapes(source) : source;
      const prepareOptions = (options) =>
        plugin.active && plugin.settings.keepDirection && options ? { ...options, autoDirection: false } : options;

      const patched = {
        ...pele,
        mount(el, source, options = {}) {
          const handle = realMount.call(pele, el, prepareSource(source), prepareOptions(options));
          // Obsidian re-renders through update() (for example after a link
          // resolves), so prepare that source too.
          if (handle && typeof handle.update === "function") {
            const update = handle.update;
            handle.update = (next, nextOptions) =>
              update.call(handle, prepareSource(next), prepareOptions(nextOptions));
          }
          return handle;
        },
      };
      originals.set(patched, pele);
      return patched;
    };

    if (window.pele) {
      window.pele = wrap(window.pele);
      this.restorePele = () => {
        if (originals.has(window.pele)) window.pele = originals.get(window.pele);
        // If another plugin wrapped ours since, leave it: `active` is now
        // false, so our mount() passes straight through.
      };
      return;
    }

    // Obsidian loads Pele lazily (`var pele = ...` in a script tag), so catch
    // it as it arrives.
    let current;
    Object.defineProperty(window, "pele", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => { current = plugin.active ? wrap(value) : value; },
    });
    this.restorePele = () => {
      const value = originals.get(current) ?? current;
      delete window.pele;
      if (value !== undefined) window.pele = value;
    };
  }
};

class ConsistentSystemDesignSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Automatic shapes")
      .setDesc(
        "Give tagged nodes their role's shape when you haven't written one: " +
        ":::db and :::cache become cylinders, :::queue a horizontal cylinder, " +
        ":::storage a bucket, :::cdn a cloud, :::lb a hexagon and :::client a pill. " +
        "Add %% csd: no-shapes to a diagram to skip it. Reopen a note to see the change."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoShapes).onChange(async (value) => {
          this.plugin.settings.autoShapes = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Keep diagram direction")
      .setDesc(
        "Stop wide left-to-right diagrams from being redrawn top-down. " +
        "They are scaled down to fit instead. Reopen a note to see the change."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.keepDirection).onChange(async (value) => {
          this.plugin.settings.keepDirection = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Component style")
      .setDesc(
        "Choose Soft, Outline or Solid for :::db, :::service and the other component " +
        "classes in Style Settings (Consistent System Design), if you have that plugin. " +
        "Without it, components use Soft."
      );
  }
}
