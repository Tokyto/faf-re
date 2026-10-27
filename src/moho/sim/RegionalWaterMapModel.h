#pragma once

#include "moho/sim/RegionalWaterBasinModel.h"
#include "moho/sim/RegionalWaterPolygonModel.h"
#include <string>

namespace moho::regionalwater
{
  inline constexpr std::size_t kMaxMapDefinitionBytes = 4096;
  struct MapDefinition
  {
    RegionSet regions{};
    std::array<bool, kMaxRegions> gentleBasins{};
    const char* error = nullptr;
    [[nodiscard]] explicit operator bool() const noexcept { return error == nullptr && regions.Enabled(); }
  };

  // Schemas 1/2 retain their rectangular grammar. Schema 3 additionally accepts
  // polygon HEIGHT COUNT X Z ... terrain preserve. No executable script input.
  [[nodiscard]] inline MapDefinition ParseMapDefinition(std::string_view text) noexcept
  {
    const auto fail = [](const char* message) { MapDefinition d; d.error = message; return d; };
    if (text.size() > kMaxMapDefinitionBytes) return fail("definition exceeds 4096 bytes");
    if (text.starts_with("\xEF\xBB\xBF")) text.remove_prefix(3);
    std::array<std::string_view, 2 + kMaxRegions * (5 + 2 * kMaxPolygonVertices)> tokens{};
    std::size_t count = 0;
    while (!text.empty()) {
      if (text.front() == '#') {
        const auto newline = text.find('\n'); if (newline == std::string_view::npos) break;
        text.remove_prefix(newline + 1); continue;
      }
      if (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' || text.front() == '\n') {
        text.remove_prefix(1); continue;
      }
      const auto end = text.find_first_of(" \t\r\n#");
      if (count == tokens.size()) return fail("too many fields; at most 8 polygons of 32 vertices are supported");
      tokens[count++] = text.substr(0, end);
      text.remove_prefix(end == std::string_view::npos ? text.size() : end);
    }
    if (count < 2 || tokens[0] != "regionalwater") return fail("expected regionalwater version");
    if (tokens[1] != "1" && tokens[1] != "2" && tokens[1] != "3") return fail("unsupported schema version");
    const auto coordinate = [](std::string_view token, float& value) {
      int number = 0;
      const auto [end,error] = std::from_chars(token.data(),token.data()+token.size(),number);
      if(error!=std::errc{}||end!=token.data()+token.size()||number<0||number>32768||number%2) return false;
      value=static_cast<float>(number);return true;
    };
    MapDefinition definition;
    for(std::size_t p=2;p<count;) {
      if(definition.regions.count==kMaxRegions)return fail("at most 8 regions are supported");
      Region region;std::size_t modeOffset=0,next=0;
      if(tokens[p]=="region") {
        if(count-p<8)return fail("incomplete region/terrain record");
        region=Parse({tokens[p+1],tokens[p+2],tokens[p+3],tokens[p+4],tokens[p+5]});
        if(!region.enabled)return fail("invalid region bounds or height");
        modeOffset=p+6;next=p+8;
      } else if(tokens[p]=="polygon"&&tokens[1]=="3") {
        if(count-p<3)return fail("incomplete polygon record");
        unsigned n=0;const auto token=tokens[p+2];
        const auto [end,error]=std::from_chars(token.data(),token.data()+token.size(),n);
        if(error!=std::errc{}||end!=token.data()+token.size()||n<3||n>kMaxPolygonVertices)
          return fail("a polygon needs 3 to 32 vertices");
        if(count-p<5+2*n)return fail("incomplete polygon/terrain record");
        region=Parse({"0","0","2","2",tokens[p+1]});
        if(!region.enabled)return fail("invalid polygon water height");
        region.vertexCount=n;
        for(std::size_t i=0;i<n;++i)
          if(!coordinate(tokens[p+3+2*i],region.vertices[i].x)||!coordinate(tokens[p+4+2*i],region.vertices[i].z))
            return fail("invalid polygon coordinate");
        if(const auto invalid=ValidatePolygon(region))return fail(invalid);
        UpdatePolygonBounds(region);modeOffset=p+3+2*n;next=modeOffset+2;
      } else return fail("expected region, or polygon in schema 3");
      if(tokens[modeOffset]!="terrain")return fail("missing terrain mode");
      const auto mode=tokens[modeOffset+1];
      if(mode!="preserve"&&mode!="gentle")return fail("unknown terrain mode");
      if(region.vertexCount&&mode!="preserve")return fail("polygons support terrain preserve only");
      const auto i=definition.regions.count++;
      definition.regions.values[i]=region;definition.gentleBasins[i]=mode=="gentle";p=next;
    }
    if(!definition.regions.count)return fail("missing region");
    if(tokens[1]=="1"&&definition.regions.count!=1)return fail("schema 1 supports only one region; use schema 2 or 3");
    return definition;
  }

  [[nodiscard]] inline const char* ValidateMapDefinition(const MapDefinition& definition,
                                                        int width, int depth, float sea, bool waterEnabled) noexcept
  {
    if (!definition) return definition.error ? definition.error : "missing region";
    if (!waterEnabled || !std::isfinite(sea)) return "the map must have enabled, finite ocean water";
    if (width <= 0 || depth <= 0 || definition.regions.count > kMaxRegions) return "invalid map or region count";
    double totalSamples = 0;
    for (std::size_t i = 0; i < definition.regions.count; ++i) {
      const auto& r = definition.regions.values[i];
      if(r.vertexCount)if(const auto invalid=ValidatePolygon(r))return invalid;
      if (r.bounds.x1 > width || r.bounds.z1 > depth) return "every region must fit fully inside the map";
      if (!definition.gentleBasins[i]) continue;
      if(r.vertexCount)return "polygons support terrain preserve only";
      const float margin = static_cast<float>(kBasinOuterMargin);
      if (width != depth || r.bounds.x0 <= margin || r.bounds.z0 <= margin ||
          r.bounds.x1 + margin >= width || r.bounds.z1 + margin >= depth ||
          r.bounds.x1 - r.bounds.x0 < 128 || r.bounds.z1 - r.bounds.z0 < 128 ||
          r.height < kBasinDepth || std::max(r.height, sea) + kBasinDryClearance > 500)
        return "gentle terrain needs a square map, a 128x128 region, 64-unit margin and supported heights";
      totalSamples += (r.bounds.x1-r.bounds.x0+2*margin+1)*(r.bounds.z1-r.bounds.z0+2*margin+1);
      if(totalSamples>1048576)return "combined gentle terrain exceeds the sample limit";
    }
    for(std::size_t i=0;i<definition.regions.count;++i)for(std::size_t j=i+1;j<definition.regions.count;++j) {
      const auto& a=definition.regions.values[i];const auto& b=definition.regions.values[j];
      if(RegionsTouch(a,b))return "water regions must be separate; overlaps and touching edges are unsupported";
      if(!definition.gentleBasins[i]&&!definition.gentleBasins[j])continue;
      auto aa=a,bb=b;
      if(definition.gentleBasins[i]){aa.bounds.x0-=64;aa.bounds.z0-=64;aa.bounds.x1+=64;aa.bounds.z1+=64;}
      if(definition.gentleBasins[j]){bb.bounds.x0-=64;bb.bounds.z0-=64;bb.bounds.x1+=64;bb.bounds.z1+=64;}
      if(RegionsTouch(aa,bb))return "automatic basin edit areas must not touch each other or another water region";
    }
    return nullptr;
  }
  [[nodiscard]] inline std::string MapDefinitionPath(std::string_view mapPath) { return std::string(mapPath)+".regionalwater"; }
}
