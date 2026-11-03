import path from "node:path";
import { hash } from "@src/util";

export const STORAGE = process.env.STORAGE || "./storage";
const NPM_ROOT = path.resolve(STORAGE, "npm");

export function getPackagePaths({ pkgName, tarball }: { pkgName: string; tarball: string | null }) {
    let pkgDir: string;
    if (pkgName.startsWith("@")) {
        const [scope, name] = pkgName.split("/");
        const id = hash(scope).slice(-2).toLocaleLowerCase();
        pkgDir = path.resolve(NPM_ROOT, id, scope, name);
    } else {
        const id = hash(pkgName).slice(-2).toLocaleLowerCase();
        pkgDir = path.resolve(NPM_ROOT, id, pkgName);
    }
    return {
        dir: pkgDir,
        packageJSON: path.resolve(pkgDir, "package.json"),
        packageMetaData: path.resolve(pkgDir, "package.meta.json"),
        tarball: tarball ? path.resolve(pkgDir, tarball) : null,
    };
}
