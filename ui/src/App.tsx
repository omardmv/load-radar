import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// ---------- API types (live/server.ts) ----------
type Lat = { p50: number | null; p95: number | null; p99: number | null }
type Score = { expected: number; delivered: number; missed: number; missedOpen5Min: number; duplicates: number; unexpected: number; backfill: number; late: number; cancelled: number; missRate: number; latencySec: Lat }
type Stats = {
  seed: number; now: number; speed: number; loadsPerDay: number; users: number; searches: number
  world: { loads: number; postings: number; perBoard: Record<string, number>; scheduled: number }
  boards: { ok: number; rejected: number; bannedRequests: number; bannedLogins: number }
  engine: { polls: number; postings: number; newLoads: number; alertsSent: number; alertsDropped: number; alertQueue: number; rawQueue: number; scheduler: { paused: number; banned: number; credentials: number } }
  score: { all: Score; you: Score; pending: number }
}
type Posting = { at: number; board: string; kind: string; loadId: string; from: string; to: string; equipment: string; rate: number | null; miles: number; pickup: string }
type Alert = { at: number; lines: string[]; loads: { loadId: string; latencySec: number | null; expected: boolean; backfill?: boolean; late?: boolean }[] }
type Saved = { spec: { searchId: string }; text: string; summary: string; createdAt: number }
type Call = { model: string; latencyMs: number; traceId: string | null }
type Parsed = { result: { equipment: string | null; origin: { city: string; state: string } | null; questions: string[]; sources: Record<string, string> }; summary: string; calls: Call[]; fallback: boolean; error?: string }

const LANGFUSE = 'http://localhost:3001/project/load-radar-parser/traces/'
const LINKS = [['Grafana', 'http://localhost:3000'], ['Langfuse', 'http://localhost:3001'], ['Jaeger', 'http://localhost:16686'], ['Prometheus', 'http://localhost:9090']]
const EQUIP = ['van', 'reefer', 'flatbed']
const BURSTS = [['Chicago', 'van'], ['Dallas', 'flatbed'], ['Fresno', 'reefer']]

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const central = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const n = (x: number) => x.toLocaleString('en-US')
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const sec = (x: number | null) => (x === null ? '—' : x < 60 ? `${x.toFixed(1)} s` : `${(x / 60).toFixed(1)} min`)

