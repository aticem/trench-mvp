// src/App.jsx — Dark, polished UI (slate theme) + subtle BG + vivid trench
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, GeoJSON, useMap, useMapEvent, Pane } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { bbox as turfBbox } from '@turf/turf'
import RBush from 'rbush'

const LS_KEY = 'trench-mvp-geojson-v2'
const PIXEL_TOLERANCE = 140 // px — zoom’dan bağımsız yakınlık eşiği

// ====== Geometry helpers (pixel-space distance) ======
function distPointToSegment(p, a, b){
  const vx = b.x - a.x, vy = b.y - a.y
  const wx = p.x - a.x, wy = p.y - a.y
  const len2 = vx*vx + vy*vy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = (wx*vx + wy*vy) / len2
  t = Math.max(0, Math.min(1, t))
  const projx = a.x + t*vx, projy = a.y + t*vy
  return Math.hypot(p.x - projx, p.y - projy)
}
function toXY(map, lat, lng){
  const pt = map.latLngToContainerPoint({lat, lng})
  return { x: pt.x, y: pt.y }
}
function pixelDistancePointToFeature(map, latlng, feature){
  const p = toXY(map, latlng.lat, latlng.lng)
  const geom = feature.geometry
  let minD = Infinity

  if (geom?.type === 'LineString') {
    const c = geom.coordinates || []
    for (let i=0; i<c.length-1; i++){
      const a = toXY(map, c[i][1], c[i][0])
      const b = toXY(map, c[i+1][1], c[i+1][0])
      const d = distPointToSegment(p, a, b)
      if (d < minD) minD = d
      if (d <= PIXEL_TOLERANCE) return d
    }
  } else if (geom?.type === 'MultiLineString') {
    for (const part of (geom.coordinates || [])){
      for (let i=0; i<part.length-1; i++){
        const a = toXY(map, part[i][1], part[i][0])
        const b = toXY(map, part[i+1][1], part[i+1][0])
        const d = distPointToSegment(p, a, b)
        if (d < minD) minD = d
        if (d <= PIXEL_TOLERANCE) return d
      }
    }
  }
  return minD
}
function pxToMeters(map, latlng, px=PIXEL_TOLERANCE){
  const p = map.latLngToContainerPoint(latlng)
  const p2 = { x: p.x + px, y: p.y }
  const ll2 = map.containerPointToLatLng(p2)
  return map.distance(latlng, ll2)
}
function metersToDegreeBox(centerLat, radiusM, inflate=2.2){
  const latDeg = (radiusM / 110540) * inflate
  const lonDeg = (radiusM / (111320 * Math.max(Math.cos(centerLat * Math.PI/180), 0.01))) * inflate
  return { latDeg, lonDeg }
}
function pickNearestFeature(map, latlng, allFeatures, spatialIndex){
  let candidates = []
  if (spatialIndex){
    const radiusM = pxToMeters(map, latlng, PIXEL_TOLERANCE)
    const { latDeg, lonDeg } = metersToDegreeBox(latlng.lat, radiusM, 2.2)
    const minX = latlng.lng - lonDeg, maxX = latlng.lng + lonDeg
    const minY = latlng.lat - latDeg, maxY = latlng.lat + latDeg
    const hits = spatialIndex.search({minX, minY, maxX, maxY})
    candidates = (hits && hits.length) ? hits.map(h=>h.feature) : (allFeatures || [])
  } else {
    candidates = allFeatures || []
  }

  let best = null, bestD = Infinity
  for (const f of candidates){
    const dpx = pixelDistancePointToFeature(map, latlng, f)
    if (dpx < bestD){ bestD = dpx; best = f }
  }
  return { feature: best, dpx: bestD }
}

