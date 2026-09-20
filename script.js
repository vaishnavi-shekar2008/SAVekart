/* ---------------------------------------------------------
   DATA — Estonian demand regions (name, lat, lng, orders/day)
   Sourced from the scenario brief: 3,200 orders/day total,
   Tallinn 45%, Tartu 15%, Narva 10%, Pärnu 9%, other towns 21%
--------------------------------------------------------- */
const REGIONS = [
  {name:"Tallinn",      lat:59.4370, lng:24.7536, orders:1440},
  {name:"Tartu",        lat:58.3780, lng:26.7290, orders:480},
  {name:"Narva",        lat:59.3797, lng:28.1791, orders:320},
  {name:"Pärnu",        lat:58.3859, lng:24.4971, orders:288},
  {name:"Viljandi",     lat:58.3639, lng:25.5900, orders:90},
  {name:"Rakvere",      lat:59.3467, lng:26.3567, orders:85},
  {name:"Kuressaare",   lat:58.2529, lng:22.4853, orders:70},
  {name:"Jõhvi",        lat:59.3592, lng:27.4147, orders:75},
  {name:"Haapsalu",     lat:58.9431, lng:23.5410, orders:65},
  {name:"Võru",         lat:57.8375, lng:27.0202, orders:60},
  {name:"Valga",        lat:57.7766, lng:26.0397, orders:62},
  {name:"Kohtla-Järve", lat:59.3975, lng:27.2736, orders:80},
  {name:"Sillamäe",     lat:59.3961, lng:27.7644, orders:85},
];

/* ---------------------------------------------------------
   MATH — haversine distance (km), weighted k-means (Lloyd's),
   naive baseline, capacity rebalancing, satisfaction scoring
--------------------------------------------------------- */
function haversine(a, b){
  const R = 6371;
  const dLat = (b.lat-a.lat) * Math.PI/180;
  const dLng = (b.lng-a.lng) * Math.PI/180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

function nearestIdx(point, centers){
  let best=0, bd=Infinity;
  centers.forEach((c,i)=>{ const d=haversine(point,c); if(d<bd){bd=d;best=i;} });
  return best;
}

// naive baseline: warehouses placed exactly at the k biggest-demand regions
function naiveBaseline(k){
  const sorted = [...REGIONS].sort((a,b)=>b.orders-a.orders);
  return sorted.slice(0,k).map(r=>({lat:r.lat,lng:r.lng}));
}

// weighted Lloyd's algorithm, returns {history:[centers,...], final:centers}
function weightedKMeans(k, iterations=8){
  let centers = naiveBaseline(k).map(c=>({...c}));
  const history = [centers.map(c=>({...c}))];

  for(let it=0; it<iterations; it++){
    const sums = centers.map(()=>({lat:0,lng:0,w:0}));
    REGIONS.forEach(r=>{
      const i = nearestIdx(r, centers);
      sums[i].lat += r.lat * r.orders;
      sums[i].lng += r.lng * r.orders;
      sums[i].w   += r.orders;
    });
    centers = centers.map((c,i)=> sums[i].w>0
      ? {lat: sums[i].lat/sums[i].w, lng: sums[i].lng/sums[i].w}
      : c
    );
    history.push(centers.map(c=>({...c})));
  }
  return {history, final:centers};
}

// assign regions to nearest center, respecting capacity via greedy reassignment
function assignWithCapacity(centers, capacity){
  let assignments = REGIONS.map(r => nearestIdx(r, centers));
  const load = () => {
    const l = centers.map(()=>0);
    assignments.forEach((a,i)=> l[a]+=REGIONS[i].orders);
    return l;
  };
  let loads = load();
  let guard = 0;
  while (loads.some(l=>l>capacity) && guard<50){
    guard++;
    // find most overloaded center
    let over = loads.indexOf(Math.max(...loads));
    // find the region assigned to it that is farthest away (cheapest to move out)
    let candidates = REGIONS.map((r,i)=>({i, d:haversine(r,centers[over])}))
      .filter(c => assignments[c.i]===over)
      .sort((a,b)=>b.d-a.d);
    if(!candidates.length) break;
    const moveIdx = candidates[0].i;
    // find next-nearest center with room
    const distances = centers.map((c,ci)=>({ci, d:haversine(REGIONS[moveIdx],c)}))
      .filter(c=>c.ci!==over)
      .sort((a,b)=>a.d-b.d);
    const target = distances.find(t => loads[t.ci] + REGIONS[moveIdx].orders <= capacity);
    if(!target){ break; } // no room anywhere — leave as overflow, flagged later
    assignments[moveIdx] = target.ci;
    loads = load();
  }
  return {assignments, loads};
}

function satisfactionForDistance(km){
  if(km<=5) return 100;
  if(km<=10) return 90;
  if(km<=20) return 75;
  if(km<=40) return 55;
  if(km<=80) return 35;
  return 15;
}

function evaluate(centers, capacity){
  const {assignments, loads} = assignWithCapacity(centers, capacity);
  let totalCost=0, totalOrders=0, satNum=0, distNum=0;
  const rows = REGIONS.map((r,i)=>{
    const c = centers[assignments[i]];
    const d = haversine(r,c);
    totalCost += d*r.orders;
    totalOrders += r.orders;
    satNum += satisfactionForDistance(d)*r.orders;
    distNum += d*r.orders;
    return {region:r, whIndex:assignments[i], dist:d, sat:satisfactionForDistance(d)};
  });
  return {
    rows,
    assignments,
    loads,
    totalCost,
    avgDist: distNum/totalOrders,
    satisfaction: satNum/totalOrders,
  };
}

/* ---------------------------------------------------------
   MAP SETUP
--------------------------------------------------------- */
const map = L.map('map', {scrollWheelZoom:false}).setView([58.75,25.5], 6.6);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution:'&copy; OpenStreetMap &copy; CARTO', subdomains:'abcd', maxZoom:19
}).addTo(map);
setTimeout(()=>{ map.invalidateSize(); }, 200); // fixes blank tiles if the container was sized after Leaflet initialized

