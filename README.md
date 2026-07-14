# npm-http2-proxy-cacher

A caching npm registry proxy. It talks to the upstream registry over **HTTP/2**
(optionally through a **SOCKS5** proxy), caches package metadata and tarballs on
disk, and rewrites tarball URLs to point back at itself.

## Features
- **HTTP/2 upstream** — multiplexes requests over a single connection, unlike
  HTTP/1, so firewalls are less likely to flag the many connections a normal
  npm install would open.
- **Tarball URL rewriting** — metadata is rewritten so tarballs are fetched (and
  cached) through this proxy.
- **ETag revalidation, both ways** — the proxy revalidates cached metadata
  upstream with `If-None-Match` and, downstream, honours the client's own
  `If-None-Match`: a matching client ETag gets a `304 Not Modified`, otherwise a
  `200` with an `ETag` header. ETags are stored **per upstream registry** in
  `package.meta.json` (`{ "etags": { "<registry-url>": "<etag>" } }`). When the
  upstream sends no ETag, one is derived from a content hash so revalidation
  still works, and metadata missing an ETag is re-fetched to populate it.
- **Optional revalidation skip** — with `SKIP_304_CHECK` enabled, cached
  metadata is served without contacting the upstream (still honouring the
  client's `If-None-Match`), making installs very fast.
- **Optional SOCKS5 tunnel** — route the upstream connection through a proxy to
  get around restrictive firewalls.

## Configuration
Copy `.env.example` to `.env` and adjust:

| Variable         | Required | Description                                                        |
|------------------|----------|--------------------------------------------------------------------|
| `PORT`           | yes      | Port the proxy listens on.                                         |
| `SERVER_URL`     | yes      | Public URL of the proxy; tarball links are rewritten to this.      |
| `UPSTREAM`       | yes      | Upstream registry, e.g. `https://registry.npmjs.com`.              |
| `STORAGE`        | no       | Cache directory (default `./storage`).                            |
| `SKIP_304_CHECK` | no       | `true`/`1` to serve cached metadata without revalidating.          |
| `SOCKS_HOST`     | no       | SOCKS5 proxy host. Unset = connect directly.                       |
| `SOCKS_PORT`     | no       | SOCKS5 proxy port (default `1080`).                                |

## Run locally
```bash
pnpm install
cp .env.example .env   # then edit
pnpm dev               # watch mode
pnpm start             # one-off run
```

Point your client at the proxy:
```bash
npm install --registry http://localhost:4873
```

## Run with Docker
```bash
docker compose up --build
```
The compose file reads `.env`, exposes the port, and persists the cache in a
named volume. Or build the image directly:
```bash
docker build -t npm-http2-proxy-cacher .
docker run --env-file .env -p 4873:4873 -v cache:/data npm-http2-proxy-cacher
```

## Tests
```bash
pnpm test
```

## To do
- [ ] concurrent download deduplication

## Licence :
MIT License

Copyright (c) 2026 Lambdaxyzt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.