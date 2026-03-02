import "./style.css";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
};

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const PINCH_THRESH = 0.045;
const VOXEL_SIZE = 0.12;
const GRID_STEP = 0.14;
const MAX_SPAWNED = 500;
const SMOOTHING = 0.68;
const WIPE_VELOCITY_THRESH = 1.35;
const WORKSPACE = {
  width: 2.8,
  height: 2,
  depth: 1.8,
};

const app = document.querySelector("#app");
app.innerHTML = `
  <main class="stage">
    <video id="video" autoplay playsinline muted></video>
    <canvas id="three"></canvas>
    <canvas id="overlay"></canvas>
    <div class="hud">
      <div class="hud-block">
        <span class="hud-label">Voxels</span>
        <span id="voxel-count">0</span>
      </div>
      <div class="hud-block">
        <span class="hud-label">Hand</span>
        <span id="tracking-label">Waiting</span>
      </div>
      <div class="hud-block">
        <span class="hud-label">Mode</span>
        <span id="mode-label">Idle</span>
      </div>
      <div class="hud-block hud-help">
        <span><b>Thumb + Index</b> place voxel</span>
        <span><b>Thumb + Middle</b> rotate space</span>
        <span><b>Thumb + Ring</b> zoom</span>
        <span><b>Closed fist</b> reset view</span>
        <span><b>Open hand + fast wipe</b> clear all</span>
        <span><b>Mouse</b> drag orbit, wheel zoom</span>
      </div>
    </div>
  </main>
`;

const video = document.querySelector("#video");
const canvas = document.querySelector("#three");
const overlayCanvas = document.querySelector("#overlay");
const voxelCountLabel = document.querySelector("#voxel-count");
const trackingLabel = document.querySelector("#tracking-label");
const modeLabel = document.querySelector("#mode-label");
const overlayContext = overlayCanvas.getContext("2d");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 30);
camera.position.set(0, 0, 3.8);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.enableZoom = true;
controls.screenSpacePanning = true;
controls.minDistance = 3.1;
controls.maxDistance = 4.8;
controls.target.set(0, 0, 0);

const world = new THREE.Group();
scene.add(world);

const ambient = new THREE.HemisphereLight(0xbad7ff, 0x101820, 1.2);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
keyLight.position.set(2.6, 3.4, 3.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.bias = -0.0001;
scene.add(keyLight);

const fillLight = new THREE.PointLight(0x52c7ff, 10, 7, 2);
fillLight.position.set(-2.2, 0.8, 2.2);
scene.add(fillLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(WORKSPACE.width, WORKSPACE.height),
  new THREE.ShadowMaterial({ opacity: 0.18 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, -1.18, 0);
floor.receiveShadow = true;
world.add(floor);

const grid = new THREE.GridHelper(3.6, 26, 0x88d7ff, 0x31506d);
grid.position.y = -1.17;
grid.material.transparent = true;
grid.material.opacity = 0.26;
world.add(grid);

const bounds = new THREE.LineSegments(
  new THREE.EdgesGeometry(
    new RoundedBoxGeometry(WORKSPACE.width, WORKSPACE.height, WORKSPACE.depth, 5, 0.06)
  ),
  new THREE.LineBasicMaterial({
    color: 0x8cd8ff,
    transparent: true,
    opacity: 0.22,
  })
);
world.add(bounds);

const voxelGeometry = new RoundedBoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE, 4, 0.028);
const previewMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x69d9ff,
  roughness: 0.15,
  metalness: 0.05,
  transparent: true,
  opacity: 0.42,
  transmission: 0.2,
  clearcoat: 1,
  emissive: new THREE.Color(0x69d9ff).multiplyScalar(0.4),
});
const previewVoxel = new THREE.Mesh(voxelGeometry, previewMaterial);
previewVoxel.visible = false;
world.add(previewVoxel);

const spawned = [];
const occupiedCells = new Set();
const clock = new THREE.Clock();