let demandLayer = L.layerGroup().addTo(map);
let beforeLayer = L.layerGroup().addTo(map);
let afterLayer  = L.layerGroup().addTo(map);
let arrowLayer  = L.layerGroup().addTo(map);

function maxOrders(){ return Math.max(...REGIONS.map(r=>r.orders)); }

function drawDemand(){
  demandLayer.clearLayers();
  const mx = maxOrders();
  REGIONS.forEach(r=>{
    const radius = 5 + (r.orders/mx)*16;
    L.circleMarker([r.lat,r.lng], {
      radius, color:'#8C96AC', weight:1, fillColor:'#8C96AC', fillOpacity:.35
    }).bindPopup(`<b>${r.name}</b><br>${r.orders} orders/day`).addTo(demandLayer);
  });
}

function drawWarehouses(layer, centers, color, labelPrefix){
  layer.clearLayers();
  centers.forEach((c,i)=>{
    L.marker([c.lat,c.lng], {
      icon: L.divIcon({
        className:'',
        html:`<div style="width:14px;height:14px;border-radius:3px;background:${color};border:2px solid #0E1420;transform:rotate(45deg);box-shadow:0 0 0 2px ${color}55;"></div>`,
        iconSize:[14,14], iconAnchor:[7,7]
      })
    }).bindPopup(`<b>${labelPrefix} warehouse ${i+1}</b>`).addTo(layer);
  });
}

