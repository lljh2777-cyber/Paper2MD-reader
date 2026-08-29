import {
  extractMinerUArchiveForReader,
  MINERU_ARCHIVE_READER_LIMITS
} from "../../../src/model/mineru-archive";

interface ArchiveRequest {
  archive: ArrayBuffer;
}

interface TransferEntry {
  path: string;
  data: ArrayBuffer;
}

const workerScope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<ArchiveRequest>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

workerScope.addEventListener("message", (event) => {
  try {
    const extraction = extractMinerUArchiveForReader(
      new Uint8Array(event.data.archive),
      MINERU_ARCHIVE_READER_LIMITS
    );
    const transfer: ArrayBuffer[] = [];
    const files: TransferEntry[] = [];
    for (const [path, bytes] of extraction.files) {
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      transfer.push(data);
      files.push({ path, data });
    }
    workerScope.postMessage({
      ok: true,
      extraction: {
        rootPrefix: extraction.rootPrefix,
        articlePath: extraction.articlePath,
        contentListPath: extraction.contentListPath,
        fileCount: extraction.fileCount,
        markdownCount: extraction.markdownCount,
        jsonCount: extraction.jsonCount,
        imageCount: extraction.imageCount
      },
      files
    }, transfer);
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }, []);
  }
});
