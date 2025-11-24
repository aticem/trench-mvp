import React, { useMemo, useRef, useCallback, useState } from 'react'
import { MapContainer, GeoJSON, useMap, useMapEvent, Pane } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { bbox as turfBbox, point as turfPoint, nearestPointOnLine, lineSlice, length as turfLength, bboxClip, along as turfAlong } from '@turf/turf'
import RBush from 'rbush'
import L from 'leaflet'

const PIXEL_TOLERANCE = 15
const BG_TEXT_CLASS = 'bg-text-label'

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function makeTextMarker(feature, latlng) {
  const text = feature?.properties?.text
  if (!text) {
    return L.circleMarker(latlng, { radius: 0, opacity: 0, interactive: false })
  }
  const angle = Number(feature?.properties?.angle || 0)
  const html = `<span class="${BG_TEXT_CLASS}__inner" style="transform: rotate(${angle}deg);">${escapeHtml(text)}</span>`
  return L.marker(latlng, {
    icon: L.divIcon({
      className: BG_TEXT_CLASS,
      html,
      iconSize: [0, 0]
    }),
    interactive: false
  })
}

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

function MapBoxSelection({ setFeatures, features, spatialIndex, beginUndoableAction }) {
  const map = useMap()
  const [selectionBox, setSelectionBox] = React.useState(null)
  const startRef = useRef(null)
  const draggingRef = useRef(false)
  const buttonRef = useRef(0)

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

  React.useEffect(() => {
    const container = map.getContainer()
    
    const onMouseDown = (e) => {
      if (e.button !== 0 && e.button !== 2) return
      e.preventDefault()
      e.stopPropagation()
      
      draggingRef.current = true
      buttonRef.current = e.button
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      startRef.current = { x, y }
      setSelectionBox({ x, y, w: 0, h: 0, type: e.button === 0 ? 'select' : 'unselect' })
      map.dragging.disable()
    }

    const onMouseMove = (e) => {
      if (!draggingRef.current) return
      e.preventDefault()
      e.stopPropagation()
      
      const rect = container.getBoundingClientRect()
      const currentX = e.clientX - rect.left
      const currentY = e.clientY - rect.top
      const startX = startRef.current.x
      const startY = startRef.current.y
      
      const x = Math.min(startX, currentX)
      const y = Math.min(startY, currentY)
      const w = Math.abs(startX - currentX)
      const h = Math.abs(startY - currentY)
      
      setSelectionBox(prev => ({ ...prev, x, y, w, h }))
    }

    const onMouseUp = (e) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      map.dragging.enable()
      
      if (selectionBox && selectionBox.w > 2 && selectionBox.h > 2) {
         beginUndoableAction()
         
         const p1 = map.containerPointToLatLng([selectionBox.x, selectionBox.y])
         const p2 = map.containerPointToLatLng([selectionBox.x + selectionBox.w, selectionBox.y + selectionBox.h])
         
         const minX = Math.min(p1.lng, p2.lng)
         const maxX = Math.max(p1.lng, p2.lng)
         const minY = Math.min(p1.lat, p2.lat)
         const maxY = Math.max(p1.lat, p2.lat)
         
         const hits = spatialIndex.search({ minX, minY, maxX, maxY })
         const hitIds = new Set(hits.map(h => h.feature.properties.id))
         
         const isSelect = buttonRef.current === 0
         const bbox = [minX, minY, maxX, maxY]

         setFeatures(prev => prev.map(f => {
           if (hitIds.has(f.properties.id)) {
             const clipped = bboxClip(f, bbox)
             if (!clipped || !clipped.geometry || clipped.geometry.coordinates.length === 0) return f

             const totalLen = f.properties.meters || 1
             const startOfLine = turfPoint(f.geometry.coordinates[0])
             const newRangesToAddOrRemove = []

             const processSegment = (coords) => {
               if (coords.length < 2) return
               const pStart = turfPoint(coords[0])
               const pEnd = turfPoint(coords[coords.length - 1])
               
               const sliceStart = lineSlice(startOfLine, pStart, f)
               const sliceEnd = lineSlice(startOfLine, pEnd, f)
               
               const dStart = turfLength(sliceStart, { units: 'meters' })
               const dEnd = turfLength(sliceEnd, { units: 'meters' })
               
               let r0 = dStart / totalLen
               let r1 = dEnd / totalLen
               if (r0 > r1) [r0, r1] = [r1, r0]
               
               newRangesToAddOrRemove.push([Math.max(0, r0), Math.min(1, r1)])
             }

             if (clipped.geometry.type === 'LineString') {
               processSegment(clipped.geometry.coordinates)
             } else if (clipped.geometry.type === 'MultiLineString') {
               clipped.geometry.coordinates.forEach(processSegment)
             }

             if (newRangesToAddOrRemove.length === 0) return f

             let currentRanges = f.properties.ranges || []
             let finalRanges = []

             if (isSelect) {
               const combined = [...currentRanges, ...newRangesToAddOrRemove]
               finalRanges = mergeRanges(combined)
             } else {
               let result = currentRanges
               for (const [r0, r1] of newRangesToAddOrRemove) {
                 const nextResult = []
                 for (const [c0, c1] of result) {
                   if (c1 < r0 || c0 > r1) {
                     nextResult.push([c0, c1])
                   } else {
                     if (c0 < r0) nextResult.push([c0, r0])
                     if (c1 > r1) nextResult.push([r1, c1])
                   }
                 }
                 result = nextResult
               }
               finalRanges = result
             }

             let coverage = finalRanges.reduce((sum, [a, b]) => sum + (b - a), 0)
             let status = 'pending'
             if (coverage >= 0.99) status = 'done'
             else if (coverage > 0) status = 'in_progress'

             return { ...f, properties: { ...f.properties, ranges: finalRanges, status } }
           }
           return f
         }))
      }
      
      setSelectionBox(null)
    }

    container.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    
    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [map, spatialIndex, selectionBox, setFeatures, beginUndoableAction])

  if (!selectionBox) return null

  return (
    <div style={{
      position: 'absolute',
      left: selectionBox.x,
      top: selectionBox.y,
      width: selectionBox.w,
      height: selectionBox.h,
      border: `2px solid ${selectionBox.type === 'select' ? '#34d399' : '#f87171'}`,
      backgroundColor: selectionBox.type === 'select' ? 'rgba(52, 211, 153, 0.2)' : 'rgba(248, 113, 113, 0.2)',
      zIndex: 1000,
      pointerEvents: 'none'
    }} />
  )
}

