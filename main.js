"use strict";
// Consistent System Design
//
// 1. Component styles (styles.css): tag a node `:::db`, `:::service`, ...
// 2. Automatic shapes: a tagged node that has no shape of its own gets its
//    role's shape (db -> cylinder, queue -> horizontal cylinder, ...).
// 3. Keep direction: Obsidian's diagram renderer, Pele, re-lays out an
//    LR/RL diagram top-down when it is wider than the note.
// 4. Settings: colours, shapes, borders and look per role, plus custom roles.
//
// Obsidian draws every diagram through the global `pele.mount()`, so this
// plugin swaps in a copy of `pele` whose mount() adjusts the source (2, 4)
// and passes Pele's own `autoDirection: false` option (3).

const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

// ---------------------------------------------------------------------------
// Roles and shapes

const BUILT_IN_ROLES = [
  { id: "client", name: "Client", desc: "Users, browsers, mobile apps", color: "var(--text-muted)", shape: "stadium", dashed: false },
  { id: "cdn", name: "CDN", desc: "CDN, edge", color: "var(--color-cyan)", shape: "cloud", dashed: false },
  { id: "gateway", name: "Gateway", desc: "API gateway", color: "var(--color-pink)", shape: "rect", dashed: false },
  { id: "lb", name: "Load balancer", desc: "Load balancer", color: "var(--color-purple)", shape: "hex", dashed: false },
  { id: "service", name: "Service", desc: "App or API service", color: "var(--color-blue)", shape: "rect", dashed: false },
  { id: "worker", name: "Worker", desc: "Async worker, background job", color: "var(--color-blue)", shape: "rect", dashed: true },
  { id: "db", name: "Database", desc: "Database", color: "var(--color-green)", shape: "cyl", dashed: false },
  { id: "cache", name: "Cache", desc: "Redis, Memcached", color: "var(--color-red)", shape: "cyl", dashed: false },
  { id: "queue", name: "Queue", desc: "Queue or stream (Kafka, SQS)", color: "var(--color-orange)", shape: "h-cyl", dashed: false },
  { id: "storage", name: "Storage", desc: "Object or blob storage", color: "var(--color-yellow)", shape: "bucket", dashed: false },
  { id: "external", name: "External", desc: "Third-party service", color: "var(--text-muted)", shape: "rect", dashed: true },
];
const BUILT_IN = new Map(BUILT_IN_ROLES.map((r) => [r.id, r]));

// Pele shape names, as offered in the settings
const SHAPE_OPTIONS = {
  rect: "Box",
  rounded: "Rounded box",
  stadium: "Pill",
  cyl: "Cylinder",
  "h-cyl": "Horizontal cylinder",
  "lin-cyl": "Disk",
  bucket: "Bucket",
  cloud: "Cloud",
  hex: "Hexagon",
  "st-rect": "Stacked boxes",
  "fr-rect": "Box with side bars",
  doc: "Document",
  docs: "Stacked documents",
  circle: "Circle",
  diam: "Diamond",
  person: "Person",
  browser: "Browser window",
  console: "Console",
};

const DASH = "5 3";
const LOOKS = { default: "Default (Style Settings, or Soft)", soft: "Soft", outline: "Outline", solid: "Solid" };
const SLIDERS = [
  { key: "fillScale", cssVar: "--csd-fill-scale", name: "Tint strength", desc: "How strongly fills are tinted.", min: 0, max: 3, step: 0.05, def: 1, unit: "" },
  { key: "strokeScale", cssVar: "--csd-stroke-scale", name: "Border strength", desc: "How strongly borders are coloured.", min: 0.25, max: 1.6, step: 0.05, def: 1, unit: "" },
  { key: "radius", cssVar: "--csd-radius", name: "Corner radius", desc: "Rounding on box corners, in pixels.", min: 0, max: 24, step: 1, def: 8, unit: "px" },
  { key: "borderWidth", cssVar: "--csd-border-width", name: "Border width", desc: "In pixels.", min: 0.5, max: 4, step: 0.25, def: 1.5, unit: "px" },
];

const DEFAULT_SETTINGS = {
  keepDirection: true,
  autoShapes: true,
  look: "default",
  // null = use the default (or Style Settings)
  fillScale: null,
  strokeScale: null,
  radius: null,
  borderWidth: null,
  // per built-in role: { color: "#rrggbb" | null, shape: string | null, dashed: boolean | null }
  roles: {},
  // [{ id, color, shape, dashed }]
  customRoles: [],
};

