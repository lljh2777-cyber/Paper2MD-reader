import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { assertOpaqueId } from "../../../../packages/agent-contracts/src/index";
import { PublishedPackageCatalog } from "../../../processing-service/src/published-package-catalog";
import type { DesktopLibraryDocument, DesktopLibrarySnapshot } from "../shared/desktop-api";

export const DESKTOP_LIBRARY_MARKER_VERSION = "paper2md-library-v1";
export const DESKTOP_LIBRARY_SELECTION_VERSION = "paper2md-library-selection-v1";
export const DESKTOP_LIBRARY_PREFERENCES_VERSION = "paper2md-library-preferences-v1";
const MAX_LIBRARY_DOCUMENTS = 500;
const MAX_PREFERENCES_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIBRARY_DIRECTORIES = ["packages", "jobs", "staging", "sidecars", "state"] as const;

interface LibraryMarker {
  contract_version: typeof DESKTOP_LIBRARY_MARKER_VERSION;
  library_id: string;
  created_at: string;
}

interface LibrarySelection {
  contract_version: typeof DESKTOP_LIBRARY_SELECTION_VERSION;
  root: string;
}

interface LibraryPreferences {
  contract_version: typeof DESKTOP_LIBRARY_PREFERENCES_VERSION;
  favorites: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function parseLibraryMarker(text: string): LibraryMarker {
  const value = object(JSON.parse(text) as unknown);
  if (
    value?.contract_version !== DESKTOP_LIBRARY_MARKER_VERSION ||
    typeof value.library_id !== "string" ||
    !UUID_PATTERN.test(value.library_id) ||
    !validDate(value.created_at)
  ) throw new Error("Paper2MD library marker is invalid");
  return value as unknown as LibraryMarker;
}

export function parseLibrarySelection(text: string): LibrarySelection {
  const value = object(JSON.parse(text) as unknown);
  if (
    value?.contract_version !== DESKTOP_LIBRARY_SELECTION_VERSION ||
    typeof value.root !== "string" ||
    !value.root ||
    value.root.length > 32_768
  ) throw new Error("Paper2MD library selection is invalid");
  return value as unknown as LibrarySelection;
}

export function parseLibraryPreferences(text: string): LibraryPreferences {
  const value = object(JSON.parse(text) as unknown);
  if (value?.contract_version !== DESKTOP_LIBRARY_PREFERENCES_VERSION || !Array.isArray(value.favorites)) {
    throw new Error("Paper2MD library preferences are invalid");
  }
  if (value.favorites.length > 5_000) throw new Error("Paper2MD library favorites exceed the safe limit");
  const favorites = value.favorites.map((item) => assertOpaqueId(item, "package_id"));
  if (new Set(favorites).size !== favorites.length) throw new Error("Paper2MD library favorites contain duplicates");
  return { contract_version: DESKTOP_LIBRARY_PREFERENCES_VERSION, favorites };
}

function selectionJson(root: string): string {
  return `${JSON.stringify({ contract_version: DESKTOP_LIBRARY_SELECTION_VERSION, root }, null, 2)}\n`;
}

function preferencesJson(favorites: ReadonlySet<string>): string {
  return `${JSON.stringify({
    contract_version: DESKTOP_LIBRARY_PREFERENCES_VERSION,
    favorites: [...favorites].sort((left, right) => left.localeCompare(right))
  }, null, 2)}\n`;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function readableJson(path: string, maximumBytes: number): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error("Paper2MD library state file is unsafe or oversized");
  }
  return readFile(path, "utf8");
}

function driveRoot(path: string): boolean {
  const parsed = parse(path);
  return parsed.root.toLowerCase() === path.toLowerCase();
}

export function assertContainedLibraryDirectory(
  root: string,
  canonicalChild: string,
  info: Pick<Awaited<ReturnType<typeof lstat>>, "isDirectory" | "isSymbolicLink">
): void {
  const child = relative(root, canonicalChild);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) throw new Error("Paper2MD library contains an unsafe fixed directory");
}

async function ensureLibraryDirectory(root: string, name: typeof LIBRARY_DIRECTORIES[number]): Promise<void> {
  const path = join(root, name);
  await mkdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
  assertContainedLibraryDirectory(root, canonical, info);
}

export class DesktopLibraryManager {
  private root: string | undefined;
  private catalog: PublishedPackageCatalog | undefined;
  private favorites = new Set<string>();

  constructor(private readonly userDataPath: string) {}

  private selectionPath(): string { return join(this.userDataPath, "desktop-library-selection-v1.json"); }
  private markerPath(root: string): string { return join(root, ".paper2md-library.json"); }
  private preferencesPath(root: string): string { return join(root, "state", "preferences.json"); }

