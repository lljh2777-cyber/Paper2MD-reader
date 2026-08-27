import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_CREDENTIALS = 16;

interface PendingPairing { codeHash: string; expiresAt: number }
interface StoredCredential { id: string; tokenHash: string; extensionOrigin: string; createdAt: string }

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ClipperCredentialStore {
  private readonly pending = new Map<string, PendingPairing>();
  private credentials: StoredCredential[] | undefined;
  private readonly path: string;

  constructor(dataRoot: string, private readonly persistent = true) {
    this.path = join(dataRoot, "clipper-credentials.json");
  }

  private async load(): Promise<StoredCredential[]> {
    if (this.credentials) return this.credentials;
    if (!this.persistent) return (this.credentials = []);
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { schema_version?: unknown; credentials?: unknown };
      if (parsed.schema_version !== 1 || !Array.isArray(parsed.credentials)) throw new Error("invalid credential store");
      this.credentials = parsed.credentials.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<StoredCredential>;
        return typeof item.id === "string" && /^[0-9a-f-]{36}$/.test(item.id)
          && typeof item.tokenHash === "string" && /^[0-9a-f]{64}$/.test(item.tokenHash)
          && typeof item.extensionOrigin === "string" && item.extensionOrigin.startsWith("chrome-extension://")
          && typeof item.createdAt === "string"
          ? [item as StoredCredential] : [];
      }).slice(-MAX_CREDENTIALS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Clipper credential store is unreadable or invalid");
      this.credentials = [];
    }
    return this.credentials;
  }

  private async save(): Promise<void> {
    if (!this.persistent) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.next`;
    await writeFile(temporary, `${JSON.stringify({ schema_version: 1, credentials: this.credentials }, null, 2)}\n`, { flag: "w", mode: 0o600 });
    await rename(temporary, this.path);
  }

  createPairing(): { pairing_id: string; code: string; expires_at: string } {
    const now = Date.now();
    for (const [id, pairing] of this.pending) if (pairing.expiresAt <= now) this.pending.delete(id);
    while (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value!);
    const pairingId = randomUUID();
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const expiresAt = now + PAIRING_TTL_MS;
    this.pending.set(pairingId, { codeHash: sha256(`${pairingId}:${code}`), expiresAt });
    return { pairing_id: pairingId, code, expires_at: new Date(expiresAt).toISOString() };
  }

  async redeem(pairingId: string, code: string, extensionOrigin: string): Promise<{ credential_id: string; token: string; scope: "clippings:publish" }> {
    const pairing = this.pending.get(pairingId);
    this.pending.delete(pairingId);
    if (!pairing || pairing.expiresAt <= Date.now() || !/^\d{8}$/.test(code)) throw new Error("Pairing code is invalid or expired");
    const supplied = Buffer.from(sha256(`${pairingId}:${code}`), "hex");
    const expected = Buffer.from(pairing.codeHash, "hex");
    if (!timingSafeEqual(supplied, expected)) throw new Error("Pairing code is invalid or expired");
    const token = randomBytes(32).toString("base64url");
    const credential: StoredCredential = {
      id: randomUUID(), tokenHash: sha256(token), extensionOrigin, createdAt: new Date().toISOString()
    };
    const credentials = await this.load();
    credentials.push(credential);
    this.credentials = credentials.slice(-MAX_CREDENTIALS);
    await this.save();
    return { credential_id: credential.id, token, scope: "clippings:publish" };
  }

  async authorize(token: string, extensionOrigin: string): Promise<boolean> {
    if (!token || token.length > 256) return false;
    const supplied = Buffer.from(sha256(token), "hex");
    return (await this.load()).some((credential) => credential.extensionOrigin === extensionOrigin
      && timingSafeEqual(supplied, Buffer.from(credential.tokenHash, "hex")));
  }

  async revokeAll(): Promise<{ revoked: number }> {
    const credentials = await this.load();
    const revoked = credentials.length;
    this.credentials = [];
    await this.save();
    return { revoked };
  }
}
