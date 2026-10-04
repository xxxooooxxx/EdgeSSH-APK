import { isLand } from 'mappo';
import type { CloudHost } from './cloud-api';
import { countryFlagEmoji } from './flags';

type Point = [number, number, number];
const AUTO_ROTATION_SPEED = 0.000099;

function sphere(lat: number, lon: number): Point {
  const a = lat * Math.PI / 180, b = lon * Math.PI / 180;
  return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)];
}

export class HostGlobe {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly points: Point[] = [];
  private markers: { point: Point; button: HTMLButtonElement }[] = [];
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)');
  private angle = -1.5;
  private frame = 0;
  private last = 0;
  private active = false;
  private paused = false;
  private dragging = false;
  private pointerX = 0;
  private size = 0;
  private readonly resize: ResizeObserver;
  private readonly orange: string;
  private readonly grid: string;
  private readonly paper: string;

  constructor(private readonly root: HTMLElement, private readonly connect: (host: CloudHost) => void) {
    this.context = this.canvas.getContext('2d')!;
    this.canvas.setAttribute('aria-hidden', 'true');
    root.append(this.canvas);
    const style = getComputedStyle(root);
    this.orange = style.getPropertyValue('--home-accent').trim();
    this.grid = style.getPropertyValue('--home-line').trim();
    this.paper = style.getPropertyValue('--home-surface').trim();
    // 复用 Mappo 的真实陆地掩码；一次预计算坐标，旋转时不再遍历地理数据。
    for (let lat = -82; lat <= 84; lat += 1.8) {
      const step = 1.8 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
      for (let lon = -180; lon < 180; lon += step) if (isLand(lat, lon)) this.points.push(sphere(lat, lon));
    }
    this.resize = new ResizeObserver(() => {
      this.size = root.clientWidth;
      const scale = Math.min(devicePixelRatio, 2);
      this.canvas.width = this.canvas.height = Math.round(this.size * scale);
      this.context.setTransform(scale, 0, 0, scale, 0, 0);
      this.draw();
    });
    this.resize.observe(root);
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true; this.pointerX = event.clientX;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.angle += (event.clientX - this.pointerX) * 0.008;
      this.pointerX = event.clientX; this.draw();
    });
    const release = () => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
    root.addEventListener('pointerenter', () => { this.paused = true; });
    root.addEventListener('pointerleave', () => { this.paused = false; });
    root.addEventListener('focusin', () => { this.paused = true; });
    root.addEventListener('focusout', () => { this.paused = false; });
    document.addEventListener('visibilitychange', () => this.schedule());
    this.motion.addEventListener('change', () => this.schedule());
  }

  setHosts(hosts: CloudHost[]): void {
    for (const marker of this.markers) marker.button.remove();
    this.markers = hosts.filter((host) => host.location).map((host) => {
      const location = host.location!;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'globe-marker';
      button.setAttribute('aria-label', `连接 ${host.name}，${location.city || location.country}`);
      const pin = document.createElement('span'); pin.className = 'globe-pin';
      const copy = document.createElement('span'); copy.className = 'globe-label';
      const name = document.createElement('strong'); name.textContent = `${countryFlagEmoji(location.countryCode)} ${host.name}`;
      const city = document.createElement('small'); city.textContent = location.city || location.country;
      copy.append(name, city); button.append(pin, copy);
      button.addEventListener('click', () => this.connect(host));
      this.root.append(button);
      return { point: sphere(location.latitude, location.longitude), button };
    });
    this.draw();
  }

  setActive(active: boolean): void { this.active = active; this.schedule(); }
  setPaused(paused: boolean): void { this.active = !paused; this.schedule(); }

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    this.last = 0;
    if (this.active && !document.hidden && !this.motion.matches) this.frame = requestAnimationFrame(this.tick);
    else this.draw();
  }

  private readonly tick = (time: number): void => {
    if (this.last && time - this.last < 32) { this.frame = requestAnimationFrame(this.tick); return; }
    const delta = this.last ? Math.min(time - this.last, 100) : 0;
    this.last = time;
    if (!this.paused && !this.dragging) this.angle += delta * AUTO_ROTATION_SPEED;
    this.draw();
    this.frame = requestAnimationFrame(this.tick);
  };

  private project(point: Point): Point {
    const [x, y, z] = point, s = Math.sin(this.angle), c = Math.cos(this.angle);
    const rx = x * c + z * s, rz = z * c - x * s;
    const tilt = 0.18;
    return [rx, y * Math.cos(tilt) - rz * Math.sin(tilt), y * Math.sin(tilt) + rz * Math.cos(tilt)];
  }

  private draw(): void {
    if (!this.size) return;
    const ctx = this.context, size = this.size, center = size / 2, radius = size * 0.405;
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath(); ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = this.paper; ctx.fill(); ctx.strokeStyle = this.grid; ctx.lineWidth = 0.8; ctx.stroke();
    const drawLine = (points: Point[]) => {
      ctx.beginPath(); let started = false;
      for (const point of points) {
        const [x, y, z] = this.project(point);
        if (z < 0) { started = false; continue; }
        if (started) ctx.lineTo(center + x * radius, center - y * radius);
        else ctx.moveTo(center + x * radius, center - y * radius);
        started = true;
      }
      ctx.stroke();
    };
    ctx.globalAlpha = 0.7;
    for (let lat = -60; lat <= 60; lat += 30) drawLine(Array.from({ length: 121 }, (_, i) => sphere(lat, i * 3 - 180)));
    for (let lon = -180; lon < 180; lon += 30) drawLine(Array.from({ length: 61 }, (_, i) => sphere(i * 3 - 90, lon)));
    ctx.fillStyle = this.orange;
    for (const point of this.points) {
      const [x, y, z] = this.project(point);
      if (z < 0) continue;
      ctx.globalAlpha = 0.25 + z * 0.7;
      ctx.beginPath(); ctx.arc(center + x * radius, center - y * radius, (0.55 + z * 0.65) * size / 460, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const occupied: { x: number; y: number }[] = [];
    for (const marker of this.markers) {
      const [x, y, z] = this.project(marker.point);
      const px = center + x * radius, py = center - y * radius;
      marker.button.hidden = z < 0.12;
      if (marker.button.hidden) continue;
      // 密集地区折叠文字而不是堆叠卡片；每台机器始终还可从左侧列表连接。
      const overlap = occupied.some((other) => Math.abs(other.x - px) < 100 && Math.abs(other.y - py) < 44);
      marker.button.classList.toggle('compact', overlap);
      if (!overlap) occupied.push({ x: px, y: py });
      marker.button.style.transform = `translate(${px}px, ${py}px)`;
      marker.button.style.zIndex = String(Math.round(z * 10));
    }
  }
}
