"use client";

import { useRef, useEffect } from "react";
import { useTheme } from "next-themes";

interface LiquidStreamVisualizerProps {
  ratePerSecond: number;
  status: "active" | "paused" | "completed";
  width?: number;
  height?: number;
  senderLabel?: string;
  recipientLabel?: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  opacity: number;
}

interface NodeShape {
  x: number;
  y: number;
  radius: number;
  color: string;
  glowColor: string;
  label: string;
}

interface Colors {
  senderNode: string;
  senderGlow: string;
  recipientNode: string;
  recipientGlow: string;
  particles: string[];
  path: string;
  pausedColor: string;
}

const PARTICLE_POOL_SIZE = 150;
const TARGET_FPS = 60;
const FRAME_TIME = 1000 / TARGET_FPS;

function getColorsForTheme(isDark: boolean): Colors {
  return {
    senderNode: isDark ? "#06b6d4" : "#3b82f6",
    senderGlow: isDark ? "rgba(6, 182, 212, 0.4)" : "rgba(59, 130, 246, 0.4)",
    recipientNode: isDark ? "#a855f7" : "#3b82f6",
    recipientGlow: isDark ? "rgba(168, 85, 247, 0.4)" : "rgba(59, 130, 246, 0.4)",
    particles: isDark
      ? ["#22d3ee", "#06b6d4", "#0891b2", "#a855f7", "#c084fc"]
      : ["#3b82f6", "#60a5fa", "#93c5fd", "#6366f1", "#818cf8"],
    path: isDark ? "rgba(6, 182, 212, 0.2)" : "rgba(59, 130, 246, 0.2)",
    pausedColor: "#f59e0b",
  };
}

function makeParticlePool(): Particle[] {
  const pool: Particle[] = [];
  for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
    pool.push({
      x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0,
      size: 2, color: "#22d3ee", opacity: 0,
    });
  }
  return pool;
}

