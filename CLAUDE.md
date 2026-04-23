@AGENTS.md

# Dashboard architektúra

## Stack
- Next.js (App Router) + TypeScript
- Supabase (PostgreSQL) — `lib/supabase.ts` egyszerű kliens, env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Recharts — grafikonok
- Tailwind CSS — stílusok (dark theme, slate paletta)

## Fő fájlok
- `app/page.tsx` — egyetlen fájl, minden logika és UI itt van (961 sor)
- `lib/supabase.ts` — Supabase kliens

## Supabase táblák
```
funds          id, name, fund_manager, risk_return_indicator, std_dev_1y, std_dev_5y, is_benchmark
fund_prices    fund_id, date, nav_price, return_1y, return_3y, return_5y
```
- `is_benchmark=true` → benchmark alap (jelenleg: "HK Index" shortName-mel)
- `fund_prices.nav_price` → az árfolyam, ebből számolódik minden metrika

## Típusok (page.tsx teteje)
- `Fund` — alap metaadata
- `PriceRow` — egy napi árfolyam sor
- `DataSeries` — feldolgozott sorozat (id, name, shortName, color, points[], isBenchmark)
- `DataPoint` — `{ date, value }` (date: ISO string, value: nav_price)
- `DrawPeriod` — egy drawdown/drawup epizód
- `PeriodSeriesMetrics` — egy sorozat metrikái egy időszakra (totalReturn, stdDev, sharpe, alpha, beta, indScores, totalScore)

## State (Dashboard komponens)
- `funds` — összes alap Supabase-ből
- `selectedIds` — user által kiválasztott alap id-k (benchmark NEM kerül bele automatikusan — ez egy ismert bug)
- `prices` — `Record<fundId, PriceRow[]>` — betöltött árfolyamok
- `period` — `'1y' | '3y' | '5y' | 'all'` — kiválasztott időszak
- `metric` — `'pct' | 'return_1y' | 'return_3y' | 'return_5y'` — főgrafikon y-tengelye
- `selectedPeriodId` — kiválasztott drawdown/drawup epizód id

## Számítási pipeline
1. `prices` (raw) → `allSeries: DataSeries[]` (useMemo) — normalizált pontsorozatok
2. `allSeries` → `chartData` (useMemo) — Recharts-kompatibilis, normalizált % vagy return érték
3. `allSeries` → `allDrawPeriods: DrawPeriod[]` (useMemo) — HWM/LWM algoritmus, top 3 epizód/sorozat/típus
4. `allSeries` + időszak → `mainMetrics: PeriodSeriesMetrics[]` (useMemo) — kockázat-hozam tábla adatai

## Metrika számítás (`computeRawMetrics`)
- `totalReturn` — (záró-nyitó)/nyitó * 100
- `stdDev` — napi hozamok szórása * √252 * 100 (annualizált)
- `sharpe` — (annualizált hozam - RISK_FREE=6) / stdDev
- `alpha`, `beta` — OLS regresszió napi hozamok alapján, ±3 napos dátum toleranciával; csak nem-benchmark sorozatoknál
- Scoring: min-max normalizáció, súlyok: Sharpe 35%, Alfa 30%, Béta 20%, Szórás 15%

## UI szekciók
1. **Fejléc** — alap/benchmark számlálóval
2. **Vezérlők** — időszak toggle + alap kiválasztó gombok
3. **Főgrafikon** — Recharts LineChart, normalizált % vagy rolling return
4. **Kockázat-hozam elemzés** — alfa, béta, sharpe, szórás, score tábla (`ExplainRow` hover tooltipekkel)
5. **Időszak elemző** — drawdown/drawup lista + `PeriodDetail` (mini grafikon + metrika tábla)
6. **Összefoglaló tábla** (`SummaryTable`) — átlagos score minden sorozatra, rangsor

## Ismert hibák (javítandó)
- Benchmark adatai nem töltődnek be és nem jelennek meg automatikusan (`selectedIds`-tól függ a betöltés és az `allSeries`)
- React key prop warning a `PeriodDetail`-ben (duplikált seriesId ha benchmark kétszer kerül allSeries-be)

## Színek
- `COLORS` — nem-benchmark alapok: kék, sárga, zöld, piros, lila, cián
- `BM_COLOR = '#94a3b8'` — benchmark: slate-400
- `RISK_FREE = 6` — évi 6% kockázatmentes hozam (HUF alapok)

