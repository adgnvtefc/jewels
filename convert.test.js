import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {convertImage,LIGHTER} from './convert.js';
import {createPuzzle,findHint,transfer,correctCount,region} from './game.js';
const art=JSON.parse(readFileSync(new URL('./assets/art.json',import.meta.url)));
const rgb=h=>[1,3,5].map(k=>parseInt(h.slice(k,k+2),16));
// Draw art at scale × scale per pixel, as a generated image would arrive.
const raster=(a,scale,noise=0)=>{const w=a.width*scale,out=new Uint8Array(w*w*4);let r=7;const rand=()=>(r=(Math.imul(r,1664525)+1013904223)>>>0)/4294967296;
 for(let i=0;i<w*w;i++){const c=rgb(a.colors[a.pixels[Math.floor(i/w/scale)*a.width+Math.floor(i%w/scale)]]);c.forEach((v,k)=>out[i*4+k]=Math.max(0,Math.min(255,v+(rand()-.5)*noise)));out[i*4+3]=255;}return out;};
const solve=a=>{let s=createPuzzle(a);for(let n=0;n<3000&&correctCount(a,s)<a.pixels.length;n++){const h=findHint(a,s);if(!h)return false;s=transfer(a,s,h.selection,h.destination,h.index).state;}return correctCount(a,s)===a.pixels.length;};

test('a clean rendering of the original art converts back exactly',()=>{
 const out=convertImage(raster(art,16),512,512,{colors:13,merge:0,clean:false,fit:false});
 assert.equal(out.colors.length,13);
 assert.ok(art.pixels.every((p,i)=>art.colors[p].toLowerCase()===out.colors[out.pixels[i]]));
});
test('a noisy, non-square picture becomes a square, speck-free, solvable puzzle',()=>{
 const src=raster(art,12,60),w=384,wide=new Uint8Array((w+64)*w*4).fill(255);
 for(let y=0;y<w;y++)wide.set(src.subarray(y*w*4,(y+1)*w*4),(y*(w+64)+32)*4);
 const out=convertImage(wide,w+64,w,{colors:12,id:'noisy'});
 assert.equal(out.width,32);assert.equal(out.pixels.length,1024);assert.ok(out.colors.length<=12&&out.colors.length>=2);
 assert.ok(out.pixels.every((c,i)=>region(out,i,j=>out.pixels[j]===c).length>1),'no lone jewels');
 assert.ok(solve(out),'hint moves finish the puzzle');
});
test('every built-in and bonus puzzle has a unique id and can be finished with hints',()=>{
 const files=['puzzles.json','bonus.json'].flatMap(list=>JSON.parse(readFileSync(new URL(`./assets/${list}`,import.meta.url)))),ids=new Set();
 for(const file of files){const a=JSON.parse(readFileSync(new URL(`./assets/${file}`,import.meta.url)));
  assert.ok(a.id&&a.title&&!ids.has(a.id),file);ids.add(a.id);assert.equal(a.pixels.length,a.width*a.height);assert.ok(solve(a),file);}
});

// The lighter conversion (used in the Create puzzle test): small features and thin outlines.
// A pink face with a thick dark outline and two small dark eyes, on white, 256 × 256.
const face=()=>{const W=256,out=new Uint8Array(W*W*4);for(let i=0;i<W*W;i++){const x=i%W,y=Math.floor(i/W),r=Math.hypot(x-128,y-128);
 let c=[255,255,255];if(r<118)c=[30,30,40];if(r<106)c=[240,160,175];if(Math.hypot(x-96,y-112)<3||Math.hypot(x-160,y-112)<3)c=[30,30,40];out.set([...c,255],i*4);}return out;};
const darkInside=(a,inner)=>{const dark=a.colors.findIndex(c=>parseInt(c.slice(1,3),16)<80);
 return a.pixels.filter((p,i)=>p===dark&&(Math.hypot(i%32-15.5,Math.floor(i/32)-15.5)<10)===inner).length;};
test('the lighter conversion keeps small eyes and thins a thick outline; the default does neither',()=>{
 const today=convertImage(face(),256,256,{}),lighter=convertImage(face(),256,256,LIGHTER);
 assert.equal(darkInside(today,true),0,'today the eyes lose the vote and vanish');
 assert.equal(darkInside(lighter,true),2,'one jewel kept for each eye');
 assert.equal(lighter.colors.length,today.colors.length,'no extra colors');
 assert.ok(darkInside(lighter,false)<darkInside(today,false)*0.7,'a thinner outline');
});
test('a lighter-converted picture is still a solvable puzzle',()=>{
 const out=convertImage(raster(art,12,60),384,384,{colors:12,id:'lighter',...LIGHTER});
 assert.ok(out.colors.length<=12&&out.colors.length>=2);
 assert.ok(solve(out),'hint moves finish the puzzle');
});