// ====== GeoJSON normalize ======
function normalizeGeoJSON(j){
  const feats=(j.features||[]).map((f,i)=>{
    const p={...(f.properties||{})}
    const id=p.id ?? `SEG_${i}`
    const lineId=p.lineId ?? 'L0'
    const meters = typeof p.meters==='number' ? p.meters
                 : typeof p.meter==='number' ? p.meter
                 : undefined
    const status=p.status ?? 'todo'
    let start=null,end=null
    if(f.geometry?.type==='LineString' && f.geometry.coordinates?.length>=2){
      const c=f.geometry.coordinates
      start=c[0]; end=c[c.length-1]
    } else if (f.geometry?.type==='MultiLineString' && f.geometry.coordinates?.[0]?.length>=2){
      const c=f.geometry.coordinates[0]
      start=c[0]; end=c[c.length-1]
    }
    const _bbox = turfBbox(f)
    return {...f, properties:{...p,id,idx:i,lineId,meters,status,_start:start,_end:end,_bbox}}
  })
  return {type:'FeatureCollection', features:feats}
}

// ====== MAP HELPERS ======
function FitToDataOnce({ geojson }){
  const map=useMap()
  const didFitRef = useRef(false)
  useEffect(()=>{
    if(didFitRef.current) return
    if(!geojson?.features?.length) return
    try{
      const [minX,minY,maxX,maxY]=turfBbox(geojson)
      map.fitBounds([[minY,minX],[maxY,maxX]],{padding:[48,48]})
      didFitRef.current = true
    }catch{}
  },[geojson,map])
  return null
}

// Middle mouse = pan

// Orta tuş: custom pan (dragging kullanmadan)
function MiddleMousePan(){
  const map = useMap()
  const isPanningRef = useRef(false)
  const lastRef = useRef({x:0, y:0})

  useEffect(() => {
    const el = map.getContainer()

    const onMouseDown = (e) => {
      if (e.button !== 1) return
      e.preventDefault(); e.stopPropagation()
      isPanningRef.current = true
      lastRef.current = { x: e.clientX, y: e.clientY }
      el.style.cursor = 'grabbing'
    }

    const onMouseMove = (e) => {
      if (!isPanningRef.current) return
      e.preventDefault(); e.stopPropagation()
      const dx = e.clientX - lastRef.current.x
      const dy = e.clientY - lastRef.current.y
      if (dx !== 0 || dy !== 0) {
        // ekran pikselini harita pan’ına çevir
        map.panBy([-dx, -dy], { animate: false })
        lastRef.current = { x: e.clientX, y: e.clientY }
      }
    }

    const endPan = (e) => {
      if (!isPanningRef.current) return
      isPanningRef.current = false
      el.style.cursor = ''
    }

    // bazı tarayıcılarda orta tık "autoscroll" açar → yut
    const swallowAuxClick = (e) => {
      if (e.button === 1) { e.preventDefault(); e.stopPropagation() }
    }

    el.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', endPan, true)
    el.addEventListener('auxclick', swallowAuxClick, true)
    el.addEventListener('click', swallowAuxClick, true)

    return () => {
      el.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', endPan, true)
      el.removeEventListener('auxclick', swallowAuxClick, true)
      el.removeEventListener('click', swallowAuxClick, true)
    }
  }, [map])

  return null
}




// Kill browser defaults (contextmenu vs.)
function KillBrowserDefaults(){
  const map = useMap()
  useEffect(()=>{
    const el = map.getContainer()
    const prevent = (e)=>{ e.preventDefault(); e.stopPropagation() }
    el.addEventListener('contextmenu', prevent)
    el.addEventListener('selectstart', prevent)
    el.addEventListener('dragstart', prevent)
    el.addEventListener('gesturestart', prevent)
    return ()=>{
      el.removeEventListener('contextmenu', prevent)
      el.removeEventListener('selectstart', prevent)
      el.removeEventListener('dragstart', prevent)
      el.removeEventListener('gesturestart', prevent)
    }
  },[map])
  return null
}

// Hover (proximity)
function MapHoverProximity({ setHoverId, features, spatialIndex }){
  const map = useMap()
  useMapEvent('mousemove', (e)=>{
    const { feature, dpx } = pickNearestFeature(map, e.latlng, features, spatialIndex)
    if (feature && dpx <= PIXEL_TOLERANCE) setHoverId(feature.properties.id)
    else setHoverId(null)
  })
  useMapEvent('mouseout', ()=> setHoverId(null))
  return null
}