const ROLE_ID = /^[a-z][a-z0-9-]*$/;
const RESERVED = /^(csd|pele|sd-|csd-|tint-|default$)/;

function roleError(id, plugin, self) {
  if (!ROLE_ID.test(id)) return "Use lowercase letters, numbers and dashes, starting with a letter.";
  if (BUILT_IN.has(id)) return `"${id}" is a built-in role.`;
  if (RESERVED.test(id)) return `"${id}" is reserved.`;
  if (plugin.settings.customRoles.some((r) => r !== self && r.id === id)) return `"${id}" is already a role.`;
  return null;
}

// ---------------------------------------------------------------------------
// Source rewriting: shapes, and the "csd" marker class for custom roles

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

// roles: Map of role id -> { shape, custom, dashed }
function prepareFlowchart(source, roles, autoShapes) {
  if (!/^\s*(?:flowchart|graph)\b/m.test(source)) return source;

  const roleOf = new Map();
  const tag = (id, classes) => {
    for (const cls of classes) {
      if (roles.has(cls) && !roleOf.has(id)) roleOf.set(id, cls);
    }
  };
  for (const m of source.matchAll(NODE_WITH_CLASS)) tag(m[1], m[2].split(","));
  for (const m of source.matchAll(CLASS_STATEMENT)) {
    const classes = m[2].split(",").map((s) => s.trim());
    for (const id of m[1].split(",")) tag(id.trim(), classes);
  }
  if (!roleOf.size) return source;

  const subgraphs = new Set([...source.matchAll(SUBGRAPH)].map((m) => m[1]));
  const shapesOn = autoShapes && !/^\s*%%\s*csd:\s*no-shapes\s*$/m.test(source);
  const lines = [];
  const marked = [];
  const dashed = [];

  for (const [id, roleId] of roleOf) {
    const role = roles.get(roleId);
    if (role.custom) {
      marked.push(id);
      if (role.dashed) dashed.push(id);
    }
    if (!shapesOn || subgraphs.has(id) || !role.shape || role.shape === "rect") continue;
    // Leave nodes whose shape was written out: anything but a plain [box].
    const explicit = new RegExp(
      String.raw`(?:^|[^\w-])${escapeRe(id)}\s*(?:\[\(|\(\[|\[\[|\[\/|\[\\|\{|\(|>|@\{)`,
      "m"
    );
    if (explicit.test(source)) continue;
    lines.push(`${id}@{ shape: ${role.shape} }`);
  }
  if (marked.length) lines.push(`class ${marked.join(",")} csd`);
  if (dashed.length) lines.push(`class ${dashed.join(",")} csd-dashed`);
  return lines.length ? `${source.replace(/\s*$/, "")}\n${lines.join("\n")}\n` : source;
}

// ---------------------------------------------------------------------------
// Colours

// Resolve any CSS colour (including var(...)) to #rrggbb, for colour pickers.
function toHex(doc, color) {
  const probe = doc.createElement("div");
  probe.style.color = color;
  probe.style.display = "none";
  doc.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const ctx = doc.createElement("canvas").getContext("2d");
  if (!ctx) return "#888888";
  ctx.fillStyle = "#888888";
  ctx.fillStyle = rgb;
  const out = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(out) ? out : "#888888";
}

// ---------------------------------------------------------------------------
// Plugin

// patched pele -> the pele it wraps
const originals = new WeakMap();

