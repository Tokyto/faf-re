#pragma once

// Experimental immutable water regions. No engine/platform headers.
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <string_view>
#include <system_error>

namespace moho::regionalwater
{
  struct Rect
  {
    float x0 = 0, z0 = 0, x1 = 0, z1 = 0;
    [[nodiscard]] bool Contains(float x, float z) const noexcept
    {
      return x >= x0 && x < x1 && z >= z0 && z < z1;
    }
  };

  inline constexpr std::size_t kMaxPolygonVertices = 32;
  struct Point2 { float x = 0, z = 0; };

  struct Region
  {
    Rect bounds;
    float height = 0;
    bool enabled = false;
    // Zero vertices retains the original half-open rectangle representation.
    std::array<Point2, kMaxPolygonVertices> vertices{};
    std::size_t vertexCount = 0;

    [[nodiscard]] bool Contains(float x, float z) const noexcept
    {
      if (!bounds.Contains(x, z)) return false;
      if (!vertexCount) return true;
      if (vertexCount < 3 || vertexCount > kMaxPolygonVertices) return false;
      bool inside = false;
      for (std::size_t i = 0, j = vertexCount - 1; i < vertexCount; j = i++) {
        const auto& a = vertices[j]; const auto& b = vertices[i];
        if ((a.z > z) != (b.z > z) &&
            static_cast<double>(x) < static_cast<double>(a.x) +
              (static_cast<double>(z) - a.z) * (static_cast<double>(b.x) - a.x) /
              (static_cast<double>(b.z) - a.z)) inside = !inside;
      }
      return inside;
    }
  };

  inline constexpr std::size_t kMaxRegions = 8;
  struct RegionSet
  {
    std::array<Region, kMaxRegions> values{};
    std::size_t count = 0;
    [[nodiscard]] bool Enabled() const noexcept { return count != 0; }
    [[nodiscard]] Region First() const noexcept { return count ? values[0] : Region{}; }
  };

  [[nodiscard]] inline RegionSet SingleRegion(const Region& region) noexcept
  {
    RegionSet regions;
    if (region.enabled) { regions.values[0] = region; regions.count = 1; }
    return regions;
  }

  [[nodiscard]] inline Region Parse(const std::array<std::string_view, 5>& values) noexcept
  {
    std::array<int, 4> bounds{};
    for (std::size_t i = 0; i < bounds.size(); ++i) {
      const auto [end, error] = std::from_chars(values[i].data(), values[i].data() + values[i].size(), bounds[i]);
      if (error != std::errc{} || end != values[i].data() + values[i].size() ||
          bounds[i] < 0 || bounds[i] > 32768 || bounds[i] % 2 != 0) {
        return {};
      }
    }
    float height = 0;
    const auto [end, error] = std::from_chars(values[4].data(), values[4].data() + values[4].size(), height);
    if (error != std::errc{} || end != values[4].data() + values[4].size() ||
        !std::isfinite(height) || height < -8192.0f || height > 8192.0f ||
        bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
      return {};
    }
    return {{static_cast<float>(bounds[0]), static_cast<float>(bounds[1]),
             static_cast<float>(bounds[2]), static_cast<float>(bounds[3])}, height, true};
  }

  [[nodiscard]] inline float HeightAt(const Region& region, float baseHeight, float x, float z) noexcept
  {
    return region.enabled && region.Contains(x, z) ? region.height : baseHeight;
  }

  [[nodiscard]] inline float HeightAt(const RegionSet& regions, float baseHeight, float x, float z) noexcept
  {
    for (std::size_t i = 0; i < regions.count; ++i) {
      if (regions.values[i].Contains(x, z)) return regions.values[i].height;
    }
    return baseHeight;
  }

  struct Patch { Rect bounds; float height = 0; };
  inline constexpr std::size_t kMaxPatches = (2 * kMaxRegions + 1) * (2 * kMaxRegions + 1);
  struct Patches { std::array<Patch, kMaxPatches> values{}; std::size_t count = 0; };

