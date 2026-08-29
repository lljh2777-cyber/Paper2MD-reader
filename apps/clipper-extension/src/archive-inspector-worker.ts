import { inspectMineruPrecisionArchive } from "./mineru-precision-client";

interface ArchiveRequest {
  archive: ArrayBuffer;
}

const workerScope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<ArchiveRequest>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

workerScope.addEventListener("message", (event) => {
  const archive = new Uint8Array(event.data.archive);
  try {
    const inspected = inspectMineruPrecisionArchive(archive);
    const buffer = archive.buffer as ArrayBuffer;
    workerScope.postMessage({ ok: true, archive: buffer, inspected }, [buffer]);
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }, []);
  }
});
