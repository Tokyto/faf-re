#include "moho/sim/RegionalWater.h"

#include <memory>
#include <vector>
#include <span>
#include <iterator>

#include "gpg/core/utils/Global.h"
#include "gpg/core/utils/Logging.h"
#include "moho/misc/StartupHelpers.h"
#include "moho/render/ID3DVertexStream.h"
#include "moho/render/d3d/CD3DVertexSheet.h"
#include "moho/render/d3d/CD3DIndexSheet.h"
#include "moho/render/d3d/CD3DDevice.h"
#include "moho/misc/ID3DDeviceResources.h"
#include "moho/sim/RegionalWaterPolygonModel.h"
#include "moho/sim/CWldMap.h"
#include "moho/sim/STIMap.h"
#include "moho/terrain/water/HighFidelityWater.h"
#include "moho/terrain/water/LowFidelityWater.h"

namespace moho
{
  namespace
  {
    struct Vertex { float x, y, z, u, v; };
    static_assert(sizeof(Vertex) == 20);

    template<class NativeWater>
    bool SetPolygonGeometry(NativeWater& water, std::span<const regionalwater::WaterTrapezoid> patches,
                            float width, float depth)
    {
      auto* const resources=D3D_GetDevice()->GetResources();
      auto* const format=resources->GetVertexFormat(3);
      if(!format||patches.empty()||patches.size()>4096)return false;
      const auto vertexCount=static_cast<int>(patches.size()*4);
      auto sheet=std::unique_ptr<CD3DVertexSheet>(resources->NewVertexSheet(0u,vertexCount,format));
      auto indices=std::unique_ptr<CD3DIndexSheet>(resources->CreateIndexSheet(false,static_cast<int>(patches.size()*6)));
      if(!sheet||!indices)return false;
      auto* const stream=sheet->GetVertStream(0u);
      auto* const vertices=static_cast<Vertex*>(stream->Lock(0,vertexCount,false,false));
      if(!vertices)return false;
      for(std::size_t i=0;i<patches.size();++i)for(std::size_t j=0;j<4;++j) {
        const auto p=patches[i].points[j];vertices[i*4+j]={p.x,patches[i].height,p.z,p.x/width,p.z/depth};
      }
      stream->Unlock();
      auto* const data=indices->Lock(0u,indices->GetSize(),true,false);
      if(!data)return false;
      for(std::size_t i=0;i<patches.size();++i) {
        const auto base=static_cast<std::int16_t>(i*4);const auto k=i*6;
        data[k]=base;data[k+1]=base+2;data[k+2]=base+1;
        data[k+3]=base+1;data[k+4]=base+2;data[k+5]=base+3;
      }
      indices->Unlock();
      delete water.mVertexSheet;delete water.mIndexSheet;
      water.mVertexSheet=sheet.release();water.mIndexSheet=indices.release();
      return true;
    }

    void SetPatchGeometry(CD3DVertexSheet* sheet, const regionalwater::Patch& patch, float width, float depth)
    {
      auto* const stream = sheet->GetVertStream(0u);
      auto* const vertices = static_cast<Vertex*>(stream->Lock(0, sheet->Func5(), false, false));
      const auto& r = patch.bounds;
      vertices[0] = {r.x0, patch.height, r.z0, r.x0 / width, r.z0 / depth};
      vertices[1] = {r.x1, patch.height, r.z0, r.x1 / width, r.z0 / depth};
      vertices[2] = {r.x0, patch.height, r.z1, r.x0 / width, r.z1 / depth};
      vertices[3] = {r.x1, patch.height, r.z1, r.x1 / width, r.z1 / depth};
      stream->Unlock();
    }

    class RegionalWaterSurface final : public WaterSurface
    {
    public:
      explicit RegionalWaterSurface(bool lowFidelity) : mLowFidelity(lowFidelity) {}

