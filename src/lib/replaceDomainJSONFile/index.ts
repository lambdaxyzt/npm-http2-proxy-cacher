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
function encodeButKeepAtAndBang(str:string) {
    return encodeURIComponent(str)
        .replace(/%40/g, '@')
}

export class StreamingReplaceURLTransform extends Transform {
    private tail;
    private readonly searchRegex: RegExp
    private readonly searchLength: number
    private readonly replace: string
    private readonly pkgNameDecoded: string

    constructor(
        private pkgName: string,
        private replaceURL: string,
    ) {
        super();
        // escape package like @react
        this.pkgNameDecoded = encodeButKeepAtAndBang(this.pkgName)
        this.searchRegex = new RegExp(
            `"tarball":\\s*"https?:\\/\\/[^"]*?\\/(?=${escapeRegex(this.pkgNameDecoded)})`,
            "g"
        );
        this.searchLength = 1000
        this.tail = ""
        this.replace = `"tarball": "${this.replaceURL}/`
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

