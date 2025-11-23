import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, GeoJSON, useMap, useMapEvent, Pane } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { bbox as turfBbox, distance as turfDistance, point as turfPoint, nearestPointOnLine, lineSlice, length as turfLength } from '@turf/turf'
import RBush from 'rbush'
import { along as turfAlong } from '@turf/turf'

const LS_KEY = 'trench-mvp-geojson-v4'
const PIXEL_TOLERANCE = 15

// ====== Geometry helpers ======
function distPointToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y
  const wx = p.x - a.x, wy = p.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = (wx * vx + wy * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const projx = a.x + t * vx, projy = a.y + t * vy
  return Math.hypot(p.x - projx, p.y - projy)
}
function toXY(map, lat, lng) {
  const pt = map.latLngToContainerPoint({ lat, lng })
  return { x: pt.x, y: pt.y }
}
function pixelDistancePointToFeature(map, latlng, feature) {
  const p = toXY(map, latlng.lat, latlng.lng)
  const geom = feature.geometry
  let minD = Infinity

  if (geom?.type === 'LineString') {
    const c = geom.coordinates || []
    for (let i = 0; i < c.length - 1; i++) {
      const a = toXY(map, c[i][1], c[i][0])
      const b = toXY(map, c[i + 1][1], c[i + 1][0])
      const d = distPointToSegment(p, a, b)
      if (d < minD) minD = d
      if (d <= PIXEL_TOLERANCE) return d
    }
  } else if (geom?.type === 'MultiLineString') {
    for (const part of (geom.coordinates || [])) {
      for (let i = 0; i < part.length - 1; i++) {
        const a = toXY(map, part[i][1], part[i][0])
        const b = toXY(map, part[i + 1][1], part[i + 1][0])
        const d = distPointToSegment(p, a, b)
        if (d < minD) minD = d
        if (d <= PIXEL_TOLERANCE) return d
      }
    }
  }
  return minD
}
function pxToMeters(map, latlng, px = PIXEL_TOLERANCE) {
  const p = map.latLngToContainerPoint(latlng)
  const p2 = { x: p.x + px, y: p.y }
  const ll2 = map.containerPointToLatLng(p2)
  return map.distance(latlng, ll2)
}
function metersToDegreeBox(centerLat, radiusM, inflate = 2.2) {
  const latDeg = (radiusM / 110540) * inflate
  const lonDeg = (radiusM / (111320 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.01))) * inflate
  return { latDeg, lonDeg }
}

function pickNearestFeature(map, latlng, allFeatures, spatialIndex) {
  let candidates = []
  if (spatialIndex) {
    const radiusM = pxToMeters(map, latlng, PIXEL_TOLERANCE)
    const { latDeg, lonDeg } = metersToDegreeBox(latlng.lat, radiusM, 2.2)
    const minX = latlng.lng - lonDeg, maxX = latlng.lng + lonDeg
    const minY = latlng.lat - latDeg, maxY = latlng.lat + latDeg
    const hits = spatialIndex.search({ minX, minY, maxX, maxY })
    candidates = (hits && hits.length) ? hits.map(h => h.feature) : (allFeatures || [])
  } else {
    candidates = allFeatures || []
  }

  let best = null, bestD = Infinity
  for (const f of candidates) {
    const dpx = pixelDistancePointToFeature(map, latlng, f)
    if (dpx < bestD) { bestD = dpx; best = f }
  }
  return { feature: best, dpx: bestD }
}

