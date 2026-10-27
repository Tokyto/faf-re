#!/usr/bin/env python3
"""Build the dependency-free HTML. Python is only needed by developers."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
html = (ROOT / 'template.html').read_text(encoding='utf-8')
for marker, name in [('/*__CORE__*/', 'core.js'), ('/*__UI__*/', 'ui.js')]:
    script = (ROOT / name).read_text(encoding='utf-8')
    if '</script' in script.lower():
        raise ValueError(f'Unexpected closing script token in {name}')
    assert html.count(marker) == 1
    html = html.replace(marker, script)
out = ROOT / 'Regional_Water_Editor.html'
out.write_text(html, encoding='utf-8')
print(f'Built {out.name}: {out.stat().st_size} bytes')
