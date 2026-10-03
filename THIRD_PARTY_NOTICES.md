# Third-party notices

MindPond's project license is MIT. It does not replace the licenses of dependencies, copied notices, model weights, tokenizers or other third-party materials.

The locked dependency declarations are in [licenses/inventory.json](licenses/inventory.json). Full license and notice files collected from installed packages are in [licenses/dependencies.txt](licenses/dependencies.txt), also served by the HTTP UI at `/licenses/third-party.txt`. Optional platform entries can be absent from the installed package set; the original package distribution remains authoritative. Regenerate and review these files when dependencies change.

## Browser distribution

The HTTP workbench sends the unchanged vis-network npm UMD bundle to the browser. Its upstream copyright header remains intact. We use its MIT option and include the complete upstream MIT text and installed package notices. This collection also includes notices for its installed dependencies; do not remove upstream bundle comments during minification.

## Native dependencies and model files

Transformers.js is Apache-2.0; its sharp/libvips dependency includes LGPL-licensed platform binaries. The inventory records the license of each concrete package. This source repository and npm package do not contain node_modules or model weights. A Docker image, offline distribution or executable containing those binaries needs a separate review of the actual components, accompanying notices, corresponding source and library modification/replacement requirements. Merely linking an upstream repository is not a substitute for every distribution obligation.

BGE-small-zh-v1.5's original model is MIT. all-MiniLM-L6-v2 and its Xenova ONNX distribution declare Apache-2.0. Xenova's BGE conversion points to the original model but has incomplete separate license metadata; verify the converted artifact's provenance before redistributing it. Custom profiles must respect the selected model's own license. See [BGE](https://huggingface.co/BAAI/bge-small-zh-v1.5), [MiniLM](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) and [Xenova BGE](https://huggingface.co/Xenova/bge-small-zh-v1.5).

## Implementation provenance

Infrastructure modules were extracted from the host project during MindPond's development. Some original comments identify OpenClaw logging/error/types design, LangGraph State, TodoWrite, AutoGPT workspace memory and TencentDB Agent Memory as references. These comments alone do not establish that their source code was copied. We retain the reference comments and do not claim authorship of upstream work. OpenClaw's current MIT license is retained in [licenses/OpenClaw-reference-MIT.txt](licenses/OpenClaw-reference-MIT.txt) as a reference notice; it is not evidence of the exact revision originally consulted.

Graph animation comments also identify a neural-network demo as a visual reference without a recorded URL or revision. No specific third-party source match was established in the static review. This is a provenance limitation, not a claim of verified original authorship. Contributors must record exact repository/file/revision and preserve original copyright/license notices when copying or adapting code; a visual or algorithmic reference should be distinguished from source reuse.

This notice collection is an engineering record, not a certification of all code ownership, employment rights, patents or trademarks.