let handLandmarker;
let pinchDown = false;
let smoothedIndex = null;
let lastRotateWrist = null;
let lastZoomWrist = null;
let lastWipeSample = null;
let wipeReady = true;
let targetRotationX = -0.2;
let targetRotationY = 0.35;
let targetCameraZ = 3.8;

function setModeLabel(text) {
  modeLabel.textContent = text;
}

function updateVoxelCount() {
  voxelCountLabel.textContent = String(spawned.length);
}

function setTracking(visible) {
  trackingLabel.textContent = visible ? "Tracked" : "Searching";
}

function quantizePosition(position) {
  return new THREE.Vector3(
    Math.round(position.x / GRID_STEP) * GRID_STEP,
    Math.round(position.y / GRID_STEP) * GRID_STEP,
    Math.round(position.z / GRID_STEP) * GRID_STEP
  );
}

function cellKey(position) {
  return `${position.x.toFixed(3)}:${position.y.toFixed(3)}:${position.z.toFixed(3)}`;
}

function smoothVec(previous, next) {
  if (!previous) return next.clone();
  return previous.lerp(next, 1 - SMOOTHING);
}

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function landmarkToWorld(lm) {
  const x = THREE.MathUtils.mapLinear(lm.x, 0, 1, WORKSPACE.width * 0.5, -WORKSPACE.width * 0.5);
  const y = THREE.MathUtils.mapLinear(lm.y, 0, 1, WORKSPACE.height * 0.5, -WORKSPACE.height * 0.5);
  const z = THREE.MathUtils.mapLinear(
    THREE.MathUtils.clamp(lm.z, -0.24, 0.24),
    -0.24,
    0.24,
    -WORKSPACE.depth * 0.5,
    WORKSPACE.depth * 0.5
  );

  return new THREE.Vector3(x, y, z);
}

function voxelColor(elapsed) {
  return new THREE.Color().setHSL((elapsed * 0.07) % 1, 0.9, 0.64);
}

function spawnVoxel(position, elapsed) {
  const snapped = quantizePosition(position);
  const key = cellKey(snapped);
  if (occupiedCells.has(key)) return;

  const color = voxelColor(elapsed);
  const material = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.24,
    metalness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.18,
    emissive: color.clone().multiplyScalar(0.16),
  });

  const voxel = new THREE.Mesh(voxelGeometry, material);
  voxel.position.copy(snapped);
  voxel.castShadow = true;
  voxel.receiveShadow = true;
  voxel.userData.baseY = snapped.y;
  voxel.userData.birth = elapsed;
  world.add(voxel);
  spawned.push(voxel);
  occupiedCells.add(key);

  if (spawned.length > MAX_SPAWNED) {
    const oldest = spawned.shift();
    world.remove(oldest);
    occupiedCells.delete(cellKey(oldest.position));
    oldest.material.dispose();
  }

  updateVoxelCount();
}

function clearVoxels() {
  for (const voxel of spawned) {
    world.remove(voxel);
    voxel.material.dispose();
  }
  spawned.length = 0;
  occupiedCells.clear();
  updateVoxelCount();
}

function isOpenHand(landmarks) {
  const wristY = landmarks[LANDMARK.WRIST].y;
  return (
    landmarks[LANDMARK.INDEX_TIP].y < wristY &&
    landmarks[LANDMARK.MIDDLE_TIP].y < wristY &&
    landmarks[LANDMARK.RING_TIP].y < wristY
  );
}

function isClosedFist(landmarks) {
  const wristY = landmarks[LANDMARK.WRIST].y;
  return (
    landmarks[LANDMARK.INDEX_TIP].y > wristY - 0.03 &&
    landmarks[LANDMARK.MIDDLE_TIP].y > wristY - 0.03 &&
    landmarks[LANDMARK.RING_TIP].y > wristY - 0.03
  );
}

function resetView() {
  targetRotationX = -0.2;
  targetRotationY = 0.35;
  targetCameraZ = 3.8;
  controls.target.set(0, 0, 0);
}