// ====== GeoJSON normalize & Grouping ======
function normalizeGeoJSON(j) {
  // 1. Filter: Keep only 'trenches' layer
  const rawFeats = (j.features || []).filter(f => f.properties?.layer === 'trenches')

  // 2. Grouping
  const THRESHOLD_KM = 0.002
  const assigned = new Set()
  const groups = []

  for (let i = 0; i < rawFeats.length; i++) {
    if (assigned.has(i)) continue
    const f1 = rawFeats[i]
    const group = [f1]
    assigned.add(i)

    const c1 = f1.geometry.coordinates
    const p1_start = c1 && c1.length > 0 ? c1[0] : null
    const p1_end = c1 && c1.length > 0 ? c1[c1.length - 1] : null
    if (!p1_start) continue

    for (let k = i + 1; k < rawFeats.length; k++) {
      if (assigned.has(k)) continue
      const f2 = rawFeats[k]
      const c2 = f2.geometry.coordinates
      const p2_start = c2 && c2.length > 0 ? c2[0] : null
      const p2_end = c2 && c2.length > 0 ? c2[c2.length - 1] : null
      if (!p2_start) continue

      const d_normal = turfDistance(turfPoint(p1_start), turfPoint(p2_start), { units: 'kilometers' })
      const d_reverse = turfDistance(turfPoint(p1_start), turfPoint(p2_end), { units: 'kilometers' })

      if (d_normal < THRESHOLD_KM || d_reverse < THRESHOLD_KM) {
        group.push(f2)
        assigned.add(k)
      }
    }
    groups.push(group)
  }

  // 3. Flatten and assign lineIds + Progress
  const feats = []
  groups.forEach((grp, gIdx) => {
    const lineId = `G_${gIdx}`
    // Calculate logical length from the first segment
    const first = grp[0]
    const len = turfLength(first, { units: 'meters' })

    grp.forEach((f, i) => {
      const p = { ...(f.properties || {}) }
      const id = p.id ?? `SEG_${gIdx}_${i}`
      // Initialize progress if not present
      const progress = (typeof p.progress === 'number') ? p.progress : 0
      const _bbox = turfBbox(f)

      feats.push({
        ...f,
        properties: {
          ...p,
          id,
          lineId,
          meters: len, // Store total length
          progress,    // 0.0 to 1.0
          _bbox
        }
      })
    })
  })

  return { type: 'FeatureCollection', features: feats }
}

// ====== MAP HELPERS ======
function FitToDataOnce({ geojson }) {
  const map = useMap()
  const didFitRef = useRef(false)
  useEffect(() => {
    if (didFitRef.current) return
    if (!geojson?.features?.length) return
    try {
      const [minX, minY, maxX, maxY] = turfBbox(geojson)
      map.fitBounds([[minY, minX], [maxY, maxX]], { padding: [48, 48] })
      didFitRef.current = true
    } catch { }
  }, [geojson, map])
  return null
}

// Middle mouse = pan
function MiddleMousePan() {
  const map = useMap()
  const isPanningRef = useRef(false)
  const lastRef = useRef({ x: 0, y: 0 })

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
        map.panBy([-dx, -dy], { animate: false })
        lastRef.current = { x: e.clientX, y: e.clientY }
      }
    }

    const endPan = (e) => {
      if (!isPanningRef.current) return
      isPanningRef.current = false
      el.style.cursor = ''
    }

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
function KillBrowserDefaults() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const prevent = (e) => { e.preventDefault(); e.stopPropagation() }
    el.addEventListener('contextmenu', prevent)
    el.addEventListener('selectstart', prevent)
    el.addEventListener('dragstart', prevent)
    el.addEventListener('gesturestart', prevent)
    return () => {
      el.removeEventListener('contextmenu', prevent)
      el.removeEventListener('selectstart', prevent)
      el.removeEventListener('dragstart', prevent)
      el.removeEventListener('gesturestart', prevent)
    }
  }, [map])
  return null
}

// Hover (proximity)
function MapHoverProximity({ setHoverId, features, spatialIndex }) {
  const map = useMap()
  useMapEvent('mousemove', (e) => {
    const { feature, dpx } = pickNearestFeature(map, e.latlng, features, spatialIndex)
    if (feature && dpx <= PIXEL_TOLERANCE) setHoverId(feature.properties.id)
    else setHoverId(null)
  })
  useMapEvent('mouseout', () => setHoverId(null))
  return null
}