const bgStyleFn = () => ({
  color: '#000000', // Black lines
  weight: 1,
  opacity: 1,
  lineCap: 'butt',
  className: 'bg-line',
  interactive: false
})

const textStyleFn = () => ({
  color: '#94a3b8',
  weight: 0.5,
  opacity: 0.3
})

const FENCE_COLORS = [
  '#32CD32', // LimeGreen
  '#FFA500', // Orange
  '#1E90FF', // DodgerBlue
  '#FFFF00', // Yellow
  '#00FFFF', // Cyan
  '#FF00FF', // Magenta
]

const fenceStyleFn = (feature) => {
  const id = feature?.properties?.fid || feature?.properties?.handle || Math.floor(Math.random() * 10000)
  const colorIndex = id % FENCE_COLORS.length
  return {
    color: FENCE_COLORS[colorIndex],
    weight: 1,
    opacity: 1,
    lineCap: 'butt',
    interactive: false
  }
}

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
  }, [doneGeoJSON])

  return (
    <Pane name="done" style={{ zIndex: 401 }}>
      <GeoJSON
        ref={ref1}
        data={null}
        style={{
          color: '#22c55e', // Solid Green
          weight: 3,        // Matching the red lines thickness roughly (maybe slightly thicker)
          opacity: 1,       // Solid, no transparency
          lineCap: 'round'
        }}
        interactive={false}
      />
    </Pane>
  )
}