  async restore(): Promise<void> {
    const text = await readableJson(this.selectionPath(), MAX_PREFERENCES_BYTES).catch(() => undefined);
    if (!text) return;
    try {
      const selection = parseLibrarySelection(text);
      await this.attach(selection.root, false);
    } catch {
      this.root = undefined;
      this.catalog = undefined;
      this.favorites.clear();
    }
  }

  async select(path: string): Promise<DesktopLibrarySnapshot> {
    await this.attach(path, true);
    await atomicWrite(this.selectionPath(), selectionJson(this.root!));
    return this.snapshot();
  }

  private async attach(path: string, initialize: boolean): Promise<void> {
    const canonical = await realpath(path);
    const rootInfo = await lstat(canonical);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Selected Paper2MD library is not a safe directory");
    if (initialize && driveRoot(canonical)) throw new Error("Choose a dedicated folder instead of an entire drive as the Paper2MD library");

    const markerPath = this.markerPath(canonical);
    const markerText = await readableJson(markerPath, 64 * 1024);
    if (!initialize) {
      if (!markerText) throw new Error("The saved Paper2MD library marker is unavailable");
      parseLibraryMarker(markerText);
    }

    await Promise.all(LIBRARY_DIRECTORIES.map((name) => ensureLibraryDirectory(canonical, name)));
    if (markerText) {
      parseLibraryMarker(markerText);
    } else if (initialize) {
      const marker: LibraryMarker = {
        contract_version: DESKTOP_LIBRARY_MARKER_VERSION,
        library_id: randomUUID(),
        created_at: new Date().toISOString()
      };
      await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }

    const preferencesText = await readableJson(this.preferencesPath(canonical), MAX_PREFERENCES_BYTES);
    this.favorites = new Set(preferencesText ? parseLibraryPreferences(preferencesText).favorites : []);
    this.root = canonical;
    this.catalog = new PublishedPackageCatalog(canonical, "http://127.0.0.1/");
  }

  async snapshot(): Promise<DesktopLibrarySnapshot> {
    if (!this.root || !this.catalog) return { configured: false, documents: [] };
    const documents: DesktopLibraryDocument[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.catalog.list(cursor, Math.min(100, MAX_LIBRARY_DOCUMENTS - documents.length));
      const rawPackages = Array.isArray(page.packages) ? page.packages : [];
      for (const raw of rawPackages) {
        const item = object(raw);
        if (
          !item || typeof item.package_id !== "string" || typeof item.label !== "string" ||
          !["mineru", "clipping"].includes(String(item.kind)) ||
          !["hash-bound", "legacy-size-bound"].includes(String(item.integrity)) ||
          !Number.isSafeInteger(item.file_count) || !Number.isSafeInteger(item.total_size_bytes)
        ) continue;
        const packageId = assertOpaqueId(item.package_id, "package_id");
        documents.push({
          packageId,
          label: item.label.slice(0, 512),
          kind: item.kind as DesktopLibraryDocument["kind"],
          integrity: item.integrity as DesktopLibraryDocument["integrity"],
          createdAt: validDate(item.created_at) ? item.created_at : undefined,
          fileCount: Number(item.file_count),
          totalSizeBytes: Number(item.total_size_bytes),
          favorite: this.favorites.has(packageId)
        });
      }
      cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    } while (cursor && documents.length < MAX_LIBRARY_DOCUMENTS);

    documents.sort((left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.label.localeCompare(right.label)
    );
    return {
      configured: true,
      label: basename(this.root),
      documents,
      truncated: Boolean(cursor)
    };
  }

  async packageRoot(packageId: string): Promise<string> {
    if (!this.catalog) throw new Error("Choose a Paper2MD library first");
    const id = assertOpaqueId(packageId, "package_id");
    const articlePath = await this.catalog.packageFilePath(id, "article.md");
    if (!articlePath) throw new Error("The selected library document is unavailable or failed validation");
    return dirname(articlePath);
  }

  async setFavorite(packageId: string, favorite: boolean): Promise<DesktopLibrarySnapshot> {
    if (!this.root || !this.catalog) throw new Error("Choose a Paper2MD library first");
    const id = assertOpaqueId(packageId, "package_id");
    if (!await this.catalog.descriptor(id)) throw new Error("The selected library document is unavailable");
    await ensureLibraryDirectory(this.root, "state");
    if (favorite) this.favorites.add(id);
    else this.favorites.delete(id);
    await atomicWrite(this.preferencesPath(this.root), preferencesJson(this.favorites));
    return this.snapshot();
  }

  async revealPath(): Promise<string> {
    if (!this.root) throw new Error("Choose a Paper2MD library first");
    await access(this.root);
    return this.root;
  }
}
