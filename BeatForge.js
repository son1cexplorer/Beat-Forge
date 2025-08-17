// BeatForge — single-file React drum machine using Web Audio API
// --------------------------------------------------------------
// Quick start:
// - Drop into a React app (uses Tailwind + shadcn/ui components available in Canvas)
// - Press Play ▶, click steps to toggle beats, adjust BPM & Swing
// - Save/Load patterns to localStorage, Share via URL, Export to WAV
//
// Notes:
// - All code/comments are in English per user preference.
// - No external samples; drums are synthesized (kick/snare/hats/clap) in Web Audio.
// - Latency-compensated scheduler (~5–10ms lookahead) for tight timing.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download, Link as LinkIcon, Play, Square, Save, Upload, Volume2, Trash2, Music2 } from "lucide-react";

// ==== Types & defaults ====
const TRACKS = [
  { id: "kick", name: "Kick", color: "bg-rose-500" },
  { id: "snare", name: "Snare", color: "bg-sky-500" },
  { id: "hat", name: "Hi-Hat", color: "bg-emerald-500" },
  { id: "clap", name: "Clap", color: "bg-amber-500" },
];
const STEPS = 16; // 16th notes in a 4/4 bar

const DEFAULT_PATTERN = () => ({
  name: "New Pattern",
  bpm: 120,
  swing: 0, // 0..100 (% applied to off-beats)
  gain: 0.9,
  tracks: Object.fromEntries(
    TRACKS.map(t => [t.id, Array.from({ length: STEPS }, (_, i) => (t.id === "kick" ? (i % 4 === 0) : false))])
  )
});

const LS_KEY = "beatforge:patterns";