function handleWipeGesture(landmarks, now) {
  const wrist = landmarks[LANDMARK.WRIST];
  const handOpen = isOpenHand(landmarks);

  if (!handOpen) {
    lastWipeSample = { x: wrist.x, time: now };
    wipeReady = true;
    return;
  }

  if (lastWipeSample) {
    const dt = Math.max((now - lastWipeSample.time) / 1000, 0.001);
    const velocityX = Math.abs(wrist.x - lastWipeSample.x) / dt;
    if (wipeReady && velocityX > WIPE_VELOCITY_THRESH) {
      clearVoxels();
      wipeReady = false;
    }
  }

  lastWipeSample = { x: wrist.x, time: now };
}

function handleSpaceGestures(landmarks) {
  const rotatePinch =
    dist2D(landmarks[LANDMARK.THUMB_TIP], landmarks[LANDMARK.MIDDLE_TIP]) < PINCH_THRESH;
  const zoomPinch =
    dist2D(landmarks[LANDMARK.THUMB_TIP], landmarks[LANDMARK.RING_TIP]) < PINCH_THRESH;
  const closedFist = isClosedFist(landmarks) && !rotatePinch && !zoomPinch;
  const wrist = landmarks[LANDMARK.WRIST];

  let currentMode = "Idle";

  if (rotatePinch) {
    if (lastRotateWrist) {
      targetRotationY += (wrist.x - lastRotateWrist.x) * 8.8;
      targetRotationX += (wrist.y - lastRotateWrist.y) * 7.2;
    }
    lastRotateWrist = { x: wrist.x, y: wrist.y };
    currentMode = "Rotate";
  } else {
    lastRotateWrist = null;
  }

  if (zoomPinch) {
    if (lastZoomWrist) {
      targetCameraZ += (wrist.y - lastZoomWrist.y) * 10.5;
      targetCameraZ = THREE.MathUtils.clamp(targetCameraZ, 3.1, 4.8);
    }
    lastZoomWrist = { x: wrist.x, y: wrist.y };
    currentMode = "Zoom";
  } else {
    lastZoomWrist = null;
  }

  if (closedFist) {
    resetView();
    currentMode = "Reset";
  }

  setModeLabel(currentMode);
}

function animateScene(elapsed) {
  world.rotation.x = THREE.MathUtils.lerp(world.rotation.x, targetRotationX, 0.18);
  world.rotation.y = THREE.MathUtils.lerp(world.rotation.y, targetRotationY, 0.18);
  camera.position.z = THREE.MathUtils.lerp(camera.position.z, targetCameraZ, 0.16);
  camera.position.x = THREE.MathUtils.lerp(camera.position.x, 0, 0.16);
  camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 0.16);
  controls.target.set(0, 0, 0);

  bounds.material.opacity = 0.16 + Math.sin(elapsed * 1.8) * 0.05;
  previewVoxel.rotation.x += 0.01;
  previewVoxel.rotation.y += 0.016;

  for (const [index, voxel] of spawned.entries()) {
    const age = elapsed - voxel.userData.birth;
    const intro = THREE.MathUtils.clamp(age * 4.5, 0, 1);
    const bob = Math.sin(elapsed * 1.6 + index * 0.4) * 0.008;
    voxel.scale.setScalar(0.75 + intro * 0.25);
    voxel.position.y = voxel.userData.baseY + bob;
  }
}

function resizeRenderer() {
  const { clientWidth, clientHeight } = canvas;
  if (!clientWidth || !clientHeight) return;

  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();

  const nextWidth = Math.max(1, Math.round(clientWidth * Math.min(window.devicePixelRatio, 2)));
  const nextHeight = Math.max(1, Math.round(clientHeight * Math.min(window.devicePixelRatio, 2)));
  if (overlayCanvas.width !== nextWidth || overlayCanvas.height !== nextHeight) {
    overlayCanvas.width = nextWidth;
    overlayCanvas.height = nextHeight;
  }
}

