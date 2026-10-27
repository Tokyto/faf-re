#include "moho/sim/RegionalWaterMapModel.h"
#include "moho/sim/RegionalWaterCombatModel.h"
#include "moho/sim/RegionalWaterRenderModel.h"
#include "moho/sim/RegionalWaterRegistry.h"
#include <cstdlib>
#include <iostream>
#include <random>

using namespace moho::regionalwater;
static void Check(bool ok, const char* message)
{
  if (!ok) { std::cerr << message << '\n'; std::exit(1); }
}

static void VerifyPartition(const RegionSet& regions, float width, float depth)
{
  const auto patches = Partition(regions, width, depth, 17.5f);
  Check(patches.count > 0 && patches.count <= kMaxPatches, "bounded partition");
  double area = 0;
  for (std::size_t i = 0; i < patches.count; ++i) {
    const auto& a = patches.values[i].bounds;
    Check(a.x0 >= 0 && a.z0 >= 0 && a.x1 <= width && a.z1 <= depth && a.x0 < a.x1 && a.z0 < a.z1,
          "patch bounds/positive area");
    area += (a.x1 - a.x0) * (a.z1 - a.z0);
    for (std::size_t j = 0; j < i; ++j) {
      const auto& b = patches.values[j].bounds;
      Check(std::min(a.x1, b.x1) <= std::max(a.x0, b.x0) || std::min(a.z1, b.z1) <= std::max(a.z0, b.z0),
            "patch interiors overlap");
    }
  }
  Check(area == width * depth, "partition covers entire map area exactly");
  for (float z = .25f; z < depth; z += 4) {
    for (float x = .25f; x < width; x += 4) {
      unsigned hits = 0;
      for (std::size_t i = 0; i < patches.count; ++i) {
        if (patches.values[i].bounds.Contains(x, z)) {
          ++hits;
          Check(patches.values[i].height == HeightAt(regions, 17.5f, x, z), "render/query heights disagree");
        }
      }
      Check(hits == 1, "render hole or duplicate plane");
    }
  }
}

// Geometric reference: intersect the render sheets rather than the combat
// helper's direct local-plane/ocean-hole selection.
static WaterCrossing Reference(const RegionSet& regions, Point3 from, Point3 to, bool below)
{
  WaterCrossing hit;
  const float dy = to.y - from.y;
  if (dy == 0 || (below && dy < 0) || (!below && dy > 0)) return hit;
  float nearest = 2;
  const auto patches = Partition(regions, 256, 256, 17.5f);
  for (std::size_t i = 0; i < patches.count; ++i) {
    const auto& p = patches.values[i];
    if (!(below ? from.y <= p.height && to.y > p.height : from.y >= p.height && to.y < p.height)) continue;
    const float t = (p.height - from.y) / dy;
    const Point3 point{from.x + (to.x - from.x) * t, p.height, from.z + (to.z - from.z) * t};
    if (t >= 0 && t <= 1 && t < nearest && p.bounds.Contains(point.x, point.z)) {
      nearest = t; hit = {below ? WaterCrossingKind::Exit : WaterCrossingKind::Enter, t, point};
    }
  }
  return hit;
}

