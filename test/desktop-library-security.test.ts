import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_LIBRARY_MARKER_VERSION,
  DESKTOP_LIBRARY_PREFERENCES_VERSION,
  DESKTOP_LIBRARY_SELECTION_VERSION,
  parseLibraryMarker,
  parseLibraryPreferences,
  parseLibrarySelection,
  assertContainedLibraryDirectory
} from "../apps/desktop/src/main/desktop-library";
import {
  DesktopCredentialStore,
  MINERU_CREDENTIAL_VERSION,
  parseCredentialEnvelope,
  validateMineruToken
} from "../apps/desktop/src/main/desktop-credential-store";

describe("desktop library state contracts", () => {
  it("accepts versioned library marker, selection and favorites", () => {
    expect(parseLibraryMarker(JSON.stringify({
      contract_version: DESKTOP_LIBRARY_MARKER_VERSION,
      library_id: "7e8b26dd-f389-42b6-9356-16b027c37fa0",
      created_at: "2026-08-27T10:00:00.000Z"
    })).library_id).toBe("7e8b26dd-f389-42b6-9356-16b027c37fa0");
    expect(parseLibrarySelection(JSON.stringify({
      contract_version: DESKTOP_LIBRARY_SELECTION_VERSION,
      root: "D:\\Paper2MD Library"
    })).root).toBe("D:\\Paper2MD Library");
    expect(parseLibraryPreferences(JSON.stringify({
      contract_version: DESKTOP_LIBRARY_PREFERENCES_VERSION,
      favorites: ["package-one", "package-two"]
    })).favorites).toEqual(["package-one", "package-two"]);
  });

  it("fails closed on malformed or duplicate library metadata", () => {
    expect(() => parseLibraryMarker('{"contract_version":"unknown"}')).toThrow("marker");
    expect(() => parseLibraryMarker(JSON.stringify({
      contract_version: DESKTOP_LIBRARY_MARKER_VERSION,
      library_id: "00000000-0000-0000-0000-000000000000",
      created_at: "2026-08-27T10:00:00.000Z"
    }))).toThrow("marker");
    expect(() => parseLibrarySelection(JSON.stringify({
      contract_version: DESKTOP_LIBRARY_SELECTION_VERSION,
      root: ""
    }))).toThrow("selection");
    expect(() => parseLibraryPreferences(JSON.stringify({
      contract_version: DESKTOP_LIBRARY_PREFERENCES_VERSION,
      favorites: ["same-package", "same-package"]
    }))).toThrow("duplicates");
  });

  it("accepts only real fixed directories contained by the selected library", () => {
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    const link = { isDirectory: () => false, isSymbolicLink: () => true };
    expect(() => assertContainedLibraryDirectory(
      "C:\\Paper2MD Library",
      "C:\\Paper2MD Library\\state",
      directory
    )).not.toThrow();
    expect(() => assertContainedLibraryDirectory(
      "C:\\Paper2MD Library",
      "C:\\outside",
      directory
    )).toThrow("unsafe fixed directory");
    expect(() => assertContainedLibraryDirectory(
      "C:\\Paper2MD Library",
      "C:\\Paper2MD Library\\state",
      link
    )).toThrow("unsafe fixed directory");
  });
});

describe("desktop MinerU credential boundary", () => {
  it("validates a token without logging or normalizing its contents", () => {
    const token = "mineru_token_1234567890.jwt-part";
    expect(validateMineruToken(token)).toBe(token);
    expect(() => validateMineruToken("short")).toThrow("invalid");
    expect(() => validateMineruToken("mineru token with spaces")).toThrow("invalid");
    expect(() => validateMineruToken("mineru_token_含有非ASCII字符")).toThrow("unsupported characters");
  });

  it("accepts only a bounded versioned encrypted envelope", () => {
    const encrypted = Buffer.from("encrypted-placeholder");
    expect(parseCredentialEnvelope(JSON.stringify({
      contract_version: MINERU_CREDENTIAL_VERSION,
      cipher_text: encrypted.toString("base64")
    }))).toEqual(new Uint8Array(encrypted));
    expect(() => parseCredentialEnvelope(JSON.stringify({
      contract_version: "unknown",
      cipher_text: encrypted.toString("base64")
    }))).toThrow("invalid");
    expect(() => parseCredentialEnvelope(JSON.stringify({
      contract_version: MINERU_CREDENTIAL_VERSION,
      cipher_text: "not base64!"
    }))).toThrow("ciphertext");
  });

  it("keeps the plaintext token behind the main-process credential store", async () => {
    const path = join(tmpdir(), `paper2md-credential-${randomUUID()}.json`);
    const protector = {
      available: () => true,
      encrypt: (value: string) => new TextEncoder().encode(value.split("").reverse().join("")),
      decrypt: (value: Uint8Array) => new TextDecoder().decode(value).split("").reverse().join("")
    };
    const store = new DesktopCredentialStore(path, protector);
    await expect(store.requireToken()).rejects.toThrow("Configure a MinerU API Token");
    await store.save("mineru_token_1234567890.jwt-part");
    await expect(store.requireToken()).resolves.toBe("mineru_token_1234567890.jwt-part");
    await store.clear();
  });
});