// ==== Web Audio engine ====
class DrumEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null; // GainNode
    this.comp = null;   // DynamicsCompressorNode
    this.metGain = null; // metronome gain

    // scheduler
    this.isRunning = false;
    this.scheduleId = 0;
    this.nextNoteTime = 0; // in ctx time
    this.currentStep = 0;

    // lookahead & schedule window (ms)
    this.lookahead = 25; // ms
    this.scheduleAheadTime = 0.1; // s

    // callbacks
    this.onStep = () => {};
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;

      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12;
      this.comp.knee.value = 30;
      this.comp.ratio.value = 3;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.25;

      this.metGain = this.ctx.createGain();
      this.metGain.gain.value = 0.0; // off by default

      this.metGain.connect(this.comp);
      this.master.connect(this.comp);
      this.comp.connect(this.ctx.destination);
    }
  }

  setMasterGain(v) {
    this.ensureCtx();
    this.master.gain.value = v;
  }

  setMetronome(on) {
    this.ensureCtx();
    this.metGain.gain.value = on ? 0.25 : 0.0;
  }

  // --- Synths ---
  playKick(time, velocity=1) {
    const ctx = this.ctx; this.ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(130, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(velocity, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);

    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = "triangle";
    click.frequency.setValueAtTime(1000, time);
    clickGain.gain.setValueAtTime(0.001, time);
    clickGain.gain.exponentialRampToValueAtTime(0.2*velocity, time + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);

    osc.connect(gain).connect(this.master);
    click.connect(clickGain).connect(this.master);
    osc.start(time); osc.stop(time + 0.5);
    click.start(time); click.stop(time + 0.05);
  }

  playSnare(time, velocity=1) {
    const ctx = this.ctx; this.ensureCtx();
    // noise
    const bufferSize = ctx.sampleRate * 0.2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i=0;i<bufferSize;i++) data[i] = Math.random()*2-1;

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1800;
    const snGain = ctx.createGain(); snGain.gain.setValueAtTime(velocity*0.6, time);
    snGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);

    noise.connect(hp).connect(snGain).connect(this.master);

    // tone
    const osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.setValueAtTime(200, time);
    const toneGain = ctx.createGain(); toneGain.gain.setValueAtTime(0.2*velocity, time);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
    osc.connect(toneGain).connect(this.master);

    noise.start(time); noise.stop(time + 0.2);
    osc.start(time); osc.stop(time + 0.2);
  }

  playHat(time, velocity=1, open=false) {
    const ctx = this.ctx; this.ensureCtx();
    // metallic noise by summing detuned squares
    const freqs = [40, 50, 60, 72, 80].map(f=>f*40);
    const gains = [];
    const mix = ctx.createGain(); mix.gain.value = 0.15*velocity;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 10000; bp.Q.value = 0.5;

    freqs.forEach(f => {
      const o = ctx.createOscillator(); o.type = "square"; o.frequency.setValueAtTime(f, time);
      const g = ctx.createGain(); g.gain.value = 0.0001; // envelope below
      o.connect(g).connect(mix);
      o.start(time); o.stop(time + (open ? 0.4 : 0.08));
      gains.push(g);
    });

    const env = (dur) => {
      gains.forEach(g => {
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.4*velocity, time + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      });
    };

    env(open ? 0.35 : 0.06);
    mix.connect(hp).connect(bp).connect(this.master);
  }

  playClap(time, velocity=1) {
    const ctx = this.ctx; this.ensureCtx();
    // multi-burst noise for clap
    const burst = (t, amp) => {
      const dur = 0.05;
      const bufferSize = ctx.sampleRate * dur;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i=0;i<bufferSize;i++) data[i] = (Math.random()*2-1) * amp;
      const src = ctx.createBufferSource(); src.buffer = buffer;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(bp).connect(g).connect(this.master);
      src.start(t); src.stop(t + dur);
    };
    burst(time, 0.6*velocity);
    burst(time + 0.012, 0.5*velocity);
    burst(time + 0.024, 0.4*velocity);
  }

  playMetronome(time, accent=false) {
    const ctx = this.ctx; this.ensureCtx();
    const o = ctx.createOscillator(); o.type = "square"; o.frequency.setValueAtTime(accent?1600:1100, time);
    const g = ctx.createGain(); g.gain.setValueAtTime(accent?0.12:0.07, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    o.connect(g).connect(this.metGain);
    o.start(time); o.stop(time + 0.06);
  }

  // --- Transport ---
  start(pattern) {
    this.ensureCtx();
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentStep = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this._scheduler(pattern);
  }

  stop() {
    this.isRunning = false;
    if (this.scheduleId) clearTimeout(this.scheduleId);
  }

  _advance(pattern) {
    const sixteenthNoteTime = 60.0 / pattern.bpm / 4; // seconds per 16th

    // swing: delay off-beats (odd steps) by up to +swing%
    const isOff = this.currentStep % 2 === 1;
    const swingRatio = (pattern.swing || 0) / 100; // 0..1
    const swingOffset = isOff ? sixteenthNoteTime * swingRatio * 0.5 : 0; // gentle swing

    this.nextNoteTime += sixteenthNoteTime + swingOffset;
    this.currentStep = (this.currentStep + 1) % STEPS;
  }

  _scheduleStep(step, time, pattern) {
    const v = 1.0;
    const t = pattern.tracks;
    if (t.kick?.[step]) this.playKick(time, v);
    if (t.snare?.[step]) this.playSnare(time, v);
    if (t.hat?.[step]) this.playHat(time, v, step % 4 === 2 && t.hat[step]); // open hat on 3rd beat example
    if (t.clap?.[step]) this.playClap(time, v);

    const beat = step % 4 === 0;
    this.onStep(step, time);
    this.playMetronome(time, beat);
  }

  _scheduler(pattern) {
    if (!this.isRunning) return;
    const ctx = this.ctx;
    while (this.nextNoteTime < ctx.currentTime + this.scheduleAheadTime) {
      this._scheduleStep(this.currentStep, this.nextNoteTime, pattern);
      this._advance(pattern);
    }
    this.scheduleId = setTimeout(() => this._scheduler(pattern), this.lookahead);
  }
}

// ==== Helpers ====
const usePersistentState = (key, initial) => {
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key) || ""); } catch { return initial; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(state)); }, [key, state]);
  return [state, setState];
};

const encodePatternToURL = (p) => {
  const payload = {
    n: p.name, b: p.bpm, s: p.swing, g: p.gain,
    t: TRACKS.map(tr => p.tracks[tr.id])
  };
  const j = JSON.stringify(payload);
  return new URLSearchParams({ p: btoa(unescape(encodeURIComponent(j))) }).toString();
};