int main()
{
  const auto demo = ParseMapDefinition("regionalwater 2\nregion 192 192 320 320 35 terrain gentle\nregion 512 192 640 320 50 terrain gentle\n");
  Check(bool(demo) && demo.regions.count == 2 && !ValidateMapDefinition(demo, 1024, 1024, 17.5f, true), "two-lake demo definition");
  const auto& lakes = demo.regions;
  Check(HeightAt(lakes, 17.5f, 256, 256) == 35 && HeightAt(lakes, 17.5f, 576, 256) == 50 &&
        HeightAt(lakes, 17.5f, 400, 256) == 17.5f, "two lakes and ordinary ocean");
  Check(HeightAt(lakes, 17.5f, 320, 256) == 17.5f && HeightAt(lakes, 17.5f, 512, 256) == 50,
        "each rectangle's half-open edge");
  auto hit = FindWaterCrossing(lakes, 17.5f, 1024, 1024, {576, 80, 256}, {576, 20, 256}, false);
  Check(hit.kind == WaterCrossingKind::Enter && hit.position.y == 50 && hit.fraction == .5f, "second lake projectile hit");
  hit = FindWaterCrossing(lakes, 17.5f, 1024, 1024, {1000, 70, 256}, {0, 20, 256}, false);
  Check(hit.position.y == 50 && std::abs(hit.fraction - .4f) < .00001f, "fast sweep chooses first of two candidate lakes");
  Check(FindWaterCrossing(lakes, 17.5f, 1024, 1024, {180, 80, 256}, {700, 0, 256}, false).kind == WaterCrossingKind::None,
        "no fictitious ocean plane inside second lake or vertical water wall");
  Check((WaterMaskPixel(HeightAt(lakes, 17.5f, 576, 256), 20, {38,38,38,38}, 0, 0) & 0xff00u) != 0,
        "second lake has wet depth mask above original sea");
  auto lower = demo; lower.regions.values[1].height = 10;
  hit = FindWaterCrossing(lower.regions, 17.5f, 1024, 1024, {576, 40, 256}, {576, 0, 256}, false);
  Check(hit.position.y == 10, "lower second lake has no ocean collision overhead");
  VerifyPartition(lakes, 1024, 1024);
  VerifyPartition(lower.regions, 1024, 1024);
  VerifyPartition(lakes, 600, 256); // clipped diagnostic command geometry

  const auto refuse = [](const char* text) {
    const auto d = ParseMapDefinition(text);
    return !d || ValidateMapDefinition(d, 2048, 2048, 17.5f, true) != nullptr;
  };
  Check(refuse("regionalwater 1 region 192 192 320 320 35 terrain preserve region 512 192 640 320 50 terrain preserve"), "schema 1 cannot silently accept multiple regions");
  Check(refuse("regionalwater 2 region 192 192 320 320 35 terrain preserve region 300 192 428 320 50 terrain preserve"), "overlap refused");
  Check(refuse("regionalwater 2 region 192 192 320 320 35 terrain preserve region 320 192 448 320 50 terrain preserve"), "touching regions refused");
  Check(refuse("regionalwater 2 region 192 192 320 320 35 terrain gentle region 400 192 528 320 50 terrain gentle"), "overlapping edit margins refused");
  Check(refuse("regionalwater 2 region 192 192 320 320 35 terrain gentle region 384 192 512 320 50 terrain preserve"), "automatic margin touching preserved lake refused");
  Check(refuse("regionalwater 2 region 192 192 320 320 35 terrain gentle region 512 192 640 320 50 terrain broken"), "bad second terrain mode refused");
  Check(refuse("regionalwater 2 region 192 192 832 832 35 terrain gentle region 1024 192 1664 832 50 terrain gentle"), "combined sample budget refused");
  std::string nine = "regionalwater 2";
  for (int i = 0; i < 9; ++i) nine += " region 192 192 320 320 35 terrain preserve";
  Check(!ParseMapDefinition(nine), "ninth region refused");

  MapRegions registry; MapRegions::Cache cache;
  int original = 0, copy = 0, preview = 0;
  registry.SetAll(&original, lakes);
  registry.SetAll(&copy, registry.GetAll(&original, {}, cache));
  registry.Set(&preview, {}); registry.Erase(&original);
  Check(registry.GetAll(&copy, {}, cache).count == 2 && registry.GetAll(&copy, {}, cache).values[1].height == 50,
        "copy retains every lake after original destruction");
  Check(!registry.GetAll(&original, {}, cache).Enabled() && !registry.GetAll(&preview, {}, cache).Enabled(), "preview and destroyed-map isolation");

  std::mt19937 rng(0x52454735);
  for (unsigned sample = 0; sample < 200; ++sample) {
    RegionSet random; random.count = 2 + rng() % 7;
    std::array<unsigned, 16> cells{};
    for (unsigned i = 0; i < cells.size(); ++i) cells[i] = i;
    std::shuffle(cells.begin(), cells.end(), rng);
    for (std::size_t i = 0; i < random.count; ++i) {
      const float x = float((cells[i] % 4) * 64 + 2), z = float((cells[i] / 4) * 64 + 2);
      const float sizeX = float(4 + (rng() % 27) * 2), sizeZ = float(4 + (rng() % 27) * 2);
      random.values[i] = {{x, z, x + sizeX, z + sizeZ}, i == 0 ? 17.5f : float(rng() % 70), true};
    }
    VerifyPartition(random, 256, 256);
    for (unsigned s = 0; s < 30; ++s) {
      const auto coordinate = [&]() { return float(int(rng() % 320) - 32); };
      const Point3 from{coordinate(), float(rng() % 100), coordinate()}, to{coordinate(), float(rng() % 100), coordinate()};
      const bool below = (rng() % 2) != 0;
      const auto expected = Reference(random, from, to, below);
      const auto actual = FindWaterCrossing(random, 17.5f, 256, 256, from, to, below);
      Check(actual.kind == expected.kind, "direct collision disagrees with render-sheet intersection");
      if (actual.kind != WaterCrossingKind::None) {
        Check(std::abs(actual.fraction - expected.fraction) < .00001f && actual.position.y == expected.position.y,
              "direct collision picks wrong first sheet");
      }
    }
  }
  std::cout << "PASS: multi-lake parsing/guards/registry, partition coverage/height agreement, lower lakes, finite impacts; 200 layouts with 2-8 lakes and 6000 swept-segment comparisons.\n";
}