// Unified Brush with Progress
function MapBrushUnified({ setProgressById, features, spatialIndex }) {
  const map = useMap()
  const isDownRef = useRef(false)
  const downButtonRef = useRef(0)
  const lastDragLatLngRef = useRef(null)

  const processPoint = (latlng, btn) => {
    const { feature, dpx } = pickNearestFeature(map, latlng, features, spatialIndex)
    if (feature && dpx <= PIXEL_TOLERANCE) {
      // Calculate progress along the line
      const pt = turfPoint([latlng.lng, latlng.lat])
      const snapped = nearestPointOnLine(feature, pt)

      const start = turfPoint(feature.geometry.coordinates[0])
      const slice = lineSlice(start, snapped, feature)
      const dist = turfLength(slice, { units: 'meters' })
      const total = feature.properties.meters || 1

      let newProg = dist / total
      if (newProg > 1) newProg = 1
      if (newProg < 0) newProg = 0

      if (btn === 0) {
        // LMB -> Paint (max)
        const current = feature.properties.progress || 0
        if (newProg > current) {
          setProgressById(feature.properties.id, newProg)
        }
      } else if (btn === 2) {
        // RMB -> Erase
        setProgressById(feature.properties.id, newProg)
      }
    }
  }

  useMapEvent('mousedown', (e) => {
    const ev = e.originalEvent
    if (!ev) return
    downButtonRef.current = ev.button ?? 0
    lastDragLatLngRef.current = e.latlng

    if (downButtonRef.current === 1) return

    isDownRef.current = true
    processPoint(e.latlng, downButtonRef.current)
    ev.preventDefault(); ev.stopPropagation()
  })

  useMapEvent('mousemove', (e) => {
    if (!isDownRef.current) return
    const btn = downButtonRef.current
    if (btn === 1) return

    const currentLatLng = e.latlng
    const lastLatLng = lastDragLatLngRef.current || currentLatLng

    // Interpolation
    const p1 = map.latLngToContainerPoint(lastLatLng)
    const p2 = map.latLngToContainerPoint(currentLatLng)
    const dist = p1.distanceTo(p2)
    const stepSize = 5
    const steps = Math.ceil(dist / stepSize)

    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const x = p1.x + (p2.x - p1.x) * t
      const y = p1.y + (p2.y - p1.y) * t
      const latlng = map.containerPointToLatLng([x, y])
      processPoint(latlng, btn)
    }
    lastDragLatLngRef.current = currentLatLng
  })

  useMapEvent('mouseup', () => {
    isDownRef.current = false
    downButtonRef.current = 0
    lastDragLatLngRef.current = null
  })

  return null
}

// ====== STYLES ======
const bgStyleFn = () => ({
  color: '#94a3b8', weight: 1.15, opacity: 0.65, className: 'bg-line'
})

// Helper component for Done Layer to handle slicing
function DoneLayer({ data }) {
  const doneGeoJSON = useMemo(() => {
    if (!data) return null
    const slices = []
    for (const f of data.features) {
      const p = f.properties.progress || 0
      if (p <= 0.01) continue

      if (p >= 0.99) {
        slices.push(f)
        continue
      }

      try {
        const len = f.properties.meters
        const dist = len * p
        const start = turfPoint(f.geometry.coordinates[0])
        const endPt = turfAlong(f, dist / 1000, { units: 'kilometers' })

        const slice = lineSlice(start, endPt, f)
        slices.push(slice)
      } catch (e) { }
    }
    return { type: 'FeatureCollection', features: slices }
  }, [data])

  if (!doneGeoJSON) return null

  return (
    <Pane name="done" style={{ zIndex: 401 }}>
      <GeoJSON
        data={doneGeoJSON}
        style={{
          color: '#22c55e', // green
          weight: 6,
          opacity: 1,
          lineCap: 'round'
        }}
        interactive={false}
      />
    </Pane>
  )
}

