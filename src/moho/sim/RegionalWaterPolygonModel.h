#pragma once

#include "moho/sim/RegionalWaterModel.h"
#include <vector>

namespace moho::regionalwater
{
  [[nodiscard]] inline double Cross(Point2 a, Point2 b, Point2 c) noexcept
  {
    return (static_cast<double>(b.x) - a.x) * (static_cast<double>(c.z) - a.z) -
           (static_cast<double>(b.z) - a.z) * (static_cast<double>(c.x) - a.x);
  }
  [[nodiscard]] inline bool OnSegment(Point2 a, Point2 b, Point2 p) noexcept
  {
    return Cross(a, b, p) == 0 && p.x >= std::min(a.x, b.x) && p.x <= std::max(a.x, b.x) &&
      p.z >= std::min(a.z, b.z) && p.z <= std::max(a.z, b.z);
  }
  [[nodiscard]] inline bool SegmentsTouch(Point2 a, Point2 b, Point2 c, Point2 d) noexcept
  {
    const auto abC = Cross(a, b, c), abD = Cross(a, b, d), cdA = Cross(c, d, a), cdB = Cross(c, d, b);
    if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
        ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
    return (abC == 0 && OnSegment(a, b, c)) || (abD == 0 && OnSegment(a, b, d)) ||
           (cdA == 0 && OnSegment(c, d, a)) || (cdB == 0 && OnSegment(c, d, b));
  }
  [[nodiscard]] inline std::size_t VertexCount(const Region& r) noexcept { return r.vertexCount ? r.vertexCount : 4; }
  [[nodiscard]] inline Point2 VertexAt(const Region& r, std::size_t i) noexcept
  {
    if (r.vertexCount) return r.vertices[i];
    const auto& b = r.bounds;
    const std::array<Point2, 4> points{{{b.x0,b.z0},{b.x1,b.z0},{b.x1,b.z1},{b.x0,b.z1}}};
    return points[i];
  }
  [[nodiscard]] inline bool ValidCoordinate(float v) noexcept
  {
    return std::isfinite(v) && v >= 0 && v <= 32768 && std::floor(v) == v && static_cast<int>(v) % 2 == 0;
  }
  [[nodiscard]] inline const char* ValidatePolygon(const Region& r) noexcept
  {
    const auto n = r.vertexCount;
    if (n < 3 || n > kMaxPolygonVertices) return "a polygon needs 3 to 32 vertices";
    double area = 0;
    for (std::size_t i = 0; i < n; ++i) {
      const auto a = r.vertices[i], b = r.vertices[(i + 1) % n], c = r.vertices[(i + 2) % n];
      if (!ValidCoordinate(a.x) || !ValidCoordinate(a.z)) return "polygon coordinates must be nonnegative even integers up to 32768";
      for (std::size_t j = i + 1; j < n; ++j)
        if (a.x == r.vertices[j].x && a.z == r.vertices[j].z) return "polygon vertices must be distinct; do not repeat the first vertex";
      if (Cross(a,b,c) == 0 &&
          (static_cast<double>(a.x)-b.x)*(c.x-b.x) + (static_cast<double>(a.z)-b.z)*(c.z-b.z) > 0)
        return "polygon edges must not double back";
      area += static_cast<double>(a.x) * b.z - static_cast<double>(b.x) * a.z;
      for (std::size_t j = i + 1; j < n; ++j) {
        if (j == i + 1 || (i == 0 && j == n - 1)) continue;
        if (SegmentsTouch(a,b,r.vertices[j],r.vertices[(j + 1) % n])) return "polygon edges must not cross or touch themselves";
      }
    }
    return area == 0 ? "polygon must have a nonzero area" : nullptr;
  }
  inline void UpdatePolygonBounds(Region& r) noexcept
  {
    r.bounds = {32768,32768,0,0};
    for (std::size_t i=0;i<r.vertexCount;++i) {
      const auto p=r.vertices[i];
      r.bounds.x0=std::min(r.bounds.x0,p.x);r.bounds.z0=std::min(r.bounds.z0,p.z);
      r.bounds.x1=std::max(r.bounds.x1,p.x);r.bounds.z1=std::max(r.bounds.z1,p.z);
    }
  }
  [[nodiscard]] inline bool RegionsTouch(const Region& a, const Region& b) noexcept
  {
    if (a.bounds.x1 < b.bounds.x0 || b.bounds.x1 < a.bounds.x0 ||
        a.bounds.z1 < b.bounds.z0 || b.bounds.z1 < a.bounds.z0) return false;
    const auto na=VertexCount(a),nb=VertexCount(b);
    for(std::size_t i=0;i<na;++i) for(std::size_t j=0;j<nb;++j)
      if(SegmentsTouch(VertexAt(a,i),VertexAt(a,(i+1)%na),VertexAt(b,j),VertexAt(b,(j+1)%nb)))return true;
    const auto pa=VertexAt(a,0),pb=VertexAt(b,0);
    return a.Contains(pb.x,pb.z)||b.Contains(pa.x,pa.z);
  }
  [[nodiscard]] inline bool HasPolygons(const RegionSet& regions) noexcept
  {
    for(std::size_t i=0;i<regions.count;++i)if(regions.values[i].vertexCount)return true;
    return false;
  }