      bool InitVerts(IWldTerrainRes* terrainResource) override
      {
        Destroy();
        mTerrainResource = terrainResource;
        // SCMAP files may contain a depth mask baked for the old sea level.
        terrainResource->UpdateWaterMap();
        const auto* field = terrainResource->mMap->mHeightField.get();
        const float width = static_cast<float>(field->width - 1);
        const float depth = static_cast<float>(field->height - 1);
        const auto regions=GetExperimentalWaterRegions(terrainResource->mMap);
        if(regionalwater::HasPolygons(regions)) {
          const auto geometry=regionalwater::PolygonWaterPatches(regions,width,depth,terrainResource->mMap->mWaterElevation);
          struct Batch {float height;std::vector<regionalwater::WaterTrapezoid> patches;};
          std::vector<Batch> batches;
          for(const auto& p:geometry) {
            auto it=std::find_if(batches.begin(),batches.end(),[&](const Batch& b){return b.height==p.height;});
            if(it==batches.end()){batches.push_back({p.height,{}});it=std::prev(batches.end());}
            it->patches.push_back(p);
          }
          for(const auto& batch:batches)for(std::size_t offset=0;offset<batch.patches.size();offset+=4096) {
            const auto count=std::min<std::size_t>(4096,batch.patches.size()-offset);
            const std::span<const regionalwater::WaterTrapezoid> part(batch.patches.data()+offset,count);
            if(mLowFidelity) {
              auto water=std::make_unique<LowFidelityWater>();
              if(!water->InitVerts(terrainResource)||!SetPolygonGeometry(*water,part,width,depth))return false;
              water->mWaterElevation=batch.height;mSurfaces.push_back(std::move(water));
            } else {
              auto water=std::make_unique<HighFidelityWater>();
              if(!water->InitVerts(terrainResource)||!SetPolygonGeometry(*water,part,width,depth))return false;
              water->mWaterElevation=batch.height;mSurfaces.push_back(std::move(water));
            }
          }
          gpg::Logf("[RegionalWaterRender v0.6] polygon mesh: trapezoids=%u, surfaces=%u, levels=%u",
            static_cast<unsigned>(geometry.size()),static_cast<unsigned>(mSurfaces.size()),static_cast<unsigned>(batches.size()));
          return !mSurfaces.empty();
        }
        const auto patches = regionalwater::Partition(GetExperimentalWaterRegions(terrainResource->mMap), width, depth,
                                                      terrainResource->mMap->mWaterElevation);
        for (std::size_t i = 0; i < patches.count; ++i) {
          const auto& patch = patches.values[i];
          std::unique_ptr<WaterSurface> surface;
          if (mLowFidelity) {
            auto water = std::make_unique<LowFidelityWater>();
            if (!water->InitVerts(terrainResource)) return false;
            water->mWaterElevation = patch.height;
            SetPatchGeometry(water->mVertexSheet, patch, width, depth);
            surface = std::move(water);
          } else {
            auto water = std::make_unique<HighFidelityWater>();
            if (!water->InitVerts(terrainResource)) return false;
            water->mWaterElevation = patch.height;
            SetPatchGeometry(water->mVertexSheet, patch, width, depth);
            surface = std::move(water);
          }
          mSurfaces.push_back(std::move(surface));
          gpg::Logf("[RegionalWaterRender v0.1.1] patch %u: [%g,%g)-[%g,%g), y=%g, %s",
                    static_cast<unsigned>(i), patch.bounds.x0, patch.bounds.z0,
                    patch.bounds.x1, patch.bounds.z1, patch.height, mLowFidelity ? "low/medium" : "high");
        }
        return !mSurfaces.empty();
      }

      void Destroy() override { mSurfaces.clear(); mTerrainResource = nullptr; mReportedSurface = false; }

      bool RenderWaterLayerAlphaMask(const GeomCamera3* camera) override
      {
        bool result = true;
        for (auto& surface : mSurfaces) result = surface->RenderWaterLayerAlphaMask(camera) && result;
        return result;
      }

      bool RenderWaterSurface(std::int32_t tick, float tickLerp, const GeomCamera3* camera,
                              const CWaterShaderProperties* properties,
                              const boost::shared_ptr<ID3DRenderTarget>& refraction,
                              const boost::shared_ptr<ID3DRenderTarget>& reflection) override
      {
        // Each native surface binds its map's mask itself, including ordinary
        // maps drawn after this wrapper has been destroyed.
        bool result = true;
        for (auto& surface : mSurfaces) {
          result = surface->RenderWaterSurface(tick, tickLerp, camera, properties, refraction, reflection) && result;
        }
        if (!mReportedSurface) {
          gpg::Logf("[RegionalWaterRender v0.1.1] surface pass: patches=%u, low/medium=%d, draw=%d",
                    static_cast<unsigned>(mSurfaces.size()), static_cast<int>(mLowFidelity), static_cast<int>(result));
          mReportedSurface = true;
        }
        return result;
      }

    private:
      bool mLowFidelity;
      bool mReportedSurface = false;
      IWldTerrainRes* mTerrainResource = nullptr;
      std::vector<std::unique_ptr<WaterSurface>> mSurfaces;
    };
  }

  WaterSurface* CreateExperimentalRegionalWater(IWldTerrainRes* terrainResource, bool lowFidelity)
  {
    auto water = std::make_unique<RegionalWaterSurface>(lowFidelity);
    if (!water->InitVerts(terrainResource)) return nullptr;
    return water.release();
  }
}