const decodePatternFromURL = () => {
  const sp = new URLSearchParams(window.location.search);
  const raw = sp.get("p");
  if (!raw) return null;
  try {
    const j = decodeURIComponent(escape(atob(raw)));
    const o = JSON.parse(j);
    return {
      name: o.n || "Shared Pattern",
      bpm: o.b || 120,
      swing: o.s || 0,
      gain: o.g || 0.9,
      tracks: Object.fromEntries(TRACKS.map((tr, i) => [tr.id, o.t?.[i] || Array(STEPS).fill(false)]))
    };
  } catch { return null; }
};

// ==== Main component ====
export default function BeatForge() {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new DrumEngine();

  const urlPattern = useMemo(() => decodePatternFromURL(), []);
  const [pattern, setPattern] = useState(urlPattern || DEFAULT_PATTERN());
  const [library, setLibrary] = usePersistentState(LS_KEY, []);
  const [playing, setPlaying] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);

  // connect engine callbacks
  useEffect(() => {
    const engine = engineRef.current;
    engine.onStep = (step) => setCurrentStep(step);
    engine.setMasterGain(pattern.gain);
    engine.setMetronome(metronome);
  }, [pattern.gain, metronome]);

  // transport handlers
  const handlePlay = () => {
    engineRef.current.setMasterGain(pattern.gain);
    engineRef.current.start(pattern);
    setPlaying(true);
  };
  const handleStop = () => {
    engineRef.current.stop();
    setPlaying(false);
    setCurrentStep(-1);
  };

  // pattern ops
  const toggleStep = (trackId, stepIdx) => {
    setPattern(p => ({
      ...p,
      tracks: {
        ...p.tracks,
        [trackId]: p.tracks[trackId].map((v, i) => (i === stepIdx ? !v : v))
      }
    }));
  };

  const clearTrack = (trackId) => {
    setPattern(p => ({ ...p, tracks: { ...p.tracks, [trackId]: Array(STEPS).fill(false) } }));
  };

  const randomize = () => {
    setPattern(p => ({
      ...p,
      tracks: Object.fromEntries(TRACKS.map(tr => [
        tr.id,
        Array.from({length: STEPS}, (_,i)=> Math.random() < (tr.id === "kick" ? 0.28 : tr.id === "snare" ? 0.22 : 0.35))
      ]))
    }));
  };

  const saveToLibrary = () => {
    const entry = { ...pattern, id: crypto.randomUUID(), savedAt: Date.now() };
    setLibrary(arr => [entry, ...arr].slice(0, 50));
  };

  const loadFromLibrary = (entry) => {
    setPattern({ name: entry.name, bpm: entry.bpm, swing: entry.swing, gain: entry.gain, tracks: entry.tracks });
  };

  const removeFromLibrary = (entryId) => {
    setLibrary(arr => arr.filter(x => x.id !== entryId));
  };

  const shareURL = () => {
    const qs = encodePatternToURL(pattern);
    const url = `${window.location.origin}${window.location.pathname}?${qs}`;
    navigator.clipboard?.writeText(url);
    alert("Share URL copied to clipboard!\n" + url);
  };

  const exportWav = async () => {
    // OfflineAudioContext render to WAV
    const sr = 44100;
    const bars = 1; // render 1 bar
    const seconds = (60/pattern.bpm) * 4 * bars;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds*sr), sr);

    const master = ctx.createGain(); master.gain.value = pattern.gain;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);

    // small copy of DrumEngine synths for offline render
    const playKick = (t) => {
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.type = "sine"; osc.frequency.setValueAtTime(130, t); osc.frequency.exponentialRampToValueAtTime(40, t+0.12);
      g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(1, t+0.005); g.gain.exponentialRampToValueAtTime(0.001, t+0.3);
      osc.connect(g).connect(master); osc.start(t); osc.stop(t+0.5);
    };
    const playSnare = (t) => {
      const dur=0.2; const buffer = ctx.createBuffer(1, ctx.sampleRate*dur, ctx.sampleRate); const data=buffer.getChannelData(0);
      for(let i=0;i<data.length;i++) data[i] = Math.random()*2-1;
      const src = ctx.createBufferSource(); src.buffer=buffer; const hp = ctx.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=1800; const g=ctx.createGain(); g.gain.setValueAtTime(0.6,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.18);
      const o=ctx.createOscillator(); o.type="triangle"; o.frequency.setValueAtTime(200,t); const tg=ctx.createGain(); tg.gain.setValueAtTime(0.2,t); tg.gain.exponentialRampToValueAtTime(0.001,t+0.12);
      src.connect(hp).connect(g).connect(master); o.connect(tg).connect(master); src.start(t); src.stop(t+dur); o.start(t); o.stop(t+0.2);
    };
    const playHat = (t, open=false) => {
      const freqs=[1600,2000,2400,2880,3200]; const mix=ctx.createGain(); mix.gain.value=0.15; const hp=ctx.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=7000; const bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=10000; bp.Q.value=0.5;
      freqs.forEach(f=>{ const o=ctx.createOscillator(); o.type="square"; o.frequency.setValueAtTime(f,t); const g=ctx.createGain(); g.gain.setValueAtTime(0.001,t); g.gain.exponentialRampToValueAtTime(0.4,t+0.002); g.gain.exponentialRampToValueAtTime(0.001,t+(open?0.35:0.06)); o.connect(g).connect(mix); o.start(t); o.stop(t+(open?0.4:0.08)); });
      mix.connect(hp).connect(bp).connect(master);
    };
    const playClap = (t) => {
      const burst=(tb,amp)=>{ const d=0.05; const buf=ctx.createBuffer(1, ctx.sampleRate*d, ctx.sampleRate); const ch=buf.getChannelData(0); for(let i=0;i<ch.length;i++) ch[i]=(Math.random()*2-1)*amp; const src=ctx.createBufferSource(); src.buffer=buf; const bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=1500; bp.Q.value=0.8; const g=ctx.createGain(); g.gain.setValueAtTime(1,tb); g.gain.exponentialRampToValueAtTime(0.001,tb+d); src.connect(bp).connect(g).connect(master); src.start(tb); src.stop(tb+d);};
      burst(t,0.6); burst(t+0.012,0.5); burst(t+0.024,0.4);
    };

    const sixteenth = 60/pattern.bpm/4;
    const swingRatio = (pattern.swing||0)/100;
    for (let step=0; step<STEPS; step++) {
      const base = step*sixteenth;
      const isOff = step%2===1; const swing = isOff ? sixteenth*swingRatio*0.5 : 0;
      const t = base + swing;
      if (pattern.tracks.kick?.[step]) playKick(t);
      if (pattern.tracks.snare?.[step]) playSnare(t);
      if (pattern.tracks.hat?.[step]) playHat(t, step%4===2 && pattern.tracks.hat[step]);
      if (pattern.tracks.clap?.[step]) playClap(t);
    }

    const rendered = await ctx.startRendering();
    // to WAV
    const wav = audioBufferToWav(rendered);
    const blob = new Blob([new DataView(wav)], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${pattern.name.replace(/\s+/g,'_')}.wav`; a.click();
    URL.revokeObjectURL(url);
  };

  // render
  return (
    <div className="w-full h-screen grid grid-rows-[auto_1fr]">
      <header className="p-4 border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Music2 className="w-6 h-6"/>
            <div>
              <h1 className="text-xl font-bold">BeatForge</h1>
              <p className="text-xs text-muted-foreground">Create simple beats & share instantly</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!playing ? (
              <Button onClick={handlePlay} className="gap-2"><Play className="w-4 h-4"/> Play</Button>
            ) : (
              <Button variant="destructive" onClick={handleStop} className="gap-2"><Square className="w-4 h-4"/> Stop</Button>
            )}
            <Button variant="outline" onClick={shareURL} className="gap-2"><LinkIcon className="w-4 h-4"/> Share</Button>
            <Button variant="outline" onClick={exportWav} className="gap-2"><Download className="w-4 h-4"/> Export WAV</Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full p-4 grid gap-4 grid-cols-1 xl:grid-cols-[1fr_320px]">
        {/* Sequencer */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Sequencer (16 steps)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4 mb-4">
              <div className="flex items-center gap-2 w-48">
                <span className="text-xs w-10">BPM</span>
                <Slider value={[pattern.bpm]} min={60} max={200} step={1} onValueChange={v=>setPattern(p=>({...p,bpm:v[0]}))}/>
                <Input type="number" className="w-20" value={pattern.bpm} onChange={e=>setPattern(p=>({...p,bpm:Math.max(40, Math.min(240, Number(e.target.value)||0))}))}/>
              </div>
              <div className="flex items-center gap-2 w-56">
                <span className="text-xs w-12">Swing</span>
                <Slider value={[pattern.swing]} min={0} max={100} step={1} onValueChange={v=>setPattern(p=>({...p,swing:v[0]}))}/>
                <Input type="number" className="w-20" value={pattern.swing} onChange={e=>setPattern(p=>({...p,swing:Math.max(0, Math.min(100, Number(e.target.value)||0))}))}/>
              </div>
              <div className="flex items-center gap-2 w-56">
                <span className="text-xs w-12 flex items-center gap-1"><Volume2 className="w-4 h-4"/>Gain</span>
                <Slider value={[Math.round(pattern.gain*100)]} min={10} max={120} step={1} onValueChange={v=>setPattern(p=>({...p,gain:v[0]/100}))}/>
                <Input type="number" className="w-20" value={Math.round(pattern.gain*100)} onChange={e=>setPattern(p=>({...p,gain:Math.max(10, Math.min(120, Number(e.target.value)||0))/100}))}/>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs">Metronome</span>
                <Switch checked={metronome} onCheckedChange={setMetronome}/>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Input className="w-48" value={pattern.name} onChange={e=>setPattern(p=>({...p,name:e.target.value}))}/>
                <Button variant="outline" className="gap-2" onClick={randomize}><Upload className="w-4 h-4"/> Randomize</Button>
              </div>
            </div>

            <div className="space-y-3">
              {TRACKS.map(tr => (
                <div key={tr.id} className="flex items-center gap-3">
                  <div className="w-28 flex items-center gap-2">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${tr.color}`}/>
                    <span className="text-sm font-medium">{tr.name}</span>
                    <Button size="sm" variant="ghost" onClick={()=>clearTrack(tr.id)} title="Clear track"><Trash2 className="w-4 h-4"/></Button>
                  </div>

                  <div className="grid grid-cols-16 gap-1 flex-1">
                    {Array.from({ length: STEPS }).map((_, i) => {
                      const active = !!pattern.tracks[tr.id][i];
                      const isBeat = i % 4 === 0;
                      const isCurrent = i === currentStep && playing;
                      return (
                        <button
                          key={i}
                          onClick={()=>toggleStep(tr.id, i)}
                          className={`group relative aspect-square rounded-xl border transition 
                            ${active ? "bg-gray-900 text-white" : "bg-white"}
                            ${isBeat ? "border-gray-400" : "border-gray-200"}
                            ${isCurrent ? "ring-2 ring-blue-500" : ""}
                          `}
                          aria-label={`${tr.name} step ${i+1}`}
                        >
                          <span className="absolute inset-0 grid place-items-center text-[10px] opacity-0 group-hover:opacity-60">
                            {i+1}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Library */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2 flex items-center justify-between">
            <CardTitle className="text-base">Library</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-3">
              <Button className="gap-2" onClick={saveToLibrary}><Save className="w-4 h-4"/> Save Pattern</Button>
              <Badge variant="secondary">{library.length} saved</Badge>
            </div>
            <ScrollArea className="h-[540px] pr-2">
              <div className="space-y-2">
                {library.length===0 && (
                  <p className="text-sm text-muted-foreground">No saved patterns yet. Click "Save Pattern" to store this setup.</p>
                )}
                {library.map(entry => (
                  <div key={entry.id} className="border rounded-xl p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{entry.name}</div>
                      <div className="text-xs text-muted-foreground">{new Date(entry.savedAt).toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">BPM {entry.bpm} • Swing {entry.swing}%</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={()=>loadFromLibrary(entry)}>Load</Button>
                      <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={()=>removeFromLibrary(entry.id)}><Trash2 className="w-4 h-4 mr-1"/>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

// ==== Utilities: audio buffer → WAV ====
function audioBufferToWav(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const samples = buffer.getChannelData(0);
  const length = buffer.length * numOfChan * 2 + 44;
  const arrayBuffer = new ArrayBuffer(length);
  const view = new DataView(arrayBuffer);

  // write WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + buffer.length * numOfChan * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numOfChan * bitDepth/8, true);
  view.setUint16(32, numOfChan * bitDepth/8, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, buffer.length * numOfChan * bitDepth/8, true);

  // write interleaved data
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numOfChan; ch++) {
      let sample = buffer.getChannelData(ch)[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return arrayBuffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}