function spawnOn(
  p: Particle,
  sx: number, sy: number,
  ex: number, ey: number,
  colors: Colors,
) {
  const progress = Math.random() * 0.3;
  const cp1x = sx + (ex - sx) * 0.3;
  const cp1y = sy - 30;
  const cp2x = sx + (ex - sx) * 0.7;
  const cp2y = ey - 30;
  const mt = 1 - progress;
  p.x = mt ** 3 * sx + 3 * mt ** 2 * progress * cp1x + 3 * mt * progress ** 2 * cp2x + progress ** 3 * ex;
  p.y = mt ** 3 * sy + 3 * mt ** 2 * progress * cp1y + 3 * mt * progress ** 2 * cp2y + progress ** 3 * ey;
  const speed = 0.8 + Math.random() * 0.4;
  p.vx = ((ex - sx) / 200) * speed;
  p.vy = (Math.random() - 0.5) * 0.5;
  p.life = 1;
  p.maxLife = 1;
  p.size = 1.5 + Math.random() * 2;
  p.color = colors.particles[Math.floor(Math.random() * colors.particles.length)] ?? colors.particles[0] ?? "#22d3ee";
  p.opacity = 0.6 + Math.random() * 0.4;
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  ex: number, ey: number,
  colors: Colors,
) {
  const cp1x = sx + (ex - sx) * 0.3;
  const cp1y = sy - 30;
  const cp2x = sx + (ex - sx) * 0.7;
  const cp2y = ey - 30;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
  ctx.strokeStyle = colors.path;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawNodeShape(
  ctx: CanvasRenderingContext2D,
  node: NodeShape,
  colors: Colors,
  isPaused: boolean,
) {
  const color = isPaused ? colors.pausedColor : node.color;
  const glowColor = isPaused ? "rgba(245, 158, 11, 0.4)" : node.glowColor;
  const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 2);
  gradient.addColorStop(0, glowColor);
  gradient.addColorStop(1, "transparent");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.radius * 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
  ctx.beginPath();
  ctx.arc(node.x - node.radius * 0.2, node.y - node.radius * 0.2, node.radius * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(node.label, node.x, node.y + node.radius + 20);
}

export function LiquidStreamVisualizer({
  ratePerSecond,
  status,
  width = 800,
  height = 200,
  senderLabel = "Sender",
  recipientLabel = "Recipient",
}: LiquidStreamVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>(makeParticlePool());
  const animFrameRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  const isPausedRef = useRef(status !== "active");
  const isVisibleRef = useRef(true);
  const { resolvedTheme } = useTheme();

  // Sync prop refs in effects to satisfy React Compiler
  const rateRef = useRef(ratePerSecond);
  const widthRef = useRef(width);
  const heightRef = useRef(height);
  const senderRef = useRef(senderLabel);
  const recipientRef = useRef(recipientLabel);
  const themeRef = useRef(resolvedTheme);

  useEffect(() => { rateRef.current = ratePerSecond; });
  useEffect(() => { widthRef.current = width; });
  useEffect(() => { heightRef.current = height; });
  useEffect(() => { senderRef.current = senderLabel; });
  useEffect(() => { recipientRef.current = recipientLabel; });
  useEffect(() => { themeRef.current = resolvedTheme; });

  // Main animation effect
  useEffect(() => {
    function loop(timestamp: number) {
      const canvas = canvasRef.current;
      if (!canvas) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const deltaTime = timestamp - lastFrameTimeRef.current;
      if (deltaTime < FRAME_TIME) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }
      lastFrameTimeRef.current = timestamp - (deltaTime % FRAME_TIME);

      const colors = getColorsForTheme(themeRef.current === "dark");
      const w = widthRef.current;
      const h = heightRef.current;
      const rate = rateRef.current;
      const startX = 80;
      const startY = h / 2;
      const endX = w - 80;
      const endY = h / 2;

      ctx.clearRect(0, 0, w, h);
      drawPath(ctx, startX, startY, endX, endY, colors);

      if (!isPausedRef.current && isVisibleRef.current) {
        const spawnRate = Math.min(Math.max(rate / 1000, 0.1), 10);
        const spawnCount = Math.max(1, Math.floor(spawnRate * (deltaTime / 1000)));
        for (let i = 0; i < spawnCount; i++) {
          const p = particlesRef.current.find((pp) => pp.life <= 0);
          if (p) spawnOn(p, startX, startY, endX, endY, colors);
        }
      }

      particlesRef.current.forEach((p) => {
        if (p.life <= 0) return;
        p.life -= deltaTime / 1000;
        if (p.life <= 0) { p.opacity = 0; return; }
        p.x += p.vx * deltaTime * 0.1;
        p.y += p.vy * deltaTime * 0.1;
        p.y += Math.sin(p.x * 0.02 + p.life * 10) * 0.3;
        ctx.globalAlpha = p.opacity * (p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.globalAlpha = 1;

      const senderNode: NodeShape = {
        x: startX, y: startY, radius: 24,
        color: colors.senderNode, glowColor: colors.senderGlow,
        label: senderRef.current,
      };
      const recipientNode: NodeShape = {
        x: endX, y: endY, radius: 24,
        color: colors.recipientNode, glowColor: colors.recipientGlow,
        label: recipientRef.current,
      };

      drawNodeShape(ctx, senderNode, colors, isPausedRef.current);
      drawNodeShape(ctx, recipientNode, colors, isPausedRef.current);

      if (isPausedRef.current) {
        ctx.fillStyle = "rgba(245, 158, 11, 0.1)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#f59e0b";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("\u23F8 Paused", w / 2, h / 2 - 40);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // Pause / resume
  useEffect(() => {
    isPausedRef.current = status !== "active";
  }, [status]);

  // IntersectionObserver
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) isVisibleRef.current = entry.isIntersecting;
      },
      { threshold: 0.1 },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Tab visibility
  useEffect(() => {
    const handler = () => { isVisibleRef.current = !document.hidden; };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return (
    <div className="relative rounded-2xl border border-slate-800 overflow-hidden bg-gradient-to-r from-slate-900/50 via-slate-800/30 to-slate-900/50">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="w-full"
        style={{ height: `${height}px` }}
      />
      <div className="absolute bottom-2 right-3 text-xs text-slate-500">
        {status === "active" ? "\u25CF Live" : status === "paused" ? "\u25CF Paused" : "\u25CF Completed"}
      </div>
    </div>
  );
}
