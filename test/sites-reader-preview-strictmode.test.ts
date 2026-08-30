import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the root TypeScript project independent from the Site's React/TSX
// compiler boundary while exercising the Site component at runtime.
const siteReactPath = "../sites-reader/node_modules/react";
const siteReactDomPath = "../sites-reader/node_modules/react-dom/client";
const readerPagePath = "../sites-reader/app/reader/page";

const previewMocks = vi.hoisted(() => ({
  receive: vi.fn()
}));

const archiveImportMocks = vi.hoisted(() => ({
  importBytes: vi.fn()
}));

const previewWorkerMocks = vi.hoisted(() => ({
  importBytes: vi.fn()
}));

const localReaderMocks = vi.hoisted(() => ({
  mount: vi.fn(),
  mountWithReady: vi.fn()
}));

vi.mock("../sites-reader/lib/repair-reader-preview", async (importOriginal) => ({
  ...await importOriginal<typeof import("../sites-reader/lib/repair-reader-preview")>(),
  receiveVerifiedPackagePreview: previewMocks.receive
}));

vi.mock("../apps/web/src/after-mineru-archive-import", () => ({
  importAfterMinerUArchiveBytes: archiveImportMocks.importBytes
}));

vi.mock("../apps/web/src/after-mineru-preview-worker-client", () => ({
  importAfterMinerUPreviewWithWorker: previewWorkerMocks.importBytes
}));

vi.mock("../local-reader/main", () => ({
  mountLocalReader: localReaderMocks.mount,
  mountLocalReaderWithReady: localReaderMocks.mountWithReady
}));

const { StrictMode, act, createElement } = await import(siteReactPath);
const { createRoot } = await import(siteReactDomPath);
const { default: ReaderPage } = await import(readerPagePath);

type ReceiveOptions = {
  signal?: AbortSignal;
  validateArchive(
    archive: {
      kind: "after-mineru-verified-package";
      name: string;
      byteLength: number;
      fileCount: number;
      bytes: ArrayBuffer;
    },
    signal: AbortSignal
  ): Promise<{ dispose(): void }>;
};

beforeEach(() => {
  previewMocks.receive.mockReset();
  archiveImportMocks.importBytes.mockReset();
  previewWorkerMocks.importBytes.mockReset();
  localReaderMocks.mount.mockReset();
  localReaderMocks.mountWithReady.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

function installDom(): HTMLElement {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(window, {
    location: {
      origin: "https://after-mineru.example",
      pathname: "/reader",
      search: "",
      hash: `#repair-preview=v1.${"11".repeat(16)}.${"22".repeat(32)}`
    }
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("Event", window.Event);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return document.querySelector<HTMLElement>("#root")!;
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("Reader preview StrictMode lifecycle", () => {
  it("keeps one handoff alive across the development effect replay and aborts it on real unmount", async () => {
    const host = installDom();
    let handoffSignal: AbortSignal | undefined;
    previewMocks.receive.mockImplementation((options: { signal?: AbortSignal }) => {
      handoffSignal = options.signal;
      return new Promise(() => undefined);
    });
    const reactRoot = createRoot(host);

    await act(async () => {
      reactRoot.render(createElement(StrictMode, null, createElement(ReaderPage)));
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(previewMocks.receive).toHaveBeenCalledTimes(1);
    expect(handoffSignal?.aborted).toBe(false);

    await act(async () => reactRoot.unmount());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handoffSignal?.aborted).toBe(true);
  });

  it("disposes a successfully mounted preview exactly once on real unmount", async () => {
    const host = installDom();
    const fileSystemDispose = vi.fn();
    const mountedDispose = vi.fn();
    archiveImportMocks.importBytes.mockResolvedValue({ dispose: fileSystemDispose });
    previewWorkerMocks.importBytes.mockResolvedValue({ dispose: fileSystemDispose });
    localReaderMocks.mountWithReady.mockReturnValue({
      dispose: mountedDispose,
      ready: Promise.resolve()
    });
    previewMocks.receive.mockImplementation(async (options: ReceiveOptions) => {
      // The production receiver invokes validation after an asynchronous
      // postMessage handshake, once createPreviewSession has assigned itself.
      await Promise.resolve();
      const bytes = new ArrayBuffer(22);
      const value = await options.validateArchive({
        kind: "after-mineru-verified-package",
        name: "paper.after-mineru.zip",
        byteLength: bytes.byteLength,
        fileCount: 1,
        bytes
      }, new AbortController().signal);
      return {
        status: "accepted" as const,
        archiveName: "paper.after-mineru.zip",
        value
      };
    });
    const reactRoot = createRoot(host);

    await act(async () => {
      reactRoot.render(createElement(StrictMode, null, createElement(ReaderPage)));
    });
    await settleEffects();

    await vi.waitFor(() => {
      expect(localReaderMocks.mountWithReady).toHaveBeenCalledTimes(1);
    });

    expect(previewMocks.receive).toHaveBeenCalledTimes(1);
    expect(archiveImportMocks.importBytes.mock.calls.length + previewWorkerMocks.importBytes.mock.calls.length).toBe(1);
    expect(mountedDispose).not.toHaveBeenCalled();

    await act(async () => reactRoot.unmount());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(mountedDispose).toHaveBeenCalledTimes(1);
    expect(fileSystemDispose).not.toHaveBeenCalled();
  });

  it("mounts one ordinary Reader after preview rejection and disposes it once", async () => {
    const host = installDom();
    const normalReaderDispose = vi.fn();
    let rejectPreview!: (error: Error) => void;
    localReaderMocks.mount.mockReturnValue(normalReaderDispose);
    previewMocks.receive.mockReturnValue(new Promise((_resolve, reject) => {
      rejectPreview = reject;
    }));
    const reactRoot = createRoot(host);

    await act(async () => {
      reactRoot.render(createElement(StrictMode, null, createElement(ReaderPage)));
    });
    await settleEffects();

    expect(previewMocks.receive).toHaveBeenCalledTimes(1);
    await act(async () => rejectPreview(new Error("preview rejected")));

    await vi.waitFor(() => {
      expect(localReaderMocks.mount).toHaveBeenCalledTimes(1);
    });

    expect(localReaderMocks.mountWithReady).not.toHaveBeenCalled();
    expect(normalReaderDispose).not.toHaveBeenCalled();

    await act(async () => reactRoot.unmount());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(normalReaderDispose).toHaveBeenCalledTimes(1);
  });
});