const FenceLayer = React.memo(({ data, zoom }) => {
  const processedData = useMemo(() => {
    if (!data || !data.features) return null
    const chunks = []
    let globalIndex = 0
    
    for (const f of data.features) {
      if (!f.geometry || f.geometry.type !== 'LineString') {
        if (f.geometry?.type === 'MultiLineString') {
           chunks.push({ ...f, properties: { ...f.properties, colorIndex: globalIndex++ } })
        } else {
           chunks.push({ ...f, properties: { ...f.properties, colorIndex: globalIndex++ } })
        }
        continue
      }

      const len = turfLength(f, { units: 'kilometers' })
      const segmentLen = 0.1 // 100 meters
      
      if (len <= segmentLen) {
        chunks.push({ ...f, properties: { ...f.properties, colorIndex: globalIndex++ } })
      } else {
        const numSegments = Math.ceil(len / segmentLen)
        for (let i = 0; i < numSegments; i++) {
          const startDist = i * segmentLen
          const endDist = Math.min((i + 1) * segmentLen, len)
          
          try {
            const startPt = turfAlong(f, startDist, { units: 'kilometers' })
            const endPt = turfAlong(f, endDist, { units: 'kilometers' })
            const slice = lineSlice(startPt, endPt, f)
            
            chunks.push({
              ...slice,
              properties: {
                ...f.properties,
                colorIndex: globalIndex++ 
              }
            })
          } catch (e) {
            console.warn('Error slicing fence:', e)
          }
        }
      }
    }
    return { type: 'FeatureCollection', features: chunks }
  }, [data])

  if (!processedData) return null

  const rainbow = [
    "#FF0000", // Neon Red
    "#FF4500", // Neon Orange Red
    "#FFD700", // Neon Gold
    "#32CD32", // Neon Lime Green
    "#00FF00", // Neon Green
    "#00FFFF", // Neon Cyan
    "#1E90FF", // Neon Dodger Blue
    "#0000FF", // Neon Blue
    "#8A2BE2", // Neon Blue Violet
    "#FF00FF", // Neon Magenta
    "#FF1493"  // Neon Deep Pink
  ]

  return (
    <Pane name="bg-fence" style={{ zIndex: 391 }}>
      <GeoJSON 
        data={processedData} 
        style={(feature) => {
          const str = (feature?.properties && Object.keys(feature.properties).length > 0) 
            ? JSON.stringify(feature.properties) 
            : JSON.stringify(feature?.geometry || Math.random())
            
          let hash = 0
          for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash)
          }
          
          const color = rainbow[Math.abs(hash) % rainbow.length]
          
          // Dynamic weight based on zoom to prevent clutter
          const weight = zoom < 16 ? 1 : (zoom < 18 ? 2 : 3)

          return {
            color: color,
            weight: weight,
            opacity: 1,
            lineCap: 'butt',
            interactive: false
          }
        }} 
        interactive={false} 
      />
    </Pane>
  )
})

function ZoomHandler({ setZoom }) {
  const map = useMap()
  useMapEvent('zoomend', () => {
    setZoom(map.getZoom())
  })
  return null
}

