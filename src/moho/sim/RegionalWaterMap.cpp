#include "moho/sim/RegionalWater.h"
#include "moho/sim/RegionalWaterMapModel.h"
#include "moho/sim/RegionalWaterRegistry.h"

#include <array>
#include <exception>
#include <utility>
#include <vector>

#include "gpg/core/utils/Logging.h"
#include "moho/misc/FileWaitHandleSet.h"
#include "moho/misc/StartupHelpers.h"
#include "moho/sim/STIMap.h"

namespace moho
{
  namespace
  {
    regionalwater::MapRegions& Regions()
    {
      // Outlive engine shutdown: maps may be destroyed by other static owners.
      static auto* const regions = new regionalwater::MapRegions;
      return *regions;
    }

    const regionalwater::Region& CommandLineRegion()
    {
      static const regionalwater::Region region = [] {
        if (ExperimentalWaterMapsEnabled()) return regionalwater::Region{};
        msvc8::vector<msvc8::string> args;
        if (!CFG_GetArgOption("/regionalwater", 5u, &args)) return regionalwater::Region{};
        if (args.size() != 5u) return regionalwater::Region{};
        const auto parsed = regionalwater::Parse({args[0].c_str(), args[1].c_str(), args[2].c_str(),
                                                  args[3].c_str(), args[4].c_str()});
        if (!parsed.enabled) gpg::Warnf("Regional water: invalid legacy command-line region; disabled");
        return parsed;
      }();
      return region;
    }
  }

  bool ExperimentalWaterMapsEnabled()
  {
    static const bool enabled = CFG_GetArgOption("/regionalwatermaps", 0u, nullptr);
    return enabled;
  }

  regionalwater::Region GetExperimentalWaterRegion(const STIMap* const map)
  {
    return GetExperimentalWaterRegions(map).First();
  }

  regionalwater::RegionSet GetExperimentalWaterRegions(const STIMap* const map)
  {
    return GetExperimentalWaterRegionsCached(map);
  }

  const regionalwater::RegionSet& GetExperimentalWaterRegionsCached(const STIMap* const map)
  {
    thread_local regionalwater::MapRegions::Cache cache;
    return Regions().GetAllCached(map, CommandLineRegion(), cache);
  }

  void SetExperimentalWaterRegion(const STIMap* const map, const regionalwater::Region region)
  {
    Regions().Set(map, region);
  }

  void SetExperimentalWaterRegions(const STIMap* const map, const regionalwater::RegionSet& regions)
  {
    Regions().SetAll(map, regions);
  }

  void ForgetExperimentalWaterRegion(const STIMap* const map)
  {
    Regions().Erase(map);
  }

