import React, { useMemo, useRef, useCallback } from 'react'
import { MapContainer, GeoJSON, useMap, useMapEvent, Pane } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { bbox as turfBbox, point as turfPoint, nearestPointOnLine, lineSlice, length as turfLength } from '@turf/turf'
import RBush from 'rbush'
import { along as turfAlong } from '@turf/turf'
import L from 'leaflet'

const PIXEL_TOLERANCE = 15

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
    candidates = hits?.length ? hits.map(h => h.feature) : (allFeatures || [])
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

function FitToDataOnce({ geojson }) {
  const map = useMap()
  const didFitRef = useRef(false)
  React.useEffect(() => {
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

function MiddleMousePan() {
  const map = useMap()
  const isPanningRef = useRef(false)
  const lastRef = useRef({ x: 0, y: 0 })

  React.useEffect(() => {
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

    const endPan = () => {
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

function KillBrowserDefaults() {
  const map = useMap()
  React.useEffect(() => {
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

function MapBrushUnified({ setProgressForLine, features, spatialIndex, beginUndoableAction }) {
  const map = useMap()
  const isDownRef = useRef(false)
  const downButtonRef = useRef(0)
  const lastDragLatLngRef = useRef(null)
  const actionStartedRef = useRef(false)

  const mergeRanges = (ranges) => {
    if (!ranges || ranges.length === 0) return []
    const sorted = [...ranges].sort((a, b) => a[0] - b[0])
    const merged = []
    let current = sorted[0]
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i]
      if (next[0] <= current[1] + 0.001) {
        current[1] = Math.max(current[1], next[1])
      } else {
        merged.push(current)
        current = next
      }
    }
    merged.push(current)
    return merged
  }

  const processPoint = (latlng, btn) => {
    const { feature, dpx } = pickNearestFeature(map, latlng, features, spatialIndex)
    if (feature && dpx <= PIXEL_TOLERANCE) {
      const pt = turfPoint([latlng.lng, latlng.lat])
      const snapped = nearestPointOnLine(feature, pt)
      const start = turfPoint(feature.geometry.coordinates[0])
      const slice = lineSlice(start, snapped, feature)
      const dist = turfLength(slice, { units: 'meters' })
      const total = feature.properties.meters || 1

      let pointProg = dist / total
      if (pointProg > 1) pointProg = 1
      if (pointProg < 0) pointProg = 0

      const brushMeters = 2
      const brushProg = brushMeters / total
      const startP = Math.max(0, pointProg - brushProg / 2)
      const endP = Math.min(1, pointProg + brushProg / 2)

      if (btn === 0) {
        const currentRanges = feature.properties.ranges || []
        const combined = [...currentRanges, [startP, endP]]
        setProgressForLine(feature.properties.lineId, mergeRanges(combined))
      } else if (btn === 2) {
        const currentRanges = feature.properties.ranges || []
        const newRanges = []
        for (const r of currentRanges) {
          if (r[1] < startP || r[0] > endP) {
            newRanges.push(r)
            continue
          }
          if (r[0] < startP) newRanges.push([r[0], startP])
          if (r[1] > endP) newRanges.push([endP, r[1]])
        }
        setProgressForLine(feature.properties.lineId, newRanges)
      }
    }
  }

  useMapEvent('mousedown', (e) => {
    const ev = e.originalEvent
    if (!ev) return
    const btn = ev.button ?? 0
    const { feature, dpx } = pickNearestFeature(map, e.latlng, features, spatialIndex)
    if (btn === 0 && feature && dpx <= PIXEL_TOLERANCE) {
      isDownRef.current = true
      downButtonRef.current = 0
      lastDragLatLngRef.current = e.latlng
      map.dragging.disable()
      if (!actionStartedRef.current) {
        beginUndoableAction?.()
        actionStartedRef.current = true
      }
      processPoint(e.latlng, 0)
      L.DomEvent.stop(ev)
      return
    }
    if (btn === 2 && feature && dpx <= PIXEL_TOLERANCE) {
      isDownRef.current = true
      downButtonRef.current = 2
      lastDragLatLngRef.current = e.latlng
      map.dragging.disable()
      if (!actionStartedRef.current) {
        beginUndoableAction?.()
        actionStartedRef.current = true
      }
      processPoint(e.latlng, 2)
      L.DomEvent.stop(ev)
    }
  })

  useMapEvent('mousemove', (e) => {
    if (!isDownRef.current) return
    const btn = downButtonRef.current
    const currentLatLng = e.latlng
    const lastLatLng = lastDragLatLngRef.current || currentLatLng
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
    if (isDownRef.current) {
      isDownRef.current = false
      downButtonRef.current = 0
      lastDragLatLngRef.current = null
      map.dragging.enable()
      actionStartedRef.current = false
    }
  })

  return null
}

const bgStyleFn = () => ({
  color: '#4c566a',
  weight: 0.9,
  opacity: 0.35,
  lineCap: 'butt',
  className: 'bg-line'
})

function DoneLayer({ features, version }) {
  const ref1 = React.useRef(null)
  const ref2 = React.useRef(null)

  const doneGeoJSON = useMemo(() => {
    if (!features) return null
    const slices = []
    for (const f of features) {
      const ranges = f.properties.ranges || []
      if (ranges.length === 0) continue
      const len = f.properties.meters
      if (!len) continue
      for (const [startP, endP] of ranges) {
        if (endP - startP <= 0.0001) continue
        try {
          const startPt = turfAlong(f, (len * startP) / 1000, { units: 'kilometers' })
          const endPt = turfAlong(f, (len * endP) / 1000, { units: 'kilometers' })
          const slice = lineSlice(startPt, endPt, f)
          slices.push(slice)
        } catch (e) { }
      }
    }
    return { type: 'FeatureCollection', features: slices }
  }, [features, version])

  React.useEffect(() => {
    if (ref1.current) {
      ref1.current.clearLayers()
      if (doneGeoJSON) ref1.current.addData(doneGeoJSON)
    }
    if (ref2.current) {
      ref2.current.clearLayers()
      if (doneGeoJSON) ref2.current.addData(doneGeoJSON)
    }
  }, [doneGeoJSON])

  return (
    <Pane name="done" style={{ zIndex: 401 }}>
      <GeoJSON
        ref={ref1}
        data={null}
        style={{
          color: '#064e3b',
          weight: 5,
          opacity: 0.85,
          lineCap: 'butt'
        }}
        interactive={false}
      />
      <GeoJSON
        ref={ref2}
        data={null}
        style={{
          color: '#34d399',
          weight: 3.2,
          opacity: 1,
          dashArray: '6 8',
          lineCap: 'butt'
        }}
        interactive={false}
      />
    </Pane>
  )
}

export default function PanelMap({ features, setFeatures, bgData, beginUndoableAction, dataVersion }) {
  const hoverIdRef = React.useRef(null)
  const [, forceRender] = React.useState(0)
  const setHoverId = (id) => {
    hoverIdRef.current = id
    forceRender(v => v + 1)
  }

  const featureCollection = useMemo(() => ({
    type: 'FeatureCollection',
    features
  }), [features])

  const spatialIndex = useMemo(() => {
    if (!features?.length) return null
    const tree = new RBush()
    const items = features.map(f => ({
      minX: f.properties._bbox?.[0],
      minY: f.properties._bbox?.[1],
      maxX: f.properties._bbox?.[2],
      maxY: f.properties._bbox?.[3],
      feature: f
    }))
    tree.load(items)
    return tree
  }, [features])

  const setProgressForLine = useCallback((lineId, ranges) => {
    setFeatures(prev => prev.map(f => {
      if (f.properties.lineId !== lineId) return f
      const normalized = (ranges || []).map(r => [...r])
      let coverage = normalized.reduce((sum, [a, b]) => sum + (b - a), 0)
      coverage = Math.max(0, Math.min(1, coverage))
      let status = 'pending'
      if (coverage >= 0.99) status = 'done'
      else if (coverage > 0) status = 'in_progress'
      return { ...f, properties: { ...f.properties, ranges: normalized, status } }
    }))
  }, [setFeatures])

  return (
    <MapContainer
      center={[52.6, -1.7]}
      zoom={17}
      zoomControl={false}
      style={{ height: '100%', width: '100%', background: '#0f172a' }}
    >
      <KillBrowserDefaults />
      <MiddleMousePan />

      {bgData && (
        <Pane name="bg" style={{ zIndex: 390 }}>
          <GeoJSON data={bgData} style={bgStyleFn} interactive={false} />
        </Pane>
      )}

      {features?.length > 0 && (
        <Pane name="todo" style={{ zIndex: 400 }}>
          <GeoJSON
            data={featureCollection}
            style={(f) => {
              const isHover = hoverIdRef.current && f.properties.id === hoverIdRef.current
              return {
                color: isHover ? '#ffffff' : '#f5f5f5',
                weight: isHover ? 1.6 : 1.05,
                opacity: isHover ? 1 : 0.88,
                lineCap: 'butt',
                lineJoin: 'round'
              }
            }}
            interactive={false}
          />
        </Pane>
      )}

      <DoneLayer features={features} version={dataVersion} />

      {features?.length > 0 && (
        <>
          <MapHoverProximity setHoverId={setHoverId} features={features} spatialIndex={spatialIndex} />
          <MapBrushUnified
            setProgressForLine={setProgressForLine}
            features={features}
            spatialIndex={spatialIndex}
            beginUndoableAction={beginUndoableAction}
          />
        </>
      )}

      <FitToDataOnce geojson={featureCollection} />
    </MapContainer>
  )
}

