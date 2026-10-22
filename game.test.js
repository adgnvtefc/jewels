import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPuzzle,select,transfer,correctCount,restore,region,SHELF_SIZE,findHint,shelfAction,continueSelection,expandShelf,compactShelf} from './game.js';
const art=JSON.parse(readFileSync(new URL('./assets/art.json',import.meta.url)));
const tutorial={width:4,height:2,colors:['blue','yellow'],pixels:[0,0,1,1,0,0,1,1]};
const fresh=()=>({board:[1,1,0,0,1,1,0,0],shelf:Array(SHELF_SIZE).fill(-1),moves:0});
const inventory=s=>[...s.board,...s.shelf].filter(c=>c>=0).sort((a,b)=>a-b);
test('tutorial: board to shelf, board to board, then shelf to board',()=>{
 let s=fresh();const expected=inventory(s);
 let r=transfer(tutorial,s,select(tutorial,s,'board',2),'shelf');assert.equal(r.transfers.length,4);s=r.state;
 assert.equal(s.board[2],-1);assert.equal(s.shelf[0],0);
 r=transfer(tutorial,s,select(tutorial,s,'board',0),'board',2);assert.equal(r.transfers.length,4);s=r.state;
 r=transfer(tutorial,s,select(tutorial,s,'shelf',0),'board',0);s=r.state;
 assert.equal(correctCount(tutorial,s),8);assert.deepEqual(inventory(s),expected);assert.ok(s.shelf.every(c=>c===-1));
});
test('wrong target and occupied target cannot overwrite jewels',()=>{let s=fresh();s=transfer(tutorial,s,select(tutorial,s,'board',2),'shelf').state;const before=JSON.stringify(s);assert.ok(transfer(tutorial,s,select(tutorial,s,'shelf',0),'board',2).error);assert.ok(transfer(tutorial,s,select(tutorial,s,'shelf',0),'board',0).error);assert.equal(JSON.stringify(s),before);});
test('a full shelf blocks removal and a nearly full shelf limits transfers',()=>{let s=fresh();s.shelf=Array(24).fill(1);const pick=select(tutorial,s,'board',2);assert.ok(transfer(tutorial,s,pick,'shelf').error);s.shelf[23]=-1;const r=transfer(tutorial,s,pick,'shelf');assert.equal(r.transfers.length,1);assert.deepEqual(inventory(r.state),inventory(s));});
test('paths include diagonals but not disconnected or wrapped cells',()=>{const a={width:3,height:3,pixels:Array(9).fill(0)};assert.deepEqual(region(a,0,i=>[0,4,8].includes(i)),[0,4,8]);assert.deepEqual(region(a,2,i=>[2,3].includes(i)),[2]);});
test('placement stops at disconnected matching holes',()=>{const a={width:3,height:1,colors:['a','b'],pixels:[0,1,0]},s={board:[-1,1,-1],shelf:[0,0,...Array(22).fill(-1)],moves:0};const r=transfer(a,s,select(a,s,'shelf',0),'board',0);assert.equal(r.transfers.length,1);assert.equal(r.state.board[2],-1);});
test('original art and generated puzzle retain every color and pixel',()=>{const s=createPuzzle(art);assert.equal(art.pixels.length,1024);assert.equal(art.colors.length,13);assert.deepEqual(inventory(s),[...art.pixels].sort((a,b)=>a-b));assert.equal(correctCount(art,s),340,'only the unavoidable turquoise matches start in place');assert.deepEqual(s,createPuzzle(art));});
test('generated scramble can be reversed through the bounded shelf',()=>{const s=createPuzzle(art);for(const {left,right} of s.swaps.toReversed()){assert.ok(left.length<=SHELF_SIZE);const a=left.map(i=>s.board[i]),b=right.map(i=>s.board[i]);left.forEach(i=>s.board[i]=-1);right.forEach((i,n)=>{s.board[left[n]]=s.board[i];s.board[i]=-1;});right.forEach((i,n)=>s.board[i]=a[n]);assert.ok(b.every(c=>c===art.pixels[left[0]]));}assert.deepEqual(s.board,art.pixels);});
test('save validation rejects old coloring saves and corrupted inventories',()=>{const s=createPuzzle(art);assert.ok(restore(art,s));assert.equal(restore(art,[0,1]),null);assert.equal(restore(art,{...s,shelf:[0]}),null);const invalid=structuredClone(s);invalid.board[0]=-1;assert.equal(restore(art,invalid),null);});

