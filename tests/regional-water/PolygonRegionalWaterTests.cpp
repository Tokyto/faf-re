#include "moho/sim/RegionalWaterMapModel.h"
#include "moho/sim/RegionalWaterCombatModel.h"
#include "moho/sim/RegionalWaterRegistry.h"
#include <cstdlib>
#include <iostream>
#include <random>

using namespace moho::regionalwater;
static void Check(bool ok,const char* message){if(!ok){std::cerr<<message<<'\n';std::exit(1);}}
static double TriangleArea(Point2 a,Point2 b,Point2 c){return std::abs(Cross(a,b,c))*.5;}
static bool InTriangle(Point2 a,Point2 b,Point2 c,Point2 p)
{
  const auto x=Cross(a,b,p),y=Cross(b,c,p),z=Cross(c,a,p);
  return (x>1e-6&&y>1e-6&&z>1e-6)||(x<-1e-6&&y<-1e-6&&z<-1e-6);
}
static void VerifyMesh(const RegionSet& regions,float width,float depth)
{
  const auto patches=PolygonWaterPatches(regions,width,depth,17.5f);double area=0;
  for(const auto& p:patches){area+=TriangleArea(p.points[0],p.points[2],p.points[1])+TriangleArea(p.points[1],p.points[2],p.points[3]);
    for(const auto v:p.points)Check(v.x>=0&&v.z>=0&&v.x<=width&&v.z<=depth,"mesh outside map");}
  Check(std::abs(area-width*depth)<.01,"polygon mesh area must cover map once");
  std::mt19937 rng(0x504f4c59);
  for(unsigned i=0;i<2500;++i){
    const Point2 q{float((rng()%100000)/100000.0*width),float((rng()%100000)/100000.0*depth)};
    unsigned hits=0;float height=-1;
    for(const auto& p:patches)if(InTriangle(p.points[0],p.points[2],p.points[1],q)||InTriangle(p.points[1],p.points[2],p.points[3],q)){++hits;height=p.height;}
    // Points on an exact mesh edge are deliberately excluded by strict tests.
    Check(hits<=1,"polygon mesh plane interiors overlap");
    if(hits)Check(height==HeightAt(regions,17.5f,q.x,q.z),"polygon render/query mismatch");
  }
}
int main()
{
  const auto d=ParseMapDefinition("regionalwater 3 polygon 35 6 20 20 100 20 100 50 50 50 50 100 20 100 terrain preserve");
  Check(bool(d)&&!ValidateMapDefinition(d,512,512,17.5f,true),"concave polygon definition");
  Check(HeightAt(d.regions,17.5f,30,70)==35&&HeightAt(d.regions,17.5f,70,70)==17.5f,"notch outside concave polygon");
  auto hit=FindWaterCrossing(d.regions,17.5f,512,512,{30,80,70},{30,0,70},false);Check(hit.position.y==35,"polygon hit");
  hit=FindWaterCrossing(d.regions,17.5f,512,512,{70,80,70},{70,0,70},false);Check(hit.position.y==17.5f,"bbox corner is ocean");
  auto lower=d;lower.regions.values[0].height=10;
  hit=FindWaterCrossing(lower.regions,17.5f,512,512,{30,80,70},{30,0,70},false);Check(hit.position.y==10,"lower polygon must remove ocean overhead");
  VerifyMesh(d.regions,512,512);VerifyMesh(lower.regions,512,512);
  const auto overlapBounds=ParseMapDefinition("regionalwater 3 polygon 35 3 0 0 40 0 0 40 terrain preserve polygon 50 3 40 40 40 10 10 40 terrain preserve");
  Check(bool(overlapBounds)&&!ValidateMapDefinition(overlapBounds,512,512,17.5f,true),"disjoint shapes with overlapping bounding boxes");
  VerifyMesh(overlapBounds.regions,512,512);
  const auto refuse=[](std::string text){const auto v=ParseMapDefinition(text);return !v||ValidateMapDefinition(v,512,512,17.5f,true);};
  Check(refuse("regionalwater 2 polygon 35 3 0 0 40 0 0 40 terrain preserve"),"polygon requires schema 3");
  Check(refuse("regionalwater 3 polygon 35 4 10 10 100 100 10 100 100 10 terrain preserve"),"self crossing refused");
  Check(refuse("regionalwater 3 polygon 35 3 10 10 20 20 30 30 terrain preserve"),"zero area refused");
  Check(refuse("regionalwater 3 polygon 35 4 10 10 100 10 100 100 10 10 terrain preserve"),"closing duplicate refused");
  Check(refuse("regionalwater 3 polygon 35 3 10 10 100 10 10 100 terrain gentle"),"no rectangular sculpt on polygon");
  Check(refuse("regionalwater 3 polygon 35 3 10 10 600 10 10 100 terrain preserve"),"outside-map polygon refused");
  Check(refuse("regionalwater 3 polygon 35 3 10 10 100 10 10 100 terrain preserve region 10 10 20 20 50 terrain preserve"),"polygon containment/touch refused");
  Check(refuse("regionalwater 3 polygon 35 3 11 10 100 10 10 100 terrain preserve"),"odd polygon vertex refused");
  MapRegions registry;MapRegions::Cache cache;int source=0,copy=0;
  registry.SetAll(&source,d.regions);registry.SetAll(&copy,registry.GetAll(&source,{},cache));registry.Erase(&source);
  Check(registry.GetAllCached(&copy,{},cache).values[0].vertexCount==6&&registry.GetAllCached(&copy,{},cache).values[0].Contains(30,70),"polygon copied and cached without dangling geometry");
  for(unsigned k=0;k<100;++k){
    RegionSet set;set.count=8;
    for(std::size_t i=0;i<8;++i){auto r=d.regions.values[0];const float x=float((i%4)*120+4),z=float((i/4)*160+4);
      for(std::size_t j=0;j<r.vertexCount;++j){r.vertices[j].x+=x;r.vertices[j].z+=z;}
      r.height=float((k+i)%70);UpdatePolygonBounds(r);set.values[i]=r;}
    VerifyMesh(set,512,512);
  }
  std::cout<<"PASS: schema 3, concavity, real geometry separation, mesh coverage/height agreement, finite water impacts, lower-lake holes and registry copies (250000 randomized mesh samples).\n";
}
