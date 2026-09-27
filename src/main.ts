import './style.css';
import { Stage } from './engine/stage';
import { loadLevel, loadMeta } from './engine/assets';
import { viewFromSpec } from './engine/camera';

async function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const stage = new Stage(canvas);
  (window as any).stage = stage;
  const meta = await loadMeta();
  const params = new URLSearchParams(location.search);
  const v = params.get('v');
  const spec = v ? JSON.parse(decodeURIComponent(v)) : { lon: 35, lat: 32, dist: 1400, pitch: 40, heading: 0 };
  stage.rig.set(viewFromSpec(spec));
  const L0 = await loadLevel('L0', meta.levels.L0);
  stage.addLevel(0, L0);
  const [L1, L2] = await Promise.all([loadLevel('L1', meta.levels.L1), loadLevel('L2', meta.levels.L2)]);
  stage.addLevel(1, L1);
  stage.addLevel(2, L2);
  stage.tu.uHas.value.set(1, 1);
  const dbg = params.get('dbg');
  if (dbg) stage.terrain.material.uniforms.uDebug.value = +dbg;
  stage.start();
  (window as any).__ready = true;
}
boot();