// Unified Brush
function MapBrushUnified({ setStatusById, features, spatialIndex }){
  const map = useMap()
  const isDownRef = useRef(false)
  const downButtonRef = useRef(0)
  const touchedRef = useRef(new Set())
  const movedRef = useRef(false)
  const lastDownLatLngRef = useRef(null)

  useMapEvent('mousedown', (e)=>{
    const ev = e.originalEvent
    if (!ev) return
    downButtonRef.current = ev.button ?? 0
    movedRef.current = false
    lastDownLatLngRef.current = e.latlng || null

    if (downButtonRef.current === 1) return // orta: pan

    isDownRef.current = true
    touchedRef.current = new Set()

    if (downButtonRef.current === 0){
      // LMB → sadece paint (done)
      const { feature, dpx } = pickNearestFeature(map, e.latlng, features, spatialIndex)
      if (feature && dpx <= PIXEL_TOLERANCE){
        if ((feature.properties.status||'todo')!=='done'){
          setStatusById(feature.properties.id, 'done')
        }
        touchedRef.current.add(feature.properties.id)
      }
      ev.preventDefault(); ev.stopPropagation()
    }

    if (downButtonRef.current === 2){
      // RMB → erase (todo)
      const { feature, dpx } = pickNearestFeature(map, e.latlng, features, spatialIndex)
      if (feature && dpx <= PIXEL_TOLERANCE){
        if ((feature.properties.status||'todo')!=='todo'){
          setStatusById(feature.properties.id, 'todo')
        }
        touchedRef.current.add(feature.properties.id)
      }
      ev.preventDefault(); ev.stopPropagation()
    }
  })

  useMapEvent('mousemove', (e)=>{
    if (!isDownRef.current) return
    movedRef.current = true
    const btn = downButtonRef.current
    if (btn === 1) return // orta: pan
    const { feature, dpx } = pickNearestFeature(map, e.latlng, features, spatialIndex)
    if (!feature || dpx > PIXEL_TOLERANCE) return
    if (touchedRef.current.has(feature.properties.id)) return

    if (btn === 0){
      // LMB drag → paint
      if ((feature.properties.status||'todo')!=='done'){
        setStatusById(feature.properties.id,'done')
      }
    } else if (btn === 2){
      // RMB drag → erase
      if ((feature.properties.status||'todo')!=='todo'){
        setStatusById(feature.properties.id,'todo')
      }
    }
    touchedRef.current.add(feature.properties.id)
  })

  useMapEvent('mouseup', ()=>{
    isDownRef.current = false
    downButtonRef.current = 0
    touchedRef.current.clear()
    movedRef.current = false
    lastDownLatLngRef.current = null
  })

  return null
}



// ====== STYLES (palette) ======
// BG lines: subtle slate on dark
const bgStyleFn = () => ({
  color: '#94a3b8',      // slate-400
  weight: 1.15,
  opacity: 0.65,
  lineCap: 'butt',
  lineJoin: 'miter',
  className: 'bg-line'
})

// trench palette by status
const trenchColor = (status) => {
  if (status === 'done') return '#22c55e'       // emerald-500 (vivid but not neon)
  if (status === 'in_progress') return '#eab308'// yellow-500 (golden)
  return '#f59e0b'                              // amber-500 (todo)
}

