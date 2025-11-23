import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { distance as turfDistance, point as turfPoint, length as turfLength, bbox as turfBbox } from '@turf/turf'
import SubmitModal from './components/SubmitModal.jsx'
import PanelMap from './components/PanelMap.jsx'
import ProgressStats from './components/ProgressStats.jsx'
import useDailyLog from './components/useDailyLog.js'
import { useChartExport } from './components/useChartExport.js'

const LS_KEY = 'trench-mvp-geojson-v4'
const MAX_UNDO = 50

const cloneData = (state) => JSON.parse(JSON.stringify(state))

function normalizeGeoJSON(j) {
  const rawFeats = (j.features || []).filter(f => f.properties?.layer === 'trenches')
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
    if (!p1_start) continue

    for (let k = i + 1; k < rawFeats.length; k++) {
      if (assigned.has(k)) continue
      const f2 = rawFeats[k]
      const c2 = f2.geometry.coordinates
      const p2_start = c2 && c2.length > 0 ? c2[0] : null
      const p2_end = c2 && c2.length > 0 ? c2[c2.length - 1] : null
      if (!p2_start) continue

      const d_normal = turfDistance(turfPoint(p1_start), turfPoint(p2_start), { units: 'kilometers' })
      const d_reverse = turfDistance(turfPoint(p1_start), turfPoint(p2_end || p2_start), { units: 'kilometers' })

      if (d_normal < THRESHOLD_KM || d_reverse < THRESHOLD_KM) {
        group.push(f2)
        assigned.add(k)
      }
    }
    groups.push(group)
  }

  const feats = []
  groups.forEach((grp, gIdx) => {
    const lineId = `G_${gIdx}`
    const first = grp[0]
    const len = turfLength(first, { units: 'meters' })

    grp.forEach((f, i) => {
      const p = { ...(f.properties || {}) }
      const id = p.id ?? `SEG_${gIdx}_${i}`
      let ranges = p.ranges || []
      if (typeof p.progress === 'number' && p.progress > 0) {
        ranges = [[0, p.progress]]
      }

      // Ensure bbox exists for RBush
      const box = p._bbox || turfBbox(f)

      feats.push({
        ...f,
        properties: {
          ...p,
          id,
          lineId,
          meters: len,
          ranges,
          status: p.status || 'pending',
          _bbox: box
        }
      })
    })
  })

  return feats
}

export default function App() {
  const [features, setFeatures] = useState([])
  const [bgData, setBgData] = useState(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [isSubmitOpen, setSubmitOpen] = useState(false)
  const [undoStack, setUndoStack] = useState([])
  const [undoCount, setUndoCount] = useState(0)

  const { dailyLog, addRecord } = useDailyLog()
  const { exportToExcel } = useChartExport()

  const pushUndoSnapshot = useCallback((state) => {
    if (!state || !state.length) return
    const snapshot = cloneData(state)
    setUndoStack(prev => {
      const next = [...prev, snapshot]
      if (next.length > MAX_UNDO) next.shift()
      setUndoCount(next.length)
      return next
    })
  }, [])

  const undoLast = useCallback(() => {
    setUndoStack(prev => {
      if (!prev.length) return prev
      const next = [...prev]
      const snapshot = next.pop()
      setUndoCount(next.length)
      if (snapshot) setFeatures(snapshot)
      return next
    })
  }, [])

  const beginUndoableAction = useCallback(() => {
    if (!features.length) return
    pushUndoSnapshot(features)
  }, [features, pushUndoSnapshot])

  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY)
    let didSetFromStorage = false
    
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed?.features?.length) {
          setFeatures(normalizeGeoJSON(parsed))
          didSetFromStorage = true
        }
      } catch { }
    }

    if (!didSetFromStorage) {
      fetch('/trenches.geojson')
        .then(r => r.json())
        .then(j => setFeatures(normalizeGeoJSON(j)))
        .catch(console.error)
    }

    fetch('/background.geojson')
      .then(r => r.json())
      .then(j => setBgData(j))
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (!features.length) return
    localStorage.setItem(LS_KEY, JSON.stringify({ type: 'FeatureCollection', features }))
    setDataVersion(prev => prev + 1)
  }, [features])

  useEffect(() => {
    const handleKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undoLast()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [undoLast])

  const summary = useMemo(() => {
    let total = 0, completed = 0
    const seenLines = new Set()
    for (const f of features) {
      const lid = f.properties.lineId
      if (seenLines.has(lid)) continue
      seenLines.add(lid)
      const meters = Number(f.properties?.meters ?? 0)
      const ranges = f.properties?.ranges || []
      total += meters
      let ratio = 0
      for (const [a, b] of ranges) ratio += (b - a)
      completed += meters * Math.min(1, ratio)
    }
    return { total, completed, remaining: total - completed }
  }, [features])

  const clearAll = () => {
    if (!features.length) return
    const confirmed = window.confirm('This will reset all progress. Continue?')
    if (!confirmed) return
    beginUndoableAction()
    setFeatures(prev => prev.map(f => ({
      ...f,
      properties: { ...f.properties, ranges: [], status: 'pending' }
    })))
  }

  const handleSubmitRecord = (record) => {
    addRecord(record)
    setSubmitOpen(false)
  }

  return (
    <>
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#0b1220', color: '#e5e7eb' }}>
        <header style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '12px 24px',
          background: '#081122',
          borderBottom: '1px solid #111b2f'
        }}>
          <ProgressStats
            total={summary.total}
            completed={summary.completed}
            remaining={summary.remaining}
            onUndo={undoLast}
            undoDisabled={!undoCount}
          />
          <h1 style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: '#f5f6fb'
          }}>
            LV &amp; DC Trench Progress Tracking
          </h1>
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={() => setSubmitOpen(true)}
              disabled={!features.length}
              style={{
                padding: '8px 18px',
                borderRadius: 8,
                border: '1px solid #1d2640',
                background: '#162037',
                color: '#e3e9ff',
                fontWeight: 500,
                cursor: features.length ? 'pointer' : 'not-allowed',
                opacity: features.length ? 1 : 0.5
              }}
            >
              Submit Daily Work
            </button>
            <button
              onClick={() => exportToExcel(dailyLog)}
              disabled={!dailyLog.length}
              style={{
                padding: '8px 18px',
                borderRadius: 8,
                border: '1px solid #1d2640',
                background: '#111a2f',
                color: '#a5b4fc',
                fontWeight: 500,
                cursor: dailyLog.length ? 'pointer' : 'not-allowed',
                opacity: dailyLog.length ? 1 : 0.5
              }}
            >
              Export
            </button>
            <button
              onClick={clearAll}
              style={{
                padding: '8px 18px',
                borderRadius: 8,
                border: '1px solid #2c394f',
                background: '#131b2d',
                color: '#fca5a5',
                fontWeight: 500,
                cursor: 'pointer'
              }}
            >
              Reset All
            </button>
          </div>
        </header>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <PanelMap
            features={features}
            setFeatures={setFeatures}
            bgData={bgData}
            beginUndoableAction={beginUndoableAction}
            dataVersion={dataVersion}
          />
        </div>
      </div>
      <SubmitModal
        isOpen={isSubmitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmit={handleSubmitRecord}
        dailyInstalled={summary.completed}
      />
      <canvas id="dailyChart" width="640" height="360" style={{ display: 'none' }} />
    </>
  )
}
