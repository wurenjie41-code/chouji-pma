// Conservative palette/shape candidates for the two receipt icon families supplied.
// Unknown graphics are not classified. These are UI icon matches, not team inference.
export function detectGameIcons({width,height,data}) {
  const classify = (r,g,b) => r>140 && g<85 && b<95 ? 1 : r>120 && g>75 && g<215 && b<75 ? 2 : b>65 && b>r*1.5 && b>g*1.15 ? 3 : 0;
  const bands=[]; let band=null;
  for (let y=Math.floor(height*.12);y<height*.87;y++) {
    let left=width,right=-1,red=0,gold=0,blue=0;
    for (let x=Math.floor(width*.025);x<width*.13;x++) {
      const i=(y*width+x)*4,c=classify(data[i],data[i+1],data[i+2]);
      if (!c) continue;
      left=Math.min(left,x);right=Math.max(right,x);if(c===1)red++;if(c===2)gold++;if(c===3)blue++;
    }
    if(right>=left) {
      if(!band) band={top:y,bottom:y,left,right,red:0,gold:0,blue:0};
      band.bottom=y;band.left=Math.min(left,band.left);band.right=Math.max(right,band.right);band.red+=red;band.gold+=gold;band.blue+=blue;
    } else if(band) { bands.push(band);band=null; }
  }
  if(band)bands.push(band);
  return bands.flatMap(b=>{
    const w=b.right-b.left+1,h=b.bottom-b.top+1,area=w*h;
    if(w<width*.018 || w>width*.065 || h<width*.018 || h>width*.065 || w/h<.65 || w/h>1.5) return [];
    if(b.red/area>.28 && b.gold+b.blue<area*.08) return [{sport:'Dota 2',y:(b.top+b.bottom)/2/height,method:'receipt-icon-candidate'}];
    if(b.gold/area>.07 && b.blue/area>.07 && (b.gold+b.blue)/area>.3 && b.red<area*.08) return [{sport:'CS',y:(b.top+b.bottom)/2/height,method:'receipt-icon-candidate'}];
    return [];
  });
}

