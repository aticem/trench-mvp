import React, { useState, useEffect } from 'react'

export default function SubmitModal({ isOpen, onClose, onSubmit, dailyInstalled }) {
  const [date, setDate] = useState('')
  const [subcontractor, setSubcontractor] = useState('')
  const [workers, setWorkers] = useState('')

  useEffect(() => {
    if (isOpen) {
      setDate(new Date().toISOString().slice(0, 10))
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSubmit = (e) => {
    e.preventDefault()
    onSubmit({
      date,
      installed_panels: dailyInstalled,
      subcontractor,
      workers
    })
    setSubcontractor('')
    setWorkers('')
    onClose?.()
  }

  return (
    <div style={styles.backdrop}>
      <div style={styles.modal}>
        <h2 style={styles.title}>Submit Daily Work</h2>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            Subcontractor
            <input
              type="text"
              value={subcontractor}
              onChange={(e) => setSubcontractor(e.target.value)}
              placeholder="Company name"
              required
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            Number of Workers
            <input
              type="number"
              value={workers}
              onChange={(e) => setWorkers(e.target.value)}
              placeholder="e.g. 5"
              style={styles.input}
            />
          </label>
          <div style={styles.summary}>
            <span>Work Amount</span>
            <strong>{dailyInstalled ? Number(dailyInstalled).toFixed(2) : '0.00'} m</strong>
          </div>
          <div style={styles.actions}>
            <button type="button" onClick={onClose} style={styles.secondary}>
              Cancel
            </button>
            <button type="submit" style={styles.primary}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999
  },
  modal: {
    width: 360,
    background: '#101828',
    border: '1px solid #1f2a44',
    borderRadius: 12,
    padding: 20,
    boxShadow: '0 25px 60px rgba(0,0,0,0.45)',
    color: '#e5e7eb'
  },
  title: {
    margin: '0 0 16px',
    fontSize: 18,
    fontWeight: 600
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 13,
    color: '#cbd5f5'
  },
  input: {
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid #273451',
    background: '#0b1220',
    color: '#e5e7eb'
  },
  summary: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: '#0f172a',
    borderRadius: 10,
    padding: '10px 12px',
    border: '1px solid #1e2b4a'
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4
  },
  secondary: {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid #273451',
    background: 'transparent',
    color: '#9ca3af',
    cursor: 'pointer'
  },
  primary: {
    padding: '8px 14px',
    borderRadius: 8,
    border: 'none',
    background: '#2563eb',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer'
  }
}

