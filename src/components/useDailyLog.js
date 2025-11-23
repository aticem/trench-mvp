import { useEffect, useState } from 'react'

const STORAGE_KEY = 'dailyLog'

export default function useDailyLog() {
  const [dailyLog, setDailyLog] = useState([])

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        setDailyLog(JSON.parse(stored))
      } catch {
        setDailyLog([])
      }
    }
  }, [])

  const persist = (records) => {
    setDailyLog(records)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  }

  const addRecord = (record) => {
    persist([...dailyLog, record])
  }

  const resetLog = () => {
    localStorage.removeItem(STORAGE_KEY)
    setDailyLog([])
  }

  return { dailyLog, addRecord, resetLog }
}

