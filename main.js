"use strict";
// Consistent System Design
//
// 1. Component styles (styles.css): tag a node `:::db`, `:::service`, ...
// 2. Keep direction: Obsidian's diagram renderer, Pele, re-lays out an
//    LR/RL diagram top-down when it is wider than the note. Obsidian draws
//    every diagram through the global `pele.mount()`, so this plugin swaps
//    in a copy of `pele` whose mount() passes Pele's own
//    `autoDirection: false` option. Wide diagrams are scaled down instead.

const { Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = { keepDirection: true };

// patched pele -> the pele it wraps
const originals = new WeakMap();

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
      const patched = {
        ...pele,
        mount(el, source, options = {}) {
          const keep = plugin.active && plugin.settings.keepDirection;
          return realMount.call(pele, el, source, keep ? { ...options, autoDirection: false } : options);
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
