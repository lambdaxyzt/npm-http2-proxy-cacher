import {STORAGE} from "@src/index";
import path from "node:path";
import {hash} from "@src/util.js";


export function getPackagePaths({pkgName, tarball}:{pkgName:string, tarball:string|null}) {
    let pkgDir: string;
    console.log("pkgName",pkgName)
    if (pkgName.startsWith("@")) {
        const [scope, name] = pkgName.split("/");
        console.log("scope",scope)
        const id = hash(scope).slice(-2).toLocaleLowerCase();
        pkgDir = path.resolve(STORAGE, id, scope, name);
    } else {
        const id = hash(pkgName).slice(-2).toLocaleLowerCase();
        console.log("pkgName",pkgName)
        pkgDir = path.resolve(STORAGE, id, pkgName);
    }
    return {
        dir: pkgDir,
        packageJSON: path.resolve(pkgDir, "package.json"),
        packageMetaData: path.resolve(pkgDir, "package.meta.json"),
        tarball: tarball ? path.resolve(pkgDir, tarball) : null
    };
}

