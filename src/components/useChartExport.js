import { useCallback } from 'react'
import { Chart, registerables } from 'chart.js'
import ChartDataLabels from 'chartjs-plugin-datalabels'
import ExcelJS from 'exceljs'

Chart.register(...registerables, ChartDataLabels)

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const parseWorkers = (value) => {
  if (!value) return 0
  const numeric = Number(value)
  if (!Number.isNaN(numeric)) return numeric
  return 0
}

const normalizeDate = (value) => {
  if (!value) return ''
  return value.slice(0, 10)
}

export function useChartExport() {
  const exportToExcel = useCallback(async (dailyLog = []) => {
    if (!dailyLog.length) {
      window.alert('No daily log data to export.')
      return
    }

    const grouped = dailyLog.reduce((acc, row) => {
      const key = normalizeDate(row.date) || 'Unknown'
      if (!acc[key]) {
        acc[key] = {
          date: key,
          work_amount: 0,
          workers: 0,
          subcontractor: row.subcontractor || ''
        }
      }
      // Support both old 'installed_panels' and new 'installed_panels' which is now work_amount (meters)
      // Ideally we should store it as work_amount in the future, but the SubmitModal still passes it as installed_panels key for now or we change it.
      // In SubmitModal we passed: onSubmit({ ..., installed_panels: dailyInstalled, ... })
      // So we keep reading installed_panels from the record.
      acc[key].work_amount += Number(row.installed_panels || 0)
      acc[key].workers += parseWorkers(row.workers)
      if (!acc[key].subcontractor && row.subcontractor) acc[key].subcontractor = row.subcontractor
      return acc
    }, {})

    const rows = Object.values(grouped).sort((a, b) => new Date(a.date) - new Date(b.date))

    const labels = rows.map(r => r.date)
    const data = rows.map(r => r.work_amount)
    const subLabels = rows.map(r => {
      const sc = r.subcontractor ? r.subcontractor.slice(0, 2).toUpperCase() : '??'
      return `${sc}-${r.workers}`
    })

    const canvas = document.getElementById('dailyChart')
    if (!canvas) {
      console.error('dailyChart canvas not found')
      return
    }
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Work Amount (m)',
          data,
          backgroundColor: '#3b82f6'
        }]
      },
      options: {
        responsive: false,
        animation: false, // Critical for sync export
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: 'end',
            align: 'top',
            color: '#0f172a',
            font: { weight: 'bold' },
            formatter: (value, context) => {
              return subLabels[context.dataIndex]
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#64748b' },
            title: {
              display: true,
              text: 'Date',
              color: '#334155',
              font: { weight: 'bold' }
            }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#64748b' },
            title: {
              display: true,
              text: 'Work Amount (m)',
              color: '#334155',
              font: { weight: 'bold' }
            }
          }
        }
      }
    })

    // Small delay to ensure render if needed, though animation: false should make it sync
    await new Promise(r => setTimeout(r, 100))

    const chartImage = chart.toBase64Image('image/png', 1)
    chart.destroy()

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Daily Log')
    sheet.columns = [
      { header: 'Date', key: 'date', width: 16 },
      { header: 'Work Amount (m)', key: 'work_amount', width: 20 },
      { header: 'Number of Workers', key: 'workers', width: 20 },
      { header: 'Subcontractor', key: 'subcontractor', width: 22 }
    ]
    
    // Map rows to match column keys
    const sheetRows = rows.map(r => ({
      date: r.date,
      work_amount: r.work_amount.toFixed(2),
      workers: r.workers,
      subcontractor: r.subcontractor
    }))
    sheetRows.forEach(row => sheet.addRow(row))

    const chartSheet = workbook.addWorksheet('Chart')
    const imageId = workbook.addImage({
      base64: chartImage,
      extension: 'png'
    })
    chartSheet.addImage(imageId, {
      tl: { col: 1, row: 1 },
      ext: { width: 640, height: 360 }
    })

    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: MIME_XLSX })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `daily-progress-${new Date().toISOString().slice(0, 10)}.xlsx`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [])

  return { exportToExcel }
}
