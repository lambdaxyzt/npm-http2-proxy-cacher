import {parseRequest} from "@src/lib/parseRequest";

describe('test parse request function', () => {
  test('handle "/react" path', () => {
    expect(parseRequest("/react")).deep.equal({
      pkgName:"react",
      tarball:null
    })
  })
  test('handle "/@react/subpackage" path', () => {
    expect(parseRequest("/@react/subpackage")).deep.equal({
      pkgName:"@react/subpackage",
      tarball:null
    })
  })
  test('handle "/@tybys%2Fwasm-util" path (url encoded)', () => {
    expect(parseRequest("/@tybys%2Fwasm-util")).deep.equal({
      pkgName:"@tybys/wasm-util",
      tarball:null
    })
  })
  test('handle "/undici-types/-/undici-types-7.24.7.tgz" path (url encoded)', () => {
    expect(parseRequest("/undici-types/-/undici-types-7.24.7.tgz")).deep.equal({
      pkgName:"undici-types",
      tarball:"undici-types-7.24.7.tgz"
    })
  })
  test('handle "/@undici-types/-/undici-types-7.24.7.tgz" path (url encoded)', () => {
    expect(parseRequest("/@undici-types/-/undici-types-7.24.7.tgz")).deep.equal({
      pkgName:"@undici-types",
      tarball:"undici-types-7.24.7.tgz"
    })
  })
})
