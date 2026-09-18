import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { trackObjectUrl, trackCanvas, trackDisposable } from './resourceRegistry.js';
import { MediaError } from './mediaSource.js';

/**
 * Renders a .glb into an offscreen canvas that the effect pipeline treats as
 * just another frame source. The model is parsed from an in-memory object URL
 * that is revoked as soon as parsing finishes.
 */

function frameCamera(camera, controls, object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fitDist = (maxDim / 2 / Math.tan((Math.PI * camera.fov) / 360)) * 1.6;

  object.position.sub(center);
  camera.position.set(fitDist * 0.6, fitDist * 0.45, fitDist);
  camera.near = fitDist / 100;
  camera.far = fitDist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

export async function createModelStage(file, { onProgress } = {}) {
  const canvas = trackCanvas(document.createElement('canvas'));
  canvas.width = 1280;
  canvas.height = 720;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
  } catch {
    throw new MediaError('WebGL is unavailable, so GLB models cannot be rendered.', {
      code: 'no_webgl',
    });
  }
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  trackDisposable('threeRenderer', renderer, () => {
    renderer.dispose();
    renderer.forceContextLoss?.();
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 1000);

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x66ff99, 1.1);
  rim.position.set(-5, 2, -4);
  scene.add(rim);

  const url = trackObjectUrl(file);
  const loader = new GLTFLoader();

  let gltf;
  try {
    gltf = await loader.loadAsync(url, (evt) => {
      if (evt.lengthComputable) {
        onProgress?.({ phase: 'decoding', progress: 0.4 + 0.5 * (evt.loaded / evt.total) });
      }
    });
  } catch {
    throw new MediaError('This .glb could not be parsed.', {
      code: 'decode_failed',
      hint: 'Only binary glTF (.glb) is supported.',
    });
  }

  const root = gltf.scene;
  scene.add(root);
  trackDisposable('threeScene', root, () => {
    root.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        for (const value of Object.values(m)) {
          if (value && value.isTexture) value.dispose();
        }
        m.dispose?.();
      }
    });
    scene.remove(root);
  });

  // Controls are driven by the preview surface; the offscreen canvas has no
  // pointer events of its own, so a proxy element is attached by the UI.
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  trackDisposable('orbitControls', controls, () => controls.dispose());

  frameCamera(camera, controls, root);

  const mixer = gltf.animations?.length ? new THREE.AnimationMixer(root) : null;
  if (mixer) {
    for (const clip of gltf.animations) mixer.clipAction(clip).play();
    trackDisposable('mixer', mixer, () => mixer.stopAllAction());
  }

  let autoRotate = true;
  let playing = true;
  let elapsed = 0;

  const render = () => {
    controls.update();
    renderer.render(scene, camera);
  };
  render();
  onProgress?.({ phase: 'ready', progress: 1 });

  return {
    kind: 'model',
    width: canvas.width,
    height: canvas.height,
    animated: true,
    duration: gltf.animations?.[0]?.duration ?? 0,
    frame: () => canvas,
    tick(dt) {
      if (!playing) {
        render();
        return;
      }
      elapsed += dt;
      if (autoRotate) root.rotation.y += dt * 0.35;
      mixer?.update(dt);
      render();
    },
    seek(t) {
      if (mixer && gltf.animations?.length) {
        mixer.setTime(Math.max(0, t));
        render();
      }
    },
    play() {
      playing = true;
    },
    pause() {
      playing = false;
    },
    isPlaying: () => playing,
    setAutoRotate(v) {
      autoRotate = !!v;
    },
    /** The UI forwards pointer events here so OrbitControls can drive the view. */
    attachControls(element) {
      controls.domElement = element;
      controls.connect?.(element);
      return () => controls.disconnect?.();
    },
    resize(w, h) {
      const width = Math.max(16, Math.round(w));
      const height = Math.max(16, Math.round(h));
      if (canvas.width === width && canvas.height === height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      this.width = width;
      this.height = height;
      render();
    },
    three: { scene, camera, renderer, root },
  };
}