function drawArrows(before, after){
  arrowLayer.clearLayers();
  before.forEach((b,i)=>{
    const a = after[i];
    if(!a) return;
    const line = L.polyline([[b.lat,b.lng],[a.lat,a.lng]], {color:'#4FD1C5', weight:2, opacity:.85, dashArray:'1,6'}).addTo(arrowLayer);
    // simple arrowhead via a small triangle marker at the 'after' end
    const angle = Math.atan2(a.lat-b.lat, a.lng-b.lng) * 180/Math.PI;
    L.marker([a.lat,a.lng], {
      icon: L.divIcon({
        className:'',
        html:`<div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid #4FD1C5;transform:rotate(${90-angle}deg);"></div>`,
        iconSize:[12,12], iconAnchor:[6,6]
      })
    }).addTo(arrowLayer);
  });
}

/* ---------------------------------------------------------
   COST / WAREHOUSE-COUNT TRADE-OFF CHART (hand-drawn SVG)
--------------------------------------------------------- */
function drawTradeoffChart(highlightK){
  const svg = document.getElementById('tradeoffChart');
  svg.innerHTML = '';
  const W=620,H=260,pad={l:56,r:20,t:20,b:34};
  const ks = [1,2,3,4,5,6,7,8];
  const costs = ks.map(k => evaluate(weightedKMeans(k).final, 100000).totalCost); // no capacity limit for the curve
  const maxC = Math.max(...costs), minC=Math.min(...costs);

  const x = k => pad.l + ((k-1)/(ks.length-1))*(W-pad.l-pad.r);
  const y = c => H-pad.b - ((c-minC)/(maxC-minC||1))*(H-pad.t-pad.b);

  // elbow: point of max drop-off decrease
  let drops = [];
  for(let i=1;i<costs.length;i++) drops.push(costs[i-1]-costs[i]);
  let elbowIdx=1;
  for(let i=1;i<drops.length;i++){ if(drops[i] < drops[0]*0.25){ elbowIdx=i; break; } elbowIdx=i+1; }

  const ns = "http://www.w3.org/2000/svg";
  function el(tag, attrs){ const e=document.createElementNS(ns,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); return e; }

  // gridlines
  for(let i=0;i<=4;i++){
    const gy = pad.t + i*(H-pad.t-pad.b)/4;
    svg.appendChild(el('line',{x1:pad.l,y1:gy,x2:W-pad.r,y2:gy,stroke:'#232E42','stroke-width':1}));
  }
  // axis labels
  ks.forEach(k=>{
    const t = el('text',{x:x(k),y:H-10,fill:'#8C96AC','font-size':11,'text-anchor':'middle','font-family':'Inter'});
    t.textContent = k;
    svg.appendChild(t);
  });
  const yl = el('text',{x:14,y:16,fill:'#8C96AC','font-size':11,'font-family':'Inter'});
  yl.textContent = 'weighted cost';
  svg.appendChild(yl);

  // line path
  let d = ks.map((k,i)=> `${i===0?'M':'L'} ${x(k)} ${y(costs[i])}`).join(' ');
  svg.appendChild(el('path',{d, fill:'none', stroke:'#4FD1C5', 'stroke-width':2.5}));

  // points
  ks.forEach((k,i)=>{
    const isElbow = k===ks[elbowIdx];
    svg.appendChild(el('circle',{cx:x(k),cy:y(costs[i]),r:isElbow?7:4, fill: isElbow?'#E8B84F':'#4FD1C5', stroke:'#0E1420','stroke-width':2}));
    if(k===highlightK){
      svg.appendChild(el('circle',{cx:x(k),cy:y(costs[i]),r:11, fill:'none', stroke:'#F0725D','stroke-width':2}));
    }
  });
  // elbow label
  const et = el('text',{x:x(ks[elbowIdx])+10,y:y(costs[elbowIdx])-10,fill:'#E8B84F','font-size':11,'font-family':'Space Grotesk'});
  et.textContent = `suggested: ${ks[elbowIdx]} warehouses`;
  svg.appendChild(et);
}

/* ---------------------------------------------------------
   UI WIRING
--------------------------------------------------------- */
const kSlider = document.getElementById('kSlider');
const kVal = document.getElementById('kVal');
const capInput = document.getElementById('capInput');
const runBtn = document.getElementById('runBtn');
const animBtn = document.getElementById('animBtn');