const SvgTextLayer = React.memo(({ data }) => {
  const map = useMap()

  React.useEffect(() => {
    if (!data || !map) return

    const TextLayer = L.Layer.extend({
      onAdd: function(map) {
        this._map = map
        // Use the default SVG renderer or create one
        this._renderer = map.getRenderer(this)
        
        // Ensure we are using SVG renderer
        if (!(this._renderer instanceof L.SVG)) {
            // Fallback or force SVG? 
            // Usually default is SVG.
            // If Canvas is default, we might need to force SVG for this layer?
            // But we can just create our own SVG container if needed.
            // Let's assume default is SVG or we can access the overlay pane.
        }

        this._container = this._renderer._container
        this._rootGroup = this._renderer._rootGroup

        this._group = L.SVG.create('g')
        L.DomUtil.addClass(this._group, 'leaflet-zoom-hide') // Hide during zoom? No, we want it to scale.
        // Actually, the renderer handles scaling of the root group.
        // We just append to it.
        
        this._rootGroup.appendChild(this._group)
        
        this._update()
        map.on('moveend zoomend', this._update, this)
      },

      onRemove: function(map) {
        if (this._group && this._rootGroup) {
          this._rootGroup.removeChild(this._group)
        }
        map.off('moveend zoomend', this._update, this)
      },

      _update: function() {
        if (!this._map || !this._group) return
        
        // Clear existing
        while (this._group.firstChild) {
          this._group.removeChild(this._group.firstChild)
        }

        const bounds = this._map.getBounds()
        const zoom = this._map.getZoom()
        
        // Simple viewport culling
        // We can use the spatial index if we had one for text, but linear scan of 3MB might be ok-ish?
        // 3MB json is maybe 10k items. 10k checks is fast.
        
        const features = data.features || []
        const fragment = document.createDocumentFragment()
        
        // Dynamic font size based on zoom to reduce clutter
        // 18 -> 9px, 19 -> 11px, 20 -> 13px, 21+ -> 15px+
        const fontSize = Math.max(9, (zoom - 18) * 2 + 9)

        for (const f of features) {
          const coords = f.geometry.coordinates
          const lat = coords[1]
          const lng = coords[0]
          
          // Quick bounds check
          if (!bounds.contains([lat, lng])) continue
          
          const pt = this._map.latLngToLayerPoint([lat, lng])
          
          const textNode = L.SVG.create('text')
          textNode.textContent = f.properties.text
          textNode.setAttribute('x', pt.x)
          textNode.setAttribute('y', pt.y)
          textNode.setAttribute('fill', '#000000') // Black text
          textNode.setAttribute('font-size', `${fontSize}px`)
          textNode.setAttribute('font-family', 'sans-serif')
          textNode.setAttribute('text-anchor', 'middle')
          textNode.setAttribute('dominant-baseline', 'middle')
          textNode.setAttribute('class', 'bg-text-svg')
          // Add white shadow for readability on black lines
          textNode.setAttribute('style', 'text-shadow: 0 0 3px #ffffff; pointer-events: none;')
          
          if (f.properties.angle) {
             // Rotate around the point
             textNode.setAttribute('transform', `rotate(${f.properties.angle}, ${pt.x}, ${pt.y})`)
          }
          
          fragment.appendChild(textNode)
        }
        
        this._group.appendChild(fragment)
      }
    })

    const l = new TextLayer()
    map.addLayer(l)

    return () => {
      map.removeLayer(l)
    }
  }, [data, map])

  return null
})

export default function PanelMap({ features, setFeatures, bgData, textData, fenceData, beginUndoableAction, dataVersion }) {
  const hoverIdRef = React.useRef(null)
  const [zoom, setZoom] = useState(17)
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
      style={{ height: '100%', width: '100%', background: '#eef2f6' }}
    >
      <KillBrowserDefaults />
      <MiddleMousePan />
      <ZoomHandler setZoom={setZoom} />

      {bgData && (
        <Pane name="bg" style={{ zIndex: 390 }}>
          <GeoJSON data={bgData} style={bgStyleFn} interactive={false} />
        </Pane>
      )}

      {fenceData && (
        <FenceLayer data={fenceData} zoom={zoom} />
      )}

      {textData && zoom >= 18 && (
        <SvgTextLayer data={textData} />
      )}

      {features?.length > 0 && (
        <Pane name="todo" style={{ zIndex: 400 }}>
          <GeoJSON
            data={featureCollection}
            style={(f) => {
              const isHover = hoverIdRef.current && f.properties.id === hoverIdRef.current
              return {
                color: isHover ? '#ff8888' : '#ef4444', // Red for "to do" trenches
                weight: isHover ? 2.5 : 1.5,
                opacity: isHover ? 1 : 0.9,
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
          <MapBoxSelection
            setFeatures={setFeatures}
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

