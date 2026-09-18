/**
 * Builds a standalone .html file that renders the exported character grid as a
 * Three.js scene with OrbitControls and an optional UnrealBloomPass.
 *
 * The file is fully self-contained apart from the Three.js module, which it
 * pulls from a pinned CDN URL — so it opens by double-clicking, with no build
 * step and no server. The character data is inlined as JSON.
 */

function escapeForScript(json) {
  // `</script>` inside a JSON string would terminate the block early, and the
  // Unicode line separators are legal JSON but illegal in a JS string literal.
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildThreeHtml({ groups, cols, rows, backgroundColor = '#0a0a0a', bloom = true }) {
  const data = escapeForScript(JSON.stringify({ groups, cols, rows, backgroundColor }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ascify export</title>
<style>
  html, body { margin: 0; height: 100%; background: ${backgroundColor}; overflow: hidden; }
  canvas { display: block; }
  #hint {
    position: fixed; left: 12px; bottom: 12px; z-index: 2;
    font: 11px ui-monospace, "JetBrains Mono", Menlo, monospace;
    color: #6f8a6f; letter-spacing: .08em; pointer-events: none;
  }
</style>
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/"
  }
}
</script>
</head>
<body>
<div id="hint">drag to orbit &middot; scroll to zoom &middot; exported from ascify</div>
<script id="ascii-data" type="application/json">${data}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
${
  bloom
    ? `import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';`
    : ''
}

const DATA = JSON.parse(document.getElementById('ascii-data').textContent);

const CELL = 10;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('${backgroundColor}');

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 20000);
const width = DATA.cols * CELL;
const height = DATA.rows * CELL;
camera.position.set(0, 0, Math.max(width, height) * 1.1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Each colour becomes one canvas-textured sprite sheet row; grouping keeps the
// draw-call count proportional to distinct colours, not characters.
const group = new THREE.Group();
scene.add(group);

const fontSize = 64;
const glyphCanvas = document.createElement('canvas');
const gctx = glyphCanvas.getContext('2d');

function textTexture(text, color) {
  gctx.font = \`500 \${fontSize}px ui-monospace, "JetBrains Mono", Menlo, monospace\`;
  const w = Math.max(1, Math.ceil(gctx.measureText(text).width));
  const h = Math.ceil(fontSize * 1.25);
  glyphCanvas.width = w;
  glyphCanvas.height = h;
  gctx.font = \`500 \${fontSize}px ui-monospace, "JetBrains Mono", Menlo, monospace\`;
  gctx.textBaseline = 'middle';
  gctx.clearRect(0, 0, w, h);
  gctx.fillStyle = color;
  gctx.fillText(text, 0, h / 2);
  const tex = new THREE.CanvasTexture(
    (() => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(glyphCanvas, 0, 0);
      return c;
    })()
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return { tex, w, h };
}

for (const g of DATA.groups) {
  const { tex, w, h } = textTexture(g.text, g.color);
  const planeW = g.count * CELL;
  const planeH = planeW * (h / w);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
  mesh.position.set(
    (g.x + g.count / 2) * CELL - width / 2,
    height / 2 - (g.y + 0.5) * CELL,
    0
  );
  group.add(mesh);
}

${
  bloom
    ? `const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.5, 0.2);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());`
    : ''
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  ${bloom ? 'composer.setSize(innerWidth, innerHeight);' : ''}
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  ${bloom ? 'composer.render();' : 'renderer.render(scene, camera);'}
}
animate();
</script>
</body>
</html>`;
}
