'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceArea } from 'recharts'

// ── Típusok ───────────────────────────────────────────────────────────────────

interface Fund { id: string; name: string; fund_manager: string; risk_return_indicator: number; std_dev_1y: number; std_dev_5y: number }
interface PriceRow { date: string; nav_price: number; return_1y: number | null; return_3y: number | null; return_5y: number | null }
interface BenchmarkRow { date: string; close: number }

interface DataSeries {
  id: string; name: string; shortName: string; color: string
  points: { date: string; value: number }[]
  isBenchmark: boolean
}

interface DrawPeriod {
  id: string; seriesId: string; seriesShortName: string; seriesColor: string
  type: 'drawdown' | 'drawup'; rank: number
  start: string; end: string; magnitude: number
}

interface PeriodSeriesMetrics {
  seriesId: string; seriesName: string; seriesColor: string; isBenchmark: boolean
  totalReturn: number | null; stdDev: number | null
  sharpe: number | null; alpha: number | null; beta: number | null
  score: number | null
}

type Period = '1y' | '3y' | '5y' | 'all'
type MainMetric = 'nav_price' | 'return_1y' | 'return_3y' | 'return_5y'

const FUND_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6']
const BM_ID = '__benchmark__'
const BM_COLOR = '#94a3b8'
const RISK_FREE = 6 // éves %, HUF

const EXPLAIN: Record<string, string> = {
  alpha: 'Az alap piaci teljesítményen felüli hozama. Pozitív alfa: az alapkezelő értéket teremtett a benchmarkhoz képest. Negatív alfa: az alap alulteljesítette a piacot.',
  beta: 'Az alap érzékenysége a piaci mozgásokra. Béta=1: együtt mozog a piaccal. Béta>1: felerősíti a piaci mozgásokat (kockázatosabb). Béta<1: tompítja azokat (stabilabb).',
  sharpe: 'A kockázattal korrigált hozam mutatója. Megmutatja, hogy egységnyi kockázatért mekkora hozamot kaptál. Minél magasabb, annál jobb az alap kockázat/hozam aránya.',
  stdDev: 'Az árfolyam ingadozásának mértéke az adott időszakban. Magas szórás = nagy kilengések = magasabb kockázat.',
  totalReturn: 'Az időszak alatt elért teljes hozam az adott periódusban (nyitó → záró árfolyam alapján).',
  score: 'Min-max normalizált összesített pontszám 0-100 között. Sharpe 35%, Alfa 30%, Béta 20%, Szórás 15%. A legjobb érték minden mutatóban 100-at, a legrosszabb 0-t kap.',
  drawdown: 'A három legnagyobb visszaesés: csúcsértékről mekkora mélységbe esett az árfolyam és mikor.',
  drawup: 'A három legnagyobb emelkedés: mélypontról mekkora magasságba emelkedett az árfolyam és mikor.',
}

// ── Segédfüggvények ───────────────────────────────────────────────────────────

