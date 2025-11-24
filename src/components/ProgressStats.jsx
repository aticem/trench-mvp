import React from 'react'

export default function ProgressStats({
  total = 0,
  completed = 0,
  remaining = 0,
  percentage = 0,
  onUndo,
  undoDisabled,
  onRedo,
  redoDisabled
}) {
  const format = (val) => `${(val || 0).toFixed(2)} m`
  const completedText = `${format(completed)} , %${(percentage || 0).toFixed(2)}`

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={onUndo}
          disabled={undoDisabled}
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            border: '1px solid #334155',
            background: '#1e293b',
            color: undoDisabled ? '#64748b' : '#38bdf8',
            fontSize: 20,
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: undoDisabled ? 'not-allowed' : 'pointer',
            opacity: undoDisabled ? 0.5 : 1
          }}
          title="Undo (Ctrl + Z)"
        >
          ↺
        </button>
        <button
          onClick={onRedo}
          disabled={redoDisabled}
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            border: '1px solid #334155',
            background: '#1e293b',
            color: redoDisabled ? '#64748b' : '#38bdf8',
            fontSize: 20,
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: redoDisabled ? 'not-allowed' : 'pointer',
            opacity: redoDisabled ? 0.5 : 1
          }}
          title="Redo (Ctrl + Y)"
        >
          ↻
        </button>
      </div>
      <StatCard label="Total" value={format(total)} />
      <StatCard label="Completed" value={completedText} highlight />
      <StatCard label="Remaining" value={format(remaining)} />
    </div>
  )
}

function StatCard({ label, value, highlight }) {
  return (
    <div style={{
      padding: '6px 12px',
      borderRadius: 8,
      background: '#111a2e',
      border: '1px solid #1d2a46',
      fontSize: 14,
      fontWeight: 600,
      color: highlight ? '#34d399' : '#e5e7eb',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }}>
      <span style={{ opacity: 0.7, color: '#cbd5f5' }}>{label}:</span>
      <span>{value}</span>
    </div>
  )
}
