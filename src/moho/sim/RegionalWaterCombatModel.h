#pragma once

#include "moho/sim/RegionalWaterModel.h"

namespace moho::regionalwater
{
  struct Point3 { float x, y, z; };
  enum class WaterCrossingKind { None, Enter, Exit };
  struct WaterCrossing
  {
    WaterCrossingKind kind = WaterCrossingKind::None;
    float fraction = 0;
    Point3 position{};
  };

  // Test at most one plane per lake plus the ocean. Do not rebuild render
  // partitions for every projectile/tick. The ocean has a hole over ALL lakes,
  // including lower ones. Region edges are not vertical water walls.
  [[nodiscard]] inline WaterCrossing FindWaterCrossing(const RegionSet& regions, float baseHeight,
                                                       float width, float depth,
                                                       Point3 from, Point3 to, bool belowWater) noexcept
  {
    WaterCrossing best;
    const float dy = to.y - from.y;
    if (!std::isfinite(dy) || dy == 0.0f ||
        !std::isfinite(from.x) || !std::isfinite(from.z) || !std::isfinite(to.x) || !std::isfinite(to.z)) return best;
    if ((belowWater && dy < 0) || (!belowWater && dy > 0)) return best;
    float nearest = 2.0f;
    const Rect mapBounds{0, 0, width, depth};
    const auto consider = [&](float h, const Region* local) {
      const bool crosses = belowWater ? (from.y <= h && to.y > h) : (from.y >= h && to.y < h);
      if (!crosses) return;
      const float t = (h - from.y) / dy;
      const Point3 hit{from.x + (to.x - from.x) * t, h, from.z + (to.z - from.z) * t};
      if (!mapBounds.Contains(hit.x, hit.z)) return;
      if (local) {
        if (!local->Contains(hit.x, hit.z)) return;
      } else {
        for (std::size_t i = 0; i < regions.count; ++i) {
          if (regions.values[i].Contains(hit.x, hit.z)) return;
        }
      }
      if (t >= 0 && t <= 1 && t < nearest) {
        nearest = t;
        best = {belowWater ? WaterCrossingKind::Exit : WaterCrossingKind::Enter, t, hit};
      }
    };
    for (std::size_t i = 0; i < regions.count; ++i) consider(regions.values[i].height, &regions.values[i]);
    consider(baseHeight, nullptr);
    return best;
  }

  [[nodiscard]] inline WaterCrossing FindWaterCrossing(const Region& region, float baseHeight,
                                                       float width, float depth,
                                                       Point3 from, Point3 to, bool belowWater) noexcept
  {
    return FindWaterCrossing(SingleRegion(region), baseHeight, width, depth, from, to, belowWater);
  }
}