  bool LoadExperimentalWaterMap(STIMap* const map, const char* const mapPath, bool* const terrainChanged)
  {
    if (terrainChanged) *terrainChanged = false;
    if (!ExperimentalWaterMapsEnabled()) return true;
    if (!map || !map->mHeightField || !mapPath) return false;
    // An ordinary map explicitly keeps ordinary water. No process-global state.
    SetExperimentalWaterRegion(map, {});
    const std::string sidecar = regionalwater::MapDefinitionPath(mapPath);
    FWaitHandleSet* const files = FILE_GetWaitHandleSet();
    if (!files || !files->mHandle) return false;
    msvc8::string resolved;
    (void)files->mHandle->FindFile(&resolved, sidecar.c_str(), nullptr);
    if (resolved.empty()) {
      gpg::Logf("[RegionalWaterMap v0.6] no definition for %s; ordinary water", mapPath);
      return true;
    }

    try {
      auto stream = DISK_OpenFileRead(resolved.c_str());
      if (!stream.get()) {
        gpg::Warnf("[RegionalWaterMap v0.6] cannot read %s; map load refused", sidecar.c_str());
        return false;
      }
      std::array<char, regionalwater::kMaxMapDefinitionBytes + 1> bytes{};
      std::size_t count = 0;
      while (count < bytes.size()) {
        const std::size_t read = stream->Read(bytes.data() + count, bytes.size() - count);
        if (read == 0) break;
        count += read;
      }
      const auto definition = regionalwater::ParseMapDefinition({bytes.data(), count});
      CHeightField* const field = map->mHeightField.get();
      const char* const error = regionalwater::ValidateMapDefinition(definition, field->width - 1,
        field->height - 1, map->mWaterElevation, map->mWaterEnabled != 0u);
      if (error) {
        gpg::Warnf("[RegionalWaterMap v0.6] %s: %s; map load refused", sidecar.c_str(), error);
        return false;
      }
      struct PreparedBasin { gpg::Rect2i rect; int stride; std::vector<std::uint16_t> heights; };
      std::vector<PreparedBasin> basins;
      basins.reserve(definition.regions.count);
      // Prepare and validate ALL edits before touching any height sample.
      // A bad second lake must not leave the first lake partially applied.
      for (std::size_t i = 0; i < definition.regions.count; ++i) {
        if (!definition.gentleBasins[i]) continue;
        if (!field->data) return false;
        const auto& region = definition.regions.values[i];
        constexpr int margin = regionalwater::kBasinOuterMargin;
        const gpg::Rect2i rect{static_cast<int>(region.bounds.x0) - margin,
                              static_cast<int>(region.bounds.z0) - margin,
                              static_cast<int>(region.bounds.x1) + margin,
                              static_cast<int>(region.bounds.z1) + margin};
        const int stride = rect.x1 - rect.x0 + 1;
        std::vector<std::uint16_t> heights(static_cast<std::size_t>(stride) * (rect.z1 - rect.z0 + 1));
        for (int z = rect.z0; z <= rect.z1; ++z) {
          for (int x = rect.x0; x <= rect.x1; ++x) {
            const float y = regionalwater::BasinHeight(region, map->mWaterElevation,
              static_cast<float>(x), static_cast<float>(z), field->GetElevation(static_cast<float>(x), static_cast<float>(z)));
            if (!std::isfinite(y) || y < 0 || y > 511.9921875f) {
              gpg::Warnf("[RegionalWaterMap v0.6] unsupported terrain height; map load refused");
              return false;
            }
            heights[static_cast<std::size_t>(x - rect.x0) + static_cast<std::size_t>(z - rect.z0) * stride] =
              static_cast<std::uint16_t>(std::lround(y * 128.0f));
          }
        }
        // Before sim copies, unit creation and terrain render resources. This
        // changes only the in-memory map, never the source SCMAP on disk.
        basins.push_back({rect, stride, std::move(heights)});
      }
      for (const auto& basin : basins) {
        const auto& rect = basin.rect;
        field->SetElevationRectRaw(rect, basin.heights.data(), basin.stride);
        field->UpdateError({rect.x0 - 1, rect.z0 - 1, rect.x1 + 1, rect.z1 + 1});
      }
      if (terrainChanged) *terrainChanged = !basins.empty();
      SetExperimentalWaterRegions(map, definition.regions);
      for (std::size_t i = 0; i < definition.regions.count; ++i) {
        const auto& r = definition.regions.values[i];
        gpg::Logf("[RegionalWaterMap v0.6] loaded %s region %u/%u: [%g,%g)-[%g,%g), water=%g, terrain=%s, vertices=%u",
                  sidecar.c_str(), static_cast<unsigned>(i + 1), static_cast<unsigned>(definition.regions.count),
                  r.bounds.x0, r.bounds.z0, r.bounds.x1, r.bounds.z1, r.height,
                  definition.gentleBasins[i] ? "gentle" : "preserve", static_cast<unsigned>(r.vertexCount));
      }
      return true;
    } catch (const std::exception& error) {
      gpg::Warnf("[RegionalWaterMap v0.6] %s: %s; map load refused", sidecar.c_str(), error.what());
      return false;
    }
  }
}
