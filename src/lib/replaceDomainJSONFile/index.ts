import { Transform, TransformCallback } from "stream";

export class StreamingReplaceTransform extends Transform {
    private tail;

    constructor(
        private search: string,
        private replace: string
    ) {
        super();
        this.tail = ""
    }

    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
        const pieces = (this.tail + chunk.toString()).split(this.search)
        const lastPiece = pieces[pieces.length -1 ]
        const tailLen = this.search.length - 1
        this.tail = lastPiece?.slice(-tailLen)
        pieces[pieces.length -1 ]= lastPiece?.slice(0,-tailLen)
        this.push(pieces.join(this.replace))
        callback();
    }

    _flush(callback: TransformCallback) {
        this.push(this.tail)
        callback()
    }
}

function escapeRegex(str:string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Build a regex fragment that matches a package name as it appears in a tarball
// URL path. For scoped names the "/" between scope and name is written literally
// by some registries (npm: "@types/node") and percent-encoded by others
// (chabokan mirror: "@dnd-kit%2Fcore"), so match either form. "@" is always literal.
function pkgNameToRegexToken(str:string) {
    return escapeRegex(str).replace(/\//g, "(?:/|%2F)")
}

export class StreamingReplaceURLTransform extends Transform {
    private tail;
    private readonly searchRegex: RegExp
    private readonly searchLength: number
    private readonly replace: string
    private readonly pkgNameToken: string

    constructor(
        private pkgName: string,
        private replaceURL: string = "",
    ) {
        super();
        this.pkgNameToken = pkgNameToRegexToken(this.pkgName);
        this.searchRegex = new RegExp(
            `"tarball":\\s*"https?:\\/\\/[^"]*?\\/(?=${this.pkgNameToken})`,
            "g",
        );
        // tail must cover the max possible regex match length
        // "tarball": " + URL + "/" — npm URLs are usually < 200 chars; 2048 is very safe
        this.searchLength = 2048;
        this.tail = "";
        this.replace = `"tarball": "${this.replaceURL}/`;
    }

    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
        const pieces = (this.tail + chunk.toString()).split(this.searchRegex)
        const lastPiece = pieces[pieces.length -1 ]
        const tailLen = this.searchLength - 1
        this.tail = lastPiece?.slice(-tailLen)
        pieces[pieces.length -1 ]= lastPiece?.slice(0,-tailLen)
        this.push(pieces.join(this.replace)) 
        callback();
    }

    _flush(callback: TransformCallback) {
       this.push(this.tail)
       callback()
    }
}

