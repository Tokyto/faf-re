#pragma once
#include "moho/sim/RegionalWaterModel.h"

namespace moho
{
  class WaterSurface;
  class IWldTerrainRes;
  class STIMap;

  // A loaded map's immutable definition, or the legacy command-line fallback.
  [[nodiscard]] regionalwater::Region GetExperimentalWaterRegion(const STIMap* map);
  [[nodiscard]] regionalwater::RegionSet GetExperimentalWaterRegions(const STIMap* map);
  [[nodiscard]] const regionalwater::RegionSet& GetExperimentalWaterRegionsCached(const STIMap* map);
  void SetExperimentalWaterRegion(const STIMap* map, regionalwater::Region region);
  void SetExperimentalWaterRegions(const STIMap* map, const regionalwater::RegionSet& regions);
  void ForgetExperimentalWaterRegion(const STIMap* map);
  [[nodiscard]] bool ExperimentalWaterMapsEnabled();
  [[nodiscard]] bool LoadExperimentalWaterMap(STIMap* map, const char* mapPath, bool* terrainChanged = nullptr);
  [[nodiscard]] WaterSurface* CreateExperimentalRegionalWater(IWldTerrainRes* terrainResource, bool lowFidelity);
}
