"""Independent SCMAP-prefix fixtures, not playable maps and not retail assets."""
import math
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parent / 'generated'
OUT.mkdir(exist_ok=True)


def make(version=60, width=512, depth=512, scale=1/128, water=True, sea=17.5,
         name='Fixture Ω', metadata=True):
    parts = []
    def u32(v): parts.append(struct.pack('<I', v))
    def f32(v): parts.append(struct.pack('<f', v))
    def string(s): parts.append(s.encode() + b'\0')
    u32(0x1A70614D); u32(2); u32(0xBEEFFEED); u32(2)
    f32(width); f32(depth)
    parts.append(name.encode('utf-16le') + b'\0\0')
    u32(2 if metadata else 0)
    if metadata:
        u32(12); u32(24); u32(7); u32(9)
    preview = b'DDS ' + bytes(125)  # deliberately odd byte count / unaligned height data
    u32(len(preview)); parts.append(preview)
    u32(version); u32(width); u32(depth); f32(scale)
    samples = []
    for z in range(depth + 1):
        for x in range(width + 1):
            # A high island, two independent depressions, ocean at the map edge.
            distance = max(abs(x - width/2)/(width*.47), abs(z - depth/2)/(depth*.47))
            y = 58 if distance < .91 else 12
            for cx, cz, rx, rz, floor in [(166,182,58,74,21), (352,310,58,74,36)]:
                d = math.hypot((x-cx)/rx,(z-cz)/rz)
                if d < 1:
                    t=max(0,min(1,(d-.35)/.65)); y=floor+(58-floor)*t*t*(3-2*t)
            samples.append(round(y/scale))
    parts.append(struct.pack('<' + 'H'*len(samples), *samples))
    parts.append(b'\0')
    string('TTerrainXP'); string('/textures/back.dds'); string('/textures/sky.dds')
    u32(2)
    string('<default>'); string('/textures/env.dds'); string('sand'); string('/textures/sand.dds')
    # Layout cross-checked with Neroxis SCMapImporter: 18 lighting floats,
    # then fog RGB (3 floats), fog start, fog end. Exactly 23, before water.
    parts.append(struct.pack('<23f', *([1.0]*18+[.3,.4,.5,0.0,1000.0])))
    parts.append(bytes([int(water)])); f32(sea); f32(15); f32(0)
    return b''.join(parts)


(OUT/'author_map.scmap').write_bytes(make())
(OUT/'author_v56.scmap').write_bytes(make(version=56, name='', metadata=False))
(OUT/'rectangular.scmap').write_bytes(make(width=256, depth=128, scale=1/256))
(OUT/'water_off.scmap').write_bytes(make(water=False))
(OUT/'invalid.scmap').write_bytes(b'not a map')
(OUT/'author_map.scmap.regionalwater').write_text(
    'regionalwater 2\nregion 100 100 232 264 35 terrain preserve\n'
    'region 286 228 418 392 50 terrain preserve\n', encoding='utf-8')
print('Generated 5 binary prefix fixtures and 1 definition (not playable maps).')
