import { strict as assert } from "node:assert";
import { build } from "esbuild";

// Exercise real modules with a minimal Obsidian lifecycle/event adapter.
const mock = `
export class Component {
  cleanups = [];
  load() { this.onload?.(); }
  unload() { this.onunload?.(); this.cleanups.splice(0).forEach(fn => fn()); }
  registerEvent(ref) { this.cleanups.push(ref); }
}
export class TFile {
  constructor(path) { this.path = path; }
  get extension() { return this.path.split('.').pop(); }
}`;
const result = await build({
  stdin: {
    contents: `export { CriticMarkupIndex } from './src/criticmarkup-index';
      export { ExplorerDecorations } from './src/explorer-decorations';
      export { TFile } from 'obsidian';`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", write: false,
  plugins: [{ name: "obsidian-mock", setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mock }));
  } }],
});
const { CriticMarkupIndex, ExplorerDecorations, TFile } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")
);
class Events {
  listeners = new Map();
  on(name, callback) {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(callback);
    return () => set.delete(callback);
  }
  emit(name, ...args) { this.listeners.get(name)?.forEach(fn => fn(...args)); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class Vault extends Events {
  files = new Map();
  contents = new Map();
  reader;
  getMarkdownFiles() { return [...this.files.values()].filter(f => f.extension === "md"); }
  getAbstractFileByPath(path) { return this.files.get(path); }
  async read(file) { return this.reader ? this.reader(file) : this.contents.get(file.path); }
  add(path, text) {
    const file = new TFile(path);
    this.files.set(path, file);
    this.contents.set(path, text);
    return file;
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const vault = new Vault();
for (const [i, mark] of ["{++a++}", "{--a--}", "{~~a~>b~~}", "{>>a<<}", "{==a==}", "{=+a+=}", '{author="AI" ++a++}'].entries()) {
  vault.add(`${i}.md`, mark);
}
vault.add("code.md", "`{++a++}`\n\n```\n{>>a<<}\n```\n\n    {--a--}");
vault.add("plain.md", "{++unfinished");
vault.add("image.png", "{++a++}");
let notifications = 0;
const index = new CriticMarkupIndex(vault, () => notifications++);
index.load();
await flush();
for (let i = 0; i < 7; i++) assert.equal(index.has(`${i}.md`), true);
for (const path of ["code.md", "plain.md", "image.png"]) assert.equal(index.has(path), false);
assert.equal(notifications, 7);

const file = vault.add("folder/new.md", "{>>external write<<}");
vault.emit("create", file);
await flush();
assert.equal(index.has(file.path), true);
vault.contents.set(file.path, "resolved");
vault.emit("modify", file);
await flush();
assert.equal(index.has(file.path), false);

// Newer reads win, even if an older external-write read finishes last.
const reads = [];
vault.reader = () => new Promise(resolve => reads.push(resolve));
vault.emit("modify", file);
vault.emit("modify", file);
reads[1]("{++latest++}");
await flush();
reads[0]("plain stale text");
await flush();
assert.equal(index.has(file.path), true);

// Folder rename invalidates old paths and any in-flight reads under them.
vault.emit("modify", file);
vault.files.delete(file.path);
file.path = "moved/new.md";
vault.files.set(file.path, file);
vault.emit("rename", { path: "moved" }, "folder");
reads[2]("{++stale++}");
reads[3]("{++current++}");
await flush();
assert.equal(index.has("folder/new.md"), false);
assert.equal(index.has("moved/new.md"), true);

vault.emit("modify", file);
vault.files.delete(file.path);
file.path = "moved/new.txt";
vault.files.set(file.path, file);
vault.emit("rename", file, "moved/new.md");
reads[4]("{++stale++}");
await flush();
assert.equal(index.has("moved/new.md"), false);
assert.equal(index.has("moved/new.txt"), false);

const deleted = vault.add("deleted.md", "");
vault.emit("create", deleted);
vault.files.delete(deleted.path);
vault.emit("delete", deleted);
reads[5]("{++deleted++}");
await flush();
assert.equal(index.has(deleted.path), false);

vault.reader = async () => { throw new Error("unreadable"); };
const warn = console.warn;
let warnings = 0;
console.warn = () => warnings++;
vault.emit("modify", vault.files.get("0.md"));
await flush();
console.warn = warn;
assert.equal(warnings, 1);
assert.equal(index.has("0.md"), true); // Retain last known state on read failure.

vault.reader = () => new Promise(resolve => reads.push(resolve));
vault.emit("modify", vault.files.get("0.md"));
index.unload();
reads[6]("{++late++}");
await flush();
assert.equal(index.has("0.md"), false);
assert.equal(vault.count(), 0);
vault.reader = undefined;
index.load();
await flush();
assert.equal(index.has("0.md"), true);
const child = vault.add("group/child.md", "{++child++}");
const sibling = vault.add("group-other/child.md", "{++sibling++}");
vault.emit("create", child);
vault.emit("create", sibling);
await flush();
vault.emit("delete", { path: "group" });
assert.equal(index.has(child.path), false);
assert.equal(index.has(sibling.path), true);
vault.files.delete(sibling.path);
const oldPath = sibling.path;
sibling.path = 'renamed [with "quotes"].md';
vault.files.set(sibling.path, sibling);
vault.contents.set(sibling.path, "{++renamed++}");
vault.emit("rename", sibling, oldPath);
await flush();
assert.equal(index.has(oldPath), false);
assert.equal(index.has(sibling.path), true);
index.unload();

// A modify event during the initial scan must beat the initial stale read.
const startupVault = new Vault();
const startupFile = startupVault.add("startup.md", "");
const startupReads = [];
startupVault.reader = () => new Promise(resolve => startupReads.push(resolve));
const startupIndex = new CriticMarkupIndex(startupVault, () => {});
startupIndex.load();
startupVault.emit("modify", startupFile);
startupReads[1]("{++new++}");
await flush();
startupReads[0]("old text");
await flush();
assert.equal(startupIndex.has("startup.md"), true);
startupIndex.unload();

// DOM adapter: explorer rebuilds, reused rows, layout changes and cleanup.
class Row {
  constructor(path) { this.path = path; }
  classes = new Set();
  classList = {
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
    remove: name => this.classes.delete(name),
  };
  getAttribute() { return this.path; }
}
const observers = [];
class Observer {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe(root, options) { this.root = root; this.options = options; }
  disconnect() { this.disconnected = true; }
}
const root = {
  rows: [new Row("yes.md"), new Row("no.md")],
  win: { MutationObserver: Observer },
  querySelectorAll(selector) {
    return selector === ".tc-explorer-marked"
      ? this.rows.filter(row => row.classes.has("tc-explorer-marked")) : this.rows;
  },
};
const workspace = new Events();
let leaves = [{ view: { containerEl: root } }];
workspace.getLeavesOfType = () => leaves;
const decorator = new ExplorerDecorations(workspace, path => path === "yes.md");
decorator.load();
await flush();
assert.equal(root.rows[0].classes.has("tc-explorer-marked"), true);
assert.equal(root.rows[1].classes.size, 0);
assert.deepEqual(observers[0].options.attributeFilter, ["data-path"]);
root.rows[0].path = "no.md";
root.rows.push(new Row("yes.md"));
observers[0].callback();
await flush();
assert.equal(root.rows[0].classes.size, 0);
assert.equal(root.rows[2].classes.has("tc-explorer-marked"), true);
leaves = [];
workspace.emit("layout-change");
await flush();
assert.equal(observers[0].disconnected, true);
assert.equal(root.rows[2].classes.size, 0);
leaves = [{ view: { containerEl: root } }];
workspace.emit("layout-change");
await flush();
assert.equal(root.rows[2].classes.size, 1);
decorator.refresh();
decorator.unload();
await flush();
assert.equal(root.rows[2].classes.size, 0);
assert.equal(observers[1].disconnected, true);
assert.equal(workspace.count(), 0);
console.log("  ok - CriticMarkup index events, parsing, races, lifecycle and explorer decorations");
