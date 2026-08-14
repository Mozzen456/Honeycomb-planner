import { describe, it } from 'vitest';
import { buildHoneycombMesh, meshIsClosed } from '../src/core/honeycomb';
import { panelModelSpecFor } from '../src/core/panelModel';
import { Store, emptyDoc } from '../src/core/store';
import catalogJson from '../src/catalog/catalog.json';
import type { Catalog, PlacedPanel, WallFrame } from '../src/core/types';
const catalog = catalogJson as unknown as Catalog;
const FRAME: WallFrame = { left:true,right:true,bottom:true,top:true,holes:true,thicknessMm:3.6 };
describe('dbg',()=>{it('plate b section at y=7.3',()=>{
  const panels: PlacedPanel[] = [
    { id:'a', partId:'x', origin:{q:0,r:0}, columns:6, rows:5 },
    { id:'b', partId:'x', origin:{q:6,r:-3}, columns:6, rows:5 },
    { id:'c', partId:'x', origin:{q:0,r:5}, columns:6, rows:5 },
    { id:'d', partId:'x', origin:{q:6,r:2}, columns:6, rows:5 },
  ];
  const store = new Store({ ...emptyDoc(), wall:{widthMm:300,heightMm:300}, panels }, catalog);
  store.setFrame(FRAME);
  const doc = store.getState().doc;
  for (const p of doc.panels) {
    const spec = panelModelSpecFor(p, doc);
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const pos = mesh.positions;
    let x0=Infinity,x1=-Infinity;
    for(let i=0;i<pos.length;i+=3){x0=Math.min(x0,pos[i]!);x1=Math.max(x1,pos[i]!);}
    const z=7; const segs:{ax:number;ay:number;bx:number;by:number}[]=[];
    for (let i=0;i<pos.length;i+=9){
      const v=[0,3,6].map(o=>({x:pos[i+o]!,y:pos[i+o+1]!,z:pos[i+o+2]!}));
      const h:{x:number;y:number}[]=[];
      for(let e=0;e<3;e++){const a=v[e]!,c=v[(e+1)%3]!;
        if((a.z-z)*(c.z-z)<0){const f=(z-a.z)/(c.z-a.z);h.push({x:a.x+f*(c.x-a.x),y:a.y+f*(c.y-a.y)});}}
      if(h.length===2)segs.push({ax:h[0]!.x,ay:h[0]!.y,bx:h[1]!.x,by:h[1]!.y});
    }
    const y=7.3; const xs:number[]=[];
    for(const s of segs){if((s.ay>y)!==(s.by>y))xs.push(s.ax+((y-s.ay)/(s.by-s.ay))*(s.bx-s.ax));}
    xs.sort((m,n)=>m-n);
    console.log(`${p.id}: closed=${meshIsClosed(mesh).unmatchedEdges} meshX[${x0.toFixed(1)},${x1.toFixed(1)}] crossings@y=7.3 n=${xs.length}: ${xs.slice(0,14).map(v=>v.toFixed(1)).join(' ')}`);
  }
});});
