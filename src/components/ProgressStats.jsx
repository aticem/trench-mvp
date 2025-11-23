import React from 'react'

export default function ProgressStats({
  total = 0,
  completed = 0,
  remaining = 0,
  onUndo,
  undoDisabled
}) {
  const format = (val) => `${(val || 0).toFixed(2)} m`

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <button
        onClick={onUndo}
        disabled={undoDisabled}
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          border: '1px solid #1f2a44',
          background: '#111a2f',
          color: undoDisabled ? '#4b5563' : '#38bdf8',
          fontSize: 18,
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
      <StatCard label="Total" value={format(total)} />
      <StatCard label="Completed" value={format(completed)} highlight />
      <StatCard label="Remaining" value={format(remaining)} />
    </div>
  )
}

function StatCard({ label, value, highlight }) {
  return (
    <div style={{
      minWidth: 140,
      padding: '10px 14px',
      borderRadius: 10,
      background: '#111a2e',
      border: '1px solid #1d2a46',
      fontSize: 14,
      fontWeight: 600,
      color: highlight ? '#34d399' : '#e5e7eb',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }}>
      <span style={{ opacity: 0.7, color: '#cbd5f5' }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}
