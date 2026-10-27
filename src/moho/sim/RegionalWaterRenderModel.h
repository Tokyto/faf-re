#pragma once

// Portable part of the experimental renderer's depth/land mask.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace moho::regionalwater
{
  [[nodiscard]] inline std::uint32_t WaterMaskPixel(float waterHeight, float depthRange,
                                                   const std::array<float, 4>& terrain,
                                                   std::uint8_t foam, std::uint8_t flatness) noexcept
  {
    // BGRA8: B = any land corner, G = depth, R = flatness/shadow, A = foam.
    // The depth range belongs to the original map, not the lake's absolute Y.
    if (!std::isfinite(depthRange) || depthRange <= 0.0f) depthRange = 1.0f;
    const auto depth = static_cast<std::uint8_t>(
      std::clamp((waterHeight - terrain[0]) / depthRange * 255.0f, 0.0f, 255.0f));
    const bool wet = std::any_of(terrain.begin(), terrain.end(),
                                 [=](float h) { return waterHeight > h; });
    const bool land = std::any_of(terrain.begin(), terrain.end(),
                                  [=](float h) { return waterHeight < h; });
    return (static_cast<std::uint32_t>(foam) << 24u) |
           (static_cast<std::uint32_t>(flatness) << 16u) |
           (wet ? static_cast<std::uint32_t>(depth) << 8u : 0u) |
           (land ? 0xffu : 0u);
  }
}
