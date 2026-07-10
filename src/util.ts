import fs from "node:fs"
import crypto from "node:crypto"

export function hash(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function ensureDirectory(dirPath: string) {
    try {
        await fs.promises.access(dirPath);
    } catch {
        await fs.promises.mkdir(dirPath, { recursive: true });
    }
}

export async function isPathExist(dirPath: string) {
    try {
        await fs.promises.access(dirPath);
        return true;
    } catch {
        return false;
    }
}

export function randomID(length = 10) {
    let id = "";
    for (let i = 0; i < length; i++) {
        const randomNumber = Math.floor(Math.random() * 10);
        id = id + `${randomNumber}`;
    }
    return id;
}