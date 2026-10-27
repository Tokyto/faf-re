#pragma once

#include "moho/sim/RegionalWaterModel.h"
#include <atomic>
#include <cstdint>
#include <mutex>
#include <unordered_map>

namespace moho::regionalwater
{
  // Side storage preserves all recovered engine object layouts. Loaded-map
  // definitions are immutable while in use, copied to sim/shadow maps and
  // erased at destruction. UI previews cannot alter another map's water.
  class MapRegions
  {
  public:
    struct Cache
    {
      const MapRegions* owner = nullptr;
      const void* map = nullptr;
      std::uint64_t revision = 0;
      RegionSet regions{};
    };

    [[nodiscard]] RegionSet GetAll(const void* map, Region fallback, Cache& cache) const
    {
      return GetAllCached(map, fallback, cache);
    }

    // Point-height queries must not copy every polygon vertex per sample.
    // The caller consumes this thread-local snapshot before another map query.
    [[nodiscard]] const RegionSet& GetAllCached(const void* map, const Region& fallback, Cache& cache) const
    {
      static const RegionSet empty{};
      if (!map) return empty;
      const auto revision = mRevision.load(std::memory_order_acquire);
      if (cache.owner == this && cache.map == map && cache.revision == revision) return cache.regions;
      std::lock_guard<std::mutex> guard(mMutex);
      const auto it = mRegions.find(map);
      const RegionSet regions = it != mRegions.end() ? it->second : SingleRegion(fallback);
      cache = {this, map, mRevision.load(std::memory_order_relaxed), regions};
      return cache.regions;
    }

    [[nodiscard]] Region Get(const void* map, Region fallback, Cache& cache) const
    {
      return GetAll(map, fallback, cache).First();
    }

    void Set(const void* map, Region region) { SetAll(map, SingleRegion(region)); }

    void SetAll(const void* map, const RegionSet& regions)
    {
      if (!map) return;
      std::lock_guard<std::mutex> guard(mMutex);
      mRegions[map] = regions;
      mRevision.fetch_add(1, std::memory_order_release);
    }

    void Erase(const void* map)
    {
      std::lock_guard<std::mutex> guard(mMutex);
      if (mRegions.erase(map)) mRevision.fetch_add(1, std::memory_order_release);
    }

  private:
    mutable std::mutex mMutex;
    std::atomic<std::uint64_t> mRevision{1};
    std::unordered_map<const void*, RegionSet> mRegions;
  };
}
