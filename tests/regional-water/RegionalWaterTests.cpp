#include "moho/sim/RegionalWaterModel.h"
#include "moho/sim/RegionalWaterRenderModel.h"
#include "moho/sim/RegionalWaterBasinModel.h"
#include "moho/sim/RegionalWaterCombatModel.h"
#include "moho/sim/RegionalWaterMapModel.h"
#include "moho/sim/RegionalWaterRegistry.h"
#include <cstdlib>
#include <iostream>
#include <random>

using namespace moho::regionalwater;
static void Check(bool condition, const char* message)
{
  if (!condition) { std::cerr << message << '\n'; std::exit(1); }
}

int main()
{
  const auto definition = ParseMapDefinition("\xEF\xBB\xBF# lake\r\nregionalwater 1\r\nregion 192 192 320 320 35\r\nterrain gentle # demo\n");
  Check(bool(definition) && definition.gentleBasins[0] && definition.regions.values[0].height == 35, "map sidecar/BOM/comments/CRLF");
  Check(!ValidateMapDefinition(definition, 1024, 1024, 17.5f, true), "valid automatic basin");
  Check(ValidateMapDefinition(definition, 256, 256, 17.5f, true), "out-of-map definition refused");
  Check(ValidateMapDefinition(definition, 1024, 512, 17.5f, true), "rectangular sculpt refused");
  Check(ValidateMapDefinition(definition, 1024, 1024, 17.5f, false), "disabled map water refused");
  Check(!ParseMapDefinition(""), "empty sidecar refused");
  Check(!ParseMapDefinition("regionalwater 4 region 192 192 320 320 35 terrain gentle"), "future schema refused");
  Check(!ParseMapDefinition("regionalwater 1 region 193 192 320 320 35 terrain gentle"), "odd bounds refused");
  Check(!ParseMapDefinition("regionalwater 1 region 192 192 320 320 nan terrain gentle"), "NaN sidecar height refused");
  Check(!ParseMapDefinition("regionalwater 1 region 192 192 320 320 35 terrain automatic"), "unknown terrain mode refused");
  Check(!ParseMapDefinition("regionalwater 1 region 192 192 320 320 35 terrain gentle extra"), "extra tokens refused");
  Check(!ParseMapDefinition(std::string(4097, ' ')), "oversized sidecar refused");
  const auto preserved = ParseMapDefinition("regionalwater 1 region 0 0 128 128 10 terrain preserve");
  Check(bool(preserved) && !preserved.gentleBasins[0] &&
        !ValidateMapDefinition(preserved, 256, 512, 35, true), "lower lake/preserve supports rectangular maps");
  Check(MapDefinitionPath("/maps/demo/demo.scmap") == "/maps/demo/demo.scmap.regionalwater", "sidecar beside exact map path");
  MapRegions maps;
  MapRegions::Cache cache;
  int mapA = 0, preview = 0, shadow = 0;
  maps.Set(&mapA, definition.regions.values[0]);
  maps.Set(&preview, preserved.regions.values[0]);
  Check(maps.Get(&mapA, {}, cache).height == 35 && maps.Get(&preview, {}, cache).height == 10,
        "map preview cannot change active map region");
  maps.Set(&shadow, maps.Get(&mapA, {}, cache));
  maps.Erase(&mapA);
  Check(!maps.Get(&mapA, {}, cache).enabled && maps.Get(&shadow, {}, cache).height == 35,
        "shadow copy survives original map destruction");
  maps.Set(&mapA, {});
  Check(!maps.Get(&mapA, definition.regions.values[0], cache).enabled, "ordinary map overrides legacy fallback");
  maps.Erase(&mapA);
  Check(maps.Get(&mapA, definition.regions.values[0], cache).height == 35, "pointer reuse invalidates cached region");

  // The probe's basin must become wet after terrain sync, even when the map's
  // original sea level is below its newly flattened floor.
  const auto dry = WaterMaskPixel(35, 20, {43, 43, 43, 43}, 0x12, 0x34);
  const auto wet = WaterMaskPixel(35, 20, {23, 23, 23, 23}, 0x12, 0x34);
  Check(dry == 0x123400ffu, "dry rim mask channels");
  Check(wet == 0x12349900u, "raised lake floor mask channels");
  Check((WaterMaskPixel(17, 20, {23, 23, 23, 23}, 0, 0) & 0xffffu) == 0xffu,
        "original ocean level should leave raised basin dry");
  Check((WaterMaskPixel(35, 20, {23, 43, 23, 43}, 0, 0) & 0xffu) == 0xffu,
        "shoreline must preserve any dry corner");
  Check((WaterMaskPixel(35, 20, {0, 0, 0, 0}, 0, 0) & 0xff00u) == 0xff00u,
        "deep water clamps");
  Check((WaterMaskPixel(35, 0, {23, 23, 23, 23}, 0, 0) & 0xff00u) == 0xff00u,
        "zero depth range guard");
  Check((WaterMaskPixel(35, -1, {23, 23, 23, 23}, 0, 0) & 0xff00u) == 0xff00u,
        "inverted depth range guard");
  Check((WaterMaskPixel(35, 20, {35, 35, 35, 35}, 0, 0) & 0xffffu) == 0u,
        "level terrain produces no positive water depth");
  const Region region = Parse({"192", "192", "320", "320", "35"});
  const auto crossing = [&](Point3 a, Point3 b, bool below = false, Region r = {}) {
    if (!r.enabled) r = region;
    return FindWaterCrossing(r, 17.5f, 1024, 1024, a, b, below);
  };
  auto hit = crossing({256, 50, 256}, {256, 20, 256});
  Check(hit.kind == WaterCrossingKind::Enter && hit.position.y == 35 && hit.fraction == .5f,
        "shell must hit raised lake, not original ocean");
  hit = crossing({100, 50, 100}, {100, 0, 100});
  Check(hit.kind == WaterCrossingKind::Enter && hit.position.y == 17.5f, "original ocean crossing");
  hit = crossing({256, 30, 256}, {256, 40, 256}, true);
  Check(hit.kind == WaterCrossingKind::Exit && hit.fraction == .5f, "missile exits local lake");
  hit = crossing({180, 60, 256}, {400, 0, 256});
  Check(hit.kind == WaterCrossingKind::Enter && hit.position.y == 35 && hit.fraction < .5f,
        "fast diagonal segment must take first finite water patch");
  Check(crossing({100, 40, 256}, {200, 30, 256}).kind == WaterCrossingKind::None,
        "intersection outside lake must not create a water wall at the edge");
  Check(crossing({256, 40, 256}, {256, 35, 256}).kind == WaterCrossingKind::None,
        "touching plane without entering");
  Check(crossing({256, 35, 256}, {256, 34, 256}).fraction == 0,
        "crossing starts on plane");
  Check(crossing({256, 30, 256}, {300, 30, 256}, true).kind == WaterCrossingKind::None,
        "horizontal underwater torpedo has no surface crossing");
  Check(crossing({256, 30, 256}, {256, 30, 256}, true).kind == WaterCrossingKind::None,
        "zero segment has no surface crossing");
  Check(crossing({256, 50, 256}, {256, 20, 256}, true).kind == WaterCrossingKind::None,
        "already-underwater flag cannot enter twice");
  Check(crossing({320, 50, 256}, {320, 0, 256}).position.y == 17.5f,
        "exclusive lake edge uses ocean plane");
  const Region lowWater{{192, 192, 320, 320}, 10, true};
  hit = crossing({256, 40, 256}, {256, 0, 256}, false, lowWater);
  Check(hit.kind == WaterCrossingKind::Enter && hit.position.y == 10,
        "lower lake must not collide with absent ocean plane overhead");
  Check(BasinHeight(region, 17.5f, 256, 256, 5) == 23, "gentle basin depth");
  Check(BasinHeight(region, 17.5f, 270, 256, 5) == 23, "frigate lane is flat floor");
  Check(BasinHeight(region, 17.5f, 192, 256, 5) == 39, "region edge is dry rim");
  Check(BasinHeight(region, 17.5f, 192, 192, 5) == 39, "region corner is dry rim");
  Check(BasinHeight(region, 17.5f, 128, 256, 7) == 7, "outer seam preserves original terrain");
  Check(BasinHeight({}, 17.5f, 256, 256, 7) == 7, "disabled basin changes nothing");
  const Region lower{{192, 192, 320, 320}, 20, true};
  Check(BasinHeight(lower, 35, 192, 256, 0) == 39, "lower lake rim must hold back ocean");
  Check(BasinHeight(lower, 35, 256, 256, 0) == 8, "lower lake depth");
  float previous = 23;
  for (int step = 0; step <= 640; ++step) {
    const float x = 256 + step * .1f;
    const float h = BasinHeight(region, 17.5f, x, 256, 5);
    Check(h >= previous - .0001f && h <= 39, "inner bank is not monotonic/bounded");
    Check(std::abs(h - previous) < .08f, "inner bank has a height jump");
    previous = h;
  }
  previous = 39;
  for (int step = 0; step <= 640; ++step) {
    const float x = 320 + step * .1f;
    const float h = BasinHeight(region, 17.5f, x, 256, 5);
    Check(h <= previous + .0001f && h >= 5, "outer bank is not monotonic/bounded");
    Check(std::abs(h - previous) < .09f, "outer bank has a height jump");
    previous = h;
  }
  for (int z = 128; z <= 384; ++z) {
    for (int x = 128; x <= 384; ++x) {
      const float h = BasinHeight(region, 17.5f, float(x), float(z), 5);
      Check(std::isfinite(h) && h >= 5 && h <= 39, "basin sample escaped bounds");
      if (x == 128 || x == 384 || z == 128 || z == 384) Check(h == 5, "outer perimeter seam");
      if ((x == 192 || x == 320) && z >= 192 && z <= 320) Check(h == 39, "wet region edge");
      if ((z == 192 || z == 320) && x >= 192 && x <= 320) Check(h == 39, "wet region edge");
    }
  }
  Check(region.enabled, "valid region rejected");
  Check(HeightAt(region, 17, 200, 200) == 35, "lake height");
  Check(HeightAt(region, 17, 192, 192) == 35, "inclusive lower boundary");
  Check(HeightAt(region, 17, 320, 200) == 17, "exclusive upper boundary");
  Check(HeightAt(region, 17, 100, 100) == 17, "ocean height");
  Check(HeightAt(Region{}, 17, 200, 200) == 17, "disabled fallback");
  Check(!Parse({"193", "192", "320", "320", "35"}).enabled, "unaligned bounds accepted");
  Check(!Parse({"320", "192", "192", "320", "35"}).enabled, "inverted bounds accepted");
  Check(!Parse({"-2", "192", "320", "320", "35"}).enabled, "negative bounds accepted");
  Check(!Parse({"192", "192", "320", "320", "nan"}).enabled, "NaN accepted");
  Check(!Parse({"192", "192", "320", "320", "inf"}).enabled, "infinity accepted");
  Check(!Parse({"192", "192", "320", "320", "1e30"}).enabled, "extreme height accepted");
  Check(!Parse({"192x", "192", "320", "320", "35"}).enabled, "trailing junk accepted");
  Check(Parse({"192", "192", "320", "320", "-5.25"}).enabled, "lower water rejected");

  const auto verify = [](Region candidate, float width, float depth) {
    const auto patches = Partition(candidate, width, depth, 17);
    Check(patches.count > 0 && patches.count <= 5, "patch count");
    float area = 0;
    for (std::size_t i = 0; i < patches.count; ++i) {
      const auto& r = patches.values[i].bounds;
      Check(r.x0 >= 0 && r.z0 >= 0 && r.x1 <= width && r.z1 <= depth, "patch outside map");
      Check(r.x1 > r.x0 && r.z1 > r.z0, "empty patch");
      area += (r.x1 - r.x0) * (r.z1 - r.z0);
    }
    Check(area == width * depth, "partition area is not the map area");
    for (float z = .25f; z < depth; z += 2) {
      for (float x = .25f; x < width; x += 2) {
        int hits = 0;
        for (std::size_t i = 0; i < patches.count; ++i) {
          if (patches.values[i].bounds.Contains(x, z)) {
            ++hits;
            Check(patches.values[i].height == HeightAt(candidate, 17, x, z), "query and rendering disagree");
          }
        }
        Check(hits == 1, "gap or overlapping water planes");
      }
    }
  };
  verify(region, 512, 512);
  verify({}, 512, 512);
  verify(Parse({"0", "0", "512", "512", "35"}), 512, 512);
  verify(Parse({"400", "400", "700", "700", "35"}), 512, 512);
  verify(Parse({"600", "600", "700", "700", "35"}), 512, 512);
  Check(Partition(region, 0, 512, 17).count == 0, "empty map");

  std::mt19937 random(0xA7E2);
  for (int i = 0; i < 200; ++i) {
    const int x = (random() % 140) * 2;
    const int z = (random() % 140) * 2;
    const int sx = 2 + (random() % 80) * 2;
    const int sz = 2 + (random() % 80) * 2;
    Region generated{{float(x), float(z), float(x + sx), float(z + sz)}, float(i % 60), true};
    verify(generated, 256, 256);
  }
  std::cout << "PASS: map definitions/registry, finite water crossings, gentle basin/seams/slope, render mask regression, parsing, bounds, disabled fallback, raised/lowered surfaces, clipped partitions, "
               "and 200 randomized region layouts. Engine/renderer integration not executed.\n";
}
