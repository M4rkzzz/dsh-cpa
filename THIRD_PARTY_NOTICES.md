# Third-party notices

Settings styles adapted from [dsh-opencode-go 0.1.24](https://github.com/Duskriver/dsh-opencode-go), MIT license:

MIT License

Copyright (c) 2026 DeepSeek
Copyright (c) 2026 dsh-opencode-go contributors

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

## Runtime and prebuilt SDK dependencies (0.2.8)

Public SDK sources are installed only in the development/build checkout, never copied from an installed host archive. PiAiAdapter and pi-ai runtime code is prebuilt into a JavaScript bundle, with pinned package provenance and a SHA-256 in [manifest.json](<lib/vendor/manifest.json>), full bundled license/notice texts under [vendor licenses](<lib/vendor/licenses/>), and reproducible generation by [build-sdk.mjs](<scripts/build-sdk.mjs>). The pi packages' omitted npm license file is supplied from the [pinned upstream MIT license](https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/LICENSE). Other runtime dependencies retain their own package notices. Bundling does not execute dependency install/build scripts. These licenses continue to apply; the plugin's MIT license does not relicense third-party code.

| Package | Pinned version | License | Upstream source |
| --- | --- | --- | --- |
| @anthropic-ai/sdk | 0.129.0 | Apache-2.0 | [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) |
| @deepseek-ai/cordis | 4.1.0 | MIT | [Cordis](https://github.com/shigma/cordis) |
| @deepseek-ai/dsh-llm | 0.2.2-rc.1 | MIT | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) |
| @deepseek-ai/dsh-llm-pi-ai | 0.2.2-rc.1 | MIT | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) |
| @deepseek-ai/schemastery | 3.19.0 | MIT | [DeepSeek Harness vendor packages](https://github.com/deepseek-ai/deepseek-harness) |
| @earendil-works/pi-ai | 1.3.0 | MIT | [pi](https://github.com/earendil-works/pi) |
| @resvg/resvg-wasm | 2.6.2 | MPL-2.0 | [resvg-js](https://github.com/yisibl/resvg-js) |
| saxes | 6.0.0 | ISC | [saxes](https://github.com/lddubeau/saxes) |

The resvg WASM package is used unmodified through its public JavaScript API. Its covered source, build instructions and release history are available from the [upstream resvg-js repository](https://github.com/yisibl/resvg-js); the [Mozilla Public License 2.0 text](https://www.mozilla.org/en-US/MPL/2.0/) governs that component. The plugin's worker and SVG allowlist are separate original files; no resvg source was altered. The dependency is loaded locally at runtime, never fetched from a CDN during image conversion.
