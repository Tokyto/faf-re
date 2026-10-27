#pragma once

#include "moho/sim/RegionalWaterModel.h"

namespace moho::regionalwater
{
  inline constexpr int kBasinOuterMargin = 64;
  inline constexpr float kBasinDepth = 12.0f;
  inline constexpr float kBasinDryClearance = 4.0f;

  [[nodiscard]] inline float SmoothStep01(float t) noexcept
  {
    t = std::clamp(t, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
  }

  // A round/elliptical bowl inside a dry rectangular rim. Outside the water
  // rectangle, blend back into each original terrain sample over 64 units.
  // All four region edges stay above BOTH water levels, including a low lake.
  [[nodiscard]] inline float BasinHeight(const Region& region, float baseHeight,
                                         float x, float z, float originalHeight) noexcept
  {
    if (!region.enabled) return originalHeight;
    const auto& r = region.bounds;
    const float halfX = (r.x1 - r.x0) * 0.5f;
    const float halfZ = (r.z1 - r.z0) * 0.5f;
    if (halfX <= 0.0f || halfZ <= 0.0f) return originalHeight;
    const float dx = std::abs(x - (r.x0 + r.x1) * 0.5f);
    const float dz = std::abs(z - (r.z0 + r.z1) * 0.5f);
    const float outsideX = std::max(0.0f, dx - halfX);
    const float outsideZ = std::max(0.0f, dz - halfZ);
    const float outside = std::sqrt(outsideX * outsideX + outsideZ * outsideZ);
    const float rim = std::max(region.height, baseHeight) + kBasinDryClearance;
    if (outside >= static_cast<float>(kBasinOuterMargin)) return originalHeight;
    if (outside > 0.0f) {
      const float blend = SmoothStep01(outside / static_cast<float>(kBasinOuterMargin));
      return rim + (originalHeight - rim) * blend;
    }
    const float nx = dx / halfX;
    const float nz = dz / halfZ;
    const float radius = std::sqrt(nx * nx + nz * nz);
    const float bank = SmoothStep01((radius - 0.35f) / 0.50f);
    const float floor = region.height - kBasinDepth;
    return floor + (rim - floor) * bank;
  }
}
