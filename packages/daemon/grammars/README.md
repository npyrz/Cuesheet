# Vendored tree-sitter grammars

These are the prebuilt `.wasm` files that the grammar packages publish on npm,
copied here rather than depended on. Each grammar package also carries a
native Node binding and an `install` script that builds it; Cuesheet uses only
the wasm, and a native module is what Step 10 chose files over SQLite to avoid.
See Step 59 in `PLAN-STEP.MD`.

The parser runtime (`web-tree-sitter.wasm`) is *not* vendored: it must match the
`web-tree-sitter` JavaScript exactly, so it is resolved from that dependency at
run time and copied beside these by the desktop build.

| File | Package | Version | SHA-256 |
|---|---|---|---|
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript` | 0.23.2 | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | `tree-sitter-typescript` | 0.23.2 | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |
| `tree-sitter-python.wasm` | `tree-sitter-python` | 0.25.0 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |

To update one: `npm pack <package>@<version>`, extract the `.wasm` from the
tarball, replace the file, and update this table. A grammar must be ABI 13–15
for the pinned `web-tree-sitter`; `repomap.test.ts` loads every file here.

## Licenses

Both packages are MIT licensed.

### tree-sitter-typescript

    The MIT License (MIT)
    
    Copyright (c) 2017 Max Brunsfeld
    
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

### tree-sitter-python

    The MIT License (MIT)
    
    Copyright (c) 2016 Max Brunsfeld
    
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
