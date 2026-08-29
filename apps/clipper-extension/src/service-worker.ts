import {
  MAX_CLIPPED_IMAGE_BYTES,
  extensionForMime,
  isFetchableImageUrl,
  readResponseBytesWithinLimit
} from "./clipping-package";
import { FETCH_IMAGE_MESSAGE, type FetchImageResponse } from "./messages";
import { installPrecisionPermissionLeaseCleanup } from "./precision-permissions";

installPrecisionPermissionLeaseCleanup();

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== FETCH_IMAGE_MESSAGE) return;
  const url = (message as { url?: unknown }).url;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(typeof url === "string" ? url : "");
  } catch {
    sendResponse({ ok: false, error: "Unsupported image URL." } satisfies FetchImageResponse);
    return;
  }
  if (!isFetchableImageUrl(parsedUrl)) {
    sendResponse({ ok: false, error: "Private, credentialed, or unsupported image URL." } satisfies FetchImageResponse);
    return;
  }
  void (async () => {
    try {
      const response = await fetch(parsedUrl.href, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
      if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_CLIPPED_IMAGE_BYTES) throw new Error("Image exceeds the safe size limit.");
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
      if (!extensionForMime(mime)) throw new Error(`Unsupported image type: ${mime || "unknown"}.`);
      const bytes = await readResponseBytesWithinLimit(response);
      if (!bytes.length) throw new Error("Image is empty.");
      sendResponse({ ok: true, mime, bytesBase64: bytesToBase64(bytes) } satisfies FetchImageResponse);
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      } satisfies FetchImageResponse);
    }
  })();
  return true;
});
