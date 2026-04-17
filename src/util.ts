import fs from "node:fs"
import crypto from "node:crypto"
import { Transform } from "node:stream";
import {IncomingMessage} from "node:http";

export function hash(input:string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function ensureDirectory(dirPath:string) {
    try {
        await fs.promises.access(dirPath);
        // If no error is thrown, the directory exists
    } catch (error) {
        await fs.promises.mkdir(dirPath, { recursive: true });
    }
}

export async function isPathExist(dirPath:string) {
    try {
        await fs.promises.access(dirPath);
        return true
    } catch (error) {
        return false
    }
}

export function randomID(length=10) {
    let id = ""
    for (let i = 0; i < length; i++) {
        let randomNumber = Math.floor(
            Math.random()*10
        )
        id = id + `${randomNumber}`
    }
    return id
}
export function ddd(req:IncomingMessage) {
  const upstream = "https://mirror2.chabokan.net";
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const proxy = `${protocol}://${req.headers.host}`;

  let tail = "";
  const TAIL_SIZE = upstream.length - 1;

  return new Transform({
    transform(chunk, enc, cb) {
      const data = tail + chunk.toString();

      const safeLength = Math.max(0, data.length - TAIL_SIZE);
      const safePart = data.slice(0, safeLength);
      tail = data.slice(safeLength);

      this.push(safePart.replaceAll(upstream, proxy));
      cb();
    },

    flush(cb) {
      this.push(tail.replaceAll(upstream, proxy));
      cb();
    }
  });
}