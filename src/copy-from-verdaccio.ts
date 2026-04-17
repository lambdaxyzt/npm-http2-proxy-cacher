import fs from "node:fs"
import path from "node:path"
import { hash, randomID,ensureDirectory} from "@src/util";
import { StreamingReplaceURLTransform} from "@src/lib/replaceDomainJSONFile/index";


export const STORAGE = process.env.STORAGE || "./storage";
if (STORAGE === undefined) {
    throw new Error("STORAGE env variable is missing");
}
const SERVER_URL = process.env.SERVER_URL;
if (SERVER_URL === undefined) {
    throw new Error("SERVER_URL env variable is missing");
}


async function walk(entryPath:string,packageName:string,packagePath:string,verdaicoPath:string,storagePath:string) {
   for (const entry of (await fs.promises.readdir(entryPath,{withFileTypes:true}))) {
        const entryPath = path.join(entry.parentPath, entry.name);
        if (entry.isDirectory()) {
            walk(entryPath,packageName,packagePath,verdaicoPath,storagePath);
        } else {
            const fileRelativePath = path.relative(verdaicoPath,entryPath)
            const packageNameHashSlice = hash(packageName).slice(-2)
            let finalFilePath = path.resolve(storagePath,packageNameHashSlice,fileRelativePath)
            if(entry.name === "package.json"){
                let finalFilePathMeta = finalFilePath.replace("package.json","package.meta.json")
                await ensureDirectory(path.dirname(finalFilePath))
                let tempFile = `${finalFilePath}.${randomID()}.tmp`
                let transform = new StreamingReplaceURLTransform(packageName,SERVER_URL)
                const writeStream = fs.createWriteStream(tempFile)
                fs.createReadStream(entryPath)
                    .pipe(transform)
                    .pipe(fs.createWriteStream(tempFile))
                    .on("finish", async () => {
                        try {
                            console.log("finished!")
                        await fs.promises.rename(tempFile, finalFilePath)
                        await fs.promises.writeFile(finalFilePathMeta, JSON.stringify({
                            url:SERVER_URL
                        }),"utf-8")
                        }catch (e) {
                            console.log(e)
                        fs.unlink(tempFile, () => {});
                        }
                    })
                    .on("error", (err) => {
                        fs.unlink(tempFile, () => {});
                    });
            }
             if(entry.isFile() && entry.name !== "package.json" ){
                await fs.promises.cp(entryPath, finalFilePath)
             }
        }
    }
}


const verdaicoPath = path.resolve("C:\\Users\\Lambdaxyzt\\Downloads\\repo\\verdaccio\\storage") 
const storagePath = path.resolve(STORAGE)

for(const libFolder of (await fs.promises.readdir(verdaicoPath,{withFileTypes:true}))) {
    const packageName = libFolder.name
    const pakcagePath = path.resolve(libFolder.parentPath,packageName)
    const packageNameHashSlice = hash(packageName).slice(-2)
    if(libFolder.isDirectory()){
        await walk(pakcagePath,packageName,pakcagePath,verdaicoPath,storagePath)
    }
    // recursive loop 
    

}