const fmt = (d: string) => new Date(d).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short' })
const fmtPct = (v: number | null, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
const fmtNum = (v: number | null, d = 3) => v == null ? '—' : v.toFixed(d)

function periodStart(p: Period): string {
  const days = { '1y': 365, '3y': 1095, '5y': 1825, 'all': 9999 }[p]
  const d = new Date(); d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

// Legközelebbi benchmark dátum keresése ±3 nap toleranciával
function buildBmLookup(bm: BenchmarkRow[]): Map<string, number> {
  return new Map(bm.map(b => [b.date, b.close]))
}

function nearestBmValue(map: Map<string, number>, date: string): number | null {
  if (map.has(date)) return map.get(date)!
  for (let d = 1; d <= 3; d++) {
    const before = new Date(date); before.setDate(before.getDate() - d)
    const after = new Date(date); after.setDate(after.getDate() + d)
    const k1 = before.toISOString().split('T')[0]
    const k2 = after.toISOString().split('T')[0]
    if (map.has(k1)) return map.get(k1)!
    if (map.has(k2)) return map.get(k2)!
  }
  return null
}

// ── Drawdown/Drawup detektálás ────────────────────────────────────────────────

function detectDrawPeriods(points: { date: string; value: number }[], findUp: boolean): DrawPeriod['start'] extends string ? { start: string; end: string; magnitude: number }[] : never[] {
  const results: { start: string; end: string; magnitude: number }[] = []
  if (points.length < 5) return results as any

  let peakIdx = 0
  let i = 1

  while (i < points.length) {
    const isNewPeak = findUp ? points[i].value < points[peakIdx].value : points[i].value > points[peakIdx].value
    if (isNewPeak) { peakIdx = i; i++; continue }

    let troughIdx = i
    while (i + 1 < points.length) {
      const continues = findUp ? points[i + 1].value > points[troughIdx].value : points[i + 1].value < points[troughIdx].value
      if (!continues) break
      i++; troughIdx = i
    }

    const peak = points[peakIdx].value
    const trough = points[troughIdx].value
    if (peak !== 0) {
      const mag = Math.abs((trough - peak) / peak) * 100
      if (mag > 0.5) {
        results.push({
          start: findUp ? points[troughIdx].date : points[peakIdx].date,
          end: findUp ? points[peakIdx].date : points[troughIdx].date,
          magnitude: mag,
        })
      }
    }
    peakIdx = troughIdx
    i = troughIdx + 1
  }

  return (results.sort((a, b) => b.magnitude - a.magnitude).slice(0, 3)) as any
}

// ── Metrikák kiszámítása egy időszakra ───────────────────────────────────────

function computePeriodMetrics(
  series: DataSeries,
  start: string, end: string,
  bmMap: Map<string, number>,
  allSeries: DataSeries[]
): PeriodSeriesMetrics {
  const pts = series.points.filter(p => p.date >= start && p.date <= end)
  const base: PeriodSeriesMetrics = {
    seriesId: series.id, seriesName: series.name, seriesColor: series.color,
    isBenchmark: series.isBenchmark,
    totalReturn: null, stdDev: null, sharpe: null, alpha: null, beta: null, score: null,
  }
  if (pts.length < 3) return base

  // Teljes hozam
  const totalReturn = ((pts[pts.length - 1].value - pts[0].value) / pts[0].value) * 100

  // Napi hozamok
  const dailyR: number[] = []
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].value) dailyR.push((pts[i].value - pts[i - 1].value) / pts[i - 1].value)
  }
  if (dailyR.length < 2) return { ...base, totalReturn }

  const mean = dailyR.reduce((s, r) => s + r, 0) / dailyR.length
  const variance = dailyR.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyR.length
  const stdDev = Math.sqrt(variance * 252) * 100
  const annualRetPct = mean * 252 * 100
  const sharpe = stdDev > 0 ? (annualRetPct - RISK_FREE) / stdDev : null

  // Alfa és Béta (csak nem-benchmark adatsoroknál, és ha van elég overlap)
  let alpha: number | null = null
  let beta: number | null = null

  if (!series.isBenchmark) {
    const paired: { f: number; b: number }[] = []
    for (let i = 1; i < pts.length; i++) {
      const bm0 = nearestBmValue(bmMap, pts[i - 1].date)
      const bm1 = nearestBmValue(bmMap, pts[i].date)
      if (bm0 && bm1 && pts[i - 1].value) {
        paired.push({ f: (pts[i].value - pts[i - 1].value) / pts[i - 1].value, b: (bm1 - bm0) / bm0 })
      }
    }
    if (paired.length >= 5) {
      const n = paired.length
      const bmMean = paired.reduce((s, p) => s + p.b, 0) / n
      const fMean = paired.reduce((s, p) => s + p.f, 0) / n
      const cov = paired.reduce((s, p) => s + (p.b - bmMean) * (p.f - fMean), 0) / n
      const bmVar = paired.reduce((s, p) => s + (p.b - bmMean) ** 2, 0) / n
      if (bmVar > 0) {
        beta = cov / bmVar
        alpha = ((fMean - beta * bmMean) * 252) * 100
      }
    }
  }

  return { ...base, totalReturn, stdDev, sharpe, alpha, beta }
}