// ====== APP ======
export default function App(){
  const [data,setData]=useState(null)          // trenches (işaretlenebilir)
  const [dataVersion, setDataVersion] = useState(0)
  const [hoverId, setHoverId] = useState(null)
  const [bgData, setBgData] = useState(null)  // background (görsel)

  // initial load
  useEffect(()=>{
    const saved=localStorage.getItem(LS_KEY)
    if(saved){
      try{ setData(normalizeGeoJSON(JSON.parse(saved))); }catch{}
    } else {
      fetch('/trenches.geojson')
        .then(r=>r.json())
        .then(j=>setData(normalizeGeoJSON(j)))
        .catch(console.error)
    }

    // background yükle
    fetch('/background.geojson')
      .then(r=>r.json())
      .then(j=>setBgData(j))
      .catch(console.error)
  },[])

  // persist
  useEffect(()=>{
    if(data) {
      localStorage.setItem(LS_KEY, JSON.stringify(data))
      setDataVersion(prev => prev + 1)
    }
  },[data])

  // RBush
  const spatialIndex = useMemo(() => {
    if (!data?.features) return null
    const tree = new RBush()
    const items = data.features.map(f => ({
      minX: f.properties._bbox[0],
      minY: f.properties._bbox[1],
      maxX: f.properties._bbox[2],
      maxY: f.properties._bbox[3],
      id: f.properties.id,
      feature: f
    }))
    tree.load(items)
    return tree
  }, [data])

  // summary
  const summary = useMemo(()=>{
    let total=0, done=0, inprog=0, todo=0
    for(const f of (data?.features||[])){
      const m=Number(f.properties?.meters)||0
      total+=m
      const s=f.properties?.status||'todo'
      if(s==='done') done+=m
      else if(s==='in_progress') inprog+=m
      else todo+=m
    }
    return { total, done, inprog, todo, remaining: total-done }
  },[data])

  // trench style: polished weights + glow
  const styleFn=(feature)=>{
    const status = feature.properties?.status ?? 'todo'
    const isHover = hoverId && feature.properties?.id===hoverId
    const baseColor = trenchColor(status)
    const w =
      status === 'done' ? (isHover ? 10 : 8) :
      status === 'in_progress' ? (isHover ? 7 : 5.5) :
      (isHover ? 6 : 4.5)

    const cls =
      'seg ' +
      (status === 'done'
        ? 'seg-done'
        : status === 'in_progress'
          ? 'seg-inprog'
          : 'seg-todo') +
      (isHover ? ' seg-hover' : '')

    return {
      color: baseColor,
      weight: w,
      opacity: 1,
      lineCap: 'round',
      className: cls
    }
  }

  const setStatusById=(id,next)=>setData(prev=>{
    if(!prev) return prev
    const feats=prev.features.map(f=>f.properties.id===id?{...f,properties:{...f.properties,status:next}}:f)
    return {...prev,features:feats}
  })

  const clearAll=()=>setData(prev=>{
    if(!prev) return prev
    return {...prev,features:prev.features.map(f=>({...f,properties:{...f.properties,status:'todo'}}))}
  })

  return (
    <div style={{
      height:'100vh',
      width:'100vw',
      display:'grid',
      gridTemplateColumns:'1fr 360px',
      background:'#0b1220', // deep slate/navy
      color:'#e5e7eb'
    }}>
      <div>
        <MapContainer
          center={[52.6,-1.7]}
          zoom={17}
          minZoom={5}
          maxZoom={22}
          dragging={false}
          wheelPxPerZoomLevel={60}
          scrollWheelZoom={true}
          doubleClickZoom={false}
          preferCanvas={false}
          style={{
            height:'100%',
            width:'100%',
            background:'#0f172a', // slate-900
            outline:'1px solid #0b1220'
          }}
        >
          <KillBrowserDefaults />
          <MiddleMousePan />

          {/* Hover/Brush yalnızca trenches üzerinde */}
          {data?.features && (
            <>
              <MapHoverProximity
                setHoverId={setHoverId}
                features={data.features}
                spatialIndex={spatialIndex}
              />
              <MapBrushUnified
                setStatusById={setStatusById}
                features={data.features}
                spatialIndex={spatialIndex}
              />
            </>
          )}

          {/* Background: subtle slate lines */}
          {bgData && (
            <Pane name="bg" style={{ zIndex: 200 }}>
              <GeoJSON
                data={bgData}
                style={bgStyleFn}
                interactive={false}
                bubblingMouseEvents={false}
                smoothFactor={1}
              />
            </Pane>
          )}

          {/* Trench: vivid, status-based */}
          {data && (
            <Pane name="fg" style={{ zIndex: 400 }}>
              <GeoJSON
                key={dataVersion}
                data={data}
                style={styleFn}
                interactive={false}
                bubblingMouseEvents={true}
              />
              <FitToDataOnce geojson={data} />
            </Pane>
          )}
        </MapContainer>
      </div>

      <aside style={{
        padding:'14px 16px',
        borderLeft:'1px solid #1e293b',    // slate-800
        background:'linear-gradient(180deg, #0b1220 0%, #0d1628 100%)',
        boxShadow:'inset 0 1px 0 rgba(255,255,255,0.02)'
      }}>
        <div style={{display:'flex', gap:10, alignItems:'center', marginBottom:12}}>
          <b style={{fontSize:16, letterSpacing:.2}}>Trench-MVP</b>
          <span style={{
            marginLeft:'auto',
            fontSize:11,
            opacity:.7,
            background:'#0f172a',
            border:'1px solid #1f2937',
            padding:'4px 8px',
            borderRadius:999
          }}>Dark</span>
          <button
            onClick={clearAll}
            style={{
              background:'#0f172a',
              color:'#e5e7eb',
              border:'1px solid #334155',
              borderRadius:10,
              padding:'6px 12px',
              cursor:'pointer',
              transition:'all .15s ease',
              boxShadow:'0 0 0 0 rgba(0,0,0,0)'
            }}
            onMouseOver={e=>{ e.currentTarget.style.borderColor='#475569' }}
            onMouseOut={e=>{ e.currentTarget.style.borderColor='#334155' }}
          >
            Clear
          </button>
        </div>

        <div style={{
          display:'grid',
          gridTemplateColumns:'1fr 1fr',
          gap:10,
          marginBottom:14
        }}>
          <div className="kpi-box" style={{
            borderColor:'#1f2937', background:'#0f172a', borderRadius:12, padding:10
          }}>
            <div className="kpi-label" style={{color:'#94a3b8'}}>Toplam</div>
            <div className="kpi-value" style={{fontWeight:700, fontSize:16}}>
              {summary.total.toFixed(2)} m
            </div>
          </div>
          <div className="kpi-box" style={{
            borderColor:'#1f2937', background:'#0f172a', borderRadius:12, padding:10
          }}>
            <div className="kpi-label" style={{color:'#94a3b8'}}>Kalan</div>
            <div className="kpi-value" style={{fontWeight:700, fontSize:16}}>
              {summary.remaining.toFixed(2)} m
            </div>
          </div>
          <div className="kpi-box" style={{
            borderColor:'#1f2937', background:'#0f172a', borderRadius:12, padding:10
          }}>
            <div className="kpi-label" style={{color:'#94a3b8'}}>Done</div>
            <div className="kpi-value" style={{fontWeight:700, fontSize:16, color:'#22c55e'}}>
              {summary.done.toFixed(2)} m
            </div>
          </div>
          <div className="kpi-box" style={{
            borderColor:'#1f2937', background:'#0f172a', borderRadius:12, padding:10
          }}>
            <div className="kpi-label" style={{color:'#94a3b8'}}>In-Prog</div>
            <div className="kpi-value" style={{fontWeight:700, fontSize:16, color:'#eab308'}}>
              {summary.inprog.toFixed(2)} m
            </div>
          </div>
        </div>

        <div style={{marginBottom:12, color:'#cbd5e1', fontSize:13, lineHeight:1.5}}>
          <div><b>Kullanım</b></div>
          <div>• <b>Sol tek tık</b>: Yakındaki segmente toggle (done ↔ todo).</div>
          <div>• <b>Sol bas & sürükle</b>: İlk temas “todo” ise boya (<b>done</b>), “done” ise sil (<b>todo</b>).</div>
          <div>• <b>Orta tuş</b>: Basılı tut & sürükle = <b>Pan</b>.</div>
          <div>• <b>Sağ tuş</b> (ops.): Silgi.</div>
          <div style={{marginTop:8}}>
            <b>Renkler</b>: BG çizgiler <span style={{color:'#94a3b8'}}>slate</span> / Trench:
            <span style={{color:'#f59e0b'}}> todo</span>,
            <span style={{color:'#eab308'}}> in-progress</span>,
            <span style={{color:'#22c55e'}}> done</span>.
          </div>
        </div>
      </aside>
    </div>
  )
}