function useLive() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [postings, setPostings] = useState<Posting[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [saved, setSaved] = useState<Saved[]>([])
  const [rates, setRates] = useState({ postings: 0, alerts: 0 })
  const prev = useRef<{ t: number; postings: number; alerts: number } | null>(null)
  useEffect(() => {
    fetch('/api/state').then((r) => r.json()).then((s) => { setPostings(s.postings); setAlerts(s.alerts); setSaved(s.you) })
    const es = new EventSource('/api/events')
    es.addEventListener('stats', (e) => {
      const s: Stats = JSON.parse(e.data)
      const p = prev.current, t = Date.now()
      if (p) setRates({ postings: ((s.world.postings - p.postings) * 60_000) / (t - p.t), alerts: ((s.engine.alertsSent - p.alerts) * 60_000) / (t - p.t) })
      prev.current = { t, postings: s.world.postings, alerts: s.engine.alertsSent }
      setStats(s)
    })
    es.addEventListener('postings', (e) => setPostings((xs) => [...(JSON.parse(e.data) as Posting[]).reverse(), ...xs].slice(0, 80)))
    es.addEventListener('alert', (e) => setAlerts((xs) => [JSON.parse(e.data) as Alert, ...xs].slice(0, 100)))
    return () => es.close()
  }, [])
  return { stats, postings, alerts, saved, setSaved, rates }
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'bad' | 'good' }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader><CardDescription>{label}</CardDescription></CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold tabular-nums ${tone === 'bad' ? 'text-red-600' : tone === 'good' ? 'text-emerald-600' : ''}`}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground tabular-nums">{hint}</div>}
      </CardContent>
    </Card>
  )
}

function Controls({ stats }: { stats: Stats }) {
  const [speed, setSpeed] = useState(stats.speed)
  useEffect(() => setSpeed(stats.speed), [stats.speed])
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Speed</span>
        <div className="w-40"><Slider min={1} max={120} value={[speed]} onValueChange={(v) => setSpeed(Array.isArray(v) ? v[0] : v)}
          onValueCommitted={(v) => post('/api/speed', { speed: Array.isArray(v) ? v[0] : v })} /></div>
        <span className="w-12 text-sm font-medium tabular-nums">{speed}×</span>
        {speed > 30 && <span className="text-xs text-amber-700">above ~30× one laptop core can't keep up: you are load-testing</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Freight</span>
        {[10_000, 20_000, 100_000].map((x) => (
          <Button key={x} size="sm" variant={stats.loadsPerDay === x ? 'default' : 'outline'} onClick={() => post('/api/rate', { loadsPerDay: x })}>{n(x / 1000)}K loads/day</Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Burst 500</span>
        {BURSTS.map(([city, equipment]) => (
          <Button key={city} size="sm" variant="outline" onClick={() => post('/api/burst', { city, equipment, count: 500 })}>{equipment} out of {city}</Button>
        ))}
      </div>
    </div>
  )
}

function Searches({ saved, setSaved, you }: { saved: Saved[]; setSaved: (f: (s: Saved[]) => Saved[]) => void; you: Score | undefined }) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [equipment, setEquipment] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const check = async () => { if (!text.trim()) return; setBusy(true); setEquipment(null); setParsed(await post('/api/parse', { text })); setBusy(false) }
  const save = async () => {
    setBusy(true)
    const r = await post('/api/searches', { text, ...(equipment ? { equipment } : {}) })
    setBusy(false)
    if (r.search) { setSaved((s) => [...s, r.search]); setText(''); setParsed(null) } else setParsed(r)
  }
  const remove = async (id: string) => { await fetch(`/api/searches/${id}`, { method: 'DELETE' }); setSaved((s) => s.filter((x) => x.spec.searchId !== id)) }
  const needsEquip = parsed && !parsed.result.equipment
  return (
    <Card className="min-h-0">
      <CardHeader>
        <CardTitle>Your searches</CardTitle>
        <CardDescription>Type it the way a dispatcher would. Rules + GLiNER2 read it; unclear parts become questions.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void (parsed ? save() : check()) }}>
          <Input placeholder="reefer out of fresno, 3.20 min, 100 mi deadhead" value={text} onChange={(e) => { setText(e.target.value); setParsed(null) }} />
          {!parsed && <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Reading…' : 'Check'}</Button>}
        </form>
        {parsed && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="font-medium">{parsed.summary}</div>
            {parsed.error && <div className="mt-1 text-red-600">{parsed.error}</div>}
            {parsed.result.questions.map((q) => <div key={q} className="mt-1 text-amber-700">? {q}</div>)}
            {needsEquip && (
              <div className="mt-2 flex gap-2">{EQUIP.map((e) => <Button key={e} size="xs" variant={equipment === e ? 'default' : 'outline'} onClick={() => setEquipment(e)}>{e}</Button>)}</div>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(parsed.result.sources).map(([k, v]) => <Badge key={k} variant={v === 'model' ? 'default' : 'secondary'}>{k}: {v}</Badge>)}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {parsed.fallback && 'GLiNER2 unreachable, rules only. '}
              {parsed.calls.length === 0 ? 'No model call needed: rules understood everything.' : parsed.calls.map((c) => (
                <span key={c.traceId ?? c.model}>{c.model} · {c.latencyMs} ms {c.traceId && <a className="underline" href={LANGFUSE + c.traceId} target="_blank">trace</a>} </span>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={save} disabled={busy || Boolean(needsEquip && !equipment)}>{needsEquip && !equipment ? 'Pick equipment to save' : 'Save search'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setParsed(null)}>Edit</Button>
            </div>
          </div>
        )}
        <Separator />
        {saved.length === 0 && <div className="text-sm text-muted-foreground">No searches yet. Alerts start with loads posted after you save.</div>}
        {saved.map((s) => (
          <div key={s.spec.searchId} className="flex items-start justify-between gap-2 text-sm">
            <div><div className="font-medium">{s.summary}</div><div className="text-xs text-muted-foreground">“{s.text}”</div></div>
            <Button size="xs" variant="ghost" onClick={() => remove(s.spec.searchId)}>Remove</Button>
          </div>
        ))}
        {you && saved.length > 0 && (
          <div className="grid grid-cols-4 gap-2 rounded-lg border p-2 text-center text-xs">
            <div><div className="text-muted-foreground">expected</div><div className="text-base font-semibold tabular-nums">{you.expected}</div></div>
            <div><div className="text-muted-foreground">delivered</div><div className="text-base font-semibold tabular-nums">{you.delivered}</div></div>
            <div><div className="text-muted-foreground">missed</div><div className="text-base font-semibold tabular-nums">{you.missed}{you.late ? <span className="text-xs font-normal text-muted-foreground"> ({you.late} late)</span> : null}</div></div>
            <div><div className="text-muted-foreground">p50</div><div className="text-base font-semibold tabular-nums">{sec(you.latencySec.p50)}</div></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Alerts({ alerts }: { alerts: Alert[] }) {
  return (
    <Card className="min-h-0">
      <CardHeader><CardTitle>Your alerts</CardTitle><CardDescription>What the Telegram bot sent you. Time is US Central (simulated).</CardDescription></CardHeader>
      <CardContent className="min-h-0">
        <ScrollArea className="h-[calc(100vh-22rem)] pr-3">
          {alerts.length === 0 && <div className="text-sm text-muted-foreground">Nothing yet.</div>}
          <div className="flex flex-col gap-2">
            {alerts.map((a, i) => (
              <div key={`${a.at}-${i}`} className="rounded-2xl rounded-tl-sm bg-sky-50 p-3 text-sm dark:bg-sky-950">
                {a.lines.map((l, j) => <div key={j}>{l}</div>)}
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">{central(a.at)}</span>
                  {a.loads.map((x) => x.expected
                    ? <Badge key={x.loadId} variant="secondary">{sec(x.latencySec)} after posting</Badge>
                    : x.late ? <Badge key={x.loadId} variant="destructive">late: {sec(x.latencySec)} (after the 15 min cutoff)</Badge>
                    : x.backfill ? <Badge key={x.loadId} variant="outline">already on the board when you saved</Badge>
                    : <Badge key={x.loadId} variant="destructive">not in answer key</Badge>)}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

const BOARD_COLOR: Record<string, string> = { dat: 'bg-blue-100 text-blue-800', truckstop: 'bg-orange-100 text-orange-800', portal_a: 'bg-violet-100 text-violet-800', portal_b: 'bg-teal-100 text-teal-800' }

function Firehose({ postings }: { postings: Posting[] }) {
  return (
    <Card className="min-h-0">
      <CardHeader><CardTitle>Board firehose</CardTitle><CardDescription>Every posting as it appears on the simulated boards: new loads, refreshes, reposts, copies on other boards.</CardDescription></CardHeader>
      <CardContent className="min-h-0">
        <ScrollArea className="h-[calc(100vh-22rem)]">
          <Table>
            <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Board</TableHead><TableHead>Lane</TableHead><TableHead>Equip</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader>
            <TableBody>
              {postings.map((p, i) => (
                <TableRow key={`${p.loadId}-${p.at}-${i}`}>
                  <TableCell className="tabular-nums text-muted-foreground">{central(p.at)}</TableCell>
                  <TableCell><span className={`rounded px-1.5 py-0.5 text-xs ${BOARD_COLOR[p.board]}`}>{p.board}</span>{p.kind !== 'first' && <span className="ml-1 text-xs text-muted-foreground">{p.kind.replace('_', ' ')}</span>}</TableCell>
                  <TableCell className="max-w-64 truncate">{p.from} → {p.to} <span className="text-muted-foreground">· {p.miles} mi</span></TableCell>
                  <TableCell>{p.equipment}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.rate ? `$${n(p.rate)}` : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export default function App() {
  const { stats, postings, alerts, saved, setSaved, rates } = useLive()
  const all = stats?.score.all
  const missTone = useMemo(() => (all && all.missRate > 0.05 ? 'bad' : 'good'), [all])
  return (
    <div className="flex h-screen flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">Load Radar <span className="text-muted-foreground font-normal">live</span></h1>
          {stats && <span className="text-sm tabular-nums text-muted-foreground">{central(stats.now)} CT · world seed {stats.seed} · {n(stats.users)} dispatchers · {n(stats.searches)} searches</span>}
        </div>
        <nav className="flex gap-3 text-sm">{LINKS.map(([k, v]) => <a key={k} className="text-muted-foreground hover:text-foreground" href={v} target="_blank">{k}</a>)}</nav>
      </header>
      {!stats ? <div className="text-muted-foreground">Connecting…</div> : (
        <>
          <Controls stats={stats} />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Stat label="Postings" value={n(stats.world.postings)} hint={`${n(Math.round(rates.postings))}/min · ${n(stats.world.loads)} real loads`} />
            <Stat label="Board requests" value={n(stats.boards.ok)} hint={`${n(stats.boards.rejected)} × 429 · ${stats.engine.scheduler.banned} of ${stats.engine.scheduler.credentials} logins banned`} tone={stats.engine.scheduler.banned ? 'bad' : undefined} />
            <Stat label="Alerts sent" value={n(stats.engine.alertsSent)} hint={`${n(Math.round(rates.alerts))}/min · ${stats.engine.alertsDropped} dropped`} />
            <Stat label="Missed" value={pct(all!.missRate)} hint={`${n(all!.missed)} of ${n(all!.delivered + all!.missed)} settled`} tone={missTone} />
            <Stat label="Post → alert p50" value={sec(all!.latencySec.p50)} hint={`p95 ${sec(all!.latencySec.p95)} · p99 ${sec(all!.latencySec.p99)}`} />
            <Stat label="Duplicates" value={n(all!.duplicates)} hint={`${n(all!.late)} late · ${n(all!.unexpected)} not in answer key`} />
            <Stat label="Queues" value={n(stats.engine.rawQueue + stats.engine.alertQueue)} hint={`raw ${n(stats.engine.rawQueue)} · alerts ${n(stats.engine.alertQueue)} · ${stats.engine.scheduler.paused} logins paused`} />
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr_1.4fr]">
            <Searches saved={saved} setSaved={setSaved} you={stats.score.you} />
            <Alerts alerts={alerts} />
            <Firehose postings={postings} />
          </div>
        </>
      )}
    </div>
  )
}