function clearOverlay() {
  overlayContext.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function drawHandOverlay(landmarks) {
  const width = overlayCanvas.width;
  const height = overlayCanvas.height;
  clearOverlay();

  overlayContext.save();
  overlayContext.lineCap = "round";
  overlayContext.lineJoin = "round";
  overlayContext.shadowBlur = 10;
  overlayContext.shadowColor = "rgba(64, 255, 120, 0.6)";

  for (const [from, to] of HAND_CONNECTIONS) {
    const a = landmarks[from];
    const b = landmarks[to];
    const ax = (1 - a.x) * width;
    const ay = a.y * height;
    const bx = (1 - b.x) * width;
    const by = b.y * height;

    overlayContext.strokeStyle = "rgba(78, 255, 120, 0.9)";
    overlayContext.lineWidth = Math.max(1.5, width * 0.0032);
    overlayContext.beginPath();
    overlayContext.moveTo(ax, ay);
    overlayContext.lineTo(bx, by);
    overlayContext.stroke();
  }

  for (const landmark of landmarks) {
    const x = (1 - landmark.x) * width;
    const y = landmark.y * height;
    const radius = Math.max(2.6, width * 0.006);

    overlayContext.fillStyle = "rgba(255, 70, 70, 0.96)";
    overlayContext.beginPath();
    overlayContext.arc(x, y, radius, 0, Math.PI * 2);
    overlayContext.fill();

    overlayContext.fillStyle = "rgba(190, 255, 190, 0.95)";
    overlayContext.beginPath();
    overlayContext.arc(x, y, radius * 0.38, 0, Math.PI * 2);
    overlayContext.fill();
  }

  overlayContext.restore();
}

async function setupWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  video.srcObject = stream;
  await video.play();
}

async function setupHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.55,
  });
}

function processHand(landmarks, elapsed, now) {
  setTracking(true);

  const indexTarget = landmarkToWorld(landmarks[LANDMARK.INDEX_TIP]);
  smoothedIndex = smoothVec(smoothedIndex, indexTarget);

  const snappedPreview = quantizePosition(smoothedIndex);
  previewVoxel.visible = true;
  previewVoxel.position.copy(snappedPreview);
  previewVoxel.material.color.copy(voxelColor(elapsed));
  previewVoxel.material.emissive.copy(previewVoxel.material.color).multiplyScalar(0.4);

  handleSpaceGestures(landmarks);
  handleWipeGesture(landmarks, now);

  const placePinch =
    dist2D(landmarks[LANDMARK.THUMB_TIP], landmarks[LANDMARK.INDEX_TIP]) < PINCH_THRESH;

  if (placePinch && !pinchDown) {
    pinchDown = true;
    spawnVoxel(smoothedIndex, elapsed);
  } else if (!placePinch) {
    pinchDown = false;
  }
}

function clearGestureState() {
  pinchDown = false;
  lastRotateWrist = null;
  lastZoomWrist = null;
  lastWipeSample = null;
  wipeReady = true;
  previewVoxel.visible = false;
  setModeLabel("Idle");
}

function loop() {
  requestAnimationFrame(loop);
  resizeRenderer();

  const elapsed = clock.getElapsedTime();
  const now = performance.now();

  if (handLandmarker && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    const result = handLandmarker.detectForVideo(video, now);
    if (result.landmarks?.length) {
      drawHandOverlay(result.landmarks[0]);
      processHand(result.landmarks[0], elapsed, now);
    } else {
      setTracking(false);
      clearGestureState();
      clearOverlay();
    }
  }

  animateScene(elapsed);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener("resize", resizeRenderer);
window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "c") return;
  clearVoxels();
});

updateVoxelCount();
setModeLabel("Idle");

async function main() {
  await setupWebcam();
  await setupHandLandmarker();
  resizeRenderer();
  loop();
}

main().catch((error) => {
  trackingLabel.textContent = "Camera error";
  clearOverlay();
  console.error(error);
});