module.exports = class ConsistentSystemDesign extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.roles = Object.assign({}, saved.roles);
    this.settings.customRoles = Array.isArray(saved.customRoles) ? saved.customRoles : [];

    this.addSettingTab(new ConsistentSystemDesignSettingTab(this.app, this));

    this.documents = new Set();
    this.styleDocument(document);
    this.registerEvent(this.app.workspace.on("window-open", (_win, win) => this.styleDocument(win.document)));
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => this.styleDocument(leaf.view.containerEl.ownerDocument));
    });

    this.patchPele();
  }

  onunload() {
    this.active = false;
    this.restorePele?.();
    for (const doc of this.documents) this.unstyleDocument(doc);
    this.documents.clear();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const doc of this.documents) this.applyStyles(doc);
  }

  // role id -> { shape, custom, dashed }, merging defaults, overrides and custom roles
  roleMap() {
    const map = new Map();
    for (const role of BUILT_IN_ROLES) {
      const o = this.settings.roles[role.id] || {};
      map.set(role.id, { shape: o.shape || role.shape, custom: false, dashed: o.dashed ?? role.dashed });
    }
    for (const role of this.settings.customRoles) {
      if (!ROLE_ID.test(role.id) || map.has(role.id)) continue;
      map.set(role.id, { shape: role.shape || "rect", custom: true, dashed: !!role.dashed });
    }
    return map;
  }

  // ---- styles ----

  styleDocument(doc) {
    if (!doc || this.documents.has(doc)) return;
    this.documents.add(doc);
    this.applyStyles(doc);
  }

  applyStyles(doc) {
    const body = doc.body;
    const s = this.settings;

    for (const look of ["soft", "outline", "solid"]) body.classList.toggle(`csd-look-${look}`, s.look === look);

    for (const slider of SLIDERS) {
      const value = s[slider.key];
      if (value === null || value === undefined) body.style.removeProperty(slider.cssVar);
      else body.style.setProperty(slider.cssVar, `${value}${slider.unit}`);
    }

    for (const role of BUILT_IN_ROLES) {
      const o = s.roles[role.id] || {};
      if (o.color) body.style.setProperty(`--csd-${role.id}-color`, o.color);
      else body.style.removeProperty(`--csd-${role.id}-color`);
      if (o.dashed === null || o.dashed === undefined) body.style.removeProperty(`--csd-${role.id}-dash`);
      else body.style.setProperty(`--csd-${role.id}-dash`, o.dashed ? DASH : "none");
    }

    // custom roles: one rule each
    let style = doc.getElementById("csd-custom-roles");
    const rules = s.customRoles
      .filter((r) => ROLE_ID.test(r.id) && !BUILT_IN.has(r.id) && !RESERVED.test(r.id))
      .map((r) => {
        const color = /^#[0-9a-f]{6}$/i.test(r.color || "") ? r.color : "var(--text-muted)";
        return `.mermaid .pele .pele-node.${r.id} { --sd: var(--csd-${r.id}-color, ${color}); --sd-dash: var(--csd-${r.id}-dash, ${r.dashed ? DASH : "none"}); }`;
      });
    if (!rules.length) {
      style?.remove();
      return;
    }
    if (!style) {
      style = doc.createElement("style");
      style.id = "csd-custom-roles";
      doc.head.appendChild(style);
    }
    style.textContent = rules.join("\n");
  }

  unstyleDocument(doc) {
    const body = doc.body;
    for (const look of ["soft", "outline", "solid"]) body.classList.remove(`csd-look-${look}`);
    for (const slider of SLIDERS) body.style.removeProperty(slider.cssVar);
    for (const role of BUILT_IN_ROLES) {
      body.style.removeProperty(`--csd-${role.id}-color`);
      body.style.removeProperty(`--csd-${role.id}-dash`);
    }
    doc.getElementById("csd-custom-roles")?.remove();
  }

  // ---- Pele ----

  patchPele() {
    this.active = true;
    const plugin = this;

    const wrap = (pele) => {
      if (!pele || typeof pele.mount !== "function" || originals.has(pele)) return pele;
      const realMount = pele.mount;

      const prepareSource = (source) =>
        plugin.active && typeof source === "string"
          ? prepareFlowchart(source, plugin.roleMap(), plugin.settings.autoShapes)
          : source;
      const prepareOptions = (options) =>
        plugin.active && plugin.settings.keepDirection && options ? { ...options, autoDirection: false } : options;

      // Pele's exports are read-only getters, so build a plain copy. Own,
      // enumerable properties keep the copy usable by other plugins that
      // spread `pele` into their own wrapper.
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

// ---------------------------------------------------------------------------
// Settings page

class ConsistentSystemDesignSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    containerEl.empty();

    const save = async (redraw = false) => {
      await plugin.saveSettings();
      if (redraw) this.display();
    };

    // ---- behaviour ----
    new Setting(containerEl)
      .setName("Automatic shapes")
      .setDesc(
        "Give tagged nodes their role's shape when you haven't written one. " +
        "Add %% csd: no-shapes to a diagram to skip it. Reopen a note to see changes to shapes."
      )
      .addToggle((t) => t.setValue(s.autoShapes).onChange(async (v) => { s.autoShapes = v; await save(); }));

    new Setting(containerEl)
      .setName("Keep diagram direction")
      .setDesc("Stop wide left-to-right diagrams from being redrawn top-down. They are scaled down to fit instead.")
      .addToggle((t) => t.setValue(s.keepDirection).onChange(async (v) => { s.keepDirection = v; await save(); }));

    // ---- look ----
    new Setting(containerEl).setName("Look").setHeading();

    new Setting(containerEl)
      .setName("Style")
      .setDesc("Soft: tinted fill. Outline: coloured border and text. Solid: filled with the role colour.")
      .addDropdown((d) => {
        for (const [value, label] of Object.entries(LOOKS)) d.addOption(value, label);
        d.setValue(s.look).onChange(async (v) => { s.look = v; await save(); });
      });

    for (const slider of SLIDERS) {
      const setting = new Setting(containerEl).setName(slider.name).setDesc(slider.desc);
      setting.addSlider((sl) =>
        sl
          .setLimits(slider.min, slider.max, slider.step)
          .setValue(s[slider.key] ?? slider.def)
          .setDynamicTooltip()
          .onChange(async (v) => { s[slider.key] = v; await save(); })
      );
      setting.addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip("Reset").onClick(async () => { s[slider.key] = null; await save(true); })
      );
    }

    // ---- built-in roles ----
    new Setting(containerEl)
      .setName("Roles")
      .setDesc("Colour, shape and border for each class. Reset a colour to follow your theme again.")
      .setHeading();

    for (const role of BUILT_IN_ROLES) {
      const o = s.roles[role.id] || {};
      const update = async (patch, redraw = false) => {
        s.roles[role.id] = Object.assign({}, s.roles[role.id], patch);
        await save(redraw);
      };
      const setting = new Setting(containerEl).setName(`${role.name} · :::${role.id}`).setDesc(role.desc);
      setting.addColorPicker((c) =>
        c.setValue(o.color || toHex(document, role.color)).onChange(async (v) => update({ color: v }))
      );
      setting.addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip("Use the theme's colour").onClick(async () => update({ color: null }, true))
      );
      this.shapeDropdown(setting, o.shape || role.shape, (v) => update({ shape: v === role.shape ? null : v }));
      setting.addToggle((t) =>
        t
          .setTooltip("Dashed border")
          .setValue(o.dashed ?? role.dashed)
          .onChange(async (v) => update({ dashed: v === role.dashed ? null : v }))
      );
    }

    // ---- custom roles ----
    new Setting(containerEl)
      .setName("Custom roles")
      .setDesc("Add your own classes, such as search, auth or ml-model. Use them like the built-in ones: Index[Search]:::search")
      .setHeading();

    s.customRoles.forEach((role, index) => {
      const setting = new Setting(containerEl);
      setting.addText((t) => {
        t.setPlaceholder("class name").setValue(role.id);
        t.inputEl.addClass("csd-role-name");
        t.onChange(async (v) => {
          const id = v.trim();
          const error = roleError(id, plugin, role);
          t.inputEl.toggleClass("csd-invalid", !!error);
          t.inputEl.title = error || "";
          if (error) return;
          role.id = id;
          await save();
        });
      });
      setting.addColorPicker((c) =>
        c.setValue(role.color || "#888888").onChange(async (v) => { role.color = v; await save(); })
      );
      this.shapeDropdown(setting, role.shape || "rect", async (v) => { role.shape = v; await save(); });
      setting.addToggle((t) =>
        t.setTooltip("Dashed border").setValue(!!role.dashed).onChange(async (v) => { role.dashed = v; await save(); })
      );
      setting.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove role").onClick(async () => {
          s.customRoles.splice(index, 1);
          await save(true);
        })
      );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add role").onClick(async () => {
        let n = s.customRoles.length + 1;
        while (roleError(`role${n}`, plugin, null)) n++;
        s.customRoles.push({ id: `role${n}`, color: "#888888", shape: "rect", dashed: false });
        await save(true);
      })
    );

    // ---- reset ----
    new Setting(containerEl)
      .setName("Reset styling")
      .setDesc("Put look, sliders and built-in role colours, shapes and borders back to their defaults. Custom roles are kept.")
      .addButton((b) =>
        b.setButtonText("Reset").setWarning().onClick(async () => {
          Object.assign(s, { look: "default", fillScale: null, strokeScale: null, radius: null, borderWidth: null, roles: {} });
          await save(true);
          new Notice("Consistent System Design: styling reset.");
        })
      );
  }

  shapeDropdown(setting, value, onChange) {
    setting.addDropdown((d) => {
      for (const [shape, label] of Object.entries(SHAPE_OPTIONS)) d.addOption(shape, label);
      d.setValue(SHAPE_OPTIONS[value] ? value : "rect").onChange(onChange);
    });
  }
}