function fmt(n, d=0){ return n.toLocaleString(undefined,{maximumFractionDigits:d}); }

const EMISSION_FACTOR = 0.18; // demo kg CO2 per vehicle-km
const BASE_PRICE = 55;        // demo INR base price/order
const DISTANCE_RATE = 1.20;   // INR/km
const PEAK_RATE = 22;         // INR at peak multiplier
const GROUP_DISCOUNT = 0.28;  // max simulated crowd-house discount

function impactModel(evalAfter){
  const peakEl = document.getElementById('peakInput');
  const groupEl = document.getElementById('groupInput');
  const peak = peakEl ? Number(peakEl.value) : 1;
  const group = groupEl ? Number(groupEl.value) : 0.25;
  const orders = REGIONS.reduce((sum,r)=>sum+r.orders,0);

  // evalAfter.totalCost is the weighted delivery distance: sum(distance × orders).
  // For this hackathon model, it is treated as vehicle-km-equivalent.
  const standardKm = evalAfter.totalCost;
  const standardCarbon = standardKm * EMISSION_FACTOR;
  const crowdKm = standardKm * (1 - group * 0.65);
  const crowdCarbon = crowdKm * EMISSION_FACTOR;
  const standardTrips = Math.max(1, Math.ceil(orders / 18));
  const crowdTrips = Math.max(1, Math.ceil(standardTrips * (1 - group)));
  const standardPrice = BASE_PRICE + evalAfter.avgDist * DISTANCE_RATE + Math.max(0,peak-1)*PEAK_RATE;
  const crowdPrice = standardPrice * (1 - group * GROUP_DISCOUNT);

  return {
    peak, group, standardCarbon, crowdCarbon,
    carbonPerOrder: crowdCarbon / orders,
    standardTrips, crowdTrips,
    standardPrice, crowdPrice,
    saving: standardCarbon ? (1-crowdCarbon/standardCarbon)*100 : 0
  };
}

function renderImpact(evalAfter){
  const m = impactModel(evalAfter);
  const set = (id,value) => { const el=document.getElementById(id); if(el) el.textContent=value; };
  set('carbonDay', fmt(m.crowdCarbon,1) + ' kg CO₂');
  set('carbonOrder', m.carbonPerOrder.toFixed(3) + ' kg');
  set('dynamicPrice', '₹' + m.crowdPrice.toFixed(0));
  set('crowdSaving', m.saving.toFixed(1) + '% CO₂');
  set('carbonStandard', fmt(m.standardCarbon,1) + ' kg CO₂');
  set('carbonCrowd', fmt(m.crowdCarbon,1) + ' kg CO₂');
  set('tripsStandard', fmt(m.standardTrips));
  set('tripsCrowd', fmt(m.crowdTrips));
  set('priceStandard', '₹' + m.standardPrice.toFixed(0));
  set('priceCrowd', '₹' + m.crowdPrice.toFixed(0));
  set('peakVal', m.peak.toFixed(2) + '×');
  set('groupVal', Math.round(m.group*100) + '%');
}

