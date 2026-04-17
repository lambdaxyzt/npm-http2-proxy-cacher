import fs from 'node:fs';
const readStream = fs.createReadStream("src/lib/package.jsond")

readStream
    .on('data', (chunk) => {
        console.log("chunk",chunk)
    })
    .on('end', () =>{console.log("end of stream")})