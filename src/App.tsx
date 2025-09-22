import { useEffect, useRef, useState } from "react";
import dutchWords from './assets/nederlands-5.txt?url';
import englishWords from './assets/english-5.txt?url';


// Shirt Button Cannon — single-file React Canvas game.
// Optional CSV/TXT upload of allowed 5-letter words (first column). If none uploaded, any 5 letters count.
// Cannon at bottom rotates to cursor; click to fire (cooldown). No gravity; projectile stops on first hit.
// Keyboard wall: staggered rows. Starts with 3 rows. Every X seconds: shift all rows down + spawn a new row at the top.
// Game over when 10 rows are VISIBLE on screen.
// Includes lightweight runtime self-tests (console.assert) that do not affect gameplay.

export default function ShirtButtonCannon() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Geometry & timing constants
  const KEY_W = 64;
  const KEY_H = 42;
  const KEY_R = 10; // rounded corners
  const KEY_HSP = 12; // horizontal spacing
  const KEY_VSP = 12; // vertical spacing
  const OFFSET_PER_ROW = (KEY_W + KEY_HSP) / 2; // ~half key width for stagger
  let currentRowOffset = 0;

  const MAX_ROWS = 10; // max visible rows on screen before game over
  const ROW_INTERVAL = 30; // seconds per new row
  const INVALID_WORD_ROW_PENALTY = 15; // seconds shaved off the next spawn when a word is rejected
  const COOLDOWN_TIME = 0.5; // seconds between shots
  const BOOST_DURATION_MS = 8000; // duration of cooldown boost window

  // Boost system: define types with color and spawn chance
  const BOOST_TYPES = [
    { type: 'destroyletter', color: '#e11d48', chance: 0.08 }, // red — if used in a valid word, arm 1 red shot
    { type: 'cooldown',      color: '#14b8a6', chance: 0.06 }, // teal — halves cooldown for 3s on valid word
    { type: 'doubleScore',   color: '#facc15', chance: 0.10 }, // yellow — doubles final word score if present in word
    { type: 'deleterow',     color: '#a855f7', chance: 0.02 }, // purple — if used in a valid word, delete the top row
  ];
  const BOOST_MAP = BOOST_TYPES.reduce((acc, b) => { (acc as any)[b.type] = b; return acc; }, {} as Record<string, {type:string;color:string;chance:number}>);
  function pickBoost(): string | null {
    // Ensure only one boost is active at a time for each key by design.
    // We pick at most one boost type per call and return immediately.
    const r = Math.random();
    let acc = 0;
    for (const b of BOOST_TYPES) { acc += b.chance; if (r < acc) return b.type; }
    return null; // no boost
  }

  // Scrabble points
  const SCRABBLE_POINTS: Record<string, number> = {
    A:1, B:3, C:3, D:2, E:1, F:4, G:2, H:4, I:1, J:8, K:5, L:1,
    M:3, N:1, O:1, P:3, Q:10, R:1, S:1, T:1, U:1, V:4, W:4, X:8, Y:4, Z:10
  };

  // Letter frequency (rough ETAOIN...)
  const LETTER_FREQ: Array<[string, number]> = [
    ["E", 12.7],["T", 9.1],["A", 8.2],["O", 7.5],["I", 7.0],["N", 6.7],["S", 6.3],["H", 6.1],["R", 6.0],["D", 4.3],["L", 4.0],
    ["C", 2.8],["U", 2.8],["M", 2.4],["W", 2.4],["F", 2.2],["G", 2.0],["Y", 2.0],["P", 1.9],["B", 1.5],["V", 1.0],["K", 0.8],["J", 0.15],["X", 0.15],["Q", 0.10],["Z", 0.07]
  ];
  const freqCdf = (() => {
    let sum = 0;
    const cdf = LETTER_FREQ.map(([ch, p]) => { sum += p; return [ch, sum] as [string, number]; });
    return cdf.map(([ch, s]) => [ch, s / sum] as [string, number]);
  })();
  function pickLetter() {
    const r = Math.random();
    for (let i = 0; i < freqCdf.length; i++) if (r <= freqCdf[i][1]) return freqCdf[i][0];
    return "E";
  }

  // UI state
  const [running, setRunning] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [cooldown, setCooldown] = useState(0); // seconds until next shot
  const [cooldownMax, setCooldownMax] = useState(COOLDOWN_TIME); // for HUD bar scaling
  const [timeToRow, setTimeToRow] = useState(ROW_INTERVAL.toFixed(1)); // seconds until next row (string for display)
  const [rack, setRack] = useState<{ ch: string; boostType: string | null }[]>([]); // collected letters (<=5), keep boostType for UI
  const [checkingFlash, setCheckingFlash] = useState(false);
  const [wordSet, setWordSet] = useState<Set<string> | null>(null); // null => any 5 letters valid
  const [uploadName, setUploadName] = useState("");

  // Refs
  const rafRef = useRef(0);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const popsRef = useRef<{x:number;y:number;life:number}[]>([]); // [{x,y,life}]

  // Core state (mutable, non-reactive)
  type KeyObj = { x:number;y:number;w:number;h:number;r:number;letter:string;row:number;dead:boolean; boostType: string | null };
  type Projectile = { x:number;y:number;vx:number;vy:number;r:number;dead?:boolean; red?: boolean };
  const stateRef = useRef({
    w: 1280,
    h: 720,
    keys: [] as KeyObj[], // Key objects
    rowsCount: 0, // number of row levels currently on screen
    lastSpawn: 0, // seconds since last row spawn
    mouse: { x: 0, y: 0 },
    cannon: { x: 640, y: 690, r: 18 },
    projectiles: [] as Projectile[],
    cooldown: 0, // seconds remaining
    shakeTime: 0, // seconds of subtle shake remaining
    sfxCtx: null as (AudioContext | null),
    cooldownBoostUntil: 0, // ms timestamp; > now means BOOST active
    redShots: 0, // number of armed red shots remaining
  });

  // ---------- Lifecycle ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Canvas DPI setup
    const resize = () => {
      const st = stateRef.current;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = st.w + "px";
      canvas.style.height = st.h + "px";
      canvas.width = Math.floor(st.w * dpr);
      canvas.height = Math.floor(st.h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctxRef.current = ctx;
    };
    resize();
    window.addEventListener("resize", resize);

    // Cannon baseline
    const st = stateRef.current;
    st.cannon.x = st.w / 2;
    st.cannon.y = st.h - 30; // 10px up from bottom

    // Mouse + click
    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      st.mouse.x = e.clientX - rect.left;
      st.mouse.y = e.clientY - rect.top;
    };
    const onClick = () => {
      if (!running || gameOver) return;
      if (st.cooldown > 0) return; // cooldown gate
      fireProjectile();
    };
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onClick);

    // Geometry reset & tests
    resetGameGeometry();

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); // clamp big jumps
      last = now;
      if (running && !gameOver) update(dt);
      draw();
      rafRef.current = requestAnimationFrame(loop as FrameRequestCallback);
    };
    rafRef.current = requestAnimationFrame(loop as FrameRequestCallback);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, gameOver]);

  // ---------- Rows / geometry ----------
  function resetGameGeometry() {
    const st = stateRef.current;
    st.keys = [];
    st.rowsCount = 0;
    st.lastSpawn = 0;
    st.projectiles = [];
    st.cooldown = 0;
    st.shakeTime = 0;
    st.cooldownBoostUntil = 0; // ensure no boost at game start/reset
    st.redShots = 0; // clear one-shot red boost
    // Anchor cannon bottom-center
    st.cannon.x = st.w / 2;
    st.cannon.y = st.h - 30;

    // Spawn initial 3 rows at indices 0..2 (top to bottom)
    for (let i = 0; i < 3; i++) spawnTopRow();
  }

  function spawnRowAt(rowIndex: number) {
    const st = stateRef.current;
    const usableWidth = st.w - 40; // margins
    const startX = 20;
    const cols = Math.floor((usableWidth + KEY_HSP) / (KEY_W + KEY_HSP));
    const y = 20 + rowIndex * (KEY_H + KEY_VSP);
    const stagger = (currentRowOffset % 2 === 1) ? OFFSET_PER_ROW : 0;
    currentRowOffset++;
    for (let c = 0; c < cols; c++) {
      const x = startX + stagger + c * (KEY_W + KEY_HSP);
      if (x + KEY_W > st.w - 20) break;
      st.keys.push({ x, y, w: KEY_W, h: KEY_H, r: KEY_R, letter: pickLetter(), row: rowIndex, dead: false, boostType: pickBoost() });
    }
    st.rowsCount = Math.max(st.rowsCount, rowIndex + 1);
  }

  function spawnTopRow() {
    shiftAllRowsDown();
    const st = stateRef.current;
    spawnRowAt(0);
    st.rowsCount += 1;
    st.shakeTime = 0.25; // subtle shake
    playDropSfx();

    // Game over only when there are MAX_ROWS (or more) VISIBLE rows on screen
    if (getVisibleRowCount() >= MAX_ROWS) {
      setGameOver(true);
      setRunning(false);
    }
  }

  function shiftAllRowsDown() {
    const st = stateRef.current;
    const dy = KEY_H + KEY_VSP;
    st.keys.forEach(k => { k.y += dy; k.row += 1; });
  }

  // ---------- Shooting ----------
  function fireProjectile() {
    const st = stateRef.current;
    const { x: cx, y: cy } = st.cannon;
    const dx = st.mouse.x - cx;
    const dy = st.mouse.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const speed = 800; // px/s
    // Consume a red shot if armed; tag the projectile for red visuals
    const useRed = st.redShots > 0;
    st.projectiles.push({ x: cx, y: cy, vx: (dx / len) * speed, vy: (dy / len) * speed, r: 8, dead: false, red: useRed });
    if (useRed) st.redShots = Math.max(0, st.redShots - 1);
    const boostActive = cooldownBoostRemaining() > 0;
    const cd = boostActive ? COOLDOWN_TIME / 2 : COOLDOWN_TIME;
    st.cooldown = cd;
    setCooldownMax(cd);
  }

  function cooldownBoostRemaining() {
    const st = stateRef.current;
    const now = performance.now();
    return Math.max(0, (st.cooldownBoostUntil || 0) - now);
  }

  // ---------- Game step ----------
  function update(dt: number) {
    const st = stateRef.current;

    // Cooldown tick
    if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - dt);
    setCooldown(st.cooldown);

    // Row spawn timer
    st.lastSpawn += dt;
    const tLeft = Math.max(0, ROW_INTERVAL - (st.lastSpawn % ROW_INTERVAL));
    setTimeToRow(tLeft.toFixed(1));
    if (st.lastSpawn >= ROW_INTERVAL) {
      st.lastSpawn -= ROW_INTERVAL;
      spawnTopRow();
    }

    // Shake decay
    if (st.shakeTime > 0) st.shakeTime = Math.max(0, st.shakeTime - dt);

    // Projectiles physics & collision
    const steps = 4; // small substeps for robust collision
    for (let idx = 0; idx < st.projectiles.length; idx++) {
      const p = st.projectiles[idx];
      if (p.dead) continue;
      for (let i = 0; i < steps; i++) {
        p.x += (p.vx * dt) / steps;
        p.y += (p.vy * dt) / steps;
        // Out of bounds -> miss
        if (p.x < -20 || p.x > st.w + 20 || p.y < -20 || p.y > st.h + 20) { p.dead = true; break; }
        // Hit test against first intersected key
        let hitIndex = -1;
        for (let k = 0; k < st.keys.length; k++) {
          const key = st.keys[k];
          if (key.dead) continue;
          if (circleRectCollision(p.x, p.y, p.r, key.x, key.y, key.w, key.h)) { hitIndex = k; break; }
        }
        if (hitIndex !== -1) {
          const key = st.keys[hitIndex];
          key.dead = true;
          p.dead = true;

          // Handle the hit. If projectile is red, delete the letter without adding to rack.
          handleKeyHit(key, !!p.red);
          break;
        }
      }
    }

    // Remove dead entities
    st.projectiles = st.projectiles.filter(p => !p.dead);
    st.keys = st.keys.filter(k => !k.dead);
  }

  function handleKeyHit(key: KeyObj, projectileWasRed: boolean): boolean {
    if (projectileWasRed) {
      // Red shot: destroy letter but do NOT append to rack
      spawnPop(key.x + key.w / 2, key.y + key.h / 2);
      playHitSfx();
      return false;
    }
    // Normal shot: append to rack and possibly validate when reaching 5
    setRack(prev => {
      const next = [...prev, { ch: key.letter, boostType: key.boostType || null }];
      if (next.length === 5) {
        setCheckingFlash(true);
        setTimeout(() => setCheckingFlash(false), 200);
        const grantCooldown = next.some(e => e.boostType === 'cooldown');
        const hasDouble = next.some(e => e.boostType === 'doubleScore');
        const hasRed    = next.some(e => e.boostType === 'destroyletter');
        const delTop    = next.some(e => e.boostType === 'deleterow');
        validateWord(next.map(e => e.ch).join(""), grantCooldown, hasDouble, hasRed, delTop);
        return [];
      }
      return next;
    });
    spawnPop(key.x + key.w / 2, key.y + key.h / 2);
    playHitSfx();
    return true;
  }

  // ---------- Effects / draw ----------
  function spawnPop(x: number, y: number) { popsRef.current.push({ x, y, life: 0.25 }); }

  function draw() {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const st = stateRef.current;

    ctx.save();
    // Subtle shake
    if (st.shakeTime > 0) {
      const m = 2; // px
      const t = st.shakeTime * 60;
      const sx = (Math.random() - 0.5) * m * (t / 15);
      const sy = (Math.random() - 0.5) * m * (t / 15);
      ctx.translate(sx, sy);
    }

    // Background
    ctx.clearRect(0, 0, st.w, st.h);
    const g = ctx.createLinearGradient(0, 0, 0, st.h);
    g.addColorStop(0, "#0f172a");
    g.addColorStop(1, "#111827");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, st.w, st.h);

    // Keys
    st.keys.forEach(key => drawKey(ctx, key));

    // Pops
    for (let i = popsRef.current.length - 1; i >= 0; i--) {
      const p = popsRef.current[i];
      p.life -= 1 / 60;
      if (p.life <= 0) { popsRef.current.splice(i, 1); continue; }
      ctx.globalAlpha = p.life * 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (1 - p.life) * 16 + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "#fef08a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Cannon & projectiles (teal and slightly larger during boost)
    const boostActive = cooldownBoostRemaining() > 0;
    const redArmed = stateRef.current.redShots > 0;
    if (redArmed) {
      // Red armed for next shot — show red cannon (no size boost)
      drawCannon("#ef4444", "#ef4444", "#ef4444", "#b91c1c", 1);
    } else if (boostActive) {
      drawCannon("#14b8a6", "#14b8a6", "#14b8a6", "#0f766e", 1.2);
    } else {
      drawCannon("#334155", "#94a3b8", "#e5e7eb", "#9ca3af", 1);
    }

    // Under-cannon boost bar shows remaining boost time
    drawBoostBar(ctx);

    // Projectiles
    for (const p of st.projectiles) {
      const fill = "#e5e7eb";
      const stroke = p.red ? "#ef4444" : (boostActive ? "#14b8a6" : "#9ca3af");
      drawButton(ctx, p.x, p.y, p.r, fill, stroke, 1);
    }

    ctx.restore();
  }

  function drawCannon(cannonFill: string, barrelFill: string, muzzleFill: string, muzzleStroke: string, scale: number) {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const st = stateRef.current;

    // Cannon base
    const { x: cx, y: cy, r } = st.cannon;
    const ang = Math.atan2(st.mouse.y - cy, st.mouse.x - cx);

    ctx.fillStyle = cannonFill;
    roundRect(ctx, cx - 30 * scale, cy - 12 * scale, 60 * scale, 24 * scale, 12 * scale);
    ctx.fill();

    // Cannon barrel
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = barrelFill;
    roundRect(ctx, 0, -6 * scale, 40 * scale, 12 * scale, 6 * scale);
    ctx.fill();
    ctx.restore();

    // Button at muzzle
    ctx.fillStyle = muzzleFill;
    ctx.beginPath();
    ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = muzzleStroke;
    ctx.stroke();
    ctx.fillStyle = muzzleStroke;
    ctx.beginPath();
    ctx.arc(cx - 5 * scale, cy, 2 * scale , 0, Math.PI * 2);
    ctx.arc(cx + 5 * scale, cy, 2 * scale , 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBoostBar(ctx: CanvasRenderingContext2D) {
    const st = stateRef.current;
    const remaining = cooldownBoostRemaining(); // ms
    if (remaining <= 0) return; // Only show the bar when a boost is active
    const pct = Math.max(0, Math.min(1, remaining / BOOST_DURATION_MS));
    const { x: cx, y: cy } = st.cannon;
    const scale = 1.2; // match boosted cannon scale while active
    const w = 60 * scale;
    const h = 4;
    const x = cx - w / 2;
    const y = Math.min(st.h - h - 2, cy + 24 * scale); // keep inside canvas

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#1f2937"; // slate-800 track
    roundRect(ctx, x, y, w, h, 2);
    ctx.fill();

    const color = BOOST_MAP['cooldown'].color;
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w * pct, h, 2);
    ctx.fill();
    ctx.restore();
  }

  function adjustHex(hex: string, percent: number) {
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length !== 6) return '#' + hex;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const f = 1 + percent / 100;
    const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const rr = clamp255(r * f);
    const gg = clamp255(g * f);
    const bb = clamp255(b * f);
    const hh = (n: number) => n.toString(16).padStart(2, '0');
    return '#' + hh(rr) + hh(gg) + hh(bb);
  }

  function drawKey(ctx: CanvasRenderingContext2D, key: KeyObj) {
    const { x, y, w, h, r } = key;

    // --- Outer drop shadow for depth ---
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#0b1220"; // shadow body
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();

    // --- Keycap face with vertical bevel gradient ---
    const boostInfo = key.boostType ? BOOST_MAP[key.boostType] : null;
    if (boostInfo) {
      // Build gradient purely from this boost's own color
      const base = boostInfo.color;
      const top = adjustHex(base, 18);
      const mid = base;
      const bottom = adjustHex(base, -28);
      const faceGradB = ctx.createLinearGradient(0, y, 0, y + h);
      faceGradB.addColorStop(0.00, top);
      faceGradB.addColorStop(0.55, mid);
      faceGradB.addColorStop(1.00, bottom);
      ctx.fillStyle = faceGradB;
    } else {
      const faceGrad = ctx.createLinearGradient(0, y, 0, y + h);
      faceGrad.addColorStop(0.00, "#4b5563"); // lighter top
      faceGrad.addColorStop(0.55, "#374151");
      faceGrad.addColorStop(1.00, "#1f2937"); // darker bottom
      ctx.fillStyle = faceGrad;
    }
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();

    // --- Inner rim for crisp edge ---
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = boostInfo ? adjustHex(boostInfo.color, -35) : "#0f172a"; // darker rim if boosted
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.max(2, r - 2));
    ctx.stroke();
    ctx.restore();

    // --- Top highlight / sheen ---
    const sheen = ctx.createLinearGradient(0, y, 0, y + h);
    sheen.addColorStop(0.0, boostInfo ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.25)");
    sheen.addColorStop(0.25, "rgba(255,255,255,0.08)" );
    sheen.addColorStop(0.26, "rgba(255,255,255,0.00)" );
    ctx.fillStyle = sheen;
    roundRect(ctx, x + 2, y + 2, w - 4, Math.max(6, (h - 6) * 0.45), Math.max(1, r - 4));
    ctx.fill();

    // --- Bottom contact shadow strip ---
    const baseShade = ctx.createLinearGradient(0, y, 0, y + h);
    baseShade.addColorStop(0.80, "rgba(0,0,0,0.00)");
    baseShade.addColorStop(1.00, boostInfo ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.25)");
    ctx.fillStyle = baseShade;
    roundRect(ctx, x + 2, y + h * 0.70, w - 4, h * 0.28, Math.max(1, r - 4));
    ctx.fill();

    // --- Letter with subtle emboss ---
    ctx.save();
    ctx.font = "400 20px ui-sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // soft shadow under text
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = boostInfo ? "#111827" : "#f9fafb"; // darker letter on bright boosted key
    ctx.fillText(key.letter, x + w / 2, y + h / 2 + 1);
    ctx.restore();
  }

  function drawButton(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, scale: number) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.arc(x - 3, y, 1.5 * scale, 0, Math.PI * 2);
    ctx.arc(x + 3, y, 1.5 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Utils ----------
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function circleRectCollision(cx: number, cy: number, cr: number, rx: number, ry: number, rw: number, rh: number) {
    const closestX = clamp(cx, rx, rx + rw);
    const closestY = clamp(cy, ry, ry + rh);
    const dx = cx - closestX;
    const dy = cy - closestY;
    return (dx * dx + dy * dy) <= cr * cr;
  }
  function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

  // Count how many distinct row bands are currently visible on screen
  function getVisibleRowCount() {
    const st = stateRef.current;
    const bandH = KEY_H + KEY_VSP;
    const seen = new Set<number>();
    for (const k of st.keys) {
      if (k.y + KEY_H > 0 && k.y < st.h) {
        const bandIdx = Math.floor((k.y - 20) / bandH);
        seen.add(bandIdx);
      }
    }
    return seen.size;
  }

  function deleteTopRow() {
    const st = stateRef.current;
    if (st.keys.length === 0) return;

    // 1) Identify the top-most visible band (smallest y among alive keys)
    let minY = Infinity;
    for (const k of st.keys) if (!k.dead) minY = Math.min(minY, k.y);
    if (!isFinite(minY)) return;

    const bandH = KEY_H + KEY_VSP;
    const targetBand = Math.floor((minY - 20) / bandH);

    // 2) Mark that band as dead
    st.keys.forEach(k => {
      const band = Math.floor((k.y - 20) / bandH);
      if (band === targetBand) k.dead = true;
    });

    // 3) Shift every remaining (alive) key up by one band so rows close the gap
    st.keys.forEach(k => {
      if (!k.dead) {
        k.y -= bandH;
        k.row = Math.max(0, k.row - 1);
      }
    });

    // 4) Compact arrays and adjust bookkeeping
    st.keys = st.keys.filter(k => !k.dead);
    st.rowsCount = Math.max(0, st.rowsCount - 1);

    // Feedback
    st.shakeTime = Math.max(st.shakeTime, 0.18);
  }

  // ---------- Word validation ----------
  function getWordScore(word: string) {
    // Sum Scrabble points for A–Z; ignore anything else (shouldn't occur)
    return [...word.toUpperCase()].reduce((sum, ch) => sum + (SCRABBLE_POINTS[ch] || 0), 0);
  }

  function validateWord(
    word: string,
    grantCooldownBoost: boolean = false,
    doubleScore: boolean = false,
    armRedShot: boolean = false,
    deleteTop: boolean = false,
    suppressScore: boolean = false,
  ) : boolean {
    // Uploaded word list stored as lowercase; keep check consistent
    const ok = wordSet ? wordSet.has(word.toLowerCase()) : true;
    if (!ok) {
      // Apply row timer penalty: shave 15s off the next spawn.
      const st = stateRef.current;
      st.lastSpawn += INVALID_WORD_ROW_PENALTY;
      // If this crosses the threshold, spawn immediately and carry overflow to the next interval.
      while (st.lastSpawn >= ROW_INTERVAL) {
        st.lastSpawn -= ROW_INTERVAL;
        spawnTopRow();
      }
      // Update HUD countdown immediately
      const tLeft = Math.max(0, ROW_INTERVAL - (st.lastSpawn % ROW_INTERVAL));
      setTimeToRow(tLeft.toFixed(1));
      return false;
    }
    let points = getWordScore(word);
    if (doubleScore) points *= 2;
    if (!suppressScore) setScore(prev => prev + points);
    const st = stateRef.current;
    // If any letter in the completed word carried a cooldown boost, activate it now
    if (grantCooldownBoost) {
      const now = performance.now();
      st.cooldownBoostUntil = Math.max(st.cooldownBoostUntil || 0, now) + BOOST_DURATION_MS;
    }
    // If the word contains a red boosted letter, arm one red shot
    if (armRedShot) {
      st.redShots = Math.max(st.redShots || 0, 1);
    }
    // If the word contains a purple delete-row letter, remove the current top row
    if (deleteTop) {
      deleteTopRow();
    }
    return true;
  }

  // ---------- Audio (simple beeps) ----------
  function ensureAudioCtx() {
    const st = stateRef.current;
    if (!st.sfxCtx) {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) st.sfxCtx = new AudioCtx();
    }
    return st.sfxCtx;
  }
  function playHitSfx() {
    const ac = ensureAudioCtx(); if (!ac) return;
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = "triangle"; o.frequency.value = 660; g.gain.value = 0.06;
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.08);
  }
  function playDropSfx() {
    const ac = ensureAudioCtx(); if (!ac) return;
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(200, ac.currentTime);
    o.frequency.exponentialRampToValueAtTime(120, ac.currentTime + 0.2);
    g.gain.value = 0.05; o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.22);
  }

  // ---------- Word list parsing helper (pure) ----------
  function parseWordListText(textRaw: string): Set<string> {
    // Strip UTF-8 BOM and split CRLF/ LF
    const text = textRaw.replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);
    const out = new Set<string>();
    for (let raw of lines) {
      let line = (raw ?? "").trim();
      if (!line) continue;
      // First cell of CSV/TSV; trim and dequote
      let first = (line.split(/[,;\t]/)[0] || "").trim();
      first = first.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (/^[A-Za-z]{5}$/.test(first)) out.add(first.toLowerCase());
    }
    return out;
  }

  // ---------- File upload (CSV/TXT) ----------
  async function handleFile(file?: File) {
    if (!file) return;
    try {
      const textRaw = await file.text();
      const words = parseWordListText(textRaw);
      // Strict mode even if 0 words are parsed
      setWordSet(words);
      setUploadName(`${file.name} (${words.size} words)`);
    } catch (e) {
      console.error(e);
      alert("Failed to read file. Using open dictionary mode instead.");
      setWordSet(null);
      setUploadName("");
    }
  }

  async function handleFileFromPath(path: string) {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const textRaw = await response.text();
    const words = parseWordListText(textRaw);
    setWordSet(words);
    setUploadName(`${path} (${words.size} words)`);
  } catch (e) {
    console.error(e);
    alert(`Failed to load ${path}. Using open dictionary mode instead.`);
    setWordSet(null);
    setUploadName("");
  }
}

  // ---------- Start / Reset ----------
  function startGame() {
    setScore(0);
    setRack([]);
    setGameOver(false);
    setRunning(true);
    setCooldownMax(COOLDOWN_TIME);
    resetGameGeometry();
  }
  function startGameDutch() {
   handleFileFromPath(dutchWords);
    setScore(0);
    setRack([]);
    setGameOver(false);
    setRunning(true);
    setCooldownMax(COOLDOWN_TIME);
    resetGameGeometry();
  }
  function startGameEnglish() {
   handleFileFromPath(englishWords);
    setScore(0);
    setRack([]);
    setGameOver(false);
    setRunning(true);
    setCooldownMax(COOLDOWN_TIME);
    resetGameGeometry();
  }
  function resetToMenu() {
    setRunning(false);
    setGameOver(false);
    setRack([]);
    setScore(0);
    setCooldown(0);
    setCooldownMax(COOLDOWN_TIME);
    setTimeToRow(ROW_INTERVAL.toFixed(1));
    resetGameGeometry();
  }

  // HUD helpers
  const cooldownPct = Math.max(0, Math.min(1, 1 - cooldown / cooldownMax));

  // ---------- Render ----------
  return (
    <div className="w-full h-full min-h-[740px] flex flex-col items-center justify-start gap-4 bg-slate-900 text-slate-100 p-4">
      <h1 className="text-2xl font-bold tracking-tight">Keyboard hero</h1>

      {/* Top HUD */}
      <div className="w-[1280px] max-w-full grid grid-cols-4 gap-4">
        <div className="col-span-1 bg-slate-800/60 rounded-2xl p-3 shadow-inner">
          <div className="text-xs uppercase opacity-70">Score</div>
          <div className="text-xl font-semibold">{score}</div>
        </div>
        <div className="col-span-1 bg-slate-800/60 rounded-2xl p-3">
          <div className="text-xs uppercase opacity-70">Cooldown</div>
          <div className="h-2 rounded-full bg-slate-700 overflow-hidden mt-2">
            <div className="h-full bg-amber-300" style={{ width: `${cooldownPct * 100}%` }} />
          </div>
          <div className="text-xs mt-1 opacity-70">{cooldown.toFixed(1)}s</div>
        </div>
        <div className="col-span-1 bg-slate-800/60 rounded-2xl p-3">
          <div className="text-xs uppercase opacity-70">Next Row</div>
          <div className="text-xl font-semibold">{timeToRow}s</div>
        </div>
        <div className={`col-span-1 bg-slate-800/60 rounded-2xl p-3 ${checkingFlash ? 'ring-2 ring-amber-300' : ''}`}>
          <div className="flex justify-between items-center">
            <div className="text-xs uppercase opacity-70">Rack</div>
            <div className="text-xs opacity-70">{getWordScore(rack.map(e => e.ch).join(''))} pts{rack.some(e => e.boostType === 'doubleScore') && <span className="ml-1 text-yellow-400 font-semibold">×2</span>}</div>
          </div>
          <div className="flex justify-between items-center">
            <div className="text-xl font-mono tracking-widest">
              {rack.map((r,i)=> (
                <span key={i} style={{ color: r.boostType ? BOOST_MAP[r.boostType].color : undefined }}>{r.ch}</span>
              ))}
              {Array.from({length: Math.max(0, 5 - rack.length)}).map((_,i)=> <span key={`dot-${i}`} className="opacity-30">·</span>)}
            </div>
            <div className="text-xl font-mono tracking-widest" />
          </div>
          <div className="text-xs opacity-60">{wordSet ? `Strict: ${uploadName || 'custom list'}` : 'Open: any 5 letters'}</div>
        </div>
      </div>

      {/* Canvas wrapper */}
      <div className="relative" style={{ width: 1280, height: 720 }}>
        <canvas ref={canvasRef} className="rounded-2xl shadow-xl ring-1 ring-slate-700"/>

        {/* Start / Menu overlay */}
        {(!running || gameOver) && (
          <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center gap-4 p-6">
            <div className="">
              <div className="text-3xl font-bold mb-2">Keyboard hero</div>
              <div className="opacity-80 max-w-3xl mx-auto"><strong>Make 5 letter words by shooting the keyboard BUTTONS with your very own BUTTON cannon!</strong></div>
              <div className="opacity-80 max-w-3xl mx-auto"><strong>Every {ROW_INTERVAL} seconds a new keyboard row will spawn. You lose when the keyboard reaches a {MAX_ROWS} row.</strong></div>
              <br/>
              <div className="opacity-80 max-w-3xl mx-auto">Some letters have bonusses, and are applied when a <strong>VALID</strong> word is scored:</div>
              <ul className="list-disc list-inside">
                <li>A <strong><span style={{ color: '#e11d48' }}> red </span></strong>letter will make next shot <strong>remove</strong> the next button you hit.</li>
                <li>A <strong><span style={{ color: '#14b8a6' }}> teal </span></strong>letter will double your firing speed for 8s.</li>
                <li>A <strong><span style={{ color: '#facc15' }}> yellow </span></strong>letter will double your current word score.</li>
                <li>A <strong><span style={{ color: '#a855f7' }}> purple </span></strong>letter will delete the top row of the keyboard.</li>
              </ul>
              <br/>
              <div className="opacity-80 max-w-3xl mx-auto">If you make an <strong>INVALID</strong> word, the following effects will trigger:</div>
              <ul className="list-disc list-inside">
                  <li>No points will be scored.</li>
                  <li>The cooldown for spawning a new row will be reduced by 15seconds.</li>
                </ul>
            </div>
            <br/>
            <div className="opacity-80 max-w-3xl mx-auto"><strong>Play in English, Dutch, or upload a custom word list.</strong></div>
            <div className="flex gap-3">
              {!running && <button onClick={startGameDutch} className="px-5 py-2 rounded-xl bg-amber-300 text-slate-900 font-semibold hover:brightness-95">Play in Dutch</button>}
              {!running && <button onClick={startGameEnglish} className="px-5 py-2 rounded-xl bg-amber-300 text-slate-900 font-semibold hover:brightness-95">Play in English</button>}
            </div>
          <br/>


            {gameOver && <div className="text-rose-300 font-semibold">Game Over — Final Score: {score}</div>}

            <div className="flex items-center gap-3">
              <label className="px-3 py-2 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700 transition">
                <input type="file" accept=".csv,.txt" className="hidden" onChange={e => handleFile(e.target.files?.[0])} />
                Upload word list (CSV/TXT)
              </label>
              <span className="text-sm opacity-70">{uploadName ? `Loaded: ${uploadName}` : 'No file (open dictionary)'}</span>
            </div>

            <div className="flex gap-3">
              {!running && <button onClick={startGame} className="px-5 py-2 rounded-xl bg-amber-300 text-slate-900 font-semibold hover:brightness-95">Start</button>}
              {gameOver && <button onClick={resetToMenu} className="px-4 py-2 rounded-xl bg-slate-200 text-slate-900">Back to Menu</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
