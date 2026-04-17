import {StreamingReplaceTransform, StreamingReplaceURLTransform} from "@src/lib/replaceDomainJSONFile/index";
import http from "node:http";
import http2 from "node:http2";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, pipeline } from "node:stream";

import { once } from 'node:events';
import { fileURLToPath } from "node:url";
import {ensureDirectory, hash, isPathExist, randomID} from "@src/util";
import { parseRequest } from "@src/lib/parseRequest";
import {getPackagePaths} from "@src/lib/getPackagePaths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET = process.env.UPSTREAM; // upstream domain
if (TARGET === undefined) {
  throw new Error("UPSTREAM env variable is missing");
}
export const STORAGE = process.env.STORAGE || "./storage";
if (STORAGE === undefined) {
  throw new Error("STORAGE env variable is missing");
}
const PORT = process.env.PORT;
if (PORT === undefined) {
  throw new Error("PORT env variable is missing");
}
const SERVER_URL = process.env.SERVER_URL;
if (SERVER_URL === undefined) {
  throw new Error("SERVER_URL env variable is missing");
}
const BASE_PATH = (new URL(TARGET)).pathname;


const client = http2.connect(TARGET);
client.on("error", (err) => {
  console.error(`Could not connect to ${TARGET},Error:`);
  console.error(err);
})
await once(client, 'connect');
console.log(`connected to ${TARGET}`);

const server = http.createServer(async (req, res) => {
  // early return if request was not GET!
  console.log(`incoming request`,req.url);
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  if(!req.url){
    res.writeHead(405);
    res.end();
    return;
  }
  const upstreamPath = BASE_PATH + req.url;
  const parsedRequest = parseRequest(req.url);
  const packagePaths = getPackagePaths(parsedRequest);

  const headers = {
    ":method": "GET",
    ":path": upstreamPath,
  };
  if (packagePaths.tarball) {

    if (await isPathExist(packagePaths.tarball)) {
      const stream = fs.createReadStream(packagePaths.tarball);

      res.writeHead(200, {
        "content-type": "application/octet-stream",
      });

      stream.pipe(res);
      return;
    }

    await ensureDirectory(packagePaths.dir);
    const proxyReq = client.request(headers);
    proxyReq.on("response", (h) => {
      const status = h[":status"] || 500;
      const responseHeaders = { ...h };
      delete responseHeaders[":status"];
      res.writeHead(status, responseHeaders);
      if (packagePaths.tarball) {
          let tempFile = `${packagePaths.tarball}.${randomID()}.tmp`;
          const fileStream = fs.createWriteStream(tempFile);
          proxyReq.pipe(fileStream);
          fileStream.on("finish", () => {
            fs.rename(tempFile, packagePaths.tarball!, (err) => {
              if (err) {
                fs.unlink(tempFile, () => {});
                return;
              }
            });
          });
          fileStream.on("error", (err) => {
            fs.unlink(tempFile, () => {});
          });
      }
      proxyReq.pipe(res);
    });
    proxyReq.on("error", (err) => {
      console.error(err);
      res.writeHead(502);
      res.end();
    });

  } else {
    if (await isPathExist(packagePaths.packageJSON)) {
      const stream = fs.createReadStream(packagePaths.packageJSON);
      res.writeHead(200, {
        "content-type": "application/json",
      });

      stream.pipe(res);
      return;
    }
    await ensureDirectory(packagePaths.dir);
    const proxyReq = client.request(headers);

    proxyReq.on("response", (h) => {
      const status = h[":status"] || 500;
      const responseHeaders = { ...h };
      delete responseHeaders[":status"];
      delete responseHeaders["content-length"];
      delete responseHeaders["Content-Length"];
      res.writeHead(status, responseHeaders);
      if (packagePaths.packageJSON && status === 200) {
        let tempFile =`${packagePaths.packageJSON}.${randomID()}.tmp`
        const fileStream = fs.createWriteStream(tempFile);
        const targetURL = new URL(TARGET)

        function debugStream(name, stream) {
          const log = (...msg) => console.log(`[${name}]`, ...msg);

          stream.on("error", (e) => log("ERROR:", e));
          stream.on("close", () => log("CLOSE"));
          stream.on("end", () => log("END"));
          stream.on("finish", () => log("FINISH"));
          stream.on("drain", () => log("DRAIN"));
          stream.on("pause", () => log("PAUSE"));
          stream.on("resume", () => log("RESUME"));
          stream.on("unpipe", () => log("UNPIPE"));
        }

        let transform = new StreamingReplaceURLTransform(parsedRequest.pkgName,SERVER_URL)
        const tee = new PassThrough();
        pipeline(proxyReq, transform, tee, err => {
          if (err) console.error(err);
        });
        debugStream("fileStream",fileStream)
        debugStream("res",res)
        tee.pipe(fileStream)
        tee.pipe(res)

        fileStream.on("finish", async () => {
          try {
            await fs.promises.rename(tempFile, packagePaths.packageJSON)
            await fs.promises.writeFile(packagePaths.packageMetaData, JSON.stringify({
              url:`http://localhost:${PORT}`
            }),"utf-8")
          }catch (e) {
            fs.unlink(tempFile, () => {});
          }
        });
        fileStream.on("error", (err) => {
          fs.unlink(tempFile, () => {});
        });
      }
    })
    proxyReq.on("error", (err) => {
      console.error(err);
      res.writeHead(502);
      res.end();
    });
  }
});

// @ts-ignore
server.listen(PORT, "0.0.0.0", () => {
  console.log(`proxy listening on :${PORT}`);
});
