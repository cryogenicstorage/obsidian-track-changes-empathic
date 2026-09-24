import { Component, TFile, type Vault } from "obsidian";
import { parse } from "./parser";

/** Only paths and pending read identities are retained, never note contents. */
export class CriticMarkupIndex extends Component {
  private paths = new Set<string>();
  private pending = new Map<string, object>();
  private active = false;

  constructor(private vault: Vault, private changed: () => void) {
    super();
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  onload(): void {
    this.active = true;
    this.registerEvent(this.vault.on("create", (file) => {
      if (file instanceof TFile) void this.update(file);
    }));
    this.registerEvent(this.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.update(file);
    }));
    this.registerEvent(this.vault.on("delete", (file) => this.remove(file.path)));
    this.registerEvent(this.vault.on("rename", (file, oldPath) => {
      this.remove(oldPath);
      if (file instanceof TFile) void this.update(file);
      else {
        // Folder events need not be accompanied by events for every child.
        for (const child of this.vault.getMarkdownFiles()) {
          if (child.path.startsWith(file.path + "/")) void this.update(child);
        }
      }
    }));
    void this.scan();
  }

  private async scan(): Promise<void> {
    // Serial reads bound startup I/O; event reads can supersede these safely.
    for (const file of this.vault.getMarkdownFiles()) {
      if (!this.active) break;
      if (this.vault.getAbstractFileByPath(file.path) === file) await this.update(file);
    }
  }

  private async update(file: TFile): Promise<void> {
    if (!this.active || file.extension !== "md") return;
    const path = file.path;
    const token = {};
    this.pending.set(path, token);
    try {
      const source = await this.vault.read(file);
      if (!this.active || this.pending.get(path) !== token) return;
      if (file.path !== path || this.vault.getAbstractFileByPath(path) !== file) return;
      const contains = parse(source).nodes.length > 0;
      if (contains !== this.paths.has(path)) {
        if (contains) this.paths.add(path);
        else this.paths.delete(path);
        this.changed();
      }
    } catch (error) {
      if (this.active && this.pending.get(path) === token) {
        console.warn(`Track Changes: could not index ${path}`, error);
      }
    } finally {
      if (this.pending.get(path) === token) this.pending.delete(path);
    }
  }

  private remove(path: string): void {
    for (const key of this.pending.keys()) {
      if (key === path || key.startsWith(path + "/")) this.pending.delete(key);
    }
    let changed = false;
    for (const key of this.paths) {
      if (key === path || key.startsWith(path + "/")) {
        this.paths.delete(key);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  onunload(): void {
    this.active = false;
    this.pending.clear();
    this.paths.clear();
  }
}