  // Partition the entire map, rather than drawing a second plane over the first.
  // This also permits a lower lake without leaving the old sea drawn above it.
  [[nodiscard]] inline Patches Partition(const Region& region, float width, float depth, float baseHeight) noexcept
  {
    Patches result;
    const auto add = [&](Rect bounds, float height) {
      if (bounds.x0 < bounds.x1 && bounds.z0 < bounds.z1) {
        result.values[result.count++] = {bounds, height};
      }
    };
    if (!(width > 0 && depth > 0)) return result;
    Rect local{std::clamp(region.bounds.x0, 0.0f, width), std::clamp(region.bounds.z0, 0.0f, depth),
               std::clamp(region.bounds.x1, 0.0f, width), std::clamp(region.bounds.z1, 0.0f, depth)};
    if (!region.enabled || local.x0 >= local.x1 || local.z0 >= local.z1) {
      add({0, 0, width, depth}, baseHeight);
      return result;
    }
    add({0, 0, width, local.z0}, baseHeight);
    add({0, local.z1, width, depth}, baseHeight);
    add({0, local.z0, local.x0, local.z1}, baseHeight);
    add({local.x1, local.z0, width, local.z1}, baseHeight);
    add(local, region.height);
    return result;
  }

  // Split along all region boundaries, then coalesce equal-height runs in
  // both axes. Every point belongs to exactly one sheet, including low lakes.
  // At most 17x17 grid cells for 8 regions; no heap allocations.
  [[nodiscard]] inline Patches Partition(const RegionSet& regions, float width, float depth, float baseHeight) noexcept
  {
    if (regions.count <= 1) return Partition(regions.First(), width, depth, baseHeight);
    Patches result;
    if (!(width > 0 && depth > 0)) return result;
    std::array<float, 2 * kMaxRegions + 2> xs{}, zs{};
    xs[0] = zs[0] = 0; xs[1] = width; zs[1] = depth;
    std::size_t nx = 2, nz = 2;
    for (std::size_t i = 0; i < regions.count; ++i) {
      const auto& r = regions.values[i].bounds;
      xs[nx++] = std::clamp(r.x0, 0.0f, width); xs[nx++] = std::clamp(r.x1, 0.0f, width);
      zs[nz++] = std::clamp(r.z0, 0.0f, depth); zs[nz++] = std::clamp(r.z1, 0.0f, depth);
    }
    std::sort(xs.begin(), xs.begin() + nx); std::sort(zs.begin(), zs.begin() + nz);
    nx = static_cast<std::size_t>(std::unique(xs.begin(), xs.begin() + nx) - xs.begin());
    nz = static_cast<std::size_t>(std::unique(zs.begin(), zs.begin() + nz) - zs.begin());
    const auto add = [&](Rect r, float h) {
      for (std::size_t i = 0; i < result.count; ++i) {
        auto& p = result.values[i];
        if (p.height == h && p.bounds.x0 == r.x0 && p.bounds.x1 == r.x1 && p.bounds.z1 == r.z0) {
          p.bounds.z1 = r.z1; return;
        }
      }
      result.values[result.count++] = {r, h};
    };
    for (std::size_t z = 0; z + 1 < nz; ++z) {
      std::size_t start = 0;
      float h = HeightAt(regions, baseHeight, (xs[0] + xs[1]) * .5f, (zs[z] + zs[z + 1]) * .5f);
      for (std::size_t x = 1; x + 1 < nx; ++x) {
        const float next = HeightAt(regions, baseHeight, (xs[x] + xs[x + 1]) * .5f, (zs[z] + zs[z + 1]) * .5f);
        if (next != h) { add({xs[start], zs[z], xs[x], zs[z + 1]}, h); start = x; h = next; }
      }
      add({xs[start], zs[z], xs[nx - 1], zs[z + 1]}, h);
    }
    return result;
  }
}
