'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from 'recharts'

// ── Típusok ───────────────────────────────────────────────────────────────────

interface Fund {
  id: string
  name: string
  fund_manager: string
  category: string
  risk_return_indicator: number
  std_dev_1y: number
  std_dev_5y: number
  inception_date: string
}

interface PriceRow {
  date: string
  nav_price: number
  return_1y: number
  return_3y: number
  return_5y: number
}

interface ChartPoint {
  date: string
  [fundName: string]: string | number
}

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4']

// ── Segédfüggvények ───────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('hu-HU', {
    year: 'numeric', month: 'short'
  })
}

function riskLabel(val: number) {
  const labels: Record<number, string> = {
    1: 'Nagyon alacsony', 2: 'Alacsony', 3: 'Közepes-alacsony',
    4: 'Közepes', 5: 'Közepes-magas', 6: 'Magas', 7: 'Nagyon magas'
  }
  return labels[val] ?? val
}

// ── Fő komponens ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [funds, setFunds] = useState<Fund[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [prices, setPrices] = useState<Record<string, PriceRow[]>>({})
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [period, setPeriod] = useState<'1y' | '3y' | '5y' | 'all'>('3y')
  const [metric, setMetric] = useState<'nav_price' | 'return_1y' | 'return_3y' | 'return_5y'>('nav_price')
  const [loading, setLoading] = useState(true)

  // Alapok betöltése
  useEffect(() => {
    supabase
      .from('funds')
      .select('id, name, fund_manager, category, risk_return_indicator, std_dev_1y, std_dev_5y, inception_date')
      .order('name')
      .then(({ data }) => {
        if (data) {
          setFunds(data)
          setSelectedIds(data.slice(0, 2).map(f => f.id))
        }
        setLoading(false)
      })
  }, [])

  // Árfolyam adatok betöltése kiválasztott alapokhoz
  useEffect(() => {
    if (selectedIds.length === 0) return

    const fromDate = {
      '1y': new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      '3y': new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000),
      '5y': new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000),
      'all': new Date('2000-01-01'),
    }[period].toISOString().split('T')[0]

    selectedIds.forEach(async (id) => {
      if (prices[id]) return // már betöltve
      const { data } = await supabase
        .from('fund_prices')
        .select('date, nav_price, return_1y, return_3y, return_5y')
        .eq('fund_id', id)
        .gte('date', fromDate)
        .order('date', { ascending: true })

      if (data) {
        setPrices(prev => ({ ...prev, [id]: data }))
      }
    })
  }, [selectedIds, period])

  // Grafikon adatok összeállítása
  useEffect(() => {
    if (selectedIds.length === 0) return

    const fromDate = {
      '1y': new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      '3y': new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000),
      '5y': new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000),
      'all': new Date('2000-01-01'),
    }[period].toISOString().split('T')[0]

    // Gyűjtsük össze az összes dátumot
    const dateMap: Record<string, ChartPoint> = {}

    selectedIds.forEach((id) => {
      const fund = funds.find(f => f.id === id)
      if (!fund || !prices[id]) return
      const shortName = fund.name.split(' ').slice(0, 3).join(' ')

      prices[id]
        .filter(p => p.date >= fromDate)
        .forEach(p => {
          if (!dateMap[p.date]) dateMap[p.date] = { date: p.date }
          const val = p[metric]
          dateMap[p.date][shortName] = val != null ? Number(val) : undefined as any
        })
    })

    const sorted = Object.values(dateMap).sort((a, b) =>
      a.date.localeCompare(b.date)
    )
    setChartData(sorted)
  }, [prices, selectedIds, period, metric, funds])

  // Időszak váltáskor töröljük a cache-t
  const handlePeriodChange = (p: typeof period) => {
    setPrices({})
    setPeriod(p)
  }

  const toggleFund = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const selectedFunds = funds.filter(f => selectedIds.includes(f.id))

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-lg animate-pulse">Adatok betöltése...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">

      {/* Fejléc */}
      <header className="border-b border-slate-800 px-8 py-5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Alap Elemző
            </h1>
            <p className="text-slate-400 text-sm mt-0.5">
              Befektetési alap teljesítmény dashboard
            </p>
          </div>
          <div className="text-slate-500 text-sm">
            {funds.length} alap • {Object.values(prices).reduce((s, p) => s + p.length, 0).toLocaleString()} adatsor
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 py-8 space-y-8">

        {/* Alapok választó */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
            Alapok kiválasztása
          </h2>
          <div className="flex flex-wrap gap-2">
            {funds.map((fund, i) => {
              const selected = selectedIds.includes(fund.id)
              const color = COLORS[funds.indexOf(fund) % COLORS.length]
              return (
                <button
                  key={fund.id}
                  onClick={() => toggleFund(fund.id)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                    selected
                      ? 'border-transparent text-white'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500 bg-slate-900'
                  }`}
                  style={selected ? { backgroundColor: color, borderColor: color } : {}}
                >
                  {fund.name.split(' ').slice(0, 4).join(' ')}
                </button>
              )
            })}
          </div>
        </section>

        {/* KPI kártyák */}
        {selectedFunds.length > 0 && (
          <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {selectedFunds.map((fund, i) => {
              const color = COLORS[funds.indexOf(fund) % COLORS.length]
              const latest = prices[fund.id]?.[prices[fund.id].length - 1]
              return (
                <div
                  key={fund.id}
                  className="bg-slate-900 rounded-xl p-5 border border-slate-800"
                  style={{ borderLeftColor: color, borderLeftWidth: 3 }}
                >
                  <div className="text-xs text-slate-500 mb-1">{fund.fund_manager}</div>
                  <div className="font-semibold text-sm text-white leading-snug mb-3">
                    {fund.name.split(' ').slice(0, 5).join(' ')}
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-400">NAV árfolyam</span>
                      <span className="font-mono text-white">
                        {latest?.nav_price?.toFixed(4) ?? '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">1 éves hozam</span>
                      <span className={`font-mono ${(latest?.return_1y ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {latest?.return_1y != null ? `${latest.return_1y.toFixed(2)}%` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Kockázat</span>
                      <span className="text-slate-300">{riskLabel(fund.risk_return_indicator)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">1é szórás</span>
                      <span className="font-mono text-slate-300">{fund.std_dev_1y?.toFixed(2)}%</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {/* Grafikon */}
        <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <h2 className="font-semibold text-white">Teljesítmény grafikon</h2>

            <div className="flex gap-4 flex-wrap">
              {/* Mutató választó */}
              <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
                {([
                  ['nav_price', 'NAV árfolyam'],
                  ['return_1y', '1 éves hozam'],
                  ['return_3y', '3 éves hozam'],
                  ['return_5y', '5 éves hozam'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setMetric(key)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      metric === key
                        ? 'bg-slate-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Időszak választó */}
              <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
                {(['1y', '3y', '5y', 'all'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => handlePeriodChange(p)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      period === p
                        ? 'bg-slate-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p === 'all' ? 'Max' : p.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#1e293b' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v =>
                    metric === 'nav_price' ? v.toFixed(2) : `${v.toFixed(1)}%`
                  }
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #1e293b',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: '#94a3b8', marginBottom: 4 }}
                  labelFormatter={(label: any) => formatDate(String(label))}

                  formatter={(value: any, name: any) => [
  value != null ? (metric === 'nav_price' ? Number(value).toFixed(4) : `${Number(value).toFixed(2)}%`) : '—',
  name
]}
                />
                <Legend
                  wrapperStyle={{ fontSize: '12px', paddingTop: '16px' }}
                />
                {selectedFunds.map((fund, i) => {
                  const shortName = fund.name.split(' ').slice(0, 3).join(' ')
                  const color = COLORS[funds.indexOf(fund) % COLORS.length]
                  return (
                    <Line
                      key={fund.id}
                      type="monotone"
                      dataKey={shortName}
                      stroke={color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  )
                })}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-80 flex items-center justify-center text-slate-500">
              {selectedIds.length === 0
                ? 'Válassz ki legalább egy alapot a grafikonhoz'
                : 'Adatok betöltése...'}
            </div>
          )}
        </section>

      </main>
    </div>
  )
}