// ── Min-max normalizáció és scoring ──────────────────────────────────────────

function minMaxScore(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
  const valid = values.filter((v): v is number => v != null)
  if (valid.length < 2) return values.map(v => v == null ? null : 50)
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  if (max === min) return values.map(v => v == null ? null : 50)
  return values.map(v => {
    if (v == null) return null
    const norm = (v - min) / (max - min)
    return Math.round((higherIsBetter ? norm : 1 - norm) * 100)
  })
}

function scorePeriodMetrics(allMetrics: PeriodSeriesMetrics[]): PeriodSeriesMetrics[] {
  const sharpeScores = minMaxScore(allMetrics.map(m => m.sharpe), true)
  const alphaScores = minMaxScore(allMetrics.map(m => m.alpha), true)
  const betaScores = minMaxScore(allMetrics.map(m => m.beta), false)
  const stdScores = minMaxScore(allMetrics.map(m => m.stdDev), false)

  return allMetrics.map((m, i) => {
    const s = sharpeScores[i], a = alphaScores[i], b = betaScores[i], sd = stdScores[i]
    let score: number | null = null
    if (s != null || a != null) {
      const parts: number[] = []
      const weights: number[] = []
      if (s != null) { parts.push(s * 0.35); weights.push(0.35) }
      if (a != null) { parts.push(a * 0.30); weights.push(0.30) }
      if (b != null) { parts.push(b * 0.20); weights.push(0.20) }
      if (sd != null) { parts.push(sd * 0.15); weights.push(0.15) }
      const totalWeight = weights.reduce((s, w) => s + w, 0)
      score = totalWeight > 0 ? Math.round(parts.reduce((s, p) => s + p, 0) / totalWeight) : null
    }
    return { ...m, score }
  })
}

// ── UI komponensek ────────────────────────────────────────────────────────────

function ExplainRow({ label, explanation, children }: { label: string; explanation: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  return (
    <tr className="relative hover:bg-slate-800/40 transition-colors cursor-default"
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <td className="py-3 pr-8 text-slate-400 font-medium select-none">
        {label}
        {show && (
          <div className="absolute left-0 top-full z-50 mt-1 w-80 bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs text-slate-300 leading-relaxed shadow-xl pointer-events-none">
            {explanation}
          </div>
        )}
      </td>
      {children}
    </tr>
  )
}

function ScoreBar({ score, color }: { score: number | null; color: string }) {
  if (score == null) return <span className="text-slate-500 font-mono text-sm">—</span>
  const label = score >= 70 ? 'Kiváló' : score >= 45 ? 'Közepes' : 'Gyenge'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-slate-800 rounded-full h-2 min-w-16">
        <div className="h-2 rounded-full" style={{ width: `${score}%`, backgroundColor: color }} />
      </div>
      <span className="font-mono font-bold text-white text-sm w-7 text-right">{score}</span>
      <span className="text-slate-500 text-xs w-12">{label}</span>
    </div>
  )
}

function MetricCell({ value, format }: { value: number | null; format: 'pct' | 'num' | 'score' }) {
  if (value == null) return <td className="py-3 px-4 text-right font-mono text-slate-500">—</td>
  const color = format === 'score'
    ? value >= 60 ? 'text-emerald-400' : value >= 35 ? 'text-yellow-400' : 'text-red-400'
    : value >= 0 ? 'text-emerald-400' : 'text-red-400'
  const text = format === 'pct' ? fmtPct(value) : format === 'num' ? fmtNum(value) : String(value)
  return <td className={`py-3 px-4 text-right font-mono font-medium ${color}`}>{text}</td>
}

// ── Mini grafikon egy periódushoz ─────────────────────────────────────────────

