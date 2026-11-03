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
/**
 * fs.rename that retries briefly on EPERM/EBUSY: on Windows, renaming over a
 * file that another request is still streaming fails until that reader closes.
 */
export async function renameWithRetry(from: string, to: string, attempts = 20) {
    for (let i = 0; ; i++) {
        try {
            return await fs.promises.rename(from, to);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (i >= attempts || (code !== "EPERM" && code !== "EBUSY")) throw err;
            await new Promise((r) => setTimeout(r, 50));
        }
    }
}
