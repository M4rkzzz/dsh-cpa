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

## Declared runtime dependencies (0.2.6)

These packages are installed as normal dependencies, not copied from an installed host archive. Their own licenses and transitive notices continue to apply; the plugin's MIT license does not relicense them.

| Package | Pinned version | License | Upstream source |
| --- | --- | --- | --- |
| @deepseek-ai/dsh-llm | 0.2.2-rc.1 | MIT | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) |
| @deepseek-ai/dsh-llm-pi-ai | 0.2.2-rc.1 | MIT | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) |
| @deepseek-ai/schemastery | 3.19.0 | MIT | [DeepSeek Harness vendor packages](https://github.com/deepseek-ai/deepseek-harness) |
| @earendil-works/pi-ai | 1.3.0 | MIT | [pi](https://github.com/earendil-works/pi) |
| @resvg/resvg-wasm | 2.6.2 | MPL-2.0 | [resvg-js](https://github.com/yisibl/resvg-js) |
| saxes | 6.0.0 | ISC | [saxes](https://github.com/lddubeau/saxes) |

The resvg WASM package is used unmodified through its public JavaScript API. Its covered source, build instructions and release history are available from the [upstream resvg-js repository](https://github.com/yisibl/resvg-js); the [Mozilla Public License 2.0 text](https://www.mozilla.org/en-US/MPL/2.0/) governs that component. The plugin's worker and SVG allowlist are separate original files; no resvg source was altered. The dependency is loaded locally at runtime, never fetched from a CDN during image conversion.