test('the complete 1,024-jewel puzzle is solvable using only legal transfers',()=>{
 let state=createPuzzle(art);const expected=inventory(state),seen=new Set();
 for(let moves=0;correctCount(art,state)<1024;moves++){
  assert.ok(moves<1500,'must finish within a bounded number of moves');
  const hash=JSON.stringify([state.board,state.shelf]);assert.ok(!seen.has(hash),'hints must not loop');seen.add(hash);
  const hint=findHint(art,state);assert.ok(hint,'must have a legal continuation');
  const before=state;const result=transfer(art,state,hint.selection,hint.destination,hint.index);assert.ok(!result.error);state=result.state;
  art.pixels.forEach((c,i)=>{if(before.board[i]===c)assert.equal(state.board[i],c,'matched jewels must remain fixed');});
  assert.deepEqual(inventory(state),expected);assert.equal(state.shelf.length,24);
 }
 assert.deepEqual(state.board,art.pixels);assert.ok(state.shelf.every(c=>c===-1));
});

test('matched jewels cannot be selected or transferred, even with a forged selection',()=>{
 const a={width:3,height:1,colors:['a','b'],pixels:[0,1,0]};
 const s={board:[0,0,-1],shelf:Array(24).fill(-1),moves:0};
 assert.equal(select(a,s,'board',0),null);
 assert.deepEqual(select(a,s,'board',1).cells,[1]);
 const forged={kind:'board',index:0,color:0,cells:[0]};
 assert.ok(transfer(a,s,forged,'board',2).error);
 assert.ok(transfer(a,s,forged,'shelf').error);
 const r=transfer(a,s,select(a,s,'board',1),'board',2);
 assert.deepEqual(r.state.board,[0,-1,0]);
 assert.equal(select(a,r.state,'board',2),null);
});
test('matched jewels cannot connect two movable groups',()=>{
 const a={width:3,height:1,colors:['a','b'],pixels:[1,0,1]};
 const s={board:[0,0,0],shelf:Array(24).fill(-1),moves:0};
 assert.deepEqual(select(a,s,'board',0).cells,[0]);
 assert.deepEqual(select(a,s,'board',2).cells,[2]);
});

test('occupied shelf slots select stored jewels even when a board group is selected',()=>{
 let s=fresh();s=transfer(tutorial,s,select(tutorial,s,'board',2),'shelf').state;
 const boardPick=select(tutorial,s,'board',0);
 assert.equal(shelfAction(s,boardPick,0),'select');
 assert.equal(shelfAction(s,boardPick,4),'store');
 assert.equal(shelfAction(s,null,0),'select');
 assert.equal(shelfAction(s,null,4),'none');
 const placed=transfer(tutorial,s,boardPick,'board',2).state;
 const returned=transfer(tutorial,placed,select(tutorial,placed,'shelf',0),'board',0);
 assert.equal(correctCount(tutorial,returned.state),8);
 assert.ok(returned.state.shelf.every(c=>c===-1));
});

test('a shelf color stays selected across compaction and successive placements',()=>{
 const a={width:5,height:1,colors:['a','b'],pixels:[0,1,0,1,0]};
 let s={board:[-1,1,-1,1,-1],shelf:[0,0,0,...Array(21).fill(-1)],moves:0};
 let selected=select(a,s,'shelf',0);
 for(const target of [0,2,4]){
  const r=transfer(a,s,selected,'board',target);assert.ok(!r.error);s=r.state;
  selected=continueSelection(a,s,selected);assert.equal(selected.color,0);
  if(target!==4){assert.equal(selected.kind,'shelf');assert.equal(selected.index,0);}
 }
 assert.equal(selected.kind,'color');assert.equal(selected.cells.length,0);
 assert.equal(continueSelection(a,s,null),null);
});
test('board color selection follows remaining jewels and then the deposited shelf group',()=>{
 const a={width:4,height:1,colors:['a','b'],pixels:[1,1,0,0]};
 let s={board:[0,0,-1,-1],shelf:Array(24).fill(-1),moves:0};
 const pick=select(a,s,'board',0);s=transfer(a,s,pick,'shelf').state;
 const next=continueSelection(a,s,pick);assert.equal(next.kind,'shelf');assert.equal(next.color,0);assert.deepEqual(next.cells,[0,1]);
});
test('shelf compaction preserves order and supplies correct animation paths',()=>{
 const r=compactShelf([-1,2,-1,0,1,-1]);assert.deepEqual(r.shelf,[2,0,1,-1,-1,-1]);
 assert.deepEqual(r.shifts.map(t=>[t.from.index,t.to.index]),[[1,0],[3,1],[4,2]]);
});
test('shelf growth preserves jewels and round-trips through save validation',()=>{
 const original=createPuzzle(art);const grown=expandShelf(original);
 assert.equal(grown.shelf.length,32);assert.deepEqual(grown.board,original.board);
 assert.equal(original.shelf.length,24);assert.equal(restore(art,grown).shelf.length,32);
 assert.equal(restore(art,{...grown,shelf:Array(31).fill(-1)}),null);
});