// ====== APP ======
export default function App() {
  const [data, setData] = useState(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [hoverId, setHoverId] = useState(null)
  const [bgData, setBgData] = useState(null)

  // initial load
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY)
    if (saved) {
      try { setData(normalizeGeoJSON(JSON.parse(saved))); } catch { }
    } else {
      fetch('/trenches.geojson')
        .then(r => r.json())
        .then(j => setData(normalizeGeoJSON(j)))
        .catch(console.error)
    }

    fetch('/background.geojson')
      .then(r => r.json())
      .then(j => setBgData(j))
      .catch(console.error)
  }, [])

  // persist
  useEffect(() => {
    if (data) {
      localStorage.setItem(LS_KEY, JSON.stringify(data))
      setDataVersion(prev => prev + 1)
    }
  }, [data])

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

  // Summary
  const summary = useMemo(() => {
    let total = 0, done = 0
    const seenLines = new Set()

    for (const f of (data?.features || [])) {
      const lid = f.properties.lineId
      if (seenLines.has(lid)) continue
      seenLines.add(lid)

      const m = Number(f.properties?.meters ?? 0)
      const p = Number(f.properties?.progress ?? 0)

      total += m
      done += m * p
    }
    return { total, done, remaining: total - done }
  }, [data])

  // Set Progress
  const setProgressById = (id, newProg) => setData(prev => {
    if (!prev) return prev
    const clicked = prev.features.find(f => f.properties.id === id)
    if (!clicked) return prev
    const targetLineId = clicked.properties.lineId

    // Update ALL segments in group
    const feats = prev.features.map(f =>
      f.properties.lineId === targetLineId
        ? { ...f, properties: { ...f.properties, progress: newProg } }
        : f
    )
    return { ...prev, features: feats }
  })

  const clearAll = () => setData(prev => {
    if (!prev) return prev
    return { ...prev, features: prev.features.map(f => ({ ...f, properties: { ...f.properties, progress: 0 } })) }
  })

  return (
    <div style={{
      height: '100vh', width: '100vw', display: 'grid', gridTemplateColumns: '1fr 360px',
      background: '#0b1220', color: '#e5e7eb'
    }}>
      <div>
        <MapContainer center={[52.6, -1.7]} zoom={17} style={{ height: '100%', width: '100%', background: '#0f172a' }}>
          <KillBrowserDefaults />
          <MiddleMousePan />

          {/* 1. Background Layer (Todo) - The full lines in yellow/amber */}
          {data && (
            <Pane name="todo" style={{ zIndex: 400 }}>
              <GeoJSON
                data={data}
                style={(f) => {
                  const isHover = hoverId && f.properties.id === hoverId
                  return {
                    color: '#f59e0b', // amber
                    weight: isHover ? 6 : 4.5,
                    opacity: 1, lineCap: 'round'
                  }
                }}
                interactive={false}
              />
            </Pane>
          )}

          {/* 2. Overlay Layer (Done) - The sliced green lines */}
          <DoneLayer data={data} />

          {/* Logic */}
          {data?.features && (
            <>
              <MapHoverProximity setHoverId={setHoverId} features={data.features} spatialIndex={spatialIndex} />
              <MapBrushUnified setProgressById={setProgressById} features={data.features} spatialIndex={spatialIndex} />
            </>
          )}

          <FitToDataOnce geojson={data} />
        </MapContainer>
      </div>
      {/* Sidebar */}
      <aside style={{ padding: '14px 16px', background: '#0b1220', borderLeft: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
          <b style={{ fontSize: 16, letterSpacing: .2 }}>Trench-MVP</b>
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: .7, background: '#0f172a', border: '1px solid #1f2937', padding: '4px 8px', borderRadius: 999 }}>Dark</span>
          <button onClick={clearAll} style={{ background: '#0f172a', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 10, padding: '6px 12px', cursor: 'pointer' }}>Clear</button>
        </div>
        <div className="kpi-box" style={{ marginBottom: 10 }}>
          <div className="kpi-label">Toplam</div>
          <div className="kpi-value">{summary.total.toFixed(2)} m</div>
        </div>
        <div className="kpi-box" style={{ marginBottom: 10 }}>
          <div className="kpi-label">Tamamlanan</div>
          <div className="kpi-value" style={{ color: '#22c55e' }}>{summary.done.toFixed(2)} m</div>
        </div>
        <div className="kpi-box">
          <div className="kpi-label">Kalan</div>
          <div className="kpi-value">{summary.remaining.toFixed(2)} m</div>
        </div>

        <div style={{ marginTop: 20, fontSize: 12, color: '#64748b' }}>
          <p>Sol Basılı Tut: Boya (İlerleme)</p>
          <p>Sağ Basılı Tut: Sil</p>
          <p>Orta Tuş: Kaydır</p>
        </div>
      </aside>
    </div>
  )
}
