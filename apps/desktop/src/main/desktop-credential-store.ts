import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";

export const MINERU_CREDENTIAL_VERSION = "paper2md-mineru-credential-v1";
const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;

export interface SecretProtector {
  available(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

export interface MineruCredentialStatus {
  configured: boolean;
  storage: "os-protected";
  maskedToken?: string;
}

export function validateMineruToken(value: unknown): string {
  if (typeof value !== "string") throw new Error("MinerU Token must be a string");
  const token = value.trim();
  if (token.length < 16 || token.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
    throw new Error("MinerU Token has an invalid length or contains unsupported characters");
  }
  return token;
}

export function parseCredentialEnvelope(text: string): Uint8Array {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MinerU credential envelope is invalid");
  const record = value as Record<string, unknown>;
  if (record.contract_version !== MINERU_CREDENTIAL_VERSION || typeof record.cipher_text !== "string") {
    throw new Error("MinerU credential envelope is invalid");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(record.cipher_text) || record.cipher_text.length > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error("MinerU credential ciphertext is invalid");
  }
  const bytes = Buffer.from(record.cipher_text, "base64");
  if (!bytes.byteLength || bytes.toString("base64") !== record.cipher_text) throw new Error("MinerU credential ciphertext is malformed");
  return new Uint8Array(bytes);
}

function credentialEnvelope(bytes: Uint8Array): string {
  return `${JSON.stringify({
    contract_version: MINERU_CREDENTIAL_VERSION,
    cipher_text: Buffer.from(bytes).toString("base64")
  }, null, 2)}\n`;
}

export class DesktopCredentialStore {
  constructor(private readonly path: string, private readonly protector: SecretProtector) {}

  private requireProtection(): void {
    if (!this.protector.available()) throw new Error("Operating-system protected credential storage is unavailable");
  }

  protectionAvailable(): boolean {
    return this.protector.available();
  }

  private async readToken(): Promise<string | undefined> {
    const info = await lstat(this.path).catch(() => undefined);
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error("Stored MinerU credential is unsafe or oversized");
    }
    this.requireProtection();
    const encrypted = parseCredentialEnvelope(await readFile(this.path, "utf8"));
    return validateMineruToken(this.protector.decrypt(encrypted));
  }

  async status(): Promise<MineruCredentialStatus> {
    const token = await this.readToken();
    return token
      ? { configured: true, storage: "os-protected", maskedToken: `••••${token.slice(-4)}` }
      : { configured: false, storage: "os-protected" };
  }

  async requireToken(): Promise<string> {
    const token = await this.readToken();
    if (!token) throw new Error("Configure a MinerU API Token in Settings before remote extraction");
    return token;
  }

  async save(value: unknown): Promise<MineruCredentialStatus> {
    this.requireProtection();
    const token = validateMineruToken(value);
    const encrypted = this.protector.encrypt(token);
    if (!encrypted.byteLength || encrypted.byteLength > MAX_CREDENTIAL_FILE_BYTES / 2) {
      throw new Error("Encrypted MinerU credential exceeds the safe limit");
    }
    const temporary = `${this.path}.next`;
    await writeFile(temporary, credentialEnvelope(encrypted), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
    return this.status();
  }

  async clear(): Promise<MineruCredentialStatus> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { configured: false, storage: "os-protected" };
  }
}
