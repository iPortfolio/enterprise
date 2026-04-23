'use client'

import React, { useEffect, useState, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

// ── Típusok ───────────────────────────────────────────────────────────────────

interface Fund {
  id: string; name: string; fund_manager: string
  risk_return_indicator: number; std_dev_1y: number; std_dev_5y: number
  is_benchmark: boolean
}
interface PriceRow {
  date: string; nav_price: number
  return_1y: number | null; return_3y: number | null; return_5y: number | null
}
interface DataPoint { date: string; value: number }
interface DataSeries {
  id: string; name: string; shortName: string; color: string
  points: DataPoint[]; isBenchmark: boolean
}
interface DrawEvent { start: string; end: string; magnitude: number; durationDays: number }
interface DrawPeriod {
  id: string; seriesId: string; seriesShortName: string; seriesColor: string
  type: 'drawdown' | 'drawup'; rank: number
  start: string; end: string; magnitude: number; durationDays: number
}
interface MetricScores {
  totalReturn: number | null; stdDev: number | null; sharpe: number | null
  alpha: number | null; beta: number | null
}
interface PeriodSeriesMetrics {
  seriesId: string; seriesName: string; seriesColor: string; isBenchmark: boolean
  totalReturn: number | null; stdDev: number | null; sharpe: number | null
  alpha: number | null; beta: number | null
  indScores: MetricScores; totalScore: number | null
}

type Period = '1y' | '3y' | '5y' | 'all'
type MainMetric = 'pct' | 'return_1y' | 'return_3y' | 'return_5y'
type DateRangeMode = 'full' | 'common'
type HeatMetric = 'score' | 'totalReturn' | 'stdDev' | 'sharpe' | 'alpha' | 'beta'

// ── Konstansok ────────────────────────────────────────────────────────────────

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4']
const BM_COLOR = '#94a3b8'
const RISK_FREE = 6

const EXPLAIN: Record<string, string> = {
  alpha: 'Az alap piaci teljesítményen felüli hozama (annualizált). Pozitív: az alapkezelő értéket teremtett.',
  beta: 'Piaci érzékenység. Béta<1: stabilabb. Béta>1: felerősíti a mozgásokat.',
  sharpe: 'Kockázattal korrigált hozam. Minél magasabb, annál hatékonyabb az alap.',
  stdDev: 'Annualizált szórás. Alacsonyabb = stabilabb.',
  totalReturn: 'Az időszak teljes hozama a nyitóárfolyamhoz képest.',
  score: 'Min-max normalizált összpontszám 0–100. Sharpe 35%, Alfa 30%, Béta 20%, Szórás 15%.',
  drawdown: 'HWM: új csúcstól a következő új csúcsig tartó epizódon belüli maximális visszaesés.',
  drawup: 'LWM: új mélyponttól a következő új mélypontig tartó epizódon belüli maximális emelkedés.',
}

const INFO: Record<string, string> = {
  chart: 'Minden görbe az időszak elejéhez viszonyítja az árfolyamot százalékban. Ha egy vonal +30%-on jár, az alap 30%-ot emelkedett. A szaggatott vonal a benchmark (piaci referencia). A "Normalizált %" bázishoz viszonyít; az "1é/3é/5é hozam" rolling hozamot mutat – minden napra kiszámítja a megelőző időszak hozamát.',
  riskreturn: 'Az Alfa megmutatja, mennyit "termelt" az alapkezelő a piac mozgásán felül. A Béta a piaci érzékenység: 0,8-as béta esetén ha a piac 10%-ot esik, az alap ~8%-ot esik. A Sharpe-ráta az egységnyi kockázatra jutó hozamot méri – minél magasabb, annál hatékonyabb. A Szórás az árfolyam-ingadozás mértéke.',
  periods: 'Az elemző automatikusan megkeresi az egyes alapok legnagyobb esés- és emelkedés-epizódjait. Egy drawdown a legutóbbi csúcstól a következő csúcs eléréséig tart. Az évesített mérték megmutatja az esés/emelkedés sebességét. Kattints egy epizódra a részletes összehasonlításhoz.',
  summary: 'Minden azonosított epizódra kiszámítja az alapok score-ját, majd az összes epizód átlagát mutatja. Magasabb score = konzisztens teljesítmény piaci turbulencia idején.',
  heatmap: 'Negyedévenként mutatja a kiválasztott mutatót. Score módban: sor-szinten az alacsonyabb értékű alap kap piros, a magasabb zöld hátteret, az erősség a különbség mértékétől függ. Egyéb mutató esetén a benchmark az alap, az ettől való eltérés és annak iránya határozza meg a színt.',
}

const HEAT_LABELS: Record<HeatMetric, string> = {
  score: 'Score', totalReturn: 'Hozam', stdDev: 'Szórás', sharpe: 'Sharpe', alpha: 'Alfa', beta: 'Béta'
}
const HEAT_HIGHER_BETTER: Record<HeatMetric, boolean> = {
  score: true, totalReturn: true, stdDev: false, sharpe: true, alpha: true, beta: false
}
const ROLLING_DAYS: Record<MainMetric, number> = {
  pct: 0, return_1y: 365, return_3y: 1095, return_5y: 1825
}

// ── Segédfüggvények ───────────────────────────────────────────────────────────

const fmt = (d: string) => new Date(d).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' })
const fmtS = (d: string) => new Date(d).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short' })
const fmtPct = (v: number | null, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
const fmtNum = (v: number | null, d = 3) => v == null ? '—' : v.toFixed(d)

function daysBetween(a: string, b: string) {
  return Math.round(Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86400000)
}
function fmtDuration(days: number) {
  if (days < 30) return `${days} nap`
  if (days < 365) return `${Math.round(days / 30)} hó`
  const y = Math.floor(days / 365), m = Math.round((days % 365) / 30)
  return m > 0 ? `${y}é ${m}h` : `${y} év`
}
function periodStart(p: Period): string {
  const days = { '1y': 365, '3y': 1095, '5y': 1825, 'all': 9999 }[p]
  const d = new Date(); d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

function rollingReturnMap(points: DataPoint[], days: number): Map<string, number> {
  const byDate = new Map(points.map(p => [p.date, p.value]))
  const result = new Map<string, number>()
  for (const pt of points) {
    const past = new Date(pt.date)
    past.setDate(past.getDate() - days)
    let prev: number | undefined
    for (let d = 0; d <= 5 && !prev; d++) {
      const t1 = new Date(past); t1.setDate(t1.getDate() - d)
      prev = byDate.get(t1.toISOString().split('T')[0])
      if (!prev) { const t2 = new Date(past); t2.setDate(t2.getDate() + d + 1); prev = byDate.get(t2.toISOString().split('T')[0]) }
    }
    if (prev && prev > 0) result.set(pt.date, ((pt.value - prev) / prev) * 100)
  }
  return result
}

function getChartTicks(data: { date: string }[], period: Period): string[] {
  if (data.length < 2) return []
  const intervalMonths = { '1y': 1, '3y': 6, '5y': 12, 'all': 12 }[period]
  const dates = new Set(data.map(d => d.date))
  const end = new Date(data[data.length - 1].date)
  const cur = new Date(data[0].date); cur.setDate(1); cur.setMonth(cur.getMonth() + 1)
  const ticks: string[] = []
  while (cur <= end) {
    for (let d = 0; d <= 7; d++) {
      const t = new Date(cur); t.setDate(t.getDate() + d)
      const s = t.toISOString().split('T')[0]
      if (dates.has(s)) { ticks.push(s); break }
    }
    cur.setMonth(cur.getMonth() + intervalMonths)
  }
  return ticks
}

// Heatmap color helpers
function cellBg(direction: 'good' | 'bad' | 'neutral', intensity: number): string {
  const a = (Math.min(intensity, 1) * 0.55).toFixed(2)
  if (direction === 'good') return `rgba(16,185,129,${a})`
  if (direction === 'bad') return `rgba(239,68,68,${a})`
  return 'transparent'
}

function heatStyleScore(val: number, rowMetrics: PeriodSeriesMetrics[]): string {
  const vals = rowMetrics.filter(m => !m.isBenchmark).map(m => m.totalScore).filter((v): v is number => v != null)
  if (vals.length < 2) return 'transparent'
  const rMin = Math.min(...vals), rMax = Math.max(...vals), spread = rMax - rMin
  if (spread === 0) return 'transparent'
  const norm = (val - rMin) / spread
  const intensity = (norm - 0.5) * 2 * Math.min(spread / 100, 1)
  return cellBg(intensity > 0 ? 'good' : 'bad', Math.abs(intensity))
}

function heatStyleBm(val: number, bmVal: number, higher: boolean, maxDiff: number): string {
  const diff = higher ? (val - bmVal) : (bmVal - val)
  const intensity = maxDiff > 0 ? Math.abs(diff) / maxDiff : 0
  return cellBg(diff > 0 ? 'good' : 'bad', intensity)
}

function heatStyleClassic(val: number, globalMin: number, globalMax: number, higher: boolean): string {
  if (globalMax === globalMin) return 'transparent'
  const norm = higher ? (val - globalMin) / (globalMax - globalMin) : (globalMax - val) / (globalMax - globalMin)
  const intensity = (norm - 0.5) * 2
  return cellBg(intensity > 0 ? 'good' : 'bad', Math.abs(intensity))
}

// ── HWM / LWM drawdown/drawup ─────────────────────────────────────────────────

function detectDrawEvents(points: DataPoint[], type: 'drawdown' | 'drawup'): DrawEvent[] {
  if (points.length < 3) return []
  const n = points.length
  const eps: { startIdx: number; extremeIdx: number; magnitude: number }[] = []

  if (type === 'drawdown') {
    let hwmIdx = 0, hwmVal = points[0].value, i = 1
    while (i < n) {
      if (points[i].value > hwmVal) {
        let tIdx = hwmIdx + 1, tVal = points[hwmIdx + 1]?.value ?? hwmVal
        for (let j = hwmIdx + 1; j < i; j++) if (points[j].value < tVal) { tVal = points[j].value; tIdx = j }
        const mag = ((tVal - hwmVal) / hwmVal) * 100
        if (mag < -1.0) eps.push({ startIdx: hwmIdx, extremeIdx: tIdx, magnitude: Math.abs(mag) })
        hwmIdx = i; hwmVal = points[i].value
      }
      i++
    }
    if (hwmIdx < n - 1) {
      let tIdx = hwmIdx + 1, tVal = points[hwmIdx + 1].value
      for (let j = hwmIdx + 1; j < n; j++) if (points[j].value < tVal) { tVal = points[j].value; tIdx = j }
      const mag = ((tVal - hwmVal) / hwmVal) * 100
      if (mag < -1.0) eps.push({ startIdx: hwmIdx, extremeIdx: tIdx, magnitude: Math.abs(mag) })
    }
  } else {
    let lwmIdx = 0, lwmVal = points[0].value, i = 1
    while (i < n) {
      if (points[i].value < lwmVal) {
        let pIdx = lwmIdx + 1, pVal = points[lwmIdx + 1]?.value ?? lwmVal
        for (let j = lwmIdx + 1; j < i; j++) if (points[j].value > pVal) { pVal = points[j].value; pIdx = j }
        const mag = ((pVal - lwmVal) / lwmVal) * 100
        if (mag > 1.0) eps.push({ startIdx: lwmIdx, extremeIdx: pIdx, magnitude: mag })
        lwmIdx = i; lwmVal = points[i].value
      }
      i++
    }
    if (lwmIdx < n - 1) {
      let pIdx = lwmIdx + 1, pVal = points[lwmIdx + 1].value
      for (let j = lwmIdx + 1; j < n; j++) if (points[j].value > pVal) { pVal = points[j].value; pIdx = j }
      const mag = ((pVal - lwmVal) / lwmVal) * 100
      if (mag > 1.0) eps.push({ startIdx: lwmIdx, extremeIdx: pIdx, magnitude: mag })
    }
  }

  return eps.sort((a, b) => b.magnitude - a.magnitude).slice(0, 3).map(e => ({
    start: points[e.startIdx].date, end: points[e.extremeIdx].date,
    magnitude: e.magnitude, durationDays: daysBetween(points[e.startIdx].date, points[e.extremeIdx].date),
  }))
}

// ── Metrikák ─────────────────────────────────────────────────────────────────

function computeRawMetrics(series: DataSeries, start: string, end: string, bm: DataSeries | null) {
  const pts = series.points.filter(p => p.date >= start && p.date <= end)
  const empty = { totalReturn: null, stdDev: null, sharpe: null, alpha: null, beta: null }
  if (pts.length < 3) return empty
  const totalReturn = ((pts[pts.length - 1].value - pts[0].value) / pts[0].value) * 100
  const dailyR: number[] = []
  for (let i = 1; i < pts.length; i++)
    if (pts[i - 1].value > 0) dailyR.push((pts[i].value - pts[i - 1].value) / pts[i - 1].value)
  if (dailyR.length < 2) return { ...empty, totalReturn }
  const mean = dailyR.reduce((s, r) => s + r, 0) / dailyR.length
  const variance = dailyR.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyR.length
  const stdDev = Math.sqrt(variance * 252) * 100
  const sharpe = stdDev > 0 ? (mean * 252 * 100 - RISK_FREE) / stdDev : null
  let alpha: number | null = null, beta: number | null = null
  if (!series.isBenchmark && bm) {
    const bmPts = bm.points.filter(p => p.date >= start && p.date <= end)
    const bmMap = new Map(bmPts.map(p => [p.date, p.value]))
    const paired: { f: number; b: number }[] = []
    for (let i = 1; i < pts.length; i++) {
      let bm0 = bmMap.get(pts[i-1].date), bm1 = bmMap.get(pts[i].date)
      if (!bm0||!bm1) for (let d=1;d<=3;d++) {
        if (!bm0){const t=new Date(pts[i-1].date);t.setDate(t.getDate()-d);bm0=bmMap.get(t.toISOString().split('T')[0]);if(!bm0){t.setDate(t.getDate()+2*d);bm0=bmMap.get(t.toISOString().split('T')[0])}}
        if (!bm1){const t=new Date(pts[i].date);t.setDate(t.getDate()-d);bm1=bmMap.get(t.toISOString().split('T')[0]);if(!bm1){t.setDate(t.getDate()+2*d);bm1=bmMap.get(t.toISOString().split('T')[0])}}
        if (bm0&&bm1) break
      }
      if (bm0&&bm1&&bm0>0&&pts[i-1].value>0) paired.push({f:(pts[i].value-pts[i-1].value)/pts[i-1].value,b:(bm1-bm0)/bm0})
    }
    if (paired.length>=5) {
      const nn=paired.length,bmMean=paired.reduce((s,p)=>s+p.b,0)/nn,fMean=paired.reduce((s,p)=>s+p.f,0)/nn
      const cov=paired.reduce((s,p)=>s+(p.b-bmMean)*(p.f-fMean),0)/nn,bmVar=paired.reduce((s,p)=>s+(p.b-bmMean)**2,0)/nn
      if (bmVar>0){beta=cov/bmVar;alpha=((fMean-beta*bmMean)*252)*100}
    }
  }
  return { totalReturn, stdDev, sharpe, alpha, beta }
}

function minMax(values: (number | null)[], higher: boolean): (number | null)[] {
  const v = values.filter((x): x is number => x != null)
  if (!v.length) return values.map(() => null)
  if (v.length===1) return values.map(x => x==null?null:50)
  const min=Math.min(...v),max=Math.max(...v)
  if (max===min) return values.map(x => x==null?null:50)
  return values.map(x => x==null?null:Math.round((higher?(x-min)/(max-min):(max-x)/(max-min))*100))
}

function computeAllMetrics(allSeries: DataSeries[], start: string, end: string): PeriodSeriesMetrics[] {
  const bm = allSeries.find(s=>s.isBenchmark)??null
  const raw = allSeries.map(s=>({series:s,...computeRawMetrics(s,start,end,bm)}))
  const sharpeS=minMax(raw.map(r=>r.sharpe),true),alphaS=minMax(raw.map(r=>r.alpha),true)
  const betaS=minMax(raw.map(r=>r.beta),false),stdS=minMax(raw.map(r=>r.stdDev),false),retS=minMax(raw.map(r=>r.totalReturn),true)
  return raw.map((r,i)=>{
    const parts:[number,number][]=[]
    if(sharpeS[i]!=null)parts.push([sharpeS[i]!,0.35])
    if(alphaS[i]!=null)parts.push([alphaS[i]!,0.30])
    if(betaS[i]!=null)parts.push([betaS[i]!,0.20])
    if(stdS[i]!=null)parts.push([stdS[i]!,0.15])
    const wSum=parts.reduce((a,[,w])=>a+w,0)
    const totalScore=parts.length>0?Math.round(parts.reduce((a,[v,w])=>a+v*w,0)/wSum):null
    return {seriesId:r.series.id,seriesName:r.series.name,seriesColor:r.series.color,isBenchmark:r.series.isBenchmark,
      totalReturn:r.totalReturn,stdDev:r.stdDev,sharpe:r.sharpe,alpha:r.alpha,beta:r.beta,
      indScores:{totalReturn:retS[i],stdDev:stdS[i],sharpe:sharpeS[i],alpha:alphaS[i],beta:betaS[i]},totalScore}
  })
}

// ── UI komponensek ────────────────────────────────────────────────────────────

function ScoreBadge({score}:{score:number|null}) {
  if (score==null) return <span className="text-slate-600 text-xs">—</span>
  const cls=score>=65?'bg-emerald-900/60 text-emerald-400':score>=40?'bg-yellow-900/60 text-yellow-400':'bg-red-900/60 text-red-400'
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-bold ${cls}`}>{score}</span>
}
function ScoreBar({score,color}:{score:number|null;color:string}) {
  if (score==null) return <span className="text-slate-500 text-sm font-mono">—</span>
  const label=score>=65?'Kiváló':score>=40?'Közepes':'Gyenge'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-slate-800 rounded-full h-2 min-w-12"><div className="h-2 rounded-full" style={{width:`${score}%`,backgroundColor:color}}/></div>
      <span className="font-mono font-bold text-white text-sm w-7">{score}</span>
      <span className="text-slate-500 text-xs w-12">{label}</span>
    </div>
  )
}
function ExplainRow({label,explanation,children}:{label:string;explanation:string;children:React.ReactNode}) {
  const [show,setShow]=useState(false)
  return (
    <tr className="relative transition-colors hover:bg-slate-800/40" onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
      <td className="py-3 pr-6 text-slate-400 font-medium whitespace-nowrap w-44">
        <span className="border-b border-dotted border-slate-600 cursor-help">{label}</span>
        {show&&<div className="absolute left-0 top-full z-50 mt-1 w-80 bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs text-slate-300 leading-relaxed shadow-xl pointer-events-none">{explanation}</div>}
      </td>
      {children}
    </tr>
  )
}
function InfoPanel({text}:{text:string}) {
  const [open,setOpen]=useState(false)
  return (
    <span className="inline-block ml-2 align-middle relative">
      <button onClick={()=>setOpen(v=>!v)} className="w-5 h-5 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white text-xs font-bold transition-colors flex items-center justify-center">?</button>
      {open&&<div className="absolute left-0 top-7 z-50 mt-1 p-3 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 leading-relaxed w-80 shadow-xl">{text}</div>}
    </span>
  )
}

// ── Mini grafikon ─────────────────────────────────────────────────────────────

function MiniChart({allSeries,start,end}:{allSeries:DataSeries[];start:string;end:string}) {
  const data = useMemo(()=>{
    const bases:Record<string,number>={},byDate:Record<string,Record<string,number>>={}
    allSeries.forEach(s=>{
      const pts=s.points.filter(p=>p.date>=start&&p.date<=end)
      if(!pts.length) return
      bases[s.shortName]=pts[0].value
      pts.forEach(p=>{if(!byDate[p.date])byDate[p.date]={};if(bases[s.shortName])byDate[p.date][s.shortName]=((p.value-bases[s.shortName])/bases[s.shortName])*100})
    })
    return Object.entries(byDate).sort(([a],[b])=>a.localeCompare(b)).map(([date,vals])=>({date,...vals}))
  },[allSeries,start,end])
  if (data.length<2) return <div className="h-36 flex items-center justify-center text-slate-600 text-xs">Nincs elég adat</div>
  return (
    <ResponsiveContainer width="100%" height={150}>
      <LineChart data={data} margin={{top:4,right:8,left:4,bottom:4}}>
        <CartesianGrid strokeDasharray="2 4" stroke="#1e293b"/>
        <XAxis dataKey="date" tickFormatter={(d:any)=>fmtS(String(d))} tick={{fill:'#475569',fontSize:9}} tickLine={false} axisLine={false} interval={Math.max(0,Math.floor(data.length/5)-1)}/>
        <YAxis tick={{fill:'#475569',fontSize:9}} tickLine={false} axisLine={false} tickFormatter={(v:any)=>`${Number(v).toFixed(1)}%`} width={44}/>
        <Tooltip contentStyle={{backgroundColor:'#0f172a',border:'1px solid #1e293b',borderRadius:'6px',fontSize:'11px'}} labelFormatter={(l:any)=>fmt(String(l))} formatter={(v:any,n:any)=>[`${Number(v).toFixed(2)}%`,n]}/>
        {allSeries.map(s=><Line key={s.id} type="monotone" dataKey={s.shortName} stroke={s.color} strokeWidth={1.5} dot={false} connectNulls/>)}
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Periódus részletek ────────────────────────────────────────────────────────

function PeriodDetail({period,allSeries}:{period:DrawPeriod;allSeries:DataSeries[]}) {
  const metrics=useMemo(()=>computeAllMetrics(allSeries,period.start,period.end),[period,allSeries])
  const rows:[{key:keyof Omit<PeriodSeriesMetrics,'seriesId'|'seriesName'|'seriesColor'|'isBenchmark'|'indScores'|'totalScore'>,label:string,expl:string,fmt:(v:number|null)=>string}]=[
    {key:'totalReturn',label:'Teljes hozam',expl:EXPLAIN.totalReturn,fmt:fmtPct},
    {key:'stdDev',label:'Szórás (ann.)',expl:EXPLAIN.stdDev,fmt:fmtPct},
    {key:'sharpe',label:'Sharpe-ráta',expl:EXPLAIN.sharpe,fmt:fmtNum},
    {key:'alpha',label:'Alfa',expl:EXPLAIN.alpha,fmt:fmtPct},
    {key:'beta',label:'Béta',expl:EXPLAIN.beta,fmt:fmtNum},
  ] as any
  const annRate=period.durationDays>0?period.magnitude/(period.durationDays/365):period.magnitude
  return (
    <div className="space-y-4">
      <div className="bg-slate-800/40 rounded-lg p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-slate-500">{fmt(period.start)} → {fmt(period.end)}</span>
          <span className={`font-mono text-xs font-bold ${period.type==='drawdown'?'text-red-400':'text-emerald-400'}`}>{period.type==='drawdown'?'↓':'↑'} {period.magnitude.toFixed(1)}% · {period.seriesShortName}</span>
        </div>
        <div className="flex items-center gap-4 mb-2 text-xs text-slate-500">
          <span>Időtartam: <span className="text-slate-300">{fmtDuration(period.durationDays)}</span></span>
          <span>Évesítve: <span className={`font-mono font-medium ${period.type==='drawdown'?'text-red-400':'text-emerald-400'}`}>{period.type==='drawdown'?'-':'+'}{annRate.toFixed(1)}%/év</span></span>
        </div>
        <MiniChart allSeries={allSeries} start={period.start} end={period.end}/>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700">
              <th className="text-left py-2 pr-4 text-slate-500 font-medium">Mutató</th>
              {metrics.map((m:PeriodSeriesMetrics)=><th key={m.seriesId} colSpan={2} className="text-center py-2 px-2 font-medium" style={{color:m.seriesColor}}>{m.seriesName.split(' ').slice(0,2).join(' ')}</th>)}
            </tr>
            <tr className="border-b border-slate-800/80">
              <th className="py-1 pr-4"/>
              {metrics.map((m:PeriodSeriesMetrics)=>(
                <React.Fragment key={`${m.seriesId}-subhdr`}>
                  <th className="py-1 px-2 text-right text-slate-600 font-normal">érték</th>
                  <th className="py-1 px-2 text-center text-slate-600 font-normal">score</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {rows.map((row:any)=>(
              <tr key={row.key} className="hover:bg-slate-800/30" title={row.expl}>
                <td className="py-2 pr-4 text-slate-400"><span className="border-b border-dotted border-slate-700">{row.label}</span></td>
                {metrics.map((m:PeriodSeriesMetrics)=>{
                  const isBmAB=m.isBenchmark&&(row.key==='alpha'||row.key==='beta')
                  const val=m[row.key as keyof PeriodSeriesMetrics] as number|null
                  const sc=m.indScores[row.key as keyof MetricScores]
                  const vc=isBmAB||val==null?'text-slate-600':(row.key==='stdDev'||row.key==='beta')?(Number(val)<(row.key==='beta'?1:15)?'text-emerald-400':Number(val)<(row.key==='beta'?1.3:25)?'text-yellow-400':'text-red-400'):Number(val)>=0?'text-emerald-400':'text-red-400'
                  return (
                    <React.Fragment key={`${m.seriesId}-${row.key}`}>
                      <td className={`py-2 px-2 text-right font-mono font-medium ${vc}`}>{isBmAB?'—':row.fmt(val)}</td>
                      <td className="py-2 px-2 text-center">{isBmAB?<span className="text-slate-700">—</span>:<ScoreBadge score={sc}/>}</td>
                    </React.Fragment>
                  )
                })}
              </tr>
            ))}
            <tr className="border-t-2 border-slate-600 bg-slate-800/20">
              <td className="py-3 pr-4 text-slate-300 font-semibold">Összesített score</td>
              {metrics.map((m:PeriodSeriesMetrics)=>(
                <React.Fragment key={`${m.seriesId}-total`}>
                  <td className="py-3 px-2"/>
                  <td className="py-3 px-2 text-center"><ScoreBadge score={m.totalScore}/></td>
                </React.Fragment>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-700">* Rövid perióduson mért alfa/béta statisztikailag kevésbé megbízható.</p>
    </div>
  )
}

// ── Összefoglaló tábla ────────────────────────────────────────────────────────

function SummaryTable({allPeriods,allSeries}:{allPeriods:DrawPeriod[];allSeries:DataSeries[]}) {
  const summary=useMemo(()=>{
    const byId:Record<string,{scores:number[];series:DataSeries}>={}
    allSeries.forEach(s=>{byId[s.id]={scores:[],series:s}})
    allPeriods.forEach(p=>{
      computeAllMetrics(allSeries,p.start,p.end).forEach(m=>{if(m.totalScore!=null)byId[m.seriesId]?.scores.push(m.totalScore)})
    })
    return Object.values(byId).map(({series,scores})=>({series,scores,avg:scores.length>0?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null,count:scores.length})).sort((a,b)=>(b.avg??0)-(a.avg??0))
  },[allPeriods,allSeries])
  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
      <h2 className="font-semibold text-white mb-1 flex items-center">Összesített teljesítmény — mind a {allPeriods.length} időszak<InfoPanel text={INFO.summary}/></h2>
      <p className="text-xs text-slate-500 mb-5">Átlagos score az összes drawdown és drawup időszak alapján, sorrendbe rendezve.</p>
      <div className="space-y-4">
        {summary.map((item,rank)=>(
          <div key={item.series.id} className="flex items-center gap-4">
            <div className="w-4 text-slate-600 font-mono text-sm shrink-0">{rank+1}.</div>
            <div className="w-48 text-sm font-medium truncate shrink-0" style={{color:item.series.color}}>{item.series.shortName}</div>
            <div className="flex-1"><ScoreBar score={item.avg} color={item.series.color}/></div>
            <div className="text-slate-600 text-xs w-28 text-right shrink-0">{item.count}/{allPeriods.length} időszak</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Negyedéves hőtérkép ───────────────────────────────────────────────────────

type ColorMode = 'relative' | 'absolute'

function QuarterlyHeatmap({allSeries,effectiveStart,effectiveEnd}:{allSeries:DataSeries[];effectiveStart:string;effectiveEnd:string}) {
  const [heatMetric,setHeatMetric]=useState<HeatMetric>('score')
  const [colorMode,setColorMode]=useState<ColorMode>('relative')

  // Clamp effectiveEnd to actual data max to avoid 2099 Q4 problem
  const actualEnd=useMemo(()=>{
    const dates=allSeries.flatMap(s=>s.points.map(p=>p.date))
    const max=dates.length?[...dates].sort().pop()!:effectiveEnd
    return max<effectiveEnd?max:effectiveEnd
  },[allSeries,effectiveEnd])

  const quarters=useMemo(()=>{
    if(!allSeries.length) return []
    const cur=new Date(effectiveStart)
    cur.setDate(1);cur.setMonth(Math.floor(cur.getMonth()/3)*3)
    const end=new Date(actualEnd)
    const result:{quarter:string;start:string;end:string}[]=[]
    while(cur<=end){
      const qEnd=new Date(cur.getFullYear(),cur.getMonth()+3,0)
      result.push({quarter:`${cur.getFullYear()} Q${Math.floor(cur.getMonth()/3)+1}`,start:cur.toISOString().split('T')[0],end:qEnd.toISOString().split('T')[0]})
      cur.setMonth(cur.getMonth()+3)
    }
    return result.reverse()
  },[allSeries,effectiveStart,actualEnd])

  const data=useMemo(()=>quarters.map(q=>({...q,metrics:computeAllMetrics(allSeries,q.start,q.end)})),[quarters,allSeries])

  // Precompute color context for current metric
  const colorCtx=useMemo(()=>{
    const hasBm=allSeries.some(s=>s.isBenchmark)
    const higher=HEAT_HIGHER_BETTER[heatMetric]
    if(heatMetric==='score') return {mode:'score' as const}
    if(hasBm){
      let maxAbsDiff=0
      data.forEach(q=>{
        const bmM=q.metrics.find(m=>m.isBenchmark)
        const bmVal=bmM?bmM[heatMetric as keyof PeriodSeriesMetrics] as number|null:null
        if(bmVal==null) return
        q.metrics.filter(m=>!m.isBenchmark).forEach(m=>{
          const val=m[heatMetric as keyof PeriodSeriesMetrics] as number|null
          if(val==null) return
          const diff=Math.abs(higher?(val-bmVal):(bmVal-val))
          if(diff>maxAbsDiff) maxAbsDiff=diff
        })
      })
      return {mode:'bm' as const,maxAbsDiff:maxAbsDiff||1}
    }
    const allVals:number[]=[]
    data.forEach(q=>q.metrics.forEach(m=>{const v=m[heatMetric as keyof PeriodSeriesMetrics] as number|null;if(v!=null)allVals.push(v)}))
    return {mode:'classic' as const,min:allVals.length?Math.min(...allVals):0,max:allVals.length?Math.max(...allVals):1}
  },[data,heatMetric,allSeries])

  function getCellBg(m:PeriodSeriesMetrics,rowMetrics:PeriodSeriesMetrics[]):string{
    if(m.isBenchmark) return 'transparent'
    const val=heatMetric==='score'?m.totalScore:m[heatMetric as keyof PeriodSeriesMetrics] as number|null
    if(val==null) return 'transparent'
    const higher=HEAT_HIGHER_BETTER[heatMetric]
    let direction:'good'|'bad'='bad', intensity=0

    if(colorCtx.mode==='score'){
      const vals=rowMetrics.filter(x=>!x.isBenchmark).map(x=>x.totalScore).filter((v):v is number=>v!=null)
      if(vals.length<2) return 'transparent'
      const rMin=Math.min(...vals),rMax=Math.max(...vals),spread=rMax-rMin
      if(spread===0) return 'transparent'
      const raw=((val-rMin)/spread-0.5)*2*Math.min(spread/100,1)
      direction=raw>0?'good':'bad'; intensity=Math.abs(raw)
    } else if(colorCtx.mode==='bm'){
      const bmM=rowMetrics.find(x=>x.isBenchmark)
      const bmVal=bmM?bmM[heatMetric as keyof PeriodSeriesMetrics] as number|null:null
      if(bmVal==null) return 'transparent'
      const diff=higher?(val-bmVal):(bmVal-val)
      direction=diff>0?'good':'bad'; intensity=colorCtx.maxAbsDiff>0?Math.abs(diff)/colorCtx.maxAbsDiff:0
    } else {
      if(colorCtx.max===colorCtx.min) return 'transparent'
      const norm=higher?(val-colorCtx.min)/(colorCtx.max-colorCtx.min):(colorCtx.max-val)/(colorCtx.max-colorCtx.min)
      const raw=(norm-0.5)*2
      direction=raw>0?'good':'bad'; intensity=Math.abs(raw)
    }

    return cellBg(direction, colorMode==='absolute'?0.72:intensity)
  }

  function fmtCell(m:PeriodSeriesMetrics):string{
    const val=heatMetric==='score'?m.totalScore:m[heatMetric as keyof PeriodSeriesMetrics] as number|null
    if(val==null) return '—'
    if(heatMetric==='score') return String(Math.round(val))
    if(heatMetric==='beta') return fmtNum(val,2)
    return fmtPct(val,1)
  }

  if(!data.length) return null

  const CELL='py-1.5 px-3 text-center border border-slate-700 font-mono text-xs'
  const HEAD='py-2 px-3 border border-slate-700 font-medium text-xs bg-slate-900 whitespace-nowrap'

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="font-semibold text-white flex items-center">Negyedéves hőtérkép<InfoPanel text={INFO.heatmap}/></h2>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
            {(Object.keys(HEAT_LABELS) as HeatMetric[]).map(k=>(
              <button key={k} onClick={()=>setHeatMetric(k)} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${heatMetric===k?'bg-slate-600 text-white':'text-slate-400 hover:text-slate-200'}`}>{HEAT_LABELS[k]}</button>
            ))}
          </div>
          <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
            {(['relative','absolute'] as ColorMode[]).map(m=>(
              <button key={m} onClick={()=>setColorMode(m)} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${colorMode===m?'bg-slate-600 text-white':'text-slate-400 hover:text-slate-200'}`}>{m==='relative'?'Relatív':'Abszolút'}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
        <table className="text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={`${HEAD} text-left text-slate-500`}>Negyedév</th>
              {allSeries.map(s=>(
                <th key={s.id} className={`${HEAD} text-center`} style={{color:s.color}}>{s.shortName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map(q=>(
              <tr key={q.quarter}>
                <td className="py-1.5 px-3 text-slate-500 font-mono whitespace-nowrap border border-slate-700 text-xs">{q.quarter}</td>
                {q.metrics.map(m=>{
                  const isBmAlphaBeta=m.isBenchmark&&(heatMetric==='alpha'||heatMetric==='beta')
                  const bg=isBmAlphaBeta||m.isBenchmark?'transparent':getCellBg(m,q.metrics)
                  return (
                    <td key={m.seriesId} className={CELL} style={{backgroundColor:bg}}>
                      <span className={isBmAlphaBeta?'text-slate-600':'text-slate-100'}>{isBmAlphaBeta?'—':fmtCell(m)}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Fő Dashboard ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [funds,setFunds]=useState<Fund[]>([])
  const [selectedIds,setSelectedIds]=useState<string[]>([])
  const [selectedBmIds,setSelectedBmIds]=useState<string[]>([])
  const [correctionSources,setCorrectionSources]=useState<string[]>([])
  const [correctionMap,setCorrectionMap]=useState<Record<string,string>>({})
  const [prices,setPrices]=useState<Record<string,PriceRow[]>>({})
  const [period,setPeriod]=useState<Period>('3y')
  const [metric,setMetric]=useState<MainMetric>('pct')
  const [isLoading,setIsLoading]=useState(false)
  const [selectedPeriodId,setSelectedPeriodId]=useState<string|null>(null)
  const [dateRangeMode,setDateRangeMode]=useState<DateRangeMode>('full')
  const [searchQuery,setSearchQuery]=useState('')
  const [bmSearchQuery,setBmSearchQuery]=useState('')
  const [corrSearchQuery,setCorrSearchQuery]=useState('')
  const [searchOpen,setSearchOpen]=useState(false)
  const [bmSearchOpen,setBmSearchOpen]=useState(false)
  const [corrSearchOpen,setCorrSearchOpen]=useState(false)
  const searchRef=useRef<HTMLDivElement>(null)
  const bmSearchRef=useRef<HTMLDivElement>(null)
  const corrSearchRef=useRef<HTMLDivElement>(null)
  const fetchGenRef=useRef(0)

  useEffect(()=>{
    function h(e:MouseEvent){
      if(searchRef.current&&!searchRef.current.contains(e.target as Node))setSearchOpen(false)
      if(bmSearchRef.current&&!bmSearchRef.current.contains(e.target as Node))setBmSearchOpen(false)
      if(corrSearchRef.current&&!corrSearchRef.current.contains(e.target as Node))setCorrSearchOpen(false)
    }
    document.addEventListener('mousedown',h)
    return()=>document.removeEventListener('mousedown',h)
  },[])

  useEffect(()=>{
    supabase.from('funds').select('id,name,fund_manager,risk_return_indicator,std_dev_1y,std_dev_5y,is_benchmark').order('name')
      .then(({data})=>{
        if(data){
          setFunds(data)
          setSelectedIds(data.filter((f:Fund)=>!f.is_benchmark).slice(0,2).map((f:Fund)=>f.id))
          setSelectedBmIds(data.filter((f:Fund)=>f.is_benchmark).map((f:Fund)=>f.id))
        }
      })
  },[])

  async function fetchAllRows(fundId:string,from:string):Promise<PriceRow[]>{
    const PAGE=999,all:PriceRow[]=[]
    let page=0
    while(true){
      const start=page*PAGE
      const{data}=await supabase.from('fund_prices')
        .select('date,nav_price,return_1y,return_3y,return_5y')
        .eq('fund_id',fundId).gte('date',from).order('date',{ascending:true})
        .range(start,start+PAGE-1)
      if(!data||!data.length) break
      all.push(...data)
      if(data.length<PAGE) break
      page++
    }
    return all
  }

  // Load prices — no reset on change, stale-generation guard prevents wrong data
  useEffect(()=>{
    if(!funds.length) return
    const ids=[...new Set([...selectedIds,...selectedBmIds,...correctionSources])]
    if(!ids.length) return
    const gen=++fetchGenRef.current
    const from=periodStart(period)
    setIsLoading(true)
    let remaining=ids.length
    ids.forEach(async id=>{
      const data=await fetchAllRows(id,from)
      if(gen!==fetchGenRef.current) return
      if(data.length) setPrices(prev=>({...prev,[id]:data}))
      remaining--
      if(remaining===0) setIsLoading(false)
    })
  },[selectedIds,selectedBmIds,correctionSources,period,funds])

  const fundColorMap=useMemo(()=>{
    const map:Record<string,string>={};let ci=0
    funds.forEach(f=>{map[f.id]=selectedBmIds.includes(f.id)?BM_COLOR:COLORS[ci++%COLORS.length]})
    return map
  },[funds,selectedBmIds])

  const allSeries:DataSeries[]=useMemo(()=>{
    const ids=[...new Set([...selectedIds,...selectedBmIds])]
    return ids.flatMap(id=>{
      const fund=funds.find(f=>f.id===id)
      if(!fund||!prices[id]) return []
      let points:DataPoint[]=prices[id].map(p=>({date:p.date,value:p.nav_price}))
      const corrId=correctionMap[id]
      if(corrId&&prices[corrId]){
        const cm=new Map(prices[corrId].map(p=>[p.date,p.nav_price]))
        const cp=points.flatMap(pt=>{const cv=cm.get(pt.date);return cv&&cv>0?[{date:pt.date,value:pt.value*cv}]:[]})
        if(cp.length>=3) points=cp
      }
      const corrFund=corrId?funds.find(f=>f.id===corrId):null
      return [{
        id,name:fund.name+(corrFund?` ×${corrFund.name.split(' ')[0]}`:''),
        shortName:fund.name.split(' ').slice(0,3).join(' ')+(corrId?'*':''),
        color:fundColorMap[id],isBenchmark:selectedBmIds.includes(id),points,
      }]
    })
  },[selectedIds,selectedBmIds,funds,prices,fundColorMap,correctionMap])

  const commonDateRange=useMemo(()=>{
    const a=allSeries.filter(s=>s.points.length>0)
    if(!a.length) return null
    const start=a.map(s=>s.points[0].date).reduce((x,y)=>x>y?x:y)
    const end=a.map(s=>s.points[s.points.length-1].date).reduce((x,y)=>x<y?x:y)
    return start<=end?{start,end}:null
  },[allSeries])

  const effectiveStart=dateRangeMode==='common'&&commonDateRange?commonDateRange.start:periodStart(period)
  const effectiveEnd=dateRangeMode==='common'&&commonDateRange?commonDateRange.end:'2099-12-31'

  const chartData=useMemo(()=>{
    const rrMaps=new Map<string,Map<string,number>>()
    if(metric!=='pct') allSeries.forEach(s=>rrMaps.set(s.id,rollingReturnMap(s.points,ROLLING_DAYS[metric])))
    const bases:Record<string,number>={}
    allSeries.forEach(s=>{const fp=s.points.find(p=>p.date>=effectiveStart);if(fp)bases[s.shortName]=fp.value})
    const map:Record<string,Record<string,number>>={}
    allSeries.forEach(s=>{
      s.points.filter(p=>p.date>=effectiveStart&&p.date<=effectiveEnd).forEach(p=>{
        if(!map[p.date])map[p.date]={}
        if(metric==='pct'){if(bases[s.shortName])map[p.date][s.shortName]=((p.value-bases[s.shortName])/bases[s.shortName])*100}
        else if(s.isBenchmark){const v=rrMaps.get(s.id)?.get(p.date);if(v!=null)map[p.date][s.shortName]=v}
        else{const pr=prices[s.id]?.find(r=>r.date===p.date);const v=pr?.[metric as 'return_1y'|'return_3y'|'return_5y'];if(v!=null)map[p.date][s.shortName]=Number(v)}
      })
    })
    return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).map(([date,vals])=>({date,...vals}))
  },[allSeries,metric,prices,effectiveStart,effectiveEnd])

  const chartTicks=useMemo(()=>getChartTicks(chartData,period),[chartData,period])

  const allDrawPeriods:DrawPeriod[]=useMemo(()=>{
    const result:DrawPeriod[]=[]
    allSeries.forEach(s=>{
      const pts=s.points.filter(p=>p.date>=effectiveStart)
      ;(['drawdown','drawup'] as const).forEach(type=>{
        detectDrawEvents(pts,type).forEach((e,i)=>{
          result.push({id:`${s.id}-${type}-${i+1}`,seriesId:s.id,seriesShortName:s.shortName,seriesColor:s.color,type,rank:i+1,start:e.start,end:e.end,magnitude:e.magnitude,durationDays:e.durationDays})
        })
      })
    })
    return result
  },[allSeries,effectiveStart])

  const selectedPeriod=allDrawPeriods.find(p=>p.id===selectedPeriodId)??allDrawPeriods[0]??null
  const mainMetrics=useMemo(()=>allSeries.length?computeAllMetrics(allSeries,effectiveStart,effectiveEnd):[],[allSeries,effectiveStart,effectiveEnd])

  const usedIds=new Set([...selectedIds,...selectedBmIds])
  const searchResults=funds.filter(f=>!usedIds.has(f.id)&&f.name.toLowerCase().includes(searchQuery.toLowerCase()))
  const bmSearchResults=funds.filter(f=>!usedIds.has(f.id)&&f.name.toLowerCase().includes(bmSearchQuery.toLowerCase()))
  const corrResults=funds.filter(f=>!correctionSources.includes(f.id)&&!usedIds.has(f.id)&&f.name.toLowerCase().includes(corrSearchQuery.toLowerCase()))

  const addFund=(id:string)=>{setSelectedIds(p=>[...p,id]);setSearchQuery('');setSearchOpen(false)}
  const addBm=(id:string)=>{setSelectedBmIds(p=>[...p,id]);setBmSearchQuery('');setBmSearchOpen(false)}
  const removeFund=(id:string)=>{
    setSelectedIds(p=>p.filter(x=>x!==id))
    setPrices(p=>{const n={...p};delete n[id];return n})
    setCorrectionMap(p=>{const n={...p};delete n[id];Object.keys(n).forEach(k=>{if(n[k]===id)delete n[k]});return n})
  }
  const removeBm=(id:string)=>{
    setSelectedBmIds(p=>p.filter(x=>x!==id))
    setPrices(p=>{const n={...p};delete n[id];return n})
    setCorrectionMap(p=>{const n={...p};Object.keys(n).forEach(k=>{if(n[k]===id)delete n[k]});return n})
  }
  const addCorrSource=(id:string)=>{setCorrectionSources(p=>[...p,id]);setCorrSearchQuery('');setCorrSearchOpen(false)}
  const removeCorrSource=(id:string)=>{
    setCorrectionSources(p=>p.filter(x=>x!==id))
    setPrices(p=>{const n={...p};delete n[id];return n})
    setCorrectionMap(p=>{const n={...p};Object.keys(n).forEach(k=>{if(n[k]===id)delete n[k]});return n})
  }

  const fundChips=[
    ...selectedBmIds.map(id=>({fund:funds.find(f=>f.id===id),isBm:true})).filter((x):x is {fund:Fund,isBm:boolean}=>!!x.fund),
    ...selectedIds.map(id=>({fund:funds.find(f=>f.id===id),isBm:false})).filter((x):x is {fund:Fund,isBm:boolean}=>!!x.fund),
  ]

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-8 py-5">
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Alap Elemző</h1>
            <p className="text-slate-400 text-sm mt-0.5">Befektetési alap teljesítmény dashboard</p>
          </div>
          <div className="text-right text-sm text-slate-500">{funds.length} adatsor · {selectedIds.length} alap + {selectedBmIds.length} benchmark</div>
        </div>
      </header>

      {/* Sticky sáv */}
      <div className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur border-b border-slate-800/60 px-8 py-3">
        <div className="max-w-screen-2xl mx-auto flex flex-wrap gap-4 items-center">
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-600 mb-1">Időszak</div>
            <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5">
              {(['1y','3y','5y','all'] as Period[]).map(p=>(
                <button key={p} onClick={()=>setPeriod(p)} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${period===p?'bg-slate-600 text-white':'text-slate-400 hover:text-slate-200'}`}>{p==='all'?'Max':p.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-600 mb-1">Megjelenítés</div>
            <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5">
              {([['full','Teljes'],['common','Közös']] as const).map(([mode,label])=>(
                <button key={mode} onClick={()=>setDateRangeMode(mode)} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${dateRangeMode===mode?'bg-slate-600 text-white':'text-slate-400 hover:text-slate-200'}`}>{label}</button>
              ))}
            </div>
          </div>
          {commonDateRange&&<div className="text-xs text-slate-600 mt-4">Közös: {fmtS(commonDateRange.start)} – {fmtS(commonDateRange.end)}</div>}
          <div className="ml-auto flex items-center gap-2 text-xs">
            {isLoading
              ? <><div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"/><span className="text-slate-500">Betöltés...</span></>
              : <span className="text-slate-700">●</span>}
          </div>
        </div>
      </div>

      <main className="max-w-screen-2xl mx-auto px-8 py-8 space-y-8">

        {/* Adatsor / Benchmark / Korrekció választók */}
        <div className="space-y-3">
          {/* Chipek + keresők */}
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Adatsorok</div>
            <div className="flex flex-wrap gap-2">
              {fundChips.map(({fund,isBm})=>(
                <div key={fund.id} className="flex items-center rounded-lg text-sm font-medium text-white overflow-hidden" style={{backgroundColor:fundColorMap[fund.id]}}>
                  <span className="px-3 py-2 select-none">{isBm?'⬡ ':''}{fund.name.split(' ').slice(0,4).join(' ')}</span>
                  <button onClick={()=>isBm?removeBm(fund.id):removeFund(fund.id)} className="px-2 py-2 hover:bg-black/20 transition-colors text-white/70 hover:text-white">×</button>
                </div>
              ))}

              {/* + Alap */}
              <div ref={searchRef} className="relative">
                <button onClick={()=>{setSearchOpen(v=>!v);setSearchQuery('')}} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-700 text-slate-400 hover:border-slate-500 bg-slate-900 hover:text-slate-200 transition-all">+ Alap</button>
                {searchOpen&&(
                  <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-slate-800 border border-slate-700 rounded-xl shadow-xl">
                    <input autoFocus type="text" placeholder="Keresés..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} className="w-full px-4 py-3 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none border-b border-slate-700"/>
                    <div className="max-h-56 overflow-y-auto">
                      {searchResults.length===0?<div className="px-4 py-3 text-xs text-slate-600">Nincs találat</div>
                        :searchResults.map(f=><button key={f.id} onClick={()=>addFund(f.id)} className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors">{f.name}</button>)}
                    </div>
                  </div>
                )}
              </div>

              {/* + Benchmark */}
              <div ref={bmSearchRef} className="relative">
                <button onClick={()=>{setBmSearchOpen(v=>!v);setBmSearchQuery('')}} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-600 text-slate-400 hover:border-slate-400 bg-slate-900 hover:text-slate-200 transition-all">⬡ + Benchmark</button>
                {bmSearchOpen&&(
                  <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-slate-800 border border-slate-700 rounded-xl shadow-xl">
                    <input autoFocus type="text" placeholder="Benchmark keresés..." value={bmSearchQuery} onChange={e=>setBmSearchQuery(e.target.value)} className="w-full px-4 py-3 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none border-b border-slate-700"/>
                    <div className="max-h-56 overflow-y-auto">
                      {bmSearchResults.length===0?<div className="px-4 py-3 text-xs text-slate-600">Nincs találat</div>
                        :bmSearchResults.map(f=><button key={f.id} onClick={()=>addBm(f.id)} className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors">⬡ {f.name}</button>)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Devizakorrekció */}
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Devizakorrekció</div>
            <div className="flex flex-wrap gap-3 items-center">
              {correctionSources.map(id=>{
                const f=funds.find(x=>x.id===id)
                return f?(
                  <div key={id} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-xs text-slate-300">
                    <span>{f.name}</span>
                    <button onClick={()=>removeCorrSource(id)} className="ml-1 text-slate-500 hover:text-white transition-colors">×</button>
                  </div>
                ):null
              })}
              <div ref={corrSearchRef} className="relative">
                <button onClick={()=>{setCorrSearchOpen(v=>!v);setCorrSearchQuery('')}} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300 bg-slate-900 transition-all">+ Korrekciós adatsor</button>
                {corrSearchOpen&&(
                  <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-slate-800 border border-slate-700 rounded-xl shadow-xl">
                    <input autoFocus type="text" placeholder="Pl. USDHUF..." value={corrSearchQuery} onChange={e=>setCorrSearchQuery(e.target.value)} className="w-full px-4 py-3 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none border-b border-slate-700"/>
                    <div className="max-h-56 overflow-y-auto">
                      {corrResults.length===0?<div className="px-4 py-3 text-xs text-slate-600">Nincs találat</div>
                        :corrResults.map(f=><button key={f.id} onClick={()=>addCorrSource(f.id)} className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors">{f.name}</button>)}
                    </div>
                  </div>
                )}
              </div>
              {correctionSources.length>0&&allSeries.length>0&&(
                <div className="flex flex-wrap gap-2 items-center ml-2 border-l border-slate-800 pl-3">
                  {allSeries.map(s=>(
                    <div key={s.id} className="flex items-center gap-2 text-xs">
                      <span style={{color:s.color}}>{s.shortName.replace('*','')}</span>
                      <span className="text-slate-600">×</span>
                      <select value={correctionMap[s.id]??''} onChange={e=>setCorrectionMap(prev=>{const n={...prev};if(e.target.value)n[s.id]=e.target.value;else delete n[s.id];return n})} className="bg-slate-800 border border-slate-700 text-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-slate-500">
                        <option value="">—</option>
                        {correctionSources.map(cid=>{const cf=funds.find(f=>f.id===cid);return cf?<option key={cid} value={cid}>{cf.name}</option>:null})}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Főgrafikon */}
        <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-2">
            <h2 className="font-semibold text-white flex items-center">Teljesítmény grafikon<InfoPanel text={INFO.chart}/></h2>
            <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
              {([['pct','Normalizált %'],['return_1y','1é hozam'],['return_3y','3é hozam'],['return_5y','5é hozam']] as const).map(([k,l])=>(
                <button key={k} onClick={()=>setMetric(k)} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${metric===k?'bg-slate-600 text-white':'text-slate-400 hover:text-slate-200'}`}>{l}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-slate-600 mb-4">{metric==='pct'?'Normalizált % az időszak elejéhez képest':'Rolling hozam'} · {dateRangeMode==='common'?'Közös időszak':'Teljes adatsor'}{correctionSources.length>0?' · * = korrigált':''}</p>
          {chartData.length>0?(
            <ResponsiveContainer width="100%" height={500}>
              <LineChart data={chartData} margin={{top:5,right:20,left:10,bottom:5}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                <XAxis dataKey="date" ticks={chartTicks} tickFormatter={(d:any)=>fmtS(String(d))} tick={{fill:'#64748b',fontSize:11}} tickLine={false} axisLine={{stroke:'#1e293b'}}/>
                <YAxis tick={{fill:'#64748b',fontSize:11}} tickLine={false} axisLine={false} tickFormatter={(v:any)=>`${Number(v).toFixed(0)}%`}/>
                <Tooltip contentStyle={{backgroundColor:'#0f172a',border:'1px solid #1e293b',borderRadius:'8px',fontSize:'12px'}} labelStyle={{color:'#94a3b8',marginBottom:4}} labelFormatter={(l:any)=>fmtS(String(l))} formatter={(v:any,n:any)=>[`${Number(v).toFixed(2)}%`,n]}/>
                <Legend wrapperStyle={{fontSize:'12px',paddingTop:'16px'}}/>
                {allSeries.map(s=><Line key={s.id} type="monotone" dataKey={s.shortName} stroke={s.color} strokeWidth={s.isBenchmark?1.5:2} strokeDasharray={s.isBenchmark?'5 3':undefined} dot={false} connectNulls/>)}
              </LineChart>
            </ResponsiveContainer>
          ):<div className="h-72 flex items-center justify-center text-slate-500">Válassz ki legalább egy adatsort</div>}
        </section>

        {/* Kockázat-hozam */}
        {mainMetrics.length>0&&(
          <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
            <h2 className="font-semibold text-white mb-1 flex items-center">Kockázat-hozam elemzés<InfoPanel text={INFO.riskreturn}/></h2>
            <p className="text-xs text-slate-500 mb-5">Vigye az egérmutatót egy sor fölé a magyarázatért</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left py-3 pr-6 text-slate-500 font-medium w-44">Mutató</th>
                    {mainMetrics.map(m=><th key={m.seriesId} className="text-right py-3 px-4 font-medium" style={{color:m.seriesColor}}>{m.isBenchmark?'⬡ ':''}{m.seriesName.split(' ').slice(0,3).join(' ')}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <ExplainRow label="Alfa" explanation={EXPLAIN.alpha}>
                    {mainMetrics.map(m=><td key={m.seriesId} className={`py-3 px-4 text-right font-mono font-medium ${m.isBenchmark||m.alpha==null?'text-slate-600':m.alpha>=0?'text-emerald-400':'text-red-400'}`}>{m.isBenchmark?'—':fmtPct(m.alpha)}</td>)}
                  </ExplainRow>
                  <ExplainRow label="Béta" explanation={EXPLAIN.beta}>
                    {mainMetrics.map(m=><td key={m.seriesId} className={`py-3 px-4 text-right font-mono ${m.isBenchmark||m.beta==null?'text-slate-600':Math.abs((m.beta??1)-1)<0.2?'text-yellow-400':(m.beta??1)<1?'text-emerald-400':'text-red-400'}`}>{m.isBenchmark?'—':fmtNum(m.beta)}</td>)}
                  </ExplainRow>
                  <ExplainRow label="Sharpe-ráta" explanation={EXPLAIN.sharpe}>
                    {mainMetrics.map(m=><td key={m.seriesId} className={`py-3 px-4 text-right font-mono ${m.sharpe==null?'text-slate-600':m.sharpe>=1?'text-emerald-400':m.sharpe>=0?'text-yellow-400':'text-red-400'}`}>{fmtNum(m.sharpe)}</td>)}
                  </ExplainRow>
                  <ExplainRow label="Szórás" explanation={EXPLAIN.stdDev}>
                    {mainMetrics.map(m=><td key={m.seriesId} className={`py-3 px-4 text-right font-mono ${m.stdDev==null?'text-slate-600':m.stdDev<10?'text-emerald-400':m.stdDev<20?'text-yellow-400':'text-red-400'}`}>{fmtPct(m.stdDev)}</td>)}
                  </ExplainRow>
                  <ExplainRow label="Összesített score" explanation={EXPLAIN.score}>
                    {mainMetrics.map(m=><td key={m.seriesId} className="py-4 px-4"><ScoreBar score={m.totalScore} color={m.seriesColor}/></td>)}
                  </ExplainRow>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Időszak elemző */}
        {allDrawPeriods.length>0&&(
          <section className="bg-slate-900 rounded-xl border border-slate-800 p-6">
            <h2 className="font-semibold text-white mb-1 flex items-center">Időszak elemző<InfoPanel text={INFO.periods}/></h2>
            <p className="text-xs text-slate-500 mb-5">{allDrawPeriods.length} azonosított időszak · Kattints egyre az összehasonlításhoz</p>
            <div className="flex gap-6">
              <div className="w-60 shrink-0 space-y-5 overflow-y-auto max-h-[600px]">
                {allSeries.map(s=>{
                  const periods=allDrawPeriods.filter(p=>p.seriesId===s.id)
                  if(!periods.length) return null
                  return (
                    <div key={s.id}>
                      <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{color:s.color}}>{s.shortName}</div>
                      <div className="space-y-1">
                        {periods.map(p=>{
                          const active=p.id===selectedPeriod?.id
                          const ar=p.durationDays>0?p.magnitude/(p.durationDays/365):p.magnitude
                          return (
                            <button key={p.id} onClick={()=>setSelectedPeriodId(p.id)} className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all border ${active?'bg-slate-700 border-slate-500 text-white':'border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
                              <div className="flex justify-between items-center">
                                <span className={p.type==='drawdown'?'text-red-400 font-semibold':'text-emerald-400 font-semibold'}>{p.type==='drawdown'?'↓':'↑'} #{p.rank}</span>
                                <span className={`font-mono ${p.type==='drawdown'?'text-red-400':'text-emerald-400'}`}>{p.type==='drawdown'?'-':'+'}{p.magnitude.toFixed(1)}%</span>
                              </div>
                              <div className="text-slate-500 mt-0.5">{fmtS(p.start)} → {fmtS(p.end)}</div>
                              <div className="flex justify-between text-slate-600 mt-0.5">
                                <span>{fmtDuration(p.durationDays)}</span>
                                <span className="font-mono">{ar.toFixed(1)}%/év</span>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex-1 min-w-0 border-l border-slate-800 pl-6">
                {selectedPeriod?<PeriodDetail period={selectedPeriod} allSeries={allSeries}/>:<div className="text-slate-500 text-sm">Válassz egy időszakot a bal oldalon</div>}
              </div>
            </div>
          </section>
        )}

        {allDrawPeriods.length>0&&allSeries.length>0&&<SummaryTable allPeriods={allDrawPeriods} allSeries={allSeries}/>}

        {allSeries.length>0&&<QuarterlyHeatmap allSeries={allSeries} effectiveStart={effectiveStart} effectiveEnd={effectiveEnd}/>}

      </main>
    </div>
  )
}