  // Horizontal trapezoid decomposition. Split at all vertex Z coordinates, then
  // sort active polygon edges in each slab. Simple disjoint polygons cannot
  // exchange edge order inside a slab. Every interval is either one lake or sea,
  // so the ocean has real holes even above lower lakes. No raster stair steps.
  struct WaterTrapezoid { std::array<Point2,4> points{}; float height=0; };
  [[nodiscard]] inline std::vector<WaterTrapezoid> PolygonWaterPatches(const RegionSet& regions,
                                                                    float width,float depth,float sea)
  {
    std::vector<WaterTrapezoid> result;
    if(!(width>0&&depth>0))return result;
    std::vector<double> zs{0,depth};
    for(std::size_t i=0;i<regions.count;++i)for(std::size_t j=0;j<VertexCount(regions.values[i]);++j)
      zs.push_back(VertexAt(regions.values[i],j).z);
    std::sort(zs.begin(),zs.end());zs.erase(std::unique(zs.begin(),zs.end()),zs.end());
    struct Edge { double top,bottom,middle; };
    std::vector<Edge> edges;edges.reserve(kMaxRegions*kMaxPolygonVertices+2);
    for(std::size_t z=0;z+1<zs.size();++z) {
      const double z0=zs[z],z1=zs[z+1],mid=(z0+z1)*.5;
      if(z0<0||z1>depth||z0==z1)continue;
      edges.clear();edges.push_back({0,0,0});edges.push_back({width,width,width});
      for(std::size_t i=0;i<regions.count;++i) {
        const auto& r=regions.values[i];const auto n=VertexCount(r);
        for(std::size_t j=0;j<n;++j) {
          const auto a=VertexAt(r,j),b=VertexAt(r,(j+1)%n);
          if(!((a.z<=mid&&b.z>mid)||(b.z<=mid&&a.z>mid)))continue;
          const auto x=[&](double at){return static_cast<double>(a.x)+(at-a.z)*(static_cast<double>(b.x)-a.x)/(static_cast<double>(b.z)-a.z);};
          edges.push_back({x(z0),x(z1),x(mid)});
        }
      }
      std::sort(edges.begin(),edges.end(),[](const Edge& a,const Edge& b){return a.middle<b.middle;});
      for(std::size_t i=0;i+1<edges.size();++i) {
        const auto& a=edges[i];const auto& b=edges[i+1];if(b.middle<=a.middle)continue;
        const float h=HeightAt(regions,sea,static_cast<float>((a.middle+b.middle)*.5),static_cast<float>(mid));
        result.push_back({{{{static_cast<float>(a.top),static_cast<float>(z0)},
                            {static_cast<float>(b.top),static_cast<float>(z0)},
                            {static_cast<float>(a.bottom),static_cast<float>(z1)},
                            {static_cast<float>(b.bottom),static_cast<float>(z1)}}},h});
      }
    }
    return result;
  }
}
