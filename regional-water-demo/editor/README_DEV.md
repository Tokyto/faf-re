# Regional Water Editor

Open Regional_Water_Editor.html locally. To regenerate the standalone HTML from template.html, core.js and ui.js, run `python3 build.py`.

Run core checks with `node tests/core.test.cjs` and `node tests/polygon.test.cjs`. The engine parity test requires compiling tests/engine_check.cpp against the engine headers. Windows browser interaction and translated interface should also be tested manually.