function render(){
  const k = parseInt(kSlider.value);
  const capacity = parseFloat(capInput.value) || 99999;
  kVal.textContent = k;

  const before = naiveBaseline(k);
  const {final: after} = weightedKMeans(k);

  const evalBefore = evaluate(before, capacity);
  const evalAfter  = evaluate(after, capacity);

  drawDemand();
  drawWarehouses(beforeLayer, before, '#F0725D', 'Before');
  drawWarehouses(afterLayer, after, '#4FD1C5', 'After');
  drawArrows(before, after);

  document.getElementById('costBefore').textContent = fmt(evalBefore.totalCost) + ' km·orders';
  document.getElementById('costAfter').textContent  = fmt(evalAfter.totalCost) + ' km·orders';
  const reduction = evalBefore.totalCost>0 ? ((evalBefore.totalCost-evalAfter.totalCost)/evalBefore.totalCost*100) : 0;
  document.getElementById('costDelta').textContent = (reduction>=0?'−':'+') + Math.abs(reduction).toFixed(1) + '%';
  document.getElementById('avgDist').textContent = evalAfter.avgDist.toFixed(1) + ' km';

  document.getElementById('cmpCostBefore').textContent = fmt(evalBefore.totalCost);
  document.getElementById('cmpDistBefore').textContent = evalBefore.avgDist.toFixed(1) + ' km';
  document.getElementById('cmpSatBefore').textContent = evalBefore.satisfaction.toFixed(0) + ' / 100';
  document.getElementById('cmpCostAfter').textContent = fmt(evalAfter.totalCost);
  document.getElementById('cmpDistAfter').textContent = evalAfter.avgDist.toFixed(1) + ' km';
  document.getElementById('cmpSatAfter').textContent = evalAfter.satisfaction.toFixed(0) + ' / 100';

  document.getElementById('satScore').textContent = evalAfter.satisfaction.toFixed(0);
  const satDeltaVal = evalAfter.satisfaction - evalBefore.satisfaction;
  const satDeltaEl = document.getElementById('satDelta');
  satDeltaEl.textContent = (satDeltaVal>=0?'▲ ':'▼ ') + Math.abs(satDeltaVal).toFixed(0) + ' pts vs. naive';
  satDeltaEl.className = 'delta ' + (satDeltaVal>=0?'up':'down');

  // capacity alert
  const overloaded = evalAfter.loads.some(l=>l>capacity+0.5);
  const alertEl = document.getElementById('capacityAlert');
  if(overloaded){
    alertEl.innerHTML = `<div class="alert warn">⚠ One or more warehouses can't absorb their nearest demand within capacity even after rebalancing — raise capacity or add a warehouse.</div>`;
  } else {
    alertEl.innerHTML = `<div class="alert ok">✓ All warehouses operate within the ${fmt(capacity)}/day capacity limit.</div>`;
  }

  // region table
  const body = document.getElementById('regionBody');
  body.innerHTML = '';
  evalAfter.rows
    .sort((a,b)=>b.region.orders-a.region.orders)
    .forEach(row=>{
      const pillClass = row.sat>=75 ? 'safe' : row.sat>=45 ? 'warn' : 'risk';
      const pillText = row.sat>=75 ? 'Good' : row.sat>=45 ? 'Watch' : 'At risk';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.region.name}</td>
        <td>${row.region.orders}</td>
        <td>WH ${row.whIndex+1}</td>
        <td>${row.dist.toFixed(1)} km</td>
        <td>${(row.dist * row.region.orders * 0.18).toFixed(1)} kg</td>
        <td><span class="pill ${pillClass}">${pillText}</span></td>
      `;
      body.appendChild(tr);
    });

  drawTradeoffChart(k);
  renderImpact(evalAfter);
}

kSlider.addEventListener('input', ()=>{ kVal.textContent = kSlider.value; });
runBtn.addEventListener('click', render);
capInput.addEventListener('change', render);

document.getElementById('peakInput')?.addEventListener('input', render);
document.getElementById('groupInput')?.addEventListener('input', render);

animBtn.addEventListener('click', ()=>{
  const k = parseInt(kSlider.value);
  const {history} = weightedKMeans(k);
  let step = 0;
  animBtn.disabled = true;
  animBtn.textContent = 'Converging…';
  const before = naiveBaseline(k);
  const timer = setInterval(()=>{
    drawWarehouses(afterLayer, history[step], '#4FD1C5', `Iter ${step}`);
    drawArrows(before, history[step]);
    step++;
    if(step >= history.length){
      clearInterval(timer);
      animBtn.disabled = false;
      animBtn.textContent = '▶ Play convergence (step by step)';
      render();
    }
  }, 550);
});

render();



render();
