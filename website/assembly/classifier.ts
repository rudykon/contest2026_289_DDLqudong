// Apache-2.0. Numeric port of the project's imu_features.js / tiny_classifier.js.
// Fixed 48 x 6 f64 ABI; static buffers, no heap allocations during inference.
const N: i32 = 48;
const INPUT: usize = memory.data(48 * 6 * 8);
const OUTPUT: usize = memory.data(6 * 8);
const FEATURES: usize = memory.data(23 * 8);
const MAG: usize = memory.data(48 * 2 * 8);
const MEANS: usize = memory.data(8 * 8);
const STDS: usize = memory.data(8 * 8);
const RANGES: usize = memory.data(8 * 8);
const SQUARES: usize = memory.data(8 * 8);
const DOWN: usize = memory.data(24 * 8);

export function input_ptr(): usize { return INPUT; }
export function output_ptr(): usize { return OUTPUT; }
export function features_ptr(): usize { return FEATURES; }
export function window_size(): i32 { return N; }
export function abi_version(): i32 { return 1; }
function get(p: usize, i: i32): f64 { return load<f64>(p + <usize>i * 8); }
function put(p: usize, i: i32, v: f64): void { store<f64>(p + <usize>i * 8, v); }
function clamp(v: f64): f64 { return Math.max(0, Math.min(1, v)); }
function high(v: f64, lo: f64, hi: f64): f64 { return clamp((v-lo)/(hi-lo)); }
function low(v: f64, lo: f64, hi: f64): f64 { return clamp((hi-v)/(hi-lo)); }
function band(v: f64, lo: f64, hi: f64): f64 {
  if (v <= lo || v >= hi) return 0;
  return clamp(1 - Math.abs(v-(lo+hi)/2)/((hi-lo)/2));
}
function axis(i: i32, c: i32): f64 {
  const x = get(INPUT, i*6+c);
  return isFinite(x) ? x : 0;
}
function norm(x: f64, y: f64, z: f64): f64 {
  let a = Math.abs(x), b = Math.abs(y), c = Math.abs(z), t: f64 = 0;
  if (a<b) { t=a;a=b;b=t; } if (b<c) { t=b;b=c;c=t; } if (a<b) { t=a;a=b;b=t; }
  return a + .375*b + .1875*c;
}
function value(i: i32, c: i32): f64 { return c<6 ? axis(i,c) : get(MAG,(c-6)*N+i); }
function crossing(c: i32): f64 {
  const center=get(MEANS,c); let prev=axis(0,c)-center, count: i32=0;
  for (let i=1;i<N;i++) {
    const cur=axis(i,c)-center;
    if (Math.abs(prev)>.05 && Math.abs(cur)>.05 && ((prev<0 && cur>0)||(prev>0 && cur<0))) count++;
    if (Math.abs(cur)>.05) prev=cur;
  }
  return <f64>count/3;
}
function peaks(offset: i32, threshold: f64): f64 {
  let count: i32=0;
  for (let i=1;i<N-1;i++) {
    const x=get(MAG,offset+i);
    if (x>threshold && x>=get(MAG,offset+i-1) && x>get(MAG,offset+i+1)) count++;
  }
  return <f64>count/3;
}
function compute(): void {
  for (let i=0;i<N;i++) {
    put(MAG,i,norm(axis(i,0),axis(i,1),axis(i,2)));
    put(MAG,N+i,norm(axis(i,3),axis(i,4),axis(i,5)));
  }
  for (let c=0;c<8;c++) {
    let sum: f64=0, sq: f64=0, mn: f64=Infinity, mx: f64=-Infinity;
    for (let i=0;i<N;i++) { const x=value(i,c); sum+=x; sq+=x*x; mn=Math.min(mn,x);mx=Math.max(mx,x); }
    const mean=sum/<f64>N, meanSq=sq/<f64>N;
    put(MEANS,c,mean);put(SQUARES,c,meanSq);put(STDS,c,Math.sqrt(Math.max(0,meanSq-mean*mean)));put(RANGES,c,mx-mn);
  }
  let total: f64=0;
  for (let i=0;i<24;i++) { const x=((get(MAG,i*2)-get(MEANS,6))+(get(MAG,i*2+1)-get(MEANS,6)))/2;put(DOWN,i,x);total+=x; }
  let denom: f64=0;
  for (let i=0;i<24;i++) { const x=get(DOWN,i)-total/24;put(DOWN,i,x);denom+=x*x; }
  let fast: f64=0, slow: f64=0;
  if (denom>=1e-6) {
    for (let lag=2;lag<=18;lag++) {
      let sum: f64=0;for (let i=lag;i<24;i++) sum+=get(DOWN,i)*get(DOWN,i-lag);
      const score=sum/denom;if (lag<=5 && score>fast)fast=score;if(lag>=7 && score>slow)slow=score;
    }
  }
  put(FEATURES,0,get(MEANS,6));put(FEATURES,1,get(STDS,6));put(FEATURES,2,get(RANGES,6));put(FEATURES,3,Math.sqrt(Math.max(0,get(SQUARES,6))));
  put(FEATURES,4,get(MEANS,7));put(FEATURES,5,get(STDS,7));put(FEATURES,6,get(RANGES,7));put(FEATURES,7,Math.sqrt(Math.max(0,get(SQUARES,7))));
  for (let i=0;i<6;i++) put(FEATURES,8+i,get(STDS,i));
  put(FEATURES,14,crossing(5));put(FEATURES,15,crossing(3));
  put(FEATURES,16,peaks(0,get(MEANS,6)+.65*get(STDS,6)));put(FEATURES,17,peaks(N,get(MEANS,7)+.80*get(STDS,7)));
  put(FEATURES,18,clamp(fast));put(FEATURES,19,clamp(slow));
  put(FEATURES,20,get(STDS,7)/Math.max(get(STDS,6),.05));put(FEATURES,21,(get(STDS,0)+get(STDS,1))/Math.max(get(STDS,2),.05));put(FEATURES,22,3);
}
const LUT: f64[]=[1,.60653066,.36787944,.22313016,.13533528,.082085,.04978707,.03019738,.01831564,.011109,.00673795,.00408677,.00247875,.00150344,.00091188,.00055308,.00033546];
function expNegative(d: f64): f64 {
  if(d<=0)return 1;const scaled=d*2;const index=<i32>Math.floor(scaled);
  if(index>=16)return LUT[16];return LUT[index]+(LUT[index+1]-LUT[index])*(scaled-<f64>index);
}
export function classify(hr: f64): i32 {
  compute();
  const am=get(FEATURES,0), asd=get(FEATURES,1), ar=get(FEATURES,2), gm=get(FEATURES,4), gs=get(FEATURES,5), gr=get(FEATURES,6);
  const gy=get(FEATURES,12),gz=get(FEATURES,13),zcr=get(FEATURES,14),ap=get(FEATURES,16),gp=get(FEATURES,17),fp=get(FEATURES,18),sp=get(FEATURES,19),gd=get(FEATURES,20),le=get(FEATURES,21);
  const heart=(isFinite(hr) && hr!=0) ? hr : 90;
  let bg=2.4*low(asd,.12,.75)+2*low(gs,.03,.45)+.6*low(ar,.8,3);
  if(asd<.35 && gs<.18)bg+=1.4;if(asd>.9 || gs>.45)bg-=1.2;
  put(OUTPUT,0,bg);
  put(OUTPUT,4,1.9*band(asd,1.8,5.6)+1.5*band(gs,.22,1.6)+1.7*fp+band(ap,1.4,4.2)+high(gy,.42,1)+.6*low(am,10,11.2)+.4*high(heart,95,145));
  put(OUTPUT,2,1.8*high(ar,5,12)+1.2*band(ap,1.5,4)+.8*fp+low(gy,.18,.58)+.9*high(am,10.2,11.4)+.9*high(am,10.55,11.35)+.6*high(zcr,6,10)+.5*low(gm,.2,.75)+.3*high(heart,100,150));
  put(OUTPUT,3,1.8*sp+1.3*band(asd,.30,1.40)+1.3*band(gs,.18,.75)+.8*high(le,1.8,3.2)+.7*low(gr,.7,2.6)+.5*low(zcr,1.5,5)+.2*low((isFinite(hr)&&hr!=0)?hr:100,120,160));
  put(OUTPUT,1,2*high(gr,3.2,7)+1.5*high(gs,.9,2.6)+1.2*high(ar,2.4,6.2)+1.2*high(le,.9,2.3)+.6*band(gp,.8,5.5));
  put(OUTPUT,5,2.3*high(gz,.75,2.2)+1.6*high(zcr,4,10)+1.1*high(gd,1,3.5)+low(asd,.5,2)+.6*high(gp,2,8)+.9*high(gz,.65,1.1)+.7*high(zcr,5,9)+.6*low(ar,.7,1.8));
  let mx=get(OUTPUT,0);for(let i=1;i<6;i++)mx=Math.max(mx,get(OUTPUT,i));
  let sum: f64=0;for(let i=0;i<6;i++){const w=expNegative(mx-get(OUTPUT,i));put(OUTPUT,i,w);sum+=w;}
  let winner: i32=0;for(let i=0;i<6;i++){put(OUTPUT,i,get(OUTPUT,i)/Math.max(sum,1e-9));}
  for(let i=1;i<6;i++)if(get(OUTPUT,i)>get(OUTPUT,winner))winner=i;
  return winner;
}
export function benchmark(repeats: i32, hr: f64): f64 {
  const n=Math.min(20000,Math.max(1,repeats));let checksum: f64=0;
  for(let i=0;i<n;i++)checksum+=<f64>classify(hr)+get(OUTPUT,0);
  return checksum;
}
