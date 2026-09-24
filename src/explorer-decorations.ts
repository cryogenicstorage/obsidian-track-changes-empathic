import { Component, type Workspace } from "obsidian";

const MARK_CLASS = "tc-explorer-marked";
const ROW_SELECTOR = ".nav-file-title[data-path]";

/** File explorer DOM conventions are private to Obsidian; keep them here. */
export class ExplorerDecorations extends Component {
  private roots = new Map<HTMLElement, MutationObserver>();
  private active = false;
  private queued = false;

  constructor(private workspace: Workspace, private hasMarkup: (path: string) => boolean) {
    super();
  }

  onload(): void {
    this.active = true;
    this.registerEvent(this.workspace.on("layout-change", () => this.refresh()));
    this.refresh();
  }

  refresh(): void {
    if (!this.active || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.active) return;
      const containers = new Set(this.workspace.getLeavesOfType("file-explorer")
        .map((leaf) => leaf.view.containerEl));
      for (const [root, observer] of this.roots) {
        if (!containers.has(root)) {
          observer.disconnect();
          this.clear(root);
          this.roots.delete(root);
        }
      }
      for (const root of containers) {
        if (!this.roots.has(root)) {
          // Use the owning window's observer for pop-out explorers too.
          const ownerWindow = root.win as Window & { MutationObserver: typeof MutationObserver };
          const observer = new ownerWindow.MutationObserver(() => this.refresh());
          observer.observe(root, {
            subtree: true, childList: true, attributes: true, attributeFilter: ["data-path"],
          });
          this.roots.set(root, observer);
        }
        root.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((row) => {
          row.classList.toggle(MARK_CLASS, this.hasMarkup(row.getAttribute("data-path") ?? ""));
        });
      }
    });
  }

  private clear(root: HTMLElement): void {
    root.querySelectorAll(`.${MARK_CLASS}`).forEach((row) => row.classList.remove(MARK_CLASS));
  }

  onunload(): void {
    this.active = false;
    for (const [root, observer] of this.roots) {
      observer.disconnect();
      this.clear(root);
    }
    this.roots.clear();
  }
}