function MiniChart({ allSeries, start, end }: { allSeries: DataSeries[]; start: string; end: string }) {
  const data = useMemo(() => {
    const map: Record<string, Record<string, number>> = {}
    allSeries.forEach(s => {
      s.points.filter(p => p.date >= start && p.date <= end).forEach(p => {
        if (!map[p.date]) map[p.date] = {}
        map[p.date][s.shortName] = p.value
      })
    })
    // Normalizálás: minden sor az időszak elejéhez képest % változás
    const sorted = Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
    if (sorted.length === 0) return []
    const bases: Record<string, number> = {}
    sorted.forEach(([, vals]) => {
      allSeries.forEach(s => {
        if (!(s.shortName in bases) && vals[s.shortName] != null) bases[s.shortName] = vals[s.shortName]
      })
    })
    return sorted.map(([date, vals]) => {
      const row: Record<string, any> = { date }
      allSeries.forEach(s => {
        if (vals[s.shortName] != null && bases[s.shortName]) {
          row[s.shortName] = ((vals[s.shortName] - bases[s.shortName]) / bases[s.shortName]) * 100
        }
      })
      return row
    })
  }, [allSeries, start, end])

  if (data.length < 2) return <div className="h-32 flex items-center justify-center text-slate-600 text-xs">Nincs elég adat</div>

  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="date" tickFormatter={(d: any) => fmt(String(d))} tick={{ fill: '#475569', fontSize: 9 }}
          tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} axisLine={false}
          tickFormatter={(v: any) => `${Number(v).toFixed(1)}%`} width={40} />
        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '6px', fontSize: '11px' }}
          labelFormatter={(l: any) => fmt(String(l))}
          formatter={(v: any, n: any) => [`${Number(v).toFixed(2)}%`, n]} />
        {allSeries.map(s => (
          <Line key={s.id} type="monotone" dataKey={s.shortName} stroke={s.color}
            strokeWidth={1.5} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Periódus részletező panel ─────────────────────────────────────────────────

function PeriodDetail({ period, allSeries, bmMap }: {
  period: DrawPeriod; allSeries: DataSeries[]; bmMap: Map<string, number>
}) {
  const rawMetrics = useMemo(() =>
    allSeries.map(s => computePeriodMetrics(s, period.start, period.end, bmMap, allSeries)),
    [period, allSeries, bmMap]
  )
  const metrics = useMemo(() => scorePeriodMetrics(rawMetrics), [rawMetrics])

  return (
    <div className="space-y-4">
      {/* Mini grafikon */}
      <div className="bg-slate-800/50 rounded-lg p-3">
        <div className="text-xs text-slate-500 mb-2">
          Normalizált hozam: {fmt(period.start)} → {fmt(period.end)}
          {period.magnitude > 0 && (
            <span className={`ml-2 font-mono ${period.type === 'drawdown' ? 'text-red-400' : 'text-emerald-400'}`}>
              {period.type === 'drawdown' ? '-' : '+'}{period.magnitude.toFixed(1)}%
            </span>
          )}
        </div>
        <MiniChart allSeries={allSeries} start={period.start} end={period.end} />
      </div>

      {/* Metrikák tábla */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700">
              <th className="text-left py-2 pr-4 text-slate-500 font-medium">Mutató</th>
              {metrics.map(m => (
                <th key={m.seriesId} className="text-right py-2 px-3 font-medium" style={{ color: m.seriesColor }}>
                  {m.seriesName.split(' ').slice(0, 2).join(' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            <tr className="hover:bg-slate-800/30">
              <td className="py-2 pr-4 text-slate-400">Teljes hozam</td>
              {metrics.map(m => <MetricCell key={m.seriesId} value={m.totalReturn} format="pct" />)}
            </tr>
            <tr className="hover:bg-slate-800/30">
              <td className="py-2 pr-4 text-slate-400">Szórás (ann.)</td>
              {metrics.map(m => <MetricCell key={m.seriesId} value={m.stdDev} format="pct" />)}
            </tr>
            <tr className="hover:bg-slate-800/30">
              <td className="py-2 pr-4 text-slate-400">Sharpe-ráta</td>
              {metrics.map(m => <MetricCell key={m.seriesId} value={m.sharpe} format="num" />)}
            </tr>
            <tr className="hover:bg-slate-800/30">
              <td className="py-2 pr-4 text-slate-400">
                Alfa {metrics.some(m => m.isBenchmark) && <span className="text-slate-600 text-xs">(alap)</span>}
              </td>
              {metrics.map(m => m.isBenchmark
                ? <td key={m.seriesId} className="py-2 px-3 text-right text-slate-600 font-mono text-xs">—</td>
                : <MetricCell key={m.seriesId} value={m.alpha} format="pct" />
              )}
            </tr>
            <tr className="hover:bg-slate-800/30">
              <td className="py-2 pr-4 text-slate-400">Béta</td>
              {metrics.map(m => m.isBenchmark
                ? <td key={m.seriesId} className="py-2 px-3 text-right text-slate-600 font-mono text-xs">—</td>
                : <MetricCell key={m.seriesId} value={m.beta} format="num" />
              )}
            </tr>
            <tr className="border-t-2 border-slate-600">
              <td className="py-3 pr-4 text-slate-300 font-semibold">Score</td>
              {metrics.map(m => (
                <td key={m.seriesId} className="py-3 px-3">
                  <ScoreBar score={m.score} color={m.seriesColor} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-600">* Rövid időszakon mért alfa/béta kevésbé megbízható statisztikailag.</p>
    </div>
  )
}

// ── Összefoglaló tábla ────────────────────────────────────────────────────────

function SummaryTable({ allPeriods, allSeries, bmMap }: {
  allPeriods: DrawPeriod[]; allSeries: DataSeries[]; bmMap: Map<string, number>
}) {
  const summary = useMemo(() => {
    // Minden periódusra kiszámoljuk és score-oljuk
    const periodScores: Record<string, number[]> = {}
    allSeries.forEach(s => { periodScores[s.id] = [] })

    allPeriods.forEach(period => {
      const raw = allSeries.map(s => computePeriodMetrics(s, period.start, period.end, bmMap, allSeries))
      const scored = scorePeriodMetrics(raw)
      scored.forEach(m => {
        if (m.score != null) periodScores[m.seriesId].push(m.score)
      })
    })

    return allSeries.map(s => ({
      series: s,
      scores: periodScores[s.id],
      avg: periodScores[s.id].length > 0
        ? Math.round(periodScores[s.id].reduce((a, b) => a + b, 0) / periodScores[s.id].length)
        : null,
      count: periodScores[s.id].length,
    })).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0))
  }, [allPeriods, allSeries, bmMap])

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
      <h2 className="font-semibold text-white mb-1">Összesített teljesítmény — mind a {allPeriods.length} időszak</h2>
      <p className="text-xs text-slate-500 mb-5">
        Az összes drawdown és drawup időszak átlagolt score-ja alapján rangsorolva
      </p>
      <div className="space-y-4">
        {summary.map((item, rank) => (
          <div key={item.series.id} className="flex items-center gap-4">
            <div className="text-slate-600 font-mono text-sm w-4">{rank + 1}.</div>
            <div className="w-40 text-sm font-medium truncate" style={{ color: item.series.color }}>
              {item.series.shortName}
            </div>
            <div className="flex-1">
              <ScoreBar score={item.avg} color={item.series.color} />
            </div>
            <div className="text-slate-600 text-xs w-24 text-right">
              {item.count} időszak átlaga
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Fő Dashboard ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [funds, setFunds] = useState<Fund[]>([])
  const [selectedFundIds, setSelectedFundIds] = useState<string[]>([])
  const [showBenchmark, setShowBenchmark] = useState(true)
  const [prices, setPrices] = useState<Record<string, PriceRow[]>>({})
  const [benchmark, setBenchmark] = useState<BenchmarkRow[]>([])
  const [period, setPeriod] = useState<Period>('3y')
  const [metric, setMetric] = useState<MainMetric>('nav_price')
  const [loading, setLoading] = useState(true)
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('funds').select('id,name,fund_manager,risk_return_indicator,std_dev_1y,std_dev_5y').order('name')
      .then(({ data }) => {
        if (data) { setFunds(data); setSelectedFundIds(data.slice(0, 2).map(f => f.id)) }
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    supabase.from('benchmark_prices').select('date,close').order('date', { ascending: true })
      .then(({ data }) => { if (data) setBenchmark(data) })
  }, [])

  useEffect(() => {
    if (selectedFundIds.length === 0) return
    const from = periodStart(period)
    selectedFundIds.forEach(async id => {
      const { data } = await supabase.from('fund_prices')
        .select('date,nav_price,return_1y,return_3y,return_5y')
        .eq('fund_id', id).gte('date', from).order('date', { ascending: true })
      if (data) setPrices(prev => ({ ...prev, [id]: data }))
    })
  }, [selectedFundIds, period])

  const bmMap = useMemo(() => buildBmLookup(benchmark), [benchmark])

  const fundColors = useMemo(() => {
    const map: Record<string, string> = {}
    funds.forEach((f, i) => { map[f.id] = FUND_COLORS[i % FUND_COLORS.length] })
    return map
  }, [funds])

  // Unified DataSeries lista (alapok + benchmark)
  const allSeries: DataSeries[] = useMemo(() => {
    const from = periodStart(period)
    const result: DataSeries[] = selectedFundIds
      .map(id => {
        const fund = funds.find(f => f.id === id)
        if (!fund || !prices[id]) return null
        return {
          id, name: fund.name, isBenchmark: false,
          shortName: fund.name.split(' ').slice(0, 3).join(' '),
          color: fundColors[id],
          points: prices[id].map(p => ({ date: p.date, value: p.nav_price })),
        } as DataSeries
      })
      .filter((s): s is DataSeries => s != null)

    if (showBenchmark && benchmark.length > 0) {
      result.push({
        id: BM_ID, name: 'HK All Stocks (Benchmark)', shortName: 'HK Index',
        color: BM_COLOR, isBenchmark: true,
        points: benchmark.filter(b => b.date >= from).map(b => ({ date: b.date, value: b.close })),
      })
    }
    return result
  }, [selectedFundIds, funds, prices, benchmark, showBenchmark, period, fundColors])

  // Grafikon adatok
  const chartData = useMemo(() => {
    const map: Record<string, Record<string, number>> = {}
    allSeries.forEach(s => {
      s.points.forEach(p => {
        if (!map[p.date]) map[p.date] = {}
        const val = s.isBenchmark ? p.value : (prices[s.id]?.find(r => r.date === p.date)?.[metric] ?? p.value)
        if (val != null) map[p.date][s.shortName] = Number(val)
      })
    })
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([date, vals]) => ({ date, ...vals }))
  }, [allSeries, metric, prices])

  // Összes drawdown/drawup periódus
  const allDrawPeriods: DrawPeriod[] = useMemo(() => {
    const result: DrawPeriod[] = []
    allSeries.forEach(s => {
      ;(['drawdown', 'drawup'] as const).forEach(type => {
        const events = detectDrawPeriods(s.points, type === 'drawup')
        events.forEach((e: any, i: number) => {
          result.push({
            id: `${s.id}-${type}-${i + 1}`,
            seriesId: s.id, seriesShortName: s.shortName, seriesColor: s.color,
            type, rank: i + 1,
            start: e.start, end: e.end, magnitude: e.magnitude,
          })
        })
      })
    })
    return result
  }, [allSeries])

  const selectedPeriod = allDrawPeriods.find(p => p.id === selectedPeriodId) ?? allDrawPeriods[0] ?? null

  // Fő metrikák (teljes időszakra)
  const mainMetrics = useMemo(() => {
    const raw = allSeries.map(s => computePeriodMetrics(s, periodStart(period), '2099-12-31', bmMap, allSeries))
    return scorePeriodMetrics(raw)
  }, [allSeries, period, bmMap])

  const toggleFund = (id: string) => {
    setPrices({})
    setSelectedFundIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }
  const handlePeriod = (p: Period) => { setPrices({}); setPeriod(p) }

  if (loading) return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-slate-400 animate-pulse">Adatok betöltése...</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">

      {/* Fejléc */}
      <header className="border-b border-slate-800 px-8 py-5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Alap Elemző</h1>
            <p className="text-slate-400 text-sm mt-0.5">Befektetési alap teljesítmény dashboard</p>
          </div>
          <div className="text-right text-sm text-slate-500">
            <div>{funds.length} alap</div>
            <div className="text-xs mt-0.5">Benchmark: Stooq HK All Stocks</div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 py-8 space-y-8">

        {/* Vezérlők */}
        <div className="flex flex-wrap gap-6 items-start">
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Időszak</div>
            <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5">
              {(['1y','3y','5y','all'] as Period[]).map(p => (
                <button key={p} onClick={() => handlePeriod(p)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${period === p ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {p === 'all' ? 'Max' : p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1">
            <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Adatsorok</div>
            <div className="flex flex-wrap gap-2">
              {funds.map(fund => {
                const sel = selectedFundIds.includes(fund.id)
                const color = fundColors[fund.id]
                return (
                  <button key={fund.id} onClick={() => toggleFund(fund.id)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${sel ? 'border-transparent text-white' : 'border-slate-700 text-slate-400 hover:border-slate-500 bg-slate-900'}`}
                    style={sel ? { backgroundColor: color } : {}}>
                    {fund.name.split(' ').slice(0, 4).join(' ')}
                  </button>
                )
              })}
              <button onClick={() => setShowBenchmark(p => !p)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${showBenchmark ? 'border-transparent text-white' : 'border-slate-700 text-slate-400 hover:border-slate-500 bg-slate-900'}`}
                style={showBenchmark ? { backgroundColor: BM_COLOR } : {}}>
                HK Index (Benchmark)
              </button>
            </div>
          </div>
        </div>

        {/* Grafikon */}
        <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <h2 className="font-semibold text-white">Teljesítmény grafikon</h2>
            <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
              {([['nav_price','NAV'], ['return_1y','1é hozam'], ['return_3y','3é hozam'], ['return_5y','5é hozam']] as const).map(([k, l]) => (
                <button key={k} onClick={() => setMetric(k)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${metric === k ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tickFormatter={(d: any) => fmt(String(d))}
                  tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false}
                  axisLine={{ stroke: '#1e293b' }} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false}
                  tickFormatter={(v: any) => metric === 'nav_price' ? Number(v).toFixed(1) : `${Number(v).toFixed(0)}%`} />
                <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '12px' }}
                  labelStyle={{ color: '#94a3b8', marginBottom: 4 }}
                  labelFormatter={(l: any) => fmt(String(l))}
                  formatter={(v: any, n: any) => [
                    v != null ? (metric === 'nav_price' ? Number(v).toFixed(4) : `${Number(v).toFixed(2)}%`) : '—', n
                  ]} />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '16px' }} />
                {allSeries.map(s => (
                  <Line key={s.id} type="monotone" dataKey={s.shortName}
                    stroke={s.color} strokeWidth={s.isBenchmark ? 1.5 : 2}
                    strokeDasharray={s.isBenchmark ? '4 2' : undefined}
                    dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-72 flex items-center justify-center text-slate-500">Válassz ki legalább egy adatsort</div>
          )}
        </section>

        {/* Kockázat-hozam elemzés */}
        {allSeries.length > 0 && (
          <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
            <h2 className="font-semibold text-white mb-1">Kockázat-hozam elemzés</h2>
            <p className="text-xs text-slate-500 mb-5">Vigye az egérmutatót egy sor fölé a magyarázatért</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left py-3 pr-8 text-slate-500 font-medium w-44">Mutató</th>
                    {mainMetrics.map(m => (
                      <th key={m.seriesId} className="text-right py-3 px-4 font-medium" style={{ color: m.seriesColor }}>
                        {m.seriesName.split(' ').slice(0, 3).join(' ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <ExplainRow label="Alfa" explanation={EXPLAIN.alpha}>
                    {mainMetrics.map(m => m.isBenchmark
                      ? <td key={m.seriesId} className="py-3 px-4 text-right font-mono text-slate-600">—</td>
                      : <td key={m.seriesId} className={`py-3 px-4 text-right font-mono font-medium ${m.alpha == null ? 'text-slate-500' : m.alpha >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmtPct(m.alpha)}
                        </td>
                    )}
                  </ExplainRow>
                  <ExplainRow label="Béta" explanation={EXPLAIN.beta}>
                    {mainMetrics.map(m => m.isBenchmark
                      ? <td key={m.seriesId} className="py-3 px-4 text-right font-mono text-slate-600">—</td>
                      : <td key={m.seriesId} className={`py-3 px-4 text-right font-mono ${m.beta == null ? 'text-slate-500' : Math.abs((m.beta ?? 1) - 1) < 0.2 ? 'text-yellow-400' : (m.beta ?? 1) < 1 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmtNum(m.beta)}
                        </td>
                    )}
                  </ExplainRow>
                  <ExplainRow label="Sharpe-ráta" explanation={EXPLAIN.sharpe}>
                    {mainMetrics.map(m => (
                      <td key={m.seriesId} className={`py-3 px-4 text-right font-mono ${m.sharpe == null ? 'text-slate-500' : (m.sharpe ?? 0) >= 1 ? 'text-emerald-400' : (m.sharpe ?? 0) >= 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {fmtNum(m.sharpe)}
                      </td>
                    ))}
                  </ExplainRow>
                  <ExplainRow label="Szórás" explanation={EXPLAIN.stdDev}>
                    {mainMetrics.map(m => (
                      <td key={m.seriesId} className={`py-3 px-4 text-right font-mono ${m.stdDev == null ? 'text-slate-500' : (m.stdDev ?? 0) < 10 ? 'text-emerald-400' : (m.stdDev ?? 0) < 20 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {fmtPct(m.stdDev)}
                      </td>
                    ))}
                  </ExplainRow>
                  <ExplainRow label="Összesített score" explanation={EXPLAIN.score}>
                    {mainMetrics.map(m => (
                      <td key={m.seriesId} className="py-4 px-4">
                        <ScoreBar score={m.score} color={m.seriesColor} />
                      </td>
                    ))}
                  </ExplainRow>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Időszak elemző */}
        {allDrawPeriods.length > 0 && (
          <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
            <h2 className="font-semibold text-white mb-1">Időszak elemző</h2>
            <p className="text-xs text-slate-500 mb-5">
              {allDrawPeriods.length} időszak azonosítva — kattints egy időszakra az összehasonlításhoz
            </p>

            <div className="flex gap-6">
              {/* Bal panel: periódus lista */}
              <div className="w-64 shrink-0 space-y-4">
                {allSeries.map(s => {
                  const periods = allDrawPeriods.filter(p => p.seriesId === s.id)
                  return (
                    <div key={s.id}>
                      <div className="text-xs font-semibold mb-2 uppercase tracking-wide" style={{ color: s.color }}>
                        {s.shortName}
                      </div>
                      <div className="space-y-1">
                        {periods.map(p => {
                          const isSelected = p.id === (selectedPeriod?.id ?? allDrawPeriods[0]?.id)
                          return (
                            <button key={p.id} onClick={() => setSelectedPeriodId(p.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                                isSelected ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                              }`}>
                              <div className="flex items-center justify-between">
                                <span className={p.type === 'drawdown' ? 'text-red-400' : 'text-emerald-400'}>
                                  {p.type === 'drawdown' ? '↓' : '↑'} #{p.rank}
                                </span>
                                <span className={`font-mono ${p.type === 'drawdown' ? 'text-red-400' : 'text-emerald-400'}`}>
                                  {p.type === 'drawdown' ? '-' : '+'}{p.magnitude.toFixed(1)}%
                                </span>
                              </div>
                              <div className="text-slate-500 mt-0.5">
                                {fmt(p.start)} → {fmt(p.end)}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Jobb panel: periódus részletek */}
              <div className="flex-1 min-w-0">
                {selectedPeriod && (
                  <PeriodDetail period={selectedPeriod} allSeries={allSeries} bmMap={bmMap} />
                )}
              </div>
            </div>
          </section>
        )}

        {/* Összefoglaló tábla */}
        {allDrawPeriods.length > 0 && allSeries.length > 0 && (
          <SummaryTable allPeriods={allDrawPeriods} allSeries={allSeries} bmMap={bmMap} />
        )}

      </main>
    </div>
  )
}